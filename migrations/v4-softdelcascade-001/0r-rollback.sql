-- 0r-rollback.sql
-- V4-SOFTDELCASCADE-001 — exact reversal.
--
-- Two independent halves; run only the ones you actually applied. Reverse order of application:
-- constraints first (0c), substrate second (0a). The predicates restored below are the LIVE
-- definitions captured from prod with pg_get_constraintdef BEFORE 0c ran, not reconstructions from
-- a migration file:
--   event_log_project_id_fkey  FOREIGN KEY (project_id) REFERENCES plant_projects(id) ON DELETE CASCADE
--   photos_project_id_fkey     FOREIGN KEY (project_id) REFERENCES plant_projects(id) ON DELETE CASCADE
--   photos_event_id_fkey       FOREIGN KEY (event_id)   REFERENCES event_log(id)      ON DELETE CASCADE
--
-- ⚠ READ THIS BEFORE RUNNING PART 1. Reversing 0c does not restore a neutral prior state — it
-- RE-ARMS the defect. The moment these three FKs are CASCADE again, a single
-- `DELETE FROM plant_projects` silently destroys every event anchored to that container and
-- cascades a second hop into those events' photos, with no error. At authoring time that was 49
-- unprotected containers / 2,432 events / 199 photos. Roll back only if the RESTRICT is actively
-- breaking something, and treat the window as one in which no hard container delete may run.
--
-- 0c moved no rows, so its reversal is lossless and unconditional.
--
-- ⚠ PART 2 IS NOT UNCONDITIONAL, and it is deliberately NON-DESTRUCTIVE. Per the Soft-Delete-Only
-- rule this file drops NO column and NO data:
--   * archived_project_id is LEFT IN PLACE. It is an additive nullable column; leaving it costs
--     nothing, and dropping it would destroy the provenance of every container-archived row —
--     rows for which the archive is the ONLY surviving copy.
--   * The shared cold-store TABLES (event_log_archive, harvest_log_archive) are NOT dropped here.
--     They belong to V4-EVTANCHORDEL-001, not to this migration; its own 0r owns them.
--   * Restoring archived_plant_id's NOT NULL is guarded: it refuses while any container-archived
--     row exists, because such a row legitimately has a NULL there.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── PART 1 — Reverse 0c (re-arms the defect; see warning above) ────────────────────────────────
ALTER TABLE public.event_log
  DROP CONSTRAINT IF EXISTS event_log_project_id_fkey,
  ADD  CONSTRAINT event_log_project_id_fkey
       FOREIGN KEY (project_id) REFERENCES public.plant_projects(id) ON DELETE CASCADE;

ALTER TABLE public.photos
  DROP CONSTRAINT IF EXISTS photos_project_id_fkey,
  ADD  CONSTRAINT photos_project_id_fkey
       FOREIGN KEY (project_id) REFERENCES public.plant_projects(id) ON DELETE CASCADE;

ALTER TABLE public.photos
  DROP CONSTRAINT IF EXISTS photos_event_id_fkey,
  ADD  CONSTRAINT photos_event_id_fkey
       FOREIGN KEY (event_id) REFERENCES public.event_log(id) ON DELETE CASCADE;

DELETE FROM public.schema_version WHERE version = '4.23.2-softdelcascade-001';

COMMIT;

-- ── PART 2 — Reverse 0a (guarded, non-destructive) ─────────────────────────────────────────────
BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.event_log_archive WHERE archived_plant_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'refusing to restore archived_plant_id NOT NULL on event_log_archive: % '
                    'container-archived row(s) present, whose provenance is archived_project_id. '
                    'These are the only surviving copy of those events. Restore or export them '
                    'first (see RESTORE in this file), then re-run.', n;
  END IF;
  SELECT count(*) INTO n FROM public.harvest_log_archive WHERE archived_plant_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'refusing to restore archived_plant_id NOT NULL on harvest_log_archive: % '
                    'container-archived row(s) present.', n;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.archive_container_events(uuid, text);

ALTER TABLE public.event_log_archive
  DROP CONSTRAINT IF EXISTS event_log_archive_has_provenance;
ALTER TABLE public.harvest_log_archive
  DROP CONSTRAINT IF EXISTS harvest_log_archive_has_provenance;

-- Safe only because the DO block above proved there are no NULLs. Restores the exact pre-migration
-- column definition.
ALTER TABLE public.event_log_archive   ALTER COLUMN archived_plant_id SET NOT NULL;
ALTER TABLE public.harvest_log_archive ALTER COLUMN archived_plant_id SET NOT NULL;

-- archived_project_id and its indexes are intentionally NOT dropped. See the header.

DELETE FROM public.schema_version WHERE version = '4.23.2-softdelcascade-001-archive';

COMMIT;

-- ── RESTORE (not part of the rollback; run by hand when you want the events BACK) ──────────────
-- row_data is the complete original row as jsonb, so the shape is recovered rather than re-derived.
-- The container must exist again first (RESTRICT means it was never deleted unless you deleted it).
-- harvest_log must go back AFTER event_log — its FK into event_log is RESTRICT.
--
--   INSERT INTO public.event_log
--   SELECT (jsonb_populate_record(NULL::public.event_log, row_data)).*
--     FROM public.event_log_archive WHERE archived_project_id = '<container-uuid>';
--
--   INSERT INTO public.harvest_log
--   SELECT (jsonb_populate_record(NULL::public.harvest_log, row_data)).*
--     FROM public.harvest_log_archive WHERE archived_project_id = '<container-uuid>';
--
--   DELETE FROM public.harvest_log_archive WHERE archived_project_id = '<container-uuid>';
--   DELETE FROM public.event_log_archive   WHERE archived_project_id = '<container-uuid>';
--
-- Photos detached by archive_container_events() are NOT re-attached by this: they were re-parented
-- to the event's planting/location and are still live and visible. Re-pointing them at a restored
-- event is a manual decision.
