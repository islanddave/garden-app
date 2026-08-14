-- V4-PLANTMERGE-001 — 0c routines.
--
-- archive_events_subset(uuid[], text): archive a CHOSEN SET of events, not a whole plant's worth.
--
-- The existing public.archive_plant_events(p_plant_id, ...) is PLANT-granular: it takes every event
-- on a planting, hard-deletes the harvest_log rows, and detaches photos. The merge needs the
-- opposite shape — an arbitrary subset (the batch-duplicate drop set) — and must NEVER destroy a
-- harvest or detach a photo, because the drop set is chores only.
--
-- Design choice, deliberate: where archive_plant_events HANDLES harvests/photos/calibration rows,
-- this routine REFUSES them. The merge's drop set provably contains none (harvest carries no
-- batch_id on any of 608 rows, so the dedup key cannot reach a harvest; photos and
-- cultivar_weight_sample were measured at 0 for the drop set). Encoding that as a guard rather than
-- as handling turns a silent assumption into a tripwire: if a future dedup-key change ever pulls a
-- harvest into the drop set, this raises instead of quietly eating it.
--
-- SOFT-delete only. event_log.deleted_at is set; the row is NOT removed. The archive copy exists so
-- a restore has the full pre-state even if the row is later hard-deleted by another path.

BEGIN;

CREATE OR REPLACE FUNCTION public.archive_events_subset(
  p_event_ids uuid[],
  p_reason    text DEFAULT 'planting merge — batch-duplicate collapse'::text,
  p_actor     text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
AS $function$
DECLARE
  v_blocked text;
  v_n       integer := 0;
BEGIN
  IF p_event_ids IS NULL OR cardinality(p_event_ids) = 0 THEN
    RETURN 0;
  END IF;

  -- Guard 1 — calibration evidence. Same authority boundary as archive_plant_events Guard 1:
  -- a weight sample is evidence, not derived data, and trg_cws_immutable protects it.
  SELECT string_agg(id::text, ', ') INTO v_blocked
    FROM public.cultivar_weight_sample WHERE source_event_id = ANY(p_event_ids);
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'archive_events_subset: event(s) in this set carry calibration weight samples',
      DETAIL  = format('cultivar_weight_sample ids: %s', v_blocked),
      HINT    = 'The merge drop set must be chores only. Resolve the samples, or fix the dedup key.';
  END IF;

  -- Guard 2 — harvests. The dedup key cannot reach a harvest (harvest rows carry no batch_id);
  -- if one is here, the key changed and the caller is about to lose yield data.
  SELECT string_agg(id::text, ', ') INTO v_blocked
    FROM public.harvest_log WHERE event_id = ANY(p_event_ids) AND deleted_at IS NULL;
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'archive_events_subset: event(s) in this set have harvest_log rows',
      DETAIL  = format('harvest_log ids: %s', v_blocked),
      HINT    = 'Harvests are never collapsed by a merge. The dedup key is wrong.';
  END IF;

  -- Guard 3 — photos. A dropped event that owns a photo would orphan it.
  SELECT string_agg(id::text, ', ') INTO v_blocked
    FROM public.photos WHERE event_id = ANY(p_event_ids) AND deleted_at IS NULL;
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'archive_events_subset: event(s) in this set have attached photos',
      DETAIL  = format('photos ids: %s', v_blocked),
      HINT    = 'Photo-bearing events are never part of a batch-duplicate drop set.';
  END IF;

  -- Guard 4 — already-deleted rows are not re-archived (keeps the routine idempotent under replay).
  INSERT INTO public.event_log_archive
    (id, plant_id, project_id, location_id, event_type, event_date, created_by,
     row_data, archived_reason, archived_by, archived_plant_id, archived_project_id)
  SELECT e.id, e.plant_id, e.project_id, e.location_id, e.event_type, e.event_date, e.created_by,
         to_jsonb(e), p_reason, COALESCE(p_actor, e.created_by), e.plant_id, e.project_id
    FROM public.event_log e
   WHERE e.id = ANY(p_event_ids)
     AND e.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.event_log_archive a WHERE a.id = e.id);

  UPDATE public.event_log
     SET deleted_at = now()
   WHERE id = ANY(p_event_ids)
     AND deleted_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  RETURN v_n;
END;
$function$;

COMMENT ON FUNCTION public.archive_events_subset(uuid[], text, text) IS
  'V4-PLANTMERGE-001: soft-delete + archive an arbitrary event subset (merge drop set). Refuses '
  'sets containing harvests, photos, or calibration samples — those can never be batch duplicates.';

COMMIT;
