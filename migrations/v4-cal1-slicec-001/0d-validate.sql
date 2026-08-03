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

-- chk_harvest_log_weight_basis_pairing and _estimated are DELIBERATELY NOT armed here — see
-- 0g-recheck-after-lambda.sql. They constrain a column only the NEW Lambda writes, so arming them
-- pre-deploy 23514s every harvest save made by the still-deployed OLD Lambda. That is exactly what
-- happened on 2026-08-03. The vocab CHECK above is safe because NULL passes it.
-- Run 0g AFTER the events Lambda deploy completes.
