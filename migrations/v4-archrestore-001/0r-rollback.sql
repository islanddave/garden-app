-- 0r-rollback.sql
-- OPS-ARCHRESTORE-001 — reverses 0c then 0a, in that order. Restores both archive routines to their
-- pre-migration bodies BYTE-FOR-BYTE: the two definitions below are the LIVE definitions captured
-- from pg_get_functiondef on 2026-08-13 and diffed against
-- migrations/v4-archpreservguard-001/0c-guard.sql (identical, 0 differing lines).
--
-- WHAT ROLLING BACK RE-ARMS — state it plainly, because it is the whole point of the ticket:
--   * archive_plant_events() / archive_container_events() go back to DESTROYING the photo->event
--     link with no record anywhere. photos.event_id is set to NULL (and, in the container routine,
--     project_id cleared and plant_id / location_id COALESCEd forward) and the previous value is
--     written into no table and no column. It is not in row_data — that is to_jsonb() over the
--     EVENT row.
--   * There is then no inverse at all: event_log_archive.row_data keeps its full snapshot and
--     nothing reconstitutes it.
--
-- DATA LOSS ON ROLLBACK, quantified rather than waved at:
--   * DROP TABLE photo_detach_archive discards every captured link. If any archive_* call has run
--     since 0c was applied, its captured links are UNRECOVERABLE by any means — the live photo rows
--     no longer carry the values either. CHECK photo_detach_archive IS EMPTY BEFORE RUNNING THIS,
--     or capture its contents first. The guard below refuses if it is not empty.
--   * DROP COLUMN schema_fingerprint discards provenance only; row_data is untouched, so an
--     un-archive rebuilt later loses drift DETECTION, not data.
--
-- SAFE OTHERWISE. Replacing a function touches no row; dropping an empty table and two nullable
-- columns touches no row data. No constraint, FK or trigger is altered in either direction.
--
-- REHEARSAL CONTRACT: run on STAGING before 0c is applied anywhere — apply 0a + 0c, run the
-- integration suite, run this, confirm neither archive body mentions photo_detach_archive and both
-- match v4-archpreservguard-001's definitions, then re-apply 0a + 0c.
--
-- The schema_version rows are left in place on purpose: they are an applied-history log, not a
-- state flag. gates.yml keys on prosrc, information_schema and pg_proc, so a rolled-back database
-- reports honestly.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Refuse to discard captured links silently ───────────────────────────────────────────────
DO $$
DECLARE v_n bigint;
BEGIN
  IF to_regclass('public.photo_detach_archive') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.photo_detach_archive' INTO v_n;
    IF v_n > 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'raise_exception',
        MESSAGE = format('archrestore 0r: photo_detach_archive holds %s captured photo link(s); '
                         'dropping it destroys them irrecoverably', v_n),
        DETAIL  = 'The live photos rows no longer carry these values — this table is the only copy.',
        HINT    = 'Export the rows first (\copy public.photo_detach_archive TO ...), then TRUNCATE '
                  'it and re-run this rollback. Refusing rather than silently discarding.';
    END IF;
  END IF;
END $$;

-- ── 1. Reverse 0c HALF 2 — drop the inverse ────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.unarchive_plant_events(uuid);
DROP FUNCTION IF EXISTS public.unarchive_container_events(uuid);
DROP FUNCTION IF EXISTS public.unarchive_events_apply(text, uuid[], uuid[], uuid[]);

-- ── 2. Reverse 0c HALF 1 — the pre-migration archive bodies, verbatim ──────────────────────────
CREATE OR REPLACE FUNCTION public.archive_plant_events(p_plant_id uuid, p_reason text DEFAULT 'hard-delete of planting'::text)
 RETURNS TABLE(events_archived integer, harvests_archived integer, photos_detached integer)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_ids     uuid[];
  v_blocked text;
  v_events  integer := 0;
  v_harv    integer := 0;
  v_photos  integer := 0;
