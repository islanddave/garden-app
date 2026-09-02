-- V4-SEEDLINK-001 — seed-lot provenance: which PLANT did this lot come from?
--
-- WHY THIS EXISTS. plants.source_inventory_item_id answers "which packet was this plant sown from"
-- (39 of 269 live plantings carry it). Nothing answers the reverse. v4-seedsaveflow-001/0a-ddl.sql
-- said so explicitly in its own receipt: "no provenance column added (V4-SEEDLINK-001 owns that FK
-- and this slice must not duplicate it)". This is that FK.
--
-- ONE PARENT, NOT MANY, AND THAT IS A MEASURED CHOICE. Measured on prod 2026-09-02: 269 plantings
-- across 257 cultivars, of which only 10 cultivars have more than one planting and none has more
-- than 3. A join table for a bulked lot is the general case for a population of at most ten. If it
-- ever becomes real, seed_lot_parent_planting is added additively and THIS column stays as the
-- denormalised primary parent -- the same expand-only shape as seed_stage (current value on the
-- parent) alongside seed_lot_stage_log (the history), shipped one slice ago.
--
-- FK IS ADDED VALID, NOT `NOT VALID`. Same exception the sibling migration documented for its CHECK:
-- the NOT-VALID-then-VALIDATE pattern (L-058) guards against a scan that trips on historical rows
-- and against a still-deployed old writer. Neither applies to a column created in this statement --
-- every existing row is NULL, which an FK admits, and no deployed code can write a column that did
-- not exist a moment ago. Leaving an unvalidated constraint behind for someone to arm later is its
-- own trap (see the 2026-08-03 arming incident).
--
-- ON DELETE RESTRICT matches plants_source_inventory_item_id_fkey, the mirror link. Provenance that
-- silently nulls itself when the parent is removed is worse than no provenance: it reads as "saved
-- from nowhere" rather than "the parent record is gone".
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql

BEGIN;

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS source_plant_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'inventory_items_source_plant_id_fkey') THEN
    ALTER TABLE public.inventory_items
      ADD CONSTRAINT inventory_items_source_plant_id_fkey
      FOREIGN KEY (source_plant_id) REFERENCES public.plants(id) ON DELETE RESTRICT;
  END IF;
END
$$;

-- NOT optional. Postgres does not index the REFERENCING side of an FK, and ON DELETE RESTRICT makes
-- every delete or key-update on plants do an integrity probe against this column. Partial on
-- IS NOT NULL to match the house style (idx_inventory_items_featured_photo) and because the column
-- will be NULL on ~260 of 263 seed rows; the RI probe (source_plant_id = $1) implies IS NOT NULL, so
-- the partial index still serves it. It is also the index for "which lots came from this plant?".
CREATE INDEX IF NOT EXISTS idx_inventory_source_plant
  ON public.inventory_items (source_plant_id)
  WHERE source_plant_id IS NOT NULL;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.91.0-seedlink-001',
        'SEEDLINK: V4-SEEDLINK-001. inventory_items +source_plant_id uuid NULL, FK -> plants(id) '
        'ON DELETE RESTRICT, added VALID (column created in-statement, all rows NULL); partial '
        'index idx_inventory_source_plant. Additive and expand-only: no view widened, no column '
        'altered, no backfill. Mirror of plants.source_inventory_item_id. Substrate only - no '
        'Lambda or UI in this file.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;

-- Verify:
-- SELECT column_name, is_nullable FROM information_schema.columns
--  WHERE table_name='inventory_items' AND column_name='source_plant_id';
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conname='inventory_items_source_plant_id_fkey';
-- SELECT to_regclass('public.idx_inventory_source_plant');
