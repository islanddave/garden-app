-- 0d-validate.sql
-- V4-HARVDUAL-001 Slice C — L-058 sweep: VALIDATE the CHECKs v4-cal1-pervariety-001 added NOT VALID.
--
-- Must run AFTER 0c-backfill-basis. Before the backfill these cannot pass: 332 live rows carry a
-- weight with a NULL basis (see the 0c header), so chk_harvest_log_weight_basis_pairing would fail
-- on the very first row it scanned.
--
-- Ordering it here also makes each VALIDATE a real assertion over live data rather than a vacuous
-- scan, and locks the invariants in so any later write that breaks them fails loudly at write time
-- instead of silently producing a weight with no provenance.
--
-- Idempotent: VALIDATE on an already-validated constraint is a no-op. No data change.

ALTER TABLE public.cultivar_weight_sample VALIDATE CONSTRAINT chk_cws_unit_vocab;
ALTER TABLE public.cultivar_weight_sample VALIDATE CONSTRAINT chk_cws_total_grams_pos;
ALTER TABLE public.cultivar_weight_sample VALIDATE CONSTRAINT chk_cws_unit_count_pos;
ALTER TABLE public.harvest_log VALIDATE CONSTRAINT chk_harvest_log_weight_basis;
ALTER TABLE public.harvest_log VALIDATE CONSTRAINT chk_harvest_log_weight_basis_pairing;
ALTER TABLE public.harvest_log VALIDATE CONSTRAINT chk_harvest_log_weight_basis_estimated;