BEGIN
  IF p_plant_id IS NULL THEN
    RAISE EXCEPTION 'archive_plant_events: p_plant_id must not be NULL';
  END IF;

  SELECT array_agg(id) INTO v_ids FROM public.event_log WHERE plant_id = p_plant_id;

  IF v_ids IS NULL THEN
    RETURN QUERY SELECT 0, 0, 0;
    RETURN;
  END IF;

  -- Guard 1 — calibration evidence is immutable and out of this function's authority.
  SELECT string_agg(id::text, ', ') INTO v_blocked
    FROM public.cultivar_weight_sample WHERE source_event_id = ANY(v_ids);
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = format('archive_plant_events: %s cultivar_weight_sample row(s) reference these events '
                       'and are immutable (trg_cws_immutable)', array_length(v_ids,1)),
      DETAIL  = format('cultivar_weight_sample ids: %s', v_blocked),
      HINT    = 'Resolve the calibration samples first (they are evidence, not derived data), then re-run.';
  END IF;

  -- Guard 2 — a photo that would be left with no parent at all. Checked BEFORE the detach so the
  -- transaction aborts with a message naming the photos rather than with a bare 23514.
  SELECT string_agg(ph.id::text, ', ') INTO v_blocked
    FROM public.photos ph
    JOIN public.event_log e ON e.id = ph.event_id
   WHERE ph.event_id = ANY(v_ids)
     AND COALESCE(ph.project_id, e.project_id) IS NULL
     AND COALESCE(ph.location_id, e.location_id) IS NULL
     AND ph.plant_id IS NULL
     AND ph.inventory_item_id IS NULL
     AND ph.space_id IS NULL
     AND COALESCE(ph.intake_status = 'pending_tag', false) = false;
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'archive_plant_events: detaching these events would leave photo(s) with no parent',
      DETAIL  = format('photos ids: %s', v_blocked),
      HINT    = 'Give each photo a parent (project, location, planting, space or inventory item) first. '
                'Photos are never deleted by this function.';
  END IF;

  -- Guard 3 (BUG-ARCHPRESERVGUARD-001) — preservation provenance. The harvest_log delete below is
  -- deliberate, but preservation_log.harvest_log_id used to be SET NULL, so it silently stripped
  -- every put-up record made from these harvests: the jar stayed, its source vanished. Same class
  -- as Guard 1 — a preservation record is user-authored evidence, not data derived from the
  -- harvest — so it gets the same treatment: refuse, name the rows, and let the operator decide.
  -- NOTE the FK itself stays SET NULL, deliberately (see section 3 of this file): this guard is
  -- the whole protection on the routine path, which is where the audit found the gap.
  SELECT string_agg(pl.id::text, ', ') INTO v_blocked
    FROM public.preservation_log pl
    JOIN public.harvest_log h ON h.id = pl.harvest_log_id
   WHERE h.event_id = ANY(v_ids);
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'archive_plant_events: preservation_log row(s) record put-ups made from these '
                'harvests; archiving would strip their provenance',
      DETAIL  = format('preservation_log ids: %s', v_blocked),
      HINT    = 'Clear or re-point preservation_log.harvest_log_id for those rows first (they are '
                'evidence, not derived data), then re-run. Preservation records are never deleted '
                'by this function.';
  END IF;

  -- DETACH photos. COALESCE, not assignment: an existing parent always wins.
  UPDATE public.photos ph
     SET event_id    = NULL,
         project_id  = COALESCE(ph.project_id,  e.project_id),
         location_id = COALESCE(ph.location_id, e.location_id),
         updated_at  = now()
    FROM public.event_log e
   WHERE e.id = ph.event_id
     AND ph.event_id = ANY(v_ids);
  GET DIAGNOSTICS v_photos = ROW_COUNT;

  -- harvest_log FIRST: its FK into event_log is RESTRICT, so it has to be gone before the events are.
  WITH moved AS (
    DELETE FROM public.harvest_log h WHERE h.event_id = ANY(v_ids) RETURNING h.*
  )
  INSERT INTO public.harvest_log_archive
        (id, event_id, row_data, archived_reason, archived_plant_id)
  SELECT m.id, m.event_id, to_jsonb(m), p_reason, p_plant_id FROM moved m;
  GET DIAGNOSTICS v_harv = ROW_COUNT;

  WITH moved AS (
    DELETE FROM public.event_log e WHERE e.id = ANY(v_ids) RETURNING e.*
  )
  INSERT INTO public.event_log_archive
        (id, plant_id, project_id, location_id, event_type, event_date, created_by,
         row_data, archived_reason, archived_plant_id)
  SELECT m.id, m.plant_id, m.project_id, m.location_id, m.event_type, m.event_date, m.created_by,
         to_jsonb(m), p_reason, p_plant_id FROM moved m;
  GET DIAGNOSTICS v_events = ROW_COUNT;

  RETURN QUERY SELECT v_events, v_harv, v_photos;
