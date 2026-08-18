-- 0r-rollback.sql — rollback for V4-LOSSEVENT-001 / BUG-LOSSCAUSE-001 / V4-HARVDISPOSITION-001.
--
-- The bundle is additive across three phases: 0a adds two formalized columns + one genuinely new
-- column, 0b arms three CHECKs, 0c validates them. A full rollback drops the two NEW constructs
-- (harvest_log.disposition + its CHECK) and the two NEW constraints on the formalized plants
-- columns, but does NOT drop plants.loss_cause / plants.qty_lost themselves — those pre-date this
-- migration on prod/staging (see 0a's header) and dropping them would destroy pre-existing
-- plant-mortality data this migration never created. Dropping the CHECKs alone fully reverts this
-- bundle's contribution to those two columns: they return to their pre-migration unconstrained
-- (Lambda-validated-only) state.
--
-- REVERSES THE PHASE ORDER, and that is the whole point of the phase split. 0b narrowed the write
-- contract; this file widens it again FIRST, so the moment it commits the pre-guard artifact is
-- legal again. A rollback that dropped the column before releasing the constraint would leave a
-- window in which the deployed writer is still constrained by something being torn down.
-- Correspondingly, on a CODE rollback (reverting the qty_lost guard) 0b's constraints must come
-- off too — the guard and chk_plants_qty_lost_nonneg are a matched pair in both directions.
--
-- ORDER WITHIN THE FILE: DROP CONSTRAINT before DROP COLUMN (harvest_log.disposition only — the
-- plants columns are never dropped, so no column/constraint ordering hazard applies to them).
--
-- SAFE while no consuming code reads harvest_log.disposition or relies on the two new plants
-- CHECKs. Once the capture UI is live, prefer rolling back the CODE and leaving disposition in
-- place (harmless to every existing read) — dropping it discards any disposition values already
-- captured. This file is the full-revert option for a bad deploy caught before real data lands.
--
-- PARTIAL ROLLBACK is legal and is the common case: running only the two ALTER ... DROP CONSTRAINT
-- statements on plants un-arms 0b while leaving 0a's columns in place. Delete only the
-- '4.25.1-...-checks' and '4.25.2-...-validate' rows if you do that, so the self-arming gates
-- disarm with it.

BEGIN;

ALTER TABLE public.harvest_log DROP CONSTRAINT IF EXISTS chk_harvest_log_disposition;
ALTER TABLE public.harvest_log DROP COLUMN IF EXISTS disposition;

ALTER TABLE public.plants DROP CONSTRAINT IF EXISTS chk_plants_loss_cause;
ALTER TABLE public.plants DROP CONSTRAINT IF EXISTS chk_plants_qty_lost_nonneg;
-- plants.loss_cause / plants.qty_lost themselves are DELIBERATELY NOT DROPPED — see header.

DELETE FROM public.schema_version
 WHERE version IN ('4.25.0-losscapture-001',
                   '4.25.1-losscapture-001-checks',
                   '4.25.2-losscapture-001-validate');

COMMIT;
