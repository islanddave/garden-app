-- 0c-routines.sql
-- OPS-ARCHRESTORE-001 — THE FIX, both halves. Requires 0a.
--
-- ┌─ HALF 1 — make ARCHIVING lossless (this is the finding behind the finding) ──────────────────┐
-- │ archive_plant_events() and archive_container_events() detach photos before deleting the       │
-- │ events. The severed photos.event_id — and, in the container routine, project_id / plant_id /  │
-- │ location_id — was written NOWHERE: not into row_data (to_jsonb() over the EVENT row, not the  │
-- │ photos) and not into the archive tables. An un-archive built alone would therefore have        │
-- │ shipped a "restore" that silently returns less than it took. Both archive tables hold 0 rows   │
-- │ in prod, so this is free NOW and expensive after the first operator invocation.                │
-- └──────────────────────────────────────────────────────────────────────────────────────────────┘
-- ┌─ HALF 2 — unarchive_plant_events() / unarchive_container_events() ───────────────────────────┐
-- │ Driven off archived_plant_id / archived_project_id, which is exactly why the *_has_provenance │
-- │ CHECK exists. Guards run BEFORE any write, in the archive routines' own house style           │
-- │ (RAISE ... USING ERRCODE/MESSAGE/DETAIL/HINT, naming the blocking rows).                       │
-- └──────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- ── WHAT CHANGED IN THE TWO ARCHIVE BODIES, EXHAUSTIVELY ──────────────────────────────────────
-- The bodies below are the LIVE definitions (pg_get_functiondef, diffed byte-for-byte against
-- migrations/v4-archpreservguard-001/0c-guard.sql on 2026-08-13 — identical) with EXACTLY ONE
-- edit each: the photo DETACH statement is wrapped in a single statement that also records the
-- pre-detach parent set. Everything else is verbatim. Specifically PRESERVED, unaltered:
--   * archive_plant_events Guard 1 (cultivar_weight_sample), Guard 2 (parentless photos),
--     Guard 3 (preservation_log) — all three, message/detail/hint text included;
--   * archive_container_events Guard 1 (cultivar_weight_sample), Guard 2 (cross-container
--     harvest_log), Guard 3 (parentless photos), Guard 4 (preservation_log) — all four;
--   * the NULL-argument checks, the v_ids computation (array_agg vs COALESCE-to-empty — the two
--     routines DIFFER here on purpose, see archive_container_events' own comment), the early
--     RETURN, the SET clauses of both detach UPDATEs term for term, both DELETE ... RETURNING ->
--     INSERT archive moves, the harvest-before-events ordering, both RETURN QUERY shapes.
--
-- ── THE ORDERING INVARIANTS THIS FILE COULD HAVE BROKEN, AND DOES NOT ─────────────────────────
--   * v4-softdelcascade-001 post_archive_functions_detach_photos_before_deleting_events —
--     positional, regexp_instr(prosrc,'event_id\s*=\s*(NULL|CASE)') <
--     regexp_instr(prosrc,'DELETE FROM public\.event_log'), both routines. The detach UPDATE keeps
--     its `event_id = NULL` / `event_id = CASE` SET clause and stays above the delete; the pre-image
--     CTE added above it contains no `event_id =` NULL/CASE form, so the FIRST match is still the
--     detach.
--   * v4-archpreservguard-001 post_preservation_guard_precedes_the_harvest_delete — positional,
--     position('preservation_log') < position('DELETE FROM public.harvest_log'). Both guards stay
--     where they are and the literal `DELETE FROM public.harvest_log` is untouched. NOTE that gate
--     uses position(), which returns 0 when not found; changing the delete's spelling would silently
--     zero it. It is not changed.
--   * v4-archpreservguard-001 pre_only_the_two_archive_routines_delete_harvest_log — matches
--     prosrc against 'delete\s+from\s+(public\.)?harvest_log\b'. The un-archive routines below
--     delete from harvest_log_ARCHIVE, which that pattern does not match (verified live: it does
--     not match `harvest_log_archive`, and — separately — `\b` is a character-entry escape in
--     PostgreSQL AREs, not a word boundary, so the pattern matches nothing at all today; reported
--     as a pre-existing vacuous gate, NOT fixed here, since v4-archpreservguard-001 is outside this
--     migration's boundary).
--
-- ── DEPLOY BOUNDARY — the falsifiable test, answered ──────────────────────────────────────────
-- QUESTION: would the CURRENTLY DEPLOYED prod code perform an operation this now rejects?
-- METHOD: inherited from v4-archpreservguard-001, whose bundle grep at prod 5c232164 (v4.14.0)
-- established that NOTHING deployed calls either archive routine — they are operator-invoked escape
-- hatches — and re-confirmed by repo grep at c509fff (v4.16.0): the only callers of
-- archive_plant_events / archive_container_events anywhere in the tree are integration tests.
-- RESULT: the archive routines gain a WRITE (the capture), not a rejection. The un-archive routines
-- are brand new and have no caller at all, deployed or otherwise.
-- ANSWER: NO. Safe to apply before or after a code deploy; no pre/post-deploy split.
--
-- ── SOFT-DELETE-ONLY, and why the archive-row DELETEs below are not a violation ───────────────
-- unarchive_* hard-deletes the archive rows it restores. That is a MOVE, not a delete: every row is
-- inserted into the live table in the SAME transaction before its archive row is removed, so no
-- user-meaningful data ceases to exist at any commit boundary. It is the exact inverse of the move
-- archive_* performs, which the rule already accommodates. Nothing here deletes a photo, a
-- preservation_log row, or a calibration sample.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ═══ HALF 1 — archive_plant_events: capture what the detach severs ════════════════════════════
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

-- ═══ HALF 1 — archive_container_events: same edit, both detach axes ═══════════════════════════
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
  --
  -- OPS-ARCHRESTORE-001: UPDATE unchanged term for term; wrapped so the pre-detach parent set is
  -- recorded. This routine is precisely why the capture is a TABLE and not a column on
  -- event_log_archive: the `ph.project_id = p_container_id` arm reaches photos with NO event in
  -- v_ids (12 such photos in live prod 2026-08-12), and an event-less container archives zero rows
  -- while still detaching — in both cases there is no archive row for a column to live on.
  WITH pre AS (
    SELECT ph.id AS photo_id, ph.event_id, ph.project_id, ph.location_id, ph.plant_id
      FROM public.photos ph
     WHERE ph.event_id = ANY(v_ids) OR ph.project_id = p_container_id
  ), detached AS (
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
     WHERE ph.event_id = ANY(v_ids) OR ph.project_id = p_container_id
    RETURNING ph.id AS photo_id
  )
  INSERT INTO public.photo_detach_archive
        (photo_id, pre_image, archived_reason, archived_project_id)
  SELECT d.photo_id,
         jsonb_build_object('event_id',    p.event_id,
                            'project_id',  p.project_id,
                            'location_id', p.location_id,
                            'plant_id',    p.plant_id),
         p_reason, p_container_id
    FROM detached d
    JOIN pre p ON p.photo_id = d.photo_id;
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

-- ═══ HALF 2 — the shared un-archive engine ════════════════════════════════════════════════════
-- Both public entry points resolve their provenance key into three id arrays and delegate here, so
-- the guard set and the reconstitution order exist in exactly ONE place. p_label is the caller's
-- name, used verbatim in every message so an operator sees which routine refused.
--
-- EVERY GUARD RUNS BEFORE THE FIRST WRITE. That is the same contract the archive routines make, and
-- for the same reason: a half-done restore is worse than a refused one.
--
-- NO `ON CONFLICT` ANYWHERE, deliberately. ON CONFLICT DO NOTHING on the reconstitution INSERT
-- would turn an id collision into a silent under-restore — the confident-zero failure mode this
-- project keeps hitting. A collision is a refusal.
CREATE OR REPLACE FUNCTION public.unarchive_events_apply(
  p_label       text,
  p_event_ids   uuid[],
  p_harvest_ids uuid[],
  p_photo_ids   uuid[])
 RETURNS TABLE(events_restored integer, harvests_restored integer, photos_relinked integer)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_blocked text;
  v_events  integer := 0;
  v_harv    integer := 0;
  v_photos  integer := 0;
BEGIN
  -- Guard 1 — row_data must be a usable snapshot. jsonb_populate_record() on a NULL or a non-object
  -- yields an all-default record with no error, which would insert a fabricated row.
  -- (row_data is NOT NULL on both archive tables, so the reachable case is a scalar/array jsonb.)
  SELECT string_agg(x.id::text || ':' || x.kind, ', ') INTO v_blocked FROM (
    SELECT a.id, COALESCE(jsonb_typeof(a.row_data), 'null') AS kind
      FROM public.event_log_archive a
     WHERE a.id = ANY(p_event_ids) AND COALESCE(jsonb_typeof(a.row_data), 'null') <> 'object'
    UNION ALL
    SELECT a.id, COALESCE(jsonb_typeof(a.row_data), 'null')
      FROM public.harvest_log_archive a
     WHERE a.id = ANY(p_harvest_ids) AND COALESCE(jsonb_typeof(a.row_data), 'null') <> 'object'
  ) x;
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = format('%s: archive row_data is not a JSON object; there is nothing to reconstitute', p_label),
      DETAIL  = format('archive id:jsonb_typeof — %s', v_blocked),
      HINT    = 'The snapshot is unusable. Repair row_data by hand or accept the loss explicitly; '
                'this routine will not insert a defaulted row in its place.';
  END IF;

  -- Guard 2 — SCHEMA DRIFT. jsonb_populate_record() is drift-TOLERANT: it defaults columns absent
  -- from the snapshot and ignores keys that are no longer columns, both silently. schema_fingerprint
  -- is the cheap trigger (matching fingerprint => the snapshot provably predates no migration, skip
  -- the comparison); archive_row_data_drift() is the actual test.
  SELECT string_agg(x.msg, '; ') INTO v_blocked FROM (
    SELECT a.id::text || ' event_log ' || d.drift AS msg
      FROM public.event_log_archive a
      CROSS JOIN LATERAL (SELECT public.archive_row_data_drift('event_log', a.row_data) AS drift) d
     WHERE a.id = ANY(p_event_ids)
       AND a.schema_fingerprint IS DISTINCT FROM public.current_schema_fingerprint()
       AND d.drift IS NOT NULL
    UNION ALL
    SELECT a.id::text || ' harvest_log ' || d.drift
      FROM public.harvest_log_archive a
      CROSS JOIN LATERAL (SELECT public.archive_row_data_drift('harvest_log', a.row_data) AS drift) d
     WHERE a.id = ANY(p_harvest_ids)
       AND a.schema_fingerprint IS DISTINCT FROM public.current_schema_fingerprint()
       AND d.drift IS NOT NULL
  ) x;
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = format('%s: the schema has changed since these rows were archived', p_label),
      DETAIL  = format('archive id / table / drift — %s', v_blocked),
      HINT    = 'A `missing=` column would be silently restored as its DEFAULT and an `unknown=` key '
                'silently dropped. Decide each column explicitly: patch row_data (and, once it '
                'matches, schema_fingerprint) on the archive rows, then re-run.';
  END IF;

  -- Guard 3 — id collision. A partial prior un-archive, or a reused id.
  SELECT string_agg(x.id::text || ':' || x.tbl, ', ') INTO v_blocked FROM (
    SELECT e.id, 'event_log' AS tbl FROM public.event_log e WHERE e.id = ANY(p_event_ids)
    UNION ALL
    SELECT h.id, 'harvest_log' FROM public.harvest_log h WHERE h.id = ANY(p_harvest_ids)
  ) x;
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = format('%s: row(s) with these ids already exist in the live table', p_label),
      DETAIL  = format('id:table — %s', v_blocked),
      HINT    = 'Refusing rather than skipping: swallowing the collision here would report a partial '
                'restore as a complete one. Resolve the collision, then re-run.';
  END IF;

  -- Guard 4 — RESTRICT-class FK targets must still resolve. Per column, the treatment MATCHES THE
  -- COLUMN'S OWN FK ACTION, so an un-archive can never leave the database in a state its own
  -- constraints would have refused:
  --   event_log.plant_id             -> plants          RESTRICT   => refuse
  --   event_log.project_id           -> plant_projects  RESTRICT   => refuse
  --   event_log.treatment_product_id -> inventory_items NO ACTION  => refuse (NO ACTION also blocks)
  --   harvest_log.project_id         -> plant_projects  RESTRICT   => refuse
  --   event_log.location_id          -> locations       SET NULL   => NULLED, not refused (below)
  -- DELIBERATELY UNFILTERED BY deleted_at: a foreign key does not know what a soft delete is, and a
  -- soft-deleted parent still satisfies it. Filtering here would refuse restores that the database
  -- would happily accept.
  SELECT string_agg(x.msg, ', ') INTO v_blocked FROM (
    SELECT a.id::text || '.plant_id=' || (a.row_data->>'plant_id') AS msg
      FROM public.event_log_archive a
     WHERE a.id = ANY(p_event_ids) AND (a.row_data->>'plant_id') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.plants t WHERE t.id = (a.row_data->>'plant_id')::uuid)
    UNION ALL
    SELECT a.id::text || '.project_id=' || (a.row_data->>'project_id')
      FROM public.event_log_archive a
     WHERE a.id = ANY(p_event_ids) AND (a.row_data->>'project_id') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.plant_projects t WHERE t.id = (a.row_data->>'project_id')::uuid)
    UNION ALL
    SELECT a.id::text || '.treatment_product_id=' || (a.row_data->>'treatment_product_id')
      FROM public.event_log_archive a
     WHERE a.id = ANY(p_event_ids) AND (a.row_data->>'treatment_product_id') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.inventory_items t
                        WHERE t.id = (a.row_data->>'treatment_product_id')::uuid)
    UNION ALL
    SELECT a.id::text || '.project_id=' || (a.row_data->>'project_id')
      FROM public.harvest_log_archive a
     WHERE a.id = ANY(p_harvest_ids) AND (a.row_data->>'project_id') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.plant_projects t WHERE t.id = (a.row_data->>'project_id')::uuid)
  ) x;
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = format('%s: a RESTRICT-class parent referenced by these snapshots no longer exists', p_label),
      DETAIL  = format('archive id.column=value — %s', v_blocked),
      HINT    = 'Restore the parent row first, then re-run. Only event_log.location_id is nulled on '
                'a dangling value, because its FK is the only SET NULL one.';
  END IF;

  -- Guard 5 — every archived harvest must land on an event that will exist after this call: either
  -- one being restored now, or one already live. harvest_log.event_id is NOT NULL and RESTRICT.
  SELECT string_agg(a.id::text || '.event_id=' || COALESCE(a.row_data->>'event_id','NULL'), ', ')
    INTO v_blocked
    FROM public.harvest_log_archive a
   WHERE a.id = ANY(p_harvest_ids)
     AND ( (a.row_data->>'event_id') IS NULL
        OR NOT ( (a.row_data->>'event_id')::uuid = ANY(p_event_ids)
                 OR EXISTS (SELECT 1 FROM public.event_log e
                             WHERE e.id = (a.row_data->>'event_id')::uuid) ) );
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = format('%s: archived harvest row(s) reference an event that is neither live nor in '
                       'this batch', p_label),
      DETAIL  = format('harvest_log_archive id.event_id — %s', v_blocked),
      HINT    = 'Restore the owning event first (un-archive its planting or container), then re-run.';
  END IF;

  -- Guard 6 — the captured photos must still exist, and must not have been re-parented onto a
  -- DIFFERENT owner since. A captured axis whose live value is NULL is restorable; one that already
  -- equals the captured value is already restored (idempotent); one that carries a different
  -- non-NULL value is a conflict only the operator can settle. Silently skipping it would be the
  -- same under-restore Guard 3 refuses.
  SELECT string_agg(x.msg, ', ') INTO v_blocked FROM (
    SELECT d.photo_id::text || ' (missing)' AS msg
      FROM public.photo_detach_archive d
     WHERE d.id = ANY(p_photo_ids)
       AND NOT EXISTS (SELECT 1 FROM public.photos ph WHERE ph.id = d.photo_id)
    UNION ALL
    SELECT d.photo_id::text || ' (conflict on ' || c.col || ')'
      FROM public.photo_detach_archive d
      JOIN public.photos ph ON ph.id = d.photo_id
      CROSS JOIN LATERAL (VALUES
        ('event_id',    ph.event_id,    NULLIF(d.pre_image->>'event_id','')::uuid),
        ('project_id',  ph.project_id,  NULLIF(d.pre_image->>'project_id','')::uuid),
        ('location_id', ph.location_id, NULLIF(d.pre_image->>'location_id','')::uuid),
        ('plant_id',    ph.plant_id,    NULLIF(d.pre_image->>'plant_id','')::uuid)
      ) AS c(col, live_val, captured_val)
     WHERE d.id = ANY(p_photo_ids)
       AND c.captured_val IS NOT NULL AND c.live_val IS NOT NULL
       AND c.live_val <> c.captured_val
  ) x;
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = format('%s: captured photo link(s) cannot be restored', p_label),
      DETAIL  = format('photos — %s', v_blocked),
      HINT    = 'A missing photo cannot be relinked; a conflicting one was re-parented after '
                'archiving and this routine will not overwrite that. Resolve the photo, or clear '
                'the matching photo_detach_archive row to accept the loss, then re-run.';
  END IF;

  -- Guard 7 — a RESTRICT parent named in a captured photo link must still resolve. photos.plant_id,
  -- .project_id, .location_id, .inventory_item_id and .space_id are ALL ON DELETE RESTRICT — unlike
  -- event_log.location_id — so nothing here is nulled; a dangling value refuses.
  SELECT string_agg(x.msg, ', ') INTO v_blocked FROM (
    SELECT d.photo_id::text || '.project_id=' || (d.pre_image->>'project_id') AS msg
      FROM public.photo_detach_archive d
     WHERE d.id = ANY(p_photo_ids) AND (d.pre_image->>'project_id') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.plant_projects t
                        WHERE t.id = (d.pre_image->>'project_id')::uuid)
    UNION ALL
    SELECT d.photo_id::text || '.plant_id=' || (d.pre_image->>'plant_id')
      FROM public.photo_detach_archive d
     WHERE d.id = ANY(p_photo_ids) AND (d.pre_image->>'plant_id') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.plants t WHERE t.id = (d.pre_image->>'plant_id')::uuid)
    UNION ALL
    SELECT d.photo_id::text || '.location_id=' || (d.pre_image->>'location_id')
      FROM public.photo_detach_archive d
     WHERE d.id = ANY(p_photo_ids) AND (d.pre_image->>'location_id') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.locations t
                        WHERE t.id = (d.pre_image->>'location_id')::uuid)
  ) x;
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = format('%s: a photo parent named in a captured link no longer exists', p_label),
      DETAIL  = format('photo id.column=value — %s', v_blocked),
      HINT    = 'photos'' parent FKs are all RESTRICT, so nothing is nulled here. Restore the parent '
                'row first, then re-run.';
  END IF;

  -- ── RECONSTITUTE, in the exact inverse of the archive order ─────────────────────────────────
  -- event_log BEFORE harvest_log: harvest_log.event_id -> event_log(id) is RESTRICT, so the event
  -- has to be back before its harvest detail can be. archive_* deletes them the other way round for
  -- the same reason.
  --
  -- jsonb_populate_record(NULL::public.event_log, row_data) is the right primitive precisely BECAUSE
  -- it tolerates drift in both directions — Guard 2 is what makes that tolerance safe rather than
  -- silent. `(record).*` expands in table column order, so this needs no column list and cannot
  -- skew if a column is added.
  --
  -- location_id is the ONE column nulled rather than refused, matching event_log_location_id_fkey's
  -- own ON DELETE SET NULL: if the location has since gone, SET NULL is exactly what the database
  -- would have done to a live row.
  --
  -- TRIGGERS, measured rather than assumed (pg_trigger.tgtype = 19 = ROW|BEFORE|UPDATE on both,
  -- re-confirmed live 2026-08-13): event_log carries prevent_ownership_transfer and set_updated_at,
  -- BOTH BEFORE UPDATE ONLY. Neither fires on INSERT, so the original created_by is restorable and
  -- updated_at survives verbatim from row_data. harvest_log carries no triggers at all.
  WITH src AS (
    SELECT CASE WHEN (a.row_data->>'location_id') IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM public.locations l
                                  WHERE l.id = (a.row_data->>'location_id')::uuid)
                THEN a.row_data || '{"location_id": null}'::jsonb
                ELSE a.row_data
           END AS row_data
      FROM public.event_log_archive a
     WHERE a.id = ANY(p_event_ids)
  )
  INSERT INTO public.event_log
  SELECT (jsonb_populate_record(NULL::public.event_log, s.row_data)).* FROM src s;
  GET DIAGNOSTICS v_events = ROW_COUNT;

  INSERT INTO public.harvest_log
  SELECT (jsonb_populate_record(NULL::public.harvest_log, a.row_data)).*
    FROM public.harvest_log_archive a
   WHERE a.id = ANY(p_harvest_ids);
  GET DIAGNOSTICS v_harv = ROW_COUNT;

  -- RELINK photos. This is LINK RESTORATION, not a byte-for-byte revert of the photo row: a
  -- captured value is written back only where the live column is still NULL, so an edit made after
  -- archiving is never clobbered (Guard 6 has already refused the conflicting case). A parent the
  -- detach COALESCEd FORWARD is deliberately left in place — it is additive and semantically true
  -- (the photo really does belong to its event's project), and reverting it would be the one way
  -- this routine could destroy information rather than restore it.
  WITH src AS (
    SELECT d.photo_id,
           NULLIF(d.pre_image->>'event_id','')::uuid    AS event_id,
           NULLIF(d.pre_image->>'project_id','')::uuid  AS project_id,
           NULLIF(d.pre_image->>'location_id','')::uuid AS location_id,
           NULLIF(d.pre_image->>'plant_id','')::uuid    AS plant_id
      FROM public.photo_detach_archive d
     WHERE d.id = ANY(p_photo_ids)
  )
  UPDATE public.photos ph
     SET event_id    = COALESCE(ph.event_id,    s.event_id),
         project_id  = COALESCE(ph.project_id,  s.project_id),
         location_id = COALESCE(ph.location_id, s.location_id),
         plant_id    = COALESCE(ph.plant_id,    s.plant_id),
         updated_at  = now()
    FROM src s
   WHERE ph.id = s.photo_id
     AND (   (ph.event_id    IS NULL AND s.event_id    IS NOT NULL)
          OR (ph.project_id  IS NULL AND s.project_id  IS NOT NULL)
          OR (ph.location_id IS NULL AND s.location_id IS NOT NULL)
          OR (ph.plant_id    IS NULL AND s.plant_id    IS NOT NULL));
  GET DIAGNOSTICS v_photos = ROW_COUNT;

  -- Drain the cold store IN THE SAME TRANSACTION. Every row above is already back in its live table
  -- at this point, so this is the second half of a move, not a delete.
  DELETE FROM public.event_log_archive    WHERE id = ANY(p_event_ids);
  DELETE FROM public.harvest_log_archive  WHERE id = ANY(p_harvest_ids);
  DELETE FROM public.photo_detach_archive WHERE id = ANY(p_photo_ids);

  RETURN QUERY SELECT v_events, v_harv, v_photos;
END
$function$;

-- ═══ HALF 2 — the two public entry points ═════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.unarchive_plant_events(p_plant_id uuid)
 RETURNS TABLE(events_restored integer, harvests_restored integer, photos_relinked integer)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_ev uuid[];
  v_hv uuid[];
  v_ph uuid[];
BEGIN
  IF p_plant_id IS NULL THEN
    RAISE EXCEPTION 'unarchive_plant_events: p_plant_id must not be NULL';
  END IF;

  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_ev
    FROM public.event_log_archive    WHERE archived_plant_id = p_plant_id;
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_hv
    FROM public.harvest_log_archive  WHERE archived_plant_id = p_plant_id;
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_ph
    FROM public.photo_detach_archive WHERE archived_plant_id = p_plant_id;

  IF cardinality(v_ev) = 0 AND cardinality(v_hv) = 0 AND cardinality(v_ph) = 0 THEN
    RETURN QUERY SELECT 0, 0, 0;
    RETURN;
  END IF;

  -- The referent must exist BEFORE anything is written. event_log.plant_id -> plants(id) is
  -- RESTRICT, so this is mandatory, not advisory: without it the INSERT fails mid-batch with a bare
  -- 23503 naming a constraint instead of naming what the operator has to do.
  -- Unfiltered by deleted_at on purpose — a soft-deleted planting still satisfies the FK, and
  -- restoring events onto one is a legitimate operator action.
  IF NOT EXISTS (SELECT 1 FROM public.plants p WHERE p.id = p_plant_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'unarchive_plant_events: the planting these rows were archived from no longer exists',
      DETAIL  = format('plants id: %s', p_plant_id),
      HINT    = 'Restore the planting row first (event_log.plant_id is ON DELETE RESTRICT), then re-run.';
  END IF;

  RETURN QUERY SELECT * FROM public.unarchive_events_apply('unarchive_plant_events', v_ev, v_hv, v_ph);
END
$function$;

CREATE OR REPLACE FUNCTION public.unarchive_container_events(p_container_id uuid)
 RETURNS TABLE(events_restored integer, harvests_restored integer, photos_relinked integer)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_ev uuid[];
  v_hv uuid[];
  v_ph uuid[];
BEGIN
  IF p_container_id IS NULL THEN
    RAISE EXCEPTION 'unarchive_container_events: p_container_id must not be NULL';
  END IF;

  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_ev
    FROM public.event_log_archive    WHERE archived_project_id = p_container_id;
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_hv
    FROM public.harvest_log_archive  WHERE archived_project_id = p_container_id;
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_ph
    FROM public.photo_detach_archive WHERE archived_project_id = p_container_id;

  IF cardinality(v_ev) = 0 AND cardinality(v_hv) = 0 AND cardinality(v_ph) = 0 THEN
    RETURN QUERY SELECT 0, 0, 0;
    RETURN;
  END IF;

  -- event_log.project_id -> plant_projects(id) is RESTRICT. Same reasoning as the plant variant.
  IF NOT EXISTS (SELECT 1 FROM public.plant_projects c WHERE c.id = p_container_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'unarchive_container_events: the container these rows were archived from no longer exists',
      DETAIL  = format('plant_projects id: %s', p_container_id),
      HINT    = 'Restore the container row first (event_log.project_id is ON DELETE RESTRICT), then re-run.';
  END IF;

  RETURN QUERY SELECT * FROM public.unarchive_events_apply('unarchive_container_events', v_ev, v_hv, v_ph);
END
$function$;

COMMENT ON FUNCTION public.unarchive_plant_events(uuid) IS
  'OPS-ARCHRESTORE-001: inverse of archive_plant_events(). Reconstitutes event_log then harvest_log '
  'from row_data and relinks the photos captured in photo_detach_archive, or refuses by name. '
  'Operator-invoked; no API surface.';
COMMENT ON FUNCTION public.unarchive_container_events(uuid) IS
  'OPS-ARCHRESTORE-001: inverse of archive_container_events(). See unarchive_plant_events().';
COMMENT ON FUNCTION public.unarchive_events_apply(text, uuid[], uuid[], uuid[]) IS
  'OPS-ARCHRESTORE-001: the shared guard set and reconstitution order behind both un-archive entry '
  'points. Not intended to be called directly — it trusts its id arrays to have been resolved from '
  'a single provenance key.';

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.12-archrestore-001',
  'ARCHRESTORE 0c: BOTH halves. (1) archive_plant_events and archive_container_events now RECORD '
  'each photo''s pre-detach parent set into photo_detach_archive, in the same statement as the '
  'detach UPDATE, which is otherwise unchanged term for term — the severed photos.event_id was '
  'previously written nowhere, so an un-archive would have returned less than archiving took. All '
  'seven existing guards (calibration, parentless photos, cross-container harvests, preservation) '
  'are preserved verbatim, and the detach still precedes the event delete in both. (2) New '
  'unarchive_plant_events / unarchive_container_events, driven off archived_plant_id / '
  'archived_project_id, delegating to unarchive_events_apply: seven guards before any write '
  '(row_data shape, schema drift vs schema_fingerprint, id collision, RESTRICT-class FK '
  'resolution, harvest->event anchoring, photo existence/conflict, photo parent resolution), then '
  'jsonb_populate_record into event_log BEFORE harvest_log (inverse of the archive order), photo '
  'relink, and the archive rows drained in the same transaction. No ON CONFLICT anywhere: a '
  'collision refuses rather than silently under-restoring. event_log.location_id is the only '
  'column nulled on a dangling parent, matching its own SET NULL FK.')
ON CONFLICT DO NOTHING;

COMMIT;
