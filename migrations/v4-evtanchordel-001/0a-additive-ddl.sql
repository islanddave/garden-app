-- 0a-additive-ddl.sql
-- V4-EVTANCHORDEL-001 — archive substrate for events stranded by a HARD plant delete.
--
-- ADDITIVE ONLY. Creates two new tables and one function. Touches no existing table, column,
-- constraint, view, index or trigger. Nothing calls the function automatically — it exists so that
-- 0c's ON DELETE RESTRICT has a supported escape hatch instead of leaving the operator to invent
-- one with a raw DELETE. Safe to apply on its own, at any time, ahead of 0c (see gates.yml
-- SEQUENCING — 0a MUST land before 0c, never after).
--
-- WHY AN ARCHIVE AND NOT A DELETE
-- event_log is the user's garden observation history: 12,027 live rows in prod at authoring time,
-- and it is the sole record that a watering/harvest/germination ever happened. A hard plant delete
-- is an admin act, but "admin act" is not a licence to vaporise logged observations — the operator
-- almost always wants the PLANTING gone, not the HISTORY. So the supported path moves the rows
-- somewhere durable and inert rather than dropping them.
--
-- ROW_DATA IS JSONB, DELIBERATELY, NOT `LIKE public.event_log`
-- A `LIKE`-shaped mirror table is column-order- and column-count-coupled to event_log forever: the
-- next `ALTER TABLE event_log ADD COLUMN` silently desynchronises it and the archive function starts
-- failing (or worse, silently truncating) months later, far from the change that caused it. event_log
-- has gained columns repeatedly (source, treatment_*, severity, flagged_as_issue...) and will again.
-- `to_jsonb(e)` captures the WHOLE row whatever its shape, so this table can never drift. The scalar
-- columns alongside it are a query/restore convenience, not the record of truth.
--
-- NO FOREIGN KEYS ON THE ARCHIVE, ON PURPOSE. The entire point is to hold rows whose parent no
-- longer exists. An FK here would re-create the exact coupling this migration is removing. Likewise
-- no anchor CHECK: an archived row is allowed to be anchorless, because it is no longer reachable
-- from the app and is not expected to satisfy a liveness invariant.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.event_log_archive (
  id               uuid PRIMARY KEY,
  plant_id         uuid,
  project_id       uuid,
  location_id      uuid,
  event_type       text,
  event_date       timestamptz,
  created_by       text,
  row_data         jsonb       NOT NULL,
  archived_at      timestamptz NOT NULL DEFAULT now(),
  archived_reason  text,
  archived_by      text        NOT NULL DEFAULT current_user,
  archived_plant_id uuid       NOT NULL
);

COMMENT ON TABLE public.event_log_archive IS
  'V4-EVTANCHORDEL-001. Inert cold store for event_log rows removed by archive_plant_events() ahead '
  'of a HARD plants delete. row_data holds the complete original row as jsonb (schema-drift proof); '
  'restore with jsonb_populate_record(null::public.event_log, row_data). No FKs and no anchor CHECK '
  'by design — archived rows are expected to be anchorless. Nothing in the app reads this table.';

CREATE INDEX IF NOT EXISTS idx_event_log_archive_plant ON public.event_log_archive (archived_plant_id);

CREATE TABLE IF NOT EXISTS public.harvest_log_archive (
  id               uuid PRIMARY KEY,
  event_id         uuid,
  row_data         jsonb       NOT NULL,
  archived_at      timestamptz NOT NULL DEFAULT now(),
  archived_reason  text,
  archived_by      text        NOT NULL DEFAULT current_user,
  archived_plant_id uuid       NOT NULL
);

COMMENT ON TABLE public.harvest_log_archive IS
  'V4-EVTANCHORDEL-001. Companion to event_log_archive. harvest_log.event_id is ON DELETE RESTRICT, '
  'so an archived harvest event cannot leave its detail row behind — the pair moves together or not '
  'at all.';

-- ── archive_plant_events(plant_id, reason) ─────────────────────────────────────────────────────
-- The ONLY supported way to clear event_log ahead of a hard `DELETE FROM plants`.
--
-- FAIL-LOUD BY DESIGN. Every child of event_log that this function cannot move without destroying
-- or orphaning something raises instead of guessing. That is the whole ethic of this ticket: the
-- original bug existed because the schema made a silent, lossy choice (SET NULL) on the operator's
-- behalf. Replacing it with a different silent choice would repeat the mistake. Where a human has to
-- decide, the function stops and says so, naming the rows.
--
-- CHILD-BY-CHILD (all four FKs into event_log are handled explicitly; see gates.yml):
--   * photos.event_id            ON DELETE CASCADE  -> DETACHED, never deleted. A raw DELETE of the
--     event would silently eat irreplaceable user photos. Mirrors V4-EVTCASCADE-001's policy exactly:
--     null the event pointer and re-parent by COALESCE so an existing parent always wins. Raises if
--     that would leave a photo parentless (photos_must_have_parent is VALIDATED and would reject it
--     anyway — this just fails with a message that names the photos).
--   * harvest_log.event_id       ON DELETE RESTRICT -> archived alongside, same transaction.
--   * cultivar_weight_sample.source_event_id  NO ACTION -> RAISES. These rows carry a BEFORE UPDATE
--     OR DELETE immutability trigger (trg_cws_immutable, V4-CAL1-PERVARIETY-001); they are calibration
--     evidence and this function has no authority to touch them. Operator resolves, then re-runs.
--   * user_achievements.trigger_event_id  ON DELETE SET NULL -> left to the FK. Nulling a reward's
--     provenance pointer is the schema's existing, deliberate choice and costs no user-visible data;
--     rewards are never clawed back (same policy as V4-EVTCASCADE-001).
--
-- The ownership-transfer trigger is NOT a factor: prevent_ownership_transfer is BEFORE UPDATE only
-- (verified live on event_log/photos/plants), this function never writes created_by, and its only
-- UPDATE is the photo detach — which touches event_id/project_id/location_id and nothing else. No
-- DISABLE TRIGGER dance is required, and none is performed.
--
-- Idempotent: a second call finds no event_log rows for the plant and returns (0,0,0).
CREATE OR REPLACE FUNCTION public.archive_plant_events(
  p_plant_id uuid,
  p_reason   text DEFAULT 'hard-delete of planting'
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
$fn$;

COMMENT ON FUNCTION public.archive_plant_events(uuid, text) IS
  'V4-EVTANCHORDEL-001. Moves every event_log row anchored to a planting (plus its harvest_log detail '
  'rows) into the *_archive cold store and detaches — never deletes — any photo hanging off those '
  'events, so the planting can then be HARD-deleted against ON DELETE RESTRICT. Raises rather than '
  'guessing when a cultivar_weight_sample or a would-be-parentless photo is in the way.';

INSERT INTO public.schema_version (version, description)
VALUES ('4.21.3-evtanchordel-001-archive',
  'EVTANCHORDEL archive substrate (additive): event_log_archive + harvest_log_archive cold-store '
  'tables (row_data jsonb, no FKs, no anchor CHECK) and archive_plant_events(uuid,text), the '
  'supported way to clear a planting''s event history before a hard delete. Nothing calls it '
  'automatically; no existing object is modified. MUST be applied before 0c-constraint.sql.')
ON CONFLICT DO NOTHING;

COMMIT;
