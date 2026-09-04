-- V5-INFLIGHTBATCH-001 — 0r: rollback.
--
-- ORDER MATTERS AND IS THE REVERSE OF APPLY. The VIEW goes first (a view projecting a column blocks
-- that column's drop — the same reason v5-varietyhybridflag-001 documents), then the guard is
-- restored to its pre-Guard-4 form, then preservation_log's CHECK, index and column, and only then
-- the tables. Guard 4 MUST be gone before kitchen_batch_input is, or the function would reference a
-- relation that no longer exists.
--
-- REHEARSED BEFORE THE REAL APPLY, per the house sequence: staging apply -> gates -> rehearse 0r ->
-- re-apply -> deploy-staging -> prod apply -> gates.
--
-- ⚠ DESTRUCTIVE. Dropping kitchen_batch destroys every batch, input link and stage row; there is no
-- archive table for these. Safe to run unrehearsed ONLY inside the apply window, before anything has
-- been written. If any real batch exists, dump the three tables first.
--
-- The function body below is the live prod definition as it stood BEFORE 0c, dumped via
-- pg_get_functiondef, with the trailing semicolon 0c's header explains.

BEGIN;

DROP VIEW IF EXISTS public.v_kitchen_batch_current;

-- Restore archive_plant_events WITHOUT Guard 4 (pre-0c definition, verbatim).
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
  --
  -- OPS-ARCHRESTORE-001: the UPDATE is UNCHANGED term for term. It is now one CTE of a single
  -- statement that ALSO records each photo's pre-detach parent set into photo_detach_archive,
  -- because photos.event_id is otherwise destroyed with no record anywhere and an un-archive
  -- cannot give back what it cannot see.
  --
  -- WHY A PRE-IMAGE CTE AND NOT `RETURNING`: RETURNING yields the NEW row, and this UPDATE's
  -- COALESCE-forward is not invertible from the new state — a project_id the photo GAINED from its
  -- event is indistinguishable from one it already carried. `pre` and `detached` are CTEs of one
  -- statement and therefore share one snapshot, so `pre` reads the values as they stood before the
  -- UPDATE. The INNER JOIN makes the captured set provably identical to the detached set (and
  -- forces `detached` to be referenced, though a data-modifying CTE executes regardless).
  WITH pre AS (
    SELECT ph.id AS photo_id, ph.event_id, ph.project_id, ph.location_id, ph.plant_id
      FROM public.photos ph
     WHERE ph.event_id = ANY(v_ids)
  ), detached AS (
    UPDATE public.photos ph
       SET event_id    = NULL,
           project_id  = COALESCE(ph.project_id,  e.project_id),
           location_id = COALESCE(ph.location_id, e.location_id),
           updated_at  = now()
      FROM public.event_log e
     WHERE e.id = ph.event_id
       AND ph.event_id = ANY(v_ids)
    RETURNING ph.id AS photo_id
  )
  INSERT INTO public.photo_detach_archive
        (photo_id, pre_image, archived_reason, archived_plant_id)
  SELECT d.photo_id,
         jsonb_build_object('event_id',    p.event_id,
                            'project_id',  p.project_id,
                            'location_id', p.location_id,
                            'plant_id',    p.plant_id),
         p_reason, p_plant_id
    FROM detached d
    JOIN pre p ON p.photo_id = d.photo_id;
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

ALTER TABLE public.preservation_log
  DROP CONSTRAINT IF EXISTS chk_preservation_log_one_provenance;
DROP INDEX IF EXISTS public.idx_preservation_log_batch;
ALTER TABLE public.preservation_log
  DROP COLUMN IF EXISTS batch_id;

-- Children first is not strictly required (CASCADE from the parent would do it), but it is stated so
-- the rollback reads as the exact inverse of 0a rather than relying on cascade behaviour.
DROP TABLE IF EXISTS public.kitchen_stage_log;
DROP TABLE IF EXISTS public.kitchen_batch_input;
DROP TABLE IF EXISTS public.kitchen_batch;

DELETE FROM public.schema_version WHERE version = '4.110.0-inflightbatch-001';

COMMIT;

-- Verify:
--   SELECT count(*) FROM information_schema.tables
--    WHERE table_schema='public' AND table_name LIKE 'kitchen%';                 -- expect 0
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='preservation_log'
--      AND column_name='batch_id';                                               -- expect 0
--   SELECT pg_get_functiondef(oid) LIKE '%kitchen_batch%'
--     FROM pg_proc WHERE proname='archive_plant_events';                         -- expect f
