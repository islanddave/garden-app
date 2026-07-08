-- 0c-validate.sql — DRG-WXWATER-001: VALIDATE the NOT VALID constraint from 0a (L-058 sweep step).
-- Run AFTER 0a. All rows carry rain_exposed_source = 'derived' (column default) or NULL, both of which satisfy
-- the CHECK, so the full-table validation scan is clean. No backfill (0b) is required — a NULL rain_exposed
-- reads as "derive from covered" in the engine, which is the intended default state.
ALTER TABLE public.plants VALIDATE CONSTRAINT chk_plants_rain_exposed_source;