END
$function$;

CREATE OR REPLACE FUNCTION public.archive_container_events(p_container_id uuid, p_reason text DEFAULT 'hard-delete of container'::text)
 RETURNS TABLE(events_archived integer, harvests_archived integer, photos_detached integer)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_ids     uuid[];
  v_blocked text;
  v_events  integer := 0;
  v_harv    integer := 0;
  v_photos  integer := 0;
BEGIN
  IF p_container_id IS NULL THEN
    RAISE EXCEPTION 'archive_container_events: p_container_id must not be NULL';
  END IF;

  -- Empty array, never NULL: every predicate below uses `= ANY(v_ids)`, which is FALSE against an
  -- empty array but NULL against a NULL one. The photo pass must still run for an event-less
  -- container (see header).
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_ids
    FROM public.event_log WHERE project_id = p_container_id;

  -- Guard 1 — calibration evidence is immutable and out of this function's authority.
  SELECT string_agg(id::text, ', ') INTO v_blocked
    FROM public.cultivar_weight_sample WHERE source_event_id = ANY(v_ids);
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'archive_container_events: cultivar_weight_sample row(s) reference these events and '
                'are immutable (trg_cws_immutable)',
      DETAIL  = format('cultivar_weight_sample ids: %s', v_blocked),
      HINT    = 'Resolve the calibration samples first (they are evidence, not derived data), then re-run.';
  END IF;

  -- Guard 2 — a harvest_log row anchored to THIS container whose event belongs to a DIFFERENT one.
  -- Archiving it would strand harvest detail off an event that is staying. Zero such rows exist in
  -- prod (verified live: harvest_log.project_id is non-null and always equals its event's
  -- project_id), so this is a tripwire for future skew, not a live condition.
  SELECT string_agg(h.id::text, ', ') INTO v_blocked
    FROM public.harvest_log h
   WHERE h.project_id = p_container_id
     AND NOT (h.event_id = ANY(v_ids));
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'archive_container_events: harvest_log row(s) anchored to this container belong to '
                'events in a different container; archiving them would strand detail off a surviving event',
      DETAIL  = format('harvest_log ids: %s', v_blocked),
      HINT    = 'Re-anchor or resolve those harvest rows first, then re-run.';
  END IF;

  -- Guard 3 — photos that the detach below would leave with no parent at all. Checked BEFORE any
  -- write so the transaction aborts with a message naming the photos rather than with a bare 23514
  -- from photos_must_have_parent (which is VALIDATED and would reject it anyway). The expression
  -- mirrors the UPDATE that follows, term for term, and the CHECK's disjunction, term for term.
  WITH affected AS (
    SELECT ph.id,
           CASE WHEN ph.event_id   = ANY(v_ids)       THEN NULL ELSE ph.event_id   END AS new_event_id,
           CASE WHEN ph.project_id = p_container_id   THEN NULL ELSE ph.project_id END AS new_project_id,
           COALESCE(ph.plant_id,
                    (SELECT e.plant_id    FROM public.event_log e
                      WHERE e.id = ph.event_id AND ph.event_id = ANY(v_ids)))          AS new_plant_id,
           COALESCE(ph.location_id,
                    (SELECT e.location_id FROM public.event_log e
                      WHERE e.id = ph.event_id AND ph.event_id = ANY(v_ids)))          AS new_location_id,
           ph.inventory_item_id, ph.space_id, ph.intake_status
      FROM public.photos ph
     WHERE ph.event_id = ANY(v_ids) OR ph.project_id = p_container_id
  )
  SELECT string_agg(a.id::text, ', ') INTO v_blocked
    FROM affected a
   WHERE a.new_event_id IS NULL AND a.new_project_id IS NULL AND a.new_plant_id IS NULL
     AND a.new_location_id IS NULL AND a.inventory_item_id IS NULL AND a.space_id IS NULL
     AND COALESCE(a.intake_status = 'pending_tag', false) = false;
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'archive_container_events: detaching this container would leave photo(s) with no parent',
      DETAIL  = format('photos ids: %s', v_blocked),
      HINT    = 'Give each photo a parent (planting, location, space or inventory item) first. '
                'Photos are never deleted by this function.';
  END IF;

  -- Guard 4 (BUG-ARCHPRESERVGUARD-001) — preservation provenance. Mirrors the harvest_log DELETE
  -- predicate below TERM FOR TERM (event_id = ANY(v_ids) OR project_id = p_container_id); a
  -- narrower guard here would let exactly the rows the delete reaches slip through. Same rationale
  -- as archive_plant_events Guard 3.
  SELECT string_agg(pl.id::text, ', ') INTO v_blocked
    FROM public.preservation_log pl
    JOIN public.harvest_log h ON h.id = pl.harvest_log_id
   WHERE h.event_id = ANY(v_ids) OR h.project_id = p_container_id;
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'archive_container_events: preservation_log row(s) record put-ups made from these '
                'harvests; archiving would strip their provenance',
      DETAIL  = format('preservation_log ids: %s', v_blocked),
      HINT    = 'Clear or re-point preservation_log.harvest_log_id for those rows first (they are '
                'evidence, not derived data), then re-run. Preservation records are never deleted '
                'by this function.';
  END IF;

  -- DETACH photos. COALESCE, not assignment: an existing parent always wins. The dying container is
  -- never used as a re-parent source. Both axes (event_id and project_id) are cleared in one pass so
  -- a photo carrying both is handled once.
  UPDATE public.photos ph
     SET event_id    = CASE WHEN ph.event_id   = ANY(v_ids)     THEN NULL ELSE ph.event_id   END,
         project_id  = CASE WHEN ph.project_id = p_container_id THEN NULL ELSE ph.project_id END,
         plant_id    = COALESCE(ph.plant_id,
                                (SELECT e.plant_id    FROM public.event_log e
                                  WHERE e.id = ph.event_id AND ph.event_id = ANY(v_ids))),
         location_id = COALESCE(ph.location_id,
                                (SELECT e.location_id FROM public.event_log e
                                  WHERE e.id = ph.event_id AND ph.event_id = ANY(v_ids))),
         updated_at  = now()
   WHERE ph.event_id = ANY(v_ids) OR ph.project_id = p_container_id;
  GET DIAGNOSTICS v_photos = ROW_COUNT;

  -- harvest_log FIRST: both of its FKs (project_id, event_id) are RESTRICT, so it has to be gone
  -- before the events and before the container are.
  WITH moved AS (
    DELETE FROM public.harvest_log h
     WHERE h.event_id = ANY(v_ids) OR h.project_id = p_container_id
    RETURNING h.*
  )
  INSERT INTO public.harvest_log_archive
        (id, event_id, row_data, archived_reason, archived_project_id)
  SELECT m.id, m.event_id, to_jsonb(m), p_reason, p_container_id FROM moved m;
  GET DIAGNOSTICS v_harv = ROW_COUNT;

  WITH moved AS (
    DELETE FROM public.event_log e WHERE e.id = ANY(v_ids) RETURNING e.*
  )
  INSERT INTO public.event_log_archive
        (id, plant_id, project_id, location_id, event_type, event_date, created_by,
         row_data, archived_reason, archived_project_id)
  SELECT m.id, m.plant_id, m.project_id, m.location_id, m.event_type, m.event_date, m.created_by,
         to_jsonb(m), p_reason, p_container_id FROM moved m;
  GET DIAGNOSTICS v_events = ROW_COUNT;

  RETURN QUERY SELECT v_events, v_harv, v_photos;
END
$function$;

-- ── 3. Reverse 0a — the substrate ──────────────────────────────────────────────────────────────
-- Columns BEFORE the function: schema_fingerprint's DEFAULT depends on
-- current_schema_fingerprint(), so dropping the function first would need CASCADE, which is a
-- blunter instrument than this migration should reach for.
DROP TABLE IF EXISTS public.photo_detach_archive;

ALTER TABLE public.event_log_archive   DROP COLUMN IF EXISTS schema_fingerprint;
ALTER TABLE public.harvest_log_archive DROP COLUMN IF EXISTS schema_fingerprint;

DROP FUNCTION IF EXISTS public.archive_row_data_drift(text, jsonb);
DROP FUNCTION IF EXISTS public.current_schema_fingerprint();

COMMIT;
