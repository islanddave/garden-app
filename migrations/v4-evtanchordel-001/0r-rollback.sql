-- 0r-rollback.sql
-- V4-EVTANCHORDEL-001 — exact reversal.
--
-- Two independent halves; run only the ones you actually applied. Reverse order of application:
-- constraints first (0c), substrate second (0a). The predicates below are the LIVE definitions
-- captured from prod before 0c ran, not reconstructions from a migration file:
--   event_log_plant_id_fkey     FOREIGN KEY (plant_id)    REFERENCES plants(id)    ON DELETE SET NULL
--   photos_plant_id_fkey        FOREIGN KEY (plant_id)    REFERENCES plants(id)    ON DELETE SET NULL
--   photos_location_id_fkey     FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL
--
-- 0c moved no rows, so its reversal is lossless and unconditional.
--
-- ⚠ 0a's reversal is NOT unconditional. If archive_plant_events() has been run, the archive tables
-- hold the ONLY surviving copy of those events — dropping them destroys user history for good. The
-- DROPs below are therefore guarded: they refuse to run while any archived row exists. To reverse
-- anyway, first restore or export the rows (see RESTORE below), then re-run.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── Reverse 0c ─────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.event_log
  DROP CONSTRAINT IF EXISTS event_log_plant_id_fkey,
  ADD  CONSTRAINT event_log_plant_id_fkey
       FOREIGN KEY (plant_id) REFERENCES public.plants(id) ON DELETE SET NULL;

ALTER TABLE public.photos
  DROP CONSTRAINT IF EXISTS photos_plant_id_fkey,
  ADD  CONSTRAINT photos_plant_id_fkey
       FOREIGN KEY (plant_id) REFERENCES public.plants(id) ON DELETE SET NULL;

ALTER TABLE public.photos
  DROP CONSTRAINT IF EXISTS photos_location_id_fkey,
  ADD  CONSTRAINT photos_location_id_fkey
       FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE SET NULL;

DELETE FROM public.schema_version WHERE version = '4.21.3-evtanchordel-001';

COMMIT;

-- ── Reverse 0a (guarded) ───────────────────────────────────────────────────────────────────────
BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE n bigint;
BEGIN
  IF to_regclass('public.event_log_archive') IS NOT NULL THEN
    SELECT count(*) INTO n FROM public.event_log_archive;
    IF n > 0 THEN
      RAISE EXCEPTION 'refusing to drop event_log_archive: % archived event(s) present. These are the '
                      'only surviving copy. Restore or export them first (see RESTORE in this file).', n;
    END IF;
  END IF;
  IF to_regclass('public.harvest_log_archive') IS NOT NULL THEN
    SELECT count(*) INTO n FROM public.harvest_log_archive;
    IF n > 0 THEN
      RAISE EXCEPTION 'refusing to drop harvest_log_archive: % archived harvest row(s) present.', n;
    END IF;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.archive_plant_events(uuid, text);
DROP TABLE    IF EXISTS public.harvest_log_archive;
DROP TABLE    IF EXISTS public.event_log_archive;

DELETE FROM public.schema_version WHERE version = '4.21.3-evtanchordel-001-archive';

COMMIT;

-- ── RESTORE (not part of the rollback; run by hand when you want the events BACK) ──────────────
-- row_data is the complete original row as jsonb, so the shape is recovered rather than re-derived.
-- The planting must exist again first (RESTRICT means it was never deleted unless you deleted it).
-- harvest_log must go back AFTER event_log — its FK is RESTRICT in the other direction.
--
--   INSERT INTO public.event_log
--   SELECT (jsonb_populate_record(NULL::public.event_log, row_data)).*
--     FROM public.event_log_archive WHERE archived_plant_id = '<plant-uuid>';
--
--   INSERT INTO public.harvest_log
--   SELECT (jsonb_populate_record(NULL::public.harvest_log, row_data)).*
--     FROM public.harvest_log_archive WHERE archived_plant_id = '<plant-uuid>';
--
--   DELETE FROM public.harvest_log_archive WHERE archived_plant_id = '<plant-uuid>';
--   DELETE FROM public.event_log_archive   WHERE archived_plant_id = '<plant-uuid>';
--
-- Photos detached by archive_plant_events() are NOT re-attached by this: they were re-parented to the
-- event's project/location and are still live and visible. Re-pointing them at a restored event is a
-- manual decision.
