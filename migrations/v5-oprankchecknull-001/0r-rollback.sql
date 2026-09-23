-- 0r-rollback.sql — v5-oprankchecknull-001
-- Reverses 0a: puts back the v5-varietyhybridflag-001 form of the CHECK (NULL-permissive on an unranked
-- row) under the same name, and removes this migration's stamp. No row changes either way: 0a changed a
-- constraint, never data, so there is nothing to un-write.
--
-- WHAT ROLLING BACK COSTS: an Open-pollinated claim on an unranked variety is accepted again by the
-- database. The variety editor still fills the rank itself, and the weekly gate
-- v5-varietyhybridflag-001::post_no_op_claim_without_cultivar_rank still reports any such row after the
-- fact. This exists to unwind a bad apply, not for tidiness.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

ALTER TABLE public.plant_varieties DROP CONSTRAINT IF EXISTS chk_plant_varieties_op_requires_cultivar;

ALTER TABLE public.plant_varieties ADD CONSTRAINT chk_plant_varieties_op_requires_cultivar
  CHECK (breeding_system IS DISTINCT FROM 'open_pollinated' OR variety_rank = 'cultivar');

COMMENT ON CONSTRAINT chk_plant_varieties_op_requires_cultivar ON public.plant_varieties IS NULL;

DELETE FROM public.schema_version WHERE version = '5.0.0-oprankchecknull-001';

COMMIT;
