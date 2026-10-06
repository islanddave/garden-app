-- 0a-additive-ddl.sql
-- V5-SEEDPLANTCOUNT-001 — how many PLANTS a saved-seed lot was taken from.
--   A lot's parents are plantings (seed_lot_parent_planting, v5-seedmultiparent-001), and one planting
--   can be a row of eighteen plants. "Seed saved from 6 plants" is the number a seed saver needs for
--   population size, and it cannot be derived: it is neither the number of parent plantings nor their
--   summed quantity (seed was taken from six of the eighteen). So it is recorded.
--   Canon: gardening-docs project-state/_seedmultiparent-20261005/r2/R2A-CONTRACT.md sections 1 and 3
--   (binding; the names below are load-bearing there) and seat-data-schema-architect.md answer 6.
--
-- SCOPE: one nullable column on inventory_items, two CHECKs, one schema_version row. No view changes:
--   the list and detail reads select i.*, and v_sow_candidates lists its columns and does not need
--   this one. No row is written.
--
-- DESIGN DECISIONS THIS DDL ENCODES:
--
--   * P1 — THE NAME. seed_parent_plant_count: the `seed_` family this table already has (seed_count,
--     seed_stage), the role word the link table uses (seed_parent), and PLANT, not planting — the two
--     are different numbers and the column is the one that cannot be counted from rows.
--
--   * P2 — NULLABLE, NO DEFAULT. NULL = nobody said. A default is a count nobody made (the grown_as
--     DEFAULT 'annual' defect stamped 362 of 413 cultivars before it was dropped).
--
--   * P3 — TWO NAMED CHECKS, ONE RULE EACH, so a violation names which rule and the handler can map
--     each name to a sentence (lambda/inventory-items constraint-message map):
--       chk_inventory_seed_parent_plant_count_seeds_only   seed_parent_plant_count IS NULL OR category = 'seeds'
--       chk_inventory_seed_parent_plant_count_positive     seed_parent_plant_count IS NULL OR seed_parent_plant_count >= 1
--     Seeds-only is spelled as chk_inventory_source_plant_seeds_only is (NULL-first, category alone):
--     this column describes the lot's PARENTS, like source_plant_id, and not its stock, so it does not
--     carry the `AND type = 'consumable'` term the seed_count / seed_weight_g CHECKs need.
--     >= 1, not >= 0: seed was taken from at least one plant, and "unknown" is NULL. This is the
--     deliberate opposite of chk_inventory_seed_count_nonneg, where 0 is a measured fact.
--     There is no upper bound in the database; the handler caps at 9999.
--
--   * P4 — THE CHECKS SHIP WITH THE COLUMN (memory `arming-a-check-is-a-deploy`), which is safe only
--     because of who writes it. See the next paragraph.
--
-- WHY THE DEPLOYED WRITER IS UNAFFECTED (the house test: would the currently deployed code produce a
--   row that violates this?). No deployed code names the column: POST and the wide PUT are explicit
--   column lists, so every row they write leaves it NULL, and both CHECKs admit NULL. The wide PUT
--   assigns `category` unconditionally, and a NULL count passes seeds-only under any category. After
--   release 2a exactly one route writes it (PUT /api/inventory-items/:id/seed-measure, a
--   presence-guarded key); the wide PUT refuses to move a lot that has a variety out of Seeds, and a
--   re-filed row with a count would be refused by seeds-only as a 23514 the handler has a sentence for.
--
-- SAFETY / IDEMPOTENCY: ADD COLUMN IF NOT EXISTS, each ADD CONSTRAINT guarded by a pg_constraint
--   lookup scoped to inventory_items, the stamp ON CONFLICT DO NOTHING. Re-running the whole file is a
--   clean no-op and does not move applied_at. Both constraints are born valid: the column is born
--   NULL on every row, so the validating scan finds nothing; no NOT VALID / VALIDATE pair.
--   lock_timeout: ADD COLUMN and ADD CONSTRAINT each take a brief ACCESS EXCLUSIVE lock on
--   inventory_items. Behind a long-open transaction that request would queue, and every inventory
--   read and write would queue behind IT; 5s turns that into a fast failure that changed nothing.
--   Run it again.
--   ⚠ Exactly ONE COMMIT, at the end. Do not wrap this file in BEGIN/ROLLBACK to "rehearse" it on a
--   shared database. Rehearse on local PostgreSQL 17 (README.md).
--
-- APPLY ORDER (README.md has the commands). Staging: pre -> sweep -> 0a -> post -> rehearse 0r -> 0a ->
--   post. Prod: Dave's approval, outside 07:00-08:00 UTC, after a pre-apply copy. On both databases
--   before the push that carries the Lambda naming the column.
--
-- ROLLBACK: 0r-rollback.sql. It refuses while any count is recorded.
--
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 1. The column (P1, P2). Nullable, no DEFAULT. ────────────────────────────────────────────────
ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS seed_parent_plant_count integer;

COMMENT ON COLUMN public.inventory_items.seed_parent_plant_count IS
  'V5-SEEDPLANTCOUNT-001. How many PLANTS this saved-seed lot was taken from — not how many parent plantings (count the live seed_parent rows of seed_lot_parent_planting for that) and not their summed quantity. NULL = not recorded. At least 1 when set; seeds rows only. Written only by PUT /api/inventory-items/:id/seed-measure.';

-- ── 2. The two CHECKs (P3). Guarded; born valid, the column is all NULL. ─────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.inventory_items'::regclass
                    AND conname = 'chk_inventory_seed_parent_plant_count_seeds_only') THEN
    ALTER TABLE public.inventory_items
      ADD CONSTRAINT chk_inventory_seed_parent_plant_count_seeds_only
      CHECK (seed_parent_plant_count IS NULL OR category = 'seeds');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.inventory_items'::regclass
                    AND conname = 'chk_inventory_seed_parent_plant_count_positive') THEN
    ALTER TABLE public.inventory_items
      ADD CONSTRAINT chk_inventory_seed_parent_plant_count_positive
      CHECK (seed_parent_plant_count IS NULL OR seed_parent_plant_count >= 1);
  END IF;
END $$;

-- ── 3. The stamp. Same transaction as the DDL: "applied" and "armed" are one event. ───────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.0.0-seedplantcount-001',
        'SEEDPLANTCOUNT: V5-SEEDPLANTCOUNT-001. inventory_items.seed_parent_plant_count (nullable '
        'integer, no DEFAULT): how many plants a saved-seed lot was taken from — not the number of '
        'parent plantings and not their summed quantity. chk_inventory_seed_parent_plant_count_seeds_only '
        '(NULL or category = seeds) and chk_inventory_seed_parent_plant_count_positive (NULL or >= 1), '
        'both shipped with the column: every deployed writer leaves it NULL. No view change, no '
        'backfill, no row written. One writer after release 2a: PUT /api/inventory-items/:id/seed-measure.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
