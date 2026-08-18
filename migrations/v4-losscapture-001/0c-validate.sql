-- 0c-validate.sql
-- V4-LOSSCAPTURE-001 — L-058 sweep: VALIDATE the NOT-VALID CHECK constraints added in 0a.
--
-- Run AFTER the events + plants Lambda deploys carrying the loss/disposition write paths, so this
-- VALIDATE is a real assertion over whatever rows those paths have since written (plus every
-- pre-existing loss_cause value on prod, which the Lambda's own ALLOWED_LOSS already constrained to
-- the same five values — this should never fail on that population) rather than a vacuous scan of an
-- all-NULL column.
--
-- SAFETY: idempotent — VALIDATE CONSTRAINT on an already-validated constraint is a no-op. No data
--   change. VALIDATE CONSTRAINT acquires only SHARE UPDATE EXCLUSIVE (concurrent reads/writes
--   proceed) and scans existing rows to confirm none violate the predicate. A raise here means the
--   deployed Lambda and this migration's vocabulary have drifted and the code must be fixed, not the
--   constraint forced.
--
-- Full-table sweep, not scoped to deleted_at IS NULL (the 2026-08-03 outage class: a pre-VALIDATE
-- check scoped to live rows passes green and then VALIDATE scans the whole heap, including
-- soft-deleted rows, and fails).
--
-- NOT applied to any environment by the authoring session — apply is Dave-gated, staging first.

ALTER TABLE public.plants VALIDATE CONSTRAINT chk_plants_loss_cause;
ALTER TABLE public.plants VALIDATE CONSTRAINT chk_plants_qty_lost_nonneg;
ALTER TABLE public.harvest_log VALIDATE CONSTRAINT chk_harvest_log_disposition;
