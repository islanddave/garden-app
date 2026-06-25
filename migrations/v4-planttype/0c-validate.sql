-- 0c-validate.sql
-- V4 PLANTTYPE — L-058 sweep: VALIDATE the NOT-VALID CHECK constraints added in 0a.
--
-- PURPOSE: promote chk_plant_varieties_lifecycle and chk_plant_varieties_scoville from NOT VALID
--   to validated. Run AFTER 0a, as a separate step, so the initial DDL apply takes no full-table
--   scan / heavy lock. VALIDATE CONSTRAINT acquires only SHARE UPDATE EXCLUSIVE (concurrent
--   reads/writes proceed) and scans existing rows to confirm none violate the predicate.
--
-- SAFETY: idempotent — VALIDATE CONSTRAINT on an already-validated constraint is a no-op.
--   No data change. If any existing row violated the predicate this would raise; on a clean
--   additive deploy (all new columns NULL on existing rows) it cannot.
--
-- DRY-RUN: validated on COW branch dryrun-v4-tagsub-20260625-193243 (br-snowy-field-amxeo8j7,
--   COW off production br-delicate-sea-amum92c2). convalidated=true confirmed post-run.
--   NOT yet applied to prod / staging.

ALTER TABLE public.plant_varieties VALIDATE CONSTRAINT chk_plant_varieties_lifecycle;
ALTER TABLE public.plant_varieties VALIDATE CONSTRAINT chk_plant_varieties_scoville;
