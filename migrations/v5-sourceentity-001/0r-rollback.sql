-- 0r-rollback.sql
-- V5-SOURCEENTITY-001 rollback. Drops the four FK columns, their CHECKs and indexes, the
-- public.source table, and the receipt — so the post gates return to vacuously green rather than
-- red-on-revert.
--
-- WHAT THIS DESTROYS. Nothing that existed before 0a. This migration backfills nothing and alters
-- nothing: plants.source_ref and inventory_items.source are never touched by 0a or by this file,
-- so the provenance record is intact either way. What IS lost is anything written to the new
-- columns or the catalogue AFTER the apply. CHECK BOTH BEFORE RUNNING:
--
--   SELECT count(*) FROM public.source WHERE deleted_at IS NULL;
--   SELECT count(*) FROM public.plants
--    WHERE source_id IS NOT NULL OR acquired_from_source_id IS NOT NULL;
--   SELECT count(*) FROM public.inventory_items
--    WHERE source_id IS NOT NULL OR acquired_from_source_id IS NOT NULL;
--
-- If any of those is non-zero, a backfill or a human has recorded provenance here. Dump it before
-- rolling back:
--   \copy (SELECT * FROM public.source) TO 'source-rollback-backup.csv' CSV HEADER
--
-- ORDER MATTERS. The parents' FK columns must go BEFORE public.source, or the DROP TABLE fails on
-- the dependent constraints. Dropping a column drops the FK constraint and any index over it
-- automatically, so they are not dropped separately — but the two distinctness CHECKs reference
-- both columns and are dropped explicitly first so a partial re-run cannot leave one behind.
--
-- IDEMPOTENT. Every statement is IF EXISTS; a re-run on an already-rolled-back database is a no-op.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

ALTER TABLE public.plants          DROP CONSTRAINT IF EXISTS chk_plants_source_distinct;
ALTER TABLE public.inventory_items DROP CONSTRAINT IF EXISTS chk_inventory_source_distinct;

ALTER TABLE public.plants
  DROP COLUMN IF EXISTS acquired_from_source_id,
  DROP COLUMN IF EXISTS source_id;

ALTER TABLE public.inventory_items
  DROP COLUMN IF EXISTS acquired_from_source_id,
  DROP COLUMN IF EXISTS source_id;

DROP TRIGGER IF EXISTS set_updated_at ON public.source;

-- Indexes and constraints on public.source go with the table.
DROP TABLE IF EXISTS public.source;

DELETE FROM public.schema_version WHERE version = '5.0.0-sourceentity-001';

COMMIT;

-- Verify the return to greenfield:
-- SELECT coalesce(to_regclass('public.source')::text, 'ABSENT');
-- SELECT count(*) FROM information_schema.columns
--  WHERE table_schema='public' AND table_name IN ('plants','inventory_items')
--    AND column_name IN ('source_id','acquired_from_source_id');   -- expect 0
