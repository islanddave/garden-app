-- 0c-validate.sql — V4-SEEDINV-001: VALIDATE the NOT VALID constraints from 0a (L-058 sweep step).
-- Run AFTER 0a and AFTER the loader (0b-load-seeds.mjs --apply) so the full-table validation scan sees the
-- loaded data. Re-running is a clean no-op: Postgres skips the scan for a constraint whose convalidated flag
-- is already true, and every constraint below is guaranteed to exist after 0a (each is created there if
-- absent), so no statement can error on a re-run.
--
-- The three classify constraints are included because 0a (re-)creates them NOT VALID on environments that
-- never ran v4-classify (staging drift heal); where v4-classify already ran + validated them, these lines
-- are instant no-ops.

-- SEEDINV sow-profile constraints (added NOT VALID in this migration's 0a).
ALTER TABLE public.plant_varieties VALIDATE CONSTRAINT chk_plant_varieties_start_method;
ALTER TABLE public.plant_varieties VALIDATE CONSTRAINT chk_plant_varieties_sow_weeks;
ALTER TABLE public.plant_varieties VALIDATE CONSTRAINT chk_plant_varieties_germ_days;
ALTER TABLE public.plant_varieties VALIDATE CONSTRAINT chk_plant_varieties_sow_season;

-- Classify constraints (no-op where v4-classify already validated them; real validation where 0a healed drift).
ALTER TABLE public.plant_varieties VALIDATE CONSTRAINT chk_plant_varieties_determinacy;
ALTER TABLE public.plant_varieties VALIDATE CONSTRAINT chk_plant_varieties_day_length;
ALTER TABLE public.plant_varieties VALIDATE CONSTRAINT chk_plant_varieties_grown_as;
