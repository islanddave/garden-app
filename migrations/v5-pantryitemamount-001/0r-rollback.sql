-- 0r-rollback.sql — V5-PUTUPLOGRETIRE-001 R2a B1 rollback. Reverses 0a-additive-ddl.sql back to the exact
--   post-v5-pantry-001 pantry_item (15 columns, 3 CHECKs).
--
-- DESTRUCTIVE: it drops four columns. Run only in the window below.
--
-- ⚠ VALID ONLY WHILE R2a's CODE IS OFF DEV. Once pantryRoutes.js names these columns (its INSERT list is
--   read by the prod schema gate's Phase 2, its contract by Phase 1), dropping them refuses every promote
--   and 500s GET /api/pantry — the whole Pantry, put-ups included, because the list SELECT names them.
--   After that the holding state is "leave the DDL applied": it is compatible with every older Lambda
--   (four nullable columns nothing older names; every CHECK passes on NULL).
--
-- THE REFUSAL GUARD (first statement after BEGIN) refuses once the shape is in use: any pantry_item row,
--   live or soft-deleted, that carries any of the four. A refusal changes nothing: it raises inside the
--   transaction.
--
-- No CASCADE: every DROP names exactly what 0a created.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. The refusal guard. ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-pantryitemamount-001') THEN
    RAISE EXCEPTION 'v5-pantryitemamount-001 0r refused: 0a (5.0.0-pantryitemamount-001) is not applied here; nothing to roll back';
  END IF;

  EXECUTE $q$SELECT count(*) FROM public.pantry_item i
              WHERE (to_jsonb(i) ->> 'quantity_value') IS NOT NULL
                 OR (to_jsonb(i) ->> 'quantity_unit')  IS NOT NULL
                 OR (to_jsonb(i) ->> 'source_kind')    IS NOT NULL
                 OR (to_jsonb(i) ->> 'source_label')   IS NOT NULL$q$ INTO v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'v5-pantryitemamount-001 0r refused, the shape is in use: % pantry_item row(s) carry an amount or a source. Forward-fix only.', v_n;
  END IF;
END $$;

-- ── 1. The CHECKs, then the columns. ─────────────────────────────────────────────────────────────
ALTER TABLE public.pantry_item
  DROP CONSTRAINT IF EXISTS chk_pantry_item_source_plant,
  DROP CONSTRAINT IF EXISTS chk_pantry_item_source_other,
  DROP CONSTRAINT IF EXISTS chk_pantry_item_source_label_kind,
  DROP CONSTRAINT IF EXISTS chk_pantry_item_source_label_len,
  DROP CONSTRAINT IF EXISTS chk_pantry_item_source_label_nonblank,
  DROP CONSTRAINT IF EXISTS chk_pantry_item_source_kind,
  DROP CONSTRAINT IF EXISTS chk_pantry_item_quantity_unit,
  DROP CONSTRAINT IF EXISTS chk_pantry_item_quantity_value,
  DROP CONSTRAINT IF EXISTS chk_pantry_item_quantity_pairing;

ALTER TABLE public.pantry_item
  DROP COLUMN IF EXISTS source_label,
  DROP COLUMN IF EXISTS source_kind,
  DROP COLUMN IF EXISTS quantity_unit,
  DROP COLUMN IF EXISTS quantity_value;

-- ── 2. The stamp. ────────────────────────────────────────────────────────────────────────────────
DELETE FROM public.schema_version WHERE version = '5.0.0-pantryitemamount-001';

COMMIT;
