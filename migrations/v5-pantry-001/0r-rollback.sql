-- 0r-rollback.sql — V5-PANTRY-001 (Put-Up release 2, as carried by B′) rollback. Reverses
--   0a-additive-ddl.sql, in reverse order, back to the exact post-F schema.
--
-- ⚠ VALID ONLY WHILE B′'s CODE IS OFF DEV (05-release-train §4, read "4r→3r→2r"). Once the Lambda names
--   pantry_item or kitchen_batch_input.pantry_item_id, dropping them blocks every thread's promote at
--   the prod schema gate; the holding state is then "leave release 2's DDL applied" (it is
--   F-compatible: a new table and one nullable column nothing older names).
--
-- ORDER IN THE CHAIN: 3r (v5-batchbuilder-001) runs before this file when release 3 was applied. This
--   file does not look at release 3's objects; if 3's DDL references pantry_item it must be rolled back
--   first, and a DROP below then fails loudly (no CASCADE anywhere here) rather than taking 3's
--   objects with it.
--
-- THE REFUSAL GUARD (first statement after BEGIN) refuses once release 2's shape is in use, naming each
--   reason with its count: any pantry_item row (live or soft-deleted — a soft delete is still a record);
--   any line naming one. A refusal changes nothing: it raises inside the transaction.
--
-- No CASCADE: every DROP names exactly what 0a created, so a dependency nobody declared stops the
--   rollback instead of disappearing with it.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. The refusal guard. ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_why   text[] := ARRAY[]::text[];
  v_n     bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-pantry-001') THEN
    RAISE EXCEPTION 'v5-pantry-001 0r refused: 0a (5.0.0-pantry-001) is not applied here; nothing to roll back';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = 'pantry_item' AND c.relkind = 'r') THEN
    EXECUTE 'SELECT count(*) FROM public.pantry_item' INTO v_n;
    IF v_n > 0 THEN
      v_why := v_why || format('%s pantry_item rows', v_n);
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'kitchen_batch_input'
                AND column_name = 'pantry_item_id') THEN
    EXECUTE 'SELECT count(*) FROM public.kitchen_batch_input WHERE pantry_item_id IS NOT NULL' INTO v_n;
    IF v_n > 0 THEN
      v_why := v_why || format('%s batch lines naming a pantry item', v_n);
    END IF;
  END IF;

  IF cardinality(v_why) > 0 THEN
    RAISE EXCEPTION 'v5-pantry-001 0r refused, release 2''s shape is in use: %. Forward-fix only.',
      array_to_string(v_why, '; ');
  END IF;
END $$;

-- ── 1. kitchen_batch_input: the CHECK, the FK, the index, the column. ────────────────────────────
DROP INDEX IF EXISTS public.idx_kbi_pantry_item;

ALTER TABLE public.kitchen_batch_input
  DROP CONSTRAINT IF EXISTS chk_kbi_pantry_item_kind,
  DROP CONSTRAINT IF EXISTS kitchen_batch_input_pantry_item_id_fkey,
  DROP COLUMN IF EXISTS pantry_item_id;

-- ── 2. pantry_item: triggers, then the table (its indexes and constraints go with it). ───────────
DROP TRIGGER IF EXISTS prevent_pantry_item_ownership_transfer ON public.pantry_item;
DROP TRIGGER IF EXISTS set_updated_at ON public.pantry_item;
DROP TABLE IF EXISTS public.pantry_item;

-- ── 3. The stamp. ────────────────────────────────────────────────────────────────────────────────
DELETE FROM public.schema_version WHERE version = '5.0.0-pantry-001';

COMMIT;
