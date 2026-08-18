-- 0r-rollback.sql — V4-LOSSCAPTURE-001 rollback.
--
-- 0a is additive: two formalized columns + one genuinely new column, three CHECKs, one
-- schema_version row. A full rollback drops the two NEW constructs (harvest_log.disposition + its
-- CHECK) and the two NEW constraints on the formalized plants columns, but does NOT drop
-- plants.loss_cause / plants.qty_lost themselves — those pre-date this migration on prod/staging
-- (see 0a's header) and dropping them would destroy pre-existing plant-mortality data this
-- migration never created. Dropping the CHECKs alone fully reverts this migration's contribution:
-- no writer this migration adds can run once the events/plants Lambda deploys are also rolled back,
-- and the columns return to their pre-migration unconstrained (Lambda-validated-only) state.
--
-- ORDER MATTERS: DROP CONSTRAINT before DROP COLUMN (harvest_log.disposition only — the plants
-- columns are never dropped, so no column/constraint ordering hazard applies to them).
--
-- SAFE while no consuming code reads harvest_log.disposition or relies on the two new plants
-- CHECKs. Once the capture UI is live, prefer rolling back the CODE and leaving disposition in
-- place (harmless to every existing read) — dropping it discards any disposition values already
-- captured. This file is the full-revert option for a bad deploy caught before real data lands.

BEGIN;

ALTER TABLE public.harvest_log DROP CONSTRAINT IF EXISTS chk_harvest_log_disposition;
ALTER TABLE public.harvest_log DROP COLUMN IF EXISTS disposition;

ALTER TABLE public.plants DROP CONSTRAINT IF EXISTS chk_plants_loss_cause;
ALTER TABLE public.plants DROP CONSTRAINT IF EXISTS chk_plants_qty_lost_nonneg;
-- plants.loss_cause / plants.qty_lost themselves are DELIBERATELY NOT DROPPED — see header.

DELETE FROM public.schema_version WHERE version='4.25.0-losscapture-001';

COMMIT;
