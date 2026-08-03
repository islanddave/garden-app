-- 0r-rollback.sql
-- V4-EVTCASCADE-001 — exact reversal of 0b-data.sql.
--
-- Restores from the snapshots 0b captured BEFORE it wrote, so the reversal is by row identity, not by
-- predicate. That matters: "harvest_log rows whose parent event is deleted" also matches rows that
-- were legitimately soft-deleted long before this migration, and a predicate-based undo would
-- resurrect those too. Only the ids 0b actually touched are restored here.
--
-- The snapshot tables are left in place — dropping them would make a second rollback impossible and
-- they are a few dozen rows. Drop manually once the repair has soaked.
--
-- SAFETY: idempotent. Does not touch critter_state (0b never did).

BEGIN;

UPDATE public.harvest_log hl
   SET deleted_at = NULL, updated_at = NOW()
  FROM public.snap_evtcascade001_harvest_log s
 WHERE s.id = hl.id;

UPDATE public.photos ph
   SET event_id   = s.event_id,
       project_id = s.project_id,
       plant_id   = s.plant_id,
       updated_at = NOW()
  FROM public.snap_evtcascade001_photos s
 WHERE s.id = ph.id;

DELETE FROM public.schema_version WHERE version = '4.18.1-evtcascade-001';

COMMIT;
