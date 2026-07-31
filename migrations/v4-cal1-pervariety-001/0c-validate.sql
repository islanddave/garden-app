-- 0c-validate.sql
-- V4-CAL1-PERVARIETY-001 — L-058 sweep: VALIDATE the NOT-VALID CHECK constraints added in 0a.
--
-- Run AFTER 0a (and after 0b — harmless either way; 0b writes no constrained columns). VALIDATE acquires
-- only SHARE UPDATE EXCLUSIVE (concurrent reads/writes proceed) and scans existing rows to confirm none
-- violate the predicate. The cultivar_weight_sample CHECKs scan an empty table (trivially valid); the
-- harvest_log weight_basis CHECKs scan 255 rows all with weight_basis NULL (trivially valid via the
-- NULL guards) — the pass LOCKS the invariants so any later write/seed that violates them fails loudly.
--
-- SAFETY: idempotent — VALIDATE on an already-validated constraint is a no-op. No data change. A raise
-- means real data violates a predicate and the migration must be fixed, not forced. Dave-gated, staging first.

ALTER TABLE public.cultivar_weight_sample VALIDATE CONSTRAINT chk_cws_unit_vocab;
ALTER TABLE public.cultivar_weight_sample VALIDATE CONSTRAINT chk_cws_total_grams_pos;
ALTER TABLE public.cultivar_weight_sample VALIDATE CONSTRAINT chk_cws_unit_count_pos;
ALTER TABLE public.harvest_log VALIDATE CONSTRAINT chk_harvest_log_weight_basis;
ALTER TABLE public.harvest_log VALIDATE CONSTRAINT chk_harvest_log_weight_basis_pairing;
ALTER TABLE public.harvest_log VALIDATE CONSTRAINT chk_harvest_log_weight_basis_estimated;
