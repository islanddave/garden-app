-- 0c-validate.sql
-- V4-CAL1-HARVWEIGHT-001 — L-058 sweep: VALIDATE the NOT-VALID CHECK constraints added in 0a.
--
-- Run AFTER 0a and AFTER 0b, as a separate step, so neither the DDL apply nor the seed takes a
-- full-table scan / heavy lock. VALIDATE CONSTRAINT acquires only SHARE UPDATE EXCLUSIVE (concurrent
-- reads/writes proceed) and scans existing rows to confirm none violate the predicate.
--
-- ORDER relative to 0b is deliberate: validating AFTER the seed makes chk_crop_types_default_unit a
-- real assertion over the seeded default_unit values rather than a vacuous scan of an all-NULL column.
-- The weight CHECKs scan harvest_log (all weight columns NULL today) — trivially valid, but the pass
-- locks the invariant in so any later backfill that violates it fails loudly at write time.
--
-- SAFETY: idempotent — VALIDATE on an already-validated constraint is a no-op. No data change. On a
-- clean 0a+0b apply it cannot raise; a raise means the seed and a CHECK vocabulary have drifted and
-- the migration must be fixed, not forced. NOT applied by the authoring session — Dave-gated, staging
-- first.

ALTER TABLE public.crop_types  VALIDATE CONSTRAINT chk_crop_types_default_unit;
ALTER TABLE public.crop_types  VALIDATE CONSTRAINT chk_crop_types_grams_per_unit;
ALTER TABLE public.harvest_log VALIDATE CONSTRAINT chk_harvest_log_weight_grams;
ALTER TABLE public.harvest_log VALIDATE CONSTRAINT chk_harvest_log_weight_pairing;
