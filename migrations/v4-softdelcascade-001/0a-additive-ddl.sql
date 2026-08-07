-- 0a-additive-ddl.sql
-- V4-SOFTDELCASCADE-001 — archive substrate for events/photos stranded by a HARD container delete.
--
-- ADDITIVE ONLY. This file extends the cold store V4-EVTANCHORDEL-001 already shipped
-- (event_log_archive / harvest_log_archive, live in prod, 0 rows at authoring time) and adds ONE
-- function. It deliberately does NOT invent a parallel archive: the plant axis and the container
-- axis are the same act — "remove a parent that history hangs off" — and splitting them into two
-- cold stores would mean two restore procedures, two rollback guards and two places to forget.
--
-- WHY THE EXISTING TABLES NEEDED A SMALL WIDENING
-- event_log_archive.archived_plant_id / harvest_log_archive.archived_plant_id are the PROVENANCE
-- key: "which parent's deletion caused this row to be archived". They are not the row's own
-- plant_id (that is already carried separately, and in row_data). A container archive has no
-- causing plant, so the provenance column has to be able to say "a container did this" instead.
-- Hence: archived_plant_id becomes nullable, archived_project_id is added, and a CHECK requires at
-- least ONE of them — which is strictly STRONGER than the old NOT NULL for the combined case, not
-- weaker. It cannot reject anything: both tables are empty in prod and staging (verified live), and
-- the pre-existing writer archive_plant_events() always supplies archived_plant_id, so arming this
-- CHECK cannot break the writer that is already deployed in the database. (This is the in-database
-- form of the "arming a constraint is a deploy" test; see gates.yml §DEPLOY BOUNDARY.)
--
-- ROW_DATA STAYS JSONB, for the reason EVTANCHORDEL gave: a LIKE-shaped mirror is column-coupled to
-- event_log forever and desynchronises on the next ADD COLUMN. to_jsonb(row) cannot drift.
--
-- STILL NO FOREIGN KEYS ON THE ARCHIVE, ON PURPOSE. The point is to hold rows whose parent no
-- longer exists. Also no anchor CHECK on the ARCHIVED row's own columns — an archived row is allowed
-- to be anchorless. The CHECK added below is about the archive's own provenance, not about the
-- archived row's anchors, and does not re-create the coupling this migration removes.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 1. Widen the EVTANCHORDEL cold store to carry container provenance ─────────────────────────
-- Idempotent: DROP NOT NULL on an already-nullable column and ADD COLUMN IF NOT EXISTS are both
-- no-ops on re-run.
ALTER TABLE public.event_log_archive
  ALTER COLUMN archived_plant_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS archived_project_id uuid;

ALTER TABLE public.harvest_log_archive
  ALTER COLUMN archived_plant_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS archived_project_id uuid;

ALTER TABLE public.event_log_archive
  DROP CONSTRAINT IF EXISTS event_log_archive_has_provenance,
  ADD  CONSTRAINT event_log_archive_has_provenance
       CHECK (archived_plant_id IS NOT NULL OR archived_project_id IS NOT NULL);

