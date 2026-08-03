-- 0c-validate.sql
-- V4-CAL1-REFWEIGHT-001 — L-058 sweep: VALIDATE the NOT-VALID CHECKs added in 0a.
--
-- Run AFTER 0a and AFTER 0b-seed, as a separate step, so neither the DDL apply nor the seed takes a
-- full-table scan / heavy lock. VALIDATE CONSTRAINT takes only SHARE UPDATE EXCLUSIVE (concurrent
-- reads/writes proceed) and scans existing rows to confirm none violate the predicate.
--
-- Ordering AFTER 0b is deliberate: it makes each VALIDATE a real assertion over the seeded values
-- (82 crop rows + 326 variety rows) rather than a vacuous scan of all-NULL columns. In particular it
-- proves every seeded unit_weights map is shape-legal — vocab-only keys, positive numeric values.
--
-- SAFETY: idempotent (VALIDATE on an already-validated constraint is a no-op). No data change. A raise
-- here means the seed and the CHECK vocabulary have drifted — fix the generator, never force it.

ALTER TABLE public.crop_types      VALIDATE CONSTRAINT chk_crop_types_unit_weights;
ALTER TABLE public.crop_types      VALIDATE CONSTRAINT chk_crop_types_weight_source;
ALTER TABLE public.crop_types      VALIDATE CONSTRAINT chk_crop_types_weight_confidence;
ALTER TABLE public.plant_varieties VALIDATE CONSTRAINT chk_plant_varieties_unit_weights;
ALTER TABLE public.plant_varieties VALIDATE CONSTRAINT chk_plant_varieties_weight_source;
ALTER TABLE public.plant_varieties VALIDATE CONSTRAINT chk_plant_varieties_weight_confidence;
