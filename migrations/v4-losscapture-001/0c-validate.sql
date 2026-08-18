-- 0c-validate.sql — PHASE 3 of 3. L-058 sweep: VALIDATE the NOT-VALID CHECKs armed in 0b.
-- Ledger items: V4-LOSSEVENT-001 / BUG-LOSSCAUSE-001 / V4-HARVDISPOSITION-001.
--
-- Run AFTER 0b, so this VALIDATE is a real assertion over the whole existing heap (every
-- pre-existing loss_cause value on prod, which the Lambda's own ALLOWED_LOSS already constrained to
-- the same five values, and every pre-existing qty_lost, which nothing ever floored) rather than a
-- vacuous scan of an all-NULL column. The pre gates pre_no_out_of_vocab_loss_cause and
-- pre_no_negative_qty_lost PREDICT this file's outcome and are the reason it should not surprise
-- anyone; they live in the pre phase precisely because a prediction of a later phase's result is
-- not a post-condition of an earlier one.
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

INSERT INTO public.schema_version (version, description)
VALUES ('4.25.2-losscapture-001-validate','V4-LOSSEVENT-001/BUG-LOSSCAUSE-001/V4-HARVDISPOSITION-001 phase 3/3 (POST-DEPLOY). VALIDATEs chk_plants_loss_cause, chk_plants_qty_lost_nonneg and chk_harvest_log_disposition against the FULL heap (soft-deleted rows included). No-op on any environment where the three already read convalidated. This row is what arms post_validate_all_three_checks_convalidated as a continuous invariant.')
ON CONFLICT (version) DO NOTHING;