ALTER TABLE public.harvest_log_archive
  DROP CONSTRAINT IF EXISTS harvest_log_archive_has_provenance,
  ADD  CONSTRAINT harvest_log_archive_has_provenance
       CHECK (archived_plant_id IS NOT NULL OR archived_project_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_event_log_archive_project
  ON public.event_log_archive (archived_project_id);
CREATE INDEX IF NOT EXISTS idx_harvest_log_archive_project
  ON public.harvest_log_archive (archived_project_id);

COMMENT ON COLUMN public.event_log_archive.archived_project_id IS
  'V4-SOFTDELCASCADE-001. Provenance: the CONTAINER whose hard delete caused this archive, set by '
  'archive_container_events(). Mutually exclusive in practice with archived_plant_id (set by '
  'archive_plant_events()); the has_provenance CHECK requires at least one.';
COMMENT ON COLUMN public.harvest_log_archive.archived_project_id IS
  'V4-SOFTDELCASCADE-001. See event_log_archive.archived_project_id.';

-- ── 2. archive_container_events(container_id, reason) ──────────────────────────────────────────
-- The ONLY supported way to clear a container's history ahead of a hard
-- `DELETE FROM plant_projects`. Sibling of archive_plant_events(); same ethic, same guarantees.
--
-- FAIL-LOUD BY DESIGN. Every child this function cannot move without destroying or orphaning
-- something RAISEs instead of guessing. The bug being closed exists precisely because the schema
-- made a silent, lossy choice (CASCADE) on the operator's behalf; replacing it with a different
-- silent choice would repeat the mistake.
--
-- WHY IT CANNOT EARLY-RETURN THE WAY archive_plant_events() DOES
-- archive_plant_events() returns (0,0,0) as soon as the plant has no events, because plant_id was
-- its only RESTRICT axis. A container has TWO independent axes after 0c: event_log.project_id AND
-- photos.project_id. A container with zero events but one project-anchored photo still blocks the
-- delete, so this function must run the photo pass regardless of the event count.
--
-- CHILD-BY-CHILD (every FK into plant_projects and into the affected event_log rows):
--   * event_log.project_id       CASCADE -> RESTRICT (0c) -> ARCHIVED here. 100% of prod event_log
--     rows carry a project_id, so this axis is the whole history, not a corner of it.
--   * photos.project_id          CASCADE -> RESTRICT (0c) -> DETACHED, never deleted.
--   * photos.event_id            CASCADE -> RESTRICT (0c) -> DETACHED, never deleted. Re-parented by
--     COALESCE from the dying event's plant_id/location_id — deliberately NOT from its project_id,
--     because that project IS the container being deleted; re-anchoring a photo to a dying parent
--     would just move the failure one step later.
--   * harvest_log.project_id     RESTRICT (already) -> archived alongside, same transaction.
--   * harvest_log.event_id       RESTRICT (already) -> archived alongside, same transaction.
--   * cultivar_weight_sample.source_event_id  NO ACTION -> RAISES. Calibration evidence carrying the
--     trg_cws_immutable BEFORE UPDATE OR DELETE trigger (V4-CAL1-PERVARIETY-001). Not this
--     function's to touch. Operator resolves, then re-runs.
--   * user_achievements.trigger_event_id  SET NULL -> left to the FK. Nulling a reward's provenance
--     pointer costs no user-visible data and rewards are never clawed back. Same policy as
--     archive_plant_events() and V4-EVTCASCADE-001.
--   * entity_memory.project_id, container_closure.*, inactive_project_dismissals.project_id
--     CASCADE -> LEFT ALONE. All three are derived caches/closure rows rebuilt from live data, not
--     user history. Cascading them on a container delete is correct and is out of scope here.
--   * plants.project_id, tasks.project_id, plant_projects.parent_project_id  SET NULL -> LEFT ALONE.
--     Called out as a SEPARATE open ticket (see README §Not closed here): SET NULL on plants.project_id
--     silently re-homes child plantings into the project-less ownership arm. Real, but a different
--     defect class from this one and not safe to fold in unreviewed.
--
-- The ownership-transfer trigger is NOT a factor: prevent_ownership_transfer is BEFORE UPDATE only
-- on event_log/photos (verified live), this function never writes created_by, and its only UPDATE
-- touches event_id/project_id/plant_id/location_id/updated_at. No DISABLE TRIGGER dance is required
-- and none is performed. There are no DELETE triggers on event_log, photos or harvest_log.
--
-- Idempotent: a second call finds nothing left for the container and returns (0,0,0).
CREATE OR REPLACE FUNCTION public.archive_container_events(
  p_container_id uuid,
  p_reason       text DEFAULT 'hard-delete of container'
)
RETURNS TABLE (events_archived integer, harvests_archived integer, photos_detached integer)
LANGUAGE plpgsql
AS $fn$
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
$fn$;

COMMENT ON FUNCTION public.archive_container_events(uuid, text) IS
  'V4-SOFTDELCASCADE-001. Moves every event_log row anchored to a container (plus its harvest_log '
  'detail rows) into the *_archive cold store and detaches — never deletes — any photo hanging off '
  'that container or off those events, so the container can then be HARD-deleted against ON DELETE '
  'RESTRICT. Sibling of archive_plant_events(). Raises rather than guessing when a '
  'cultivar_weight_sample, a cross-container harvest row, or a would-be-parentless photo is in the way.';

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.2-softdelcascade-001-archive',
  'SOFTDELCASCADE archive substrate (additive): widens the EVTANCHORDEL cold store with '
  'archived_project_id + a has_provenance CHECK (archived_plant_id relaxed to nullable) and adds '
  'archive_container_events(uuid,text), the supported way to clear a container''s history before a '
  'hard delete. Nothing calls it automatically; no row data is touched. MUST be applied before '
  '0c-constraint.sql.')
ON CONFLICT DO NOTHING;

COMMIT;
