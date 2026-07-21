-- 0c-validate.sql
-- V4-HARVATTR-001 — L-058 sweep: VALIDATE the NOT-VALID CHECK constraints added in 0a.
--
-- PURPOSE: promote the five harvest-attribute CHECKs from NOT VALID to validated. Run AFTER 0a and
--   AFTER 0b, as a separate step, so neither the DDL apply nor the data seed takes a full-table
--   scan / heavy lock. VALIDATE CONSTRAINT acquires only SHARE UPDATE EXCLUSIVE (concurrent
--   reads/writes proceed) and scans existing rows to confirm none violate the predicate.
--
--   ORDER MATTERS relative to 0b: validating AFTER the seed is deliberate. It means these VALIDATEs
--   are a real assertion over the 51 seeded rows (habit vocab, no interval on a 'single' crop,
--   in-range hours/days, paired DOY bounds) rather than a vacuous scan of an all-NULL column.
--   If 0b ever seeds a value that contradicts a CHECK, THIS is the step that fails, loudly, before
--   any application code reads the attributes.
--
-- SAFETY: idempotent — VALIDATE CONSTRAINT on an already-validated constraint is a no-op. No data
--   change. On a clean 0a+0b apply it cannot raise; a raise here means the seed and the constraint
--   vocabulary have drifted and the migration must be fixed, not forced.
--
-- NOT applied to any environment by the authoring session — apply is Dave-gated, staging first.

ALTER TABLE public.crop_types VALIDATE CONSTRAINT chk_crop_types_harvest_habit;
ALTER TABLE public.crop_types VALIDATE CONSTRAINT chk_crop_types_repeat_interval;
ALTER TABLE public.crop_types VALIDATE CONSTRAINT chk_crop_types_loss_horizon;
ALTER TABLE public.crop_types VALIDATE CONSTRAINT chk_crop_types_set_to_first_pick;
ALTER TABLE public.crop_types VALIDATE CONSTRAINT chk_crop_types_harvest_season_doy;
