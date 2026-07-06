-- 0c-validate.sql — V4 CLASSIFY: VALIDATE the NOT VALID constraints from 0a (L-058 sweep step).
-- Run AFTER 0a and AFTER the backfill (0b) so the full-table validation scan sees final data.
ALTER TABLE public.tag VALIDATE CONSTRAINT tag_facet_check;
ALTER TABLE public.plant_varieties VALIDATE CONSTRAINT chk_plant_varieties_determinacy;
ALTER TABLE public.plant_varieties VALIDATE CONSTRAINT chk_plant_varieties_day_length;
ALTER TABLE public.plant_varieties VALIDATE CONSTRAINT chk_plant_varieties_grown_as;
