-- V4-SEEDORIGIN-001 rollback. Drops the four CHECKs and the column, and removes the receipt so the
-- post gates go vacuously green again rather than red-on-revert.
--
-- Safe to run: the column is nullable with no default and no backfill, so dropping it destroys only
-- values written after the apply. If any lot has recorded a non-planting origin, THAT DATA IS LOST —
-- check before running:
--   SELECT count(*) FROM public.inventory_items WHERE source_kind IS NOT NULL;
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

ALTER TABLE public.inventory_items DROP CONSTRAINT IF EXISTS chk_inventory_source_plant_seeds_only;
ALTER TABLE public.inventory_items DROP CONSTRAINT IF EXISTS chk_inventory_source_kind_seeds_only;
ALTER TABLE public.inventory_items DROP CONSTRAINT IF EXISTS chk_inventory_seed_source_plant;
ALTER TABLE public.inventory_items DROP CONSTRAINT IF EXISTS chk_inventory_source_kind;

ALTER TABLE public.inventory_items DROP COLUMN IF EXISTS source_kind;

DELETE FROM public.schema_version WHERE version = '4.94.0-seedorigin-001';

COMMIT;
