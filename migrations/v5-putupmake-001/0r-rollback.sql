-- 0r-rollback.sql — V5-PUTUPMAKE-001 (Put-Up release 1b) rollback. Reverses 0a-additive-ddl.sql, in
--   reverse order, back to the exact pre-1b schema (the same constraint, index, trigger, view and
--   routine definitions that prod and staging carried on 2026-09-29).
--
-- ⚠ VALID ONLY WHILE B'S CODE IS OFF DEV (05-release-train §4). Once the train is pushed, dev's
--   Lambdas name 1b's columns; the prod schema gate refuses every promote that names a column or
--   relation prod lacks, so running this on prod after the push would block EVERY thread's promote.
--   After the push the holding state is "leave 1b's DDL applied" — it is 1a-compatible (README.md) —
--   and a declined B is reverted on dev before any 0r on prod. After the first new-shape row, or the
--   0p backfill, whichever comes first: FORWARD-FIX ONLY, by hand.
--
-- THE REFUSAL GUARD (first statement after BEGIN). It refuses once B's shape is in use: V4's four
--   conditions — any put_up or void stage row, any keyed row, any non-NULL use_by_basis — and, because
--   "reverses 0a" must lose nothing and must be able to finish, every other value this file would
--   destroy or could not put back: any value in a column 0a added, a stage kind / input kind /
--   precision word / unit outside the pre-1b vocabularies, an Other batch with no name, a quantity pair
--   left NULL (SET NOT NULL), an undated stage row (SET NOT NULL). Each reason is named with its count.
--   A refusal changes nothing: it raises inside the transaction.
--
-- THE UNIT CHECK. chk_preservation_log_quantity_unit did not exist before 0a on prod or staging
--   (v5-preservunit-001 phase A was never applied there). This file puts back whichever state 0a found,
--   keyed on phase A's own stamp: with '5.0.0-preservunit-20260904' present it restores phase A's
--   22-value union verbatim; without it, it leaves the column with no unit CHECK, as it was.
--
-- THE VIEW is DROPPED and re-CREATED (CREATE OR REPLACE cannot remove a column), from the pre-1b
--   definition read on prod, and its grants are captured before the DROP and re-granted after — the
--   one thing a DROP loses that CREATE OR REPLACE kept. No GRANT is hard-coded: staging has no
--   garden_ro role, so a literal GRANT would 42704 there.
--
-- THE ARCHIVE ROUTINES go back to their pre-1b bodies verbatim (md5(prosrc) b98b7fa25681bd8929bba311ee490869
--   and 76a4c2e1969ac0c675a2a853578a406d — the fingerprints 0a's guard accepts as "pre-1b").
--
-- Both stamps go: 0a's, and the backfill's if it exists (the guard has already refused if the backfill
--   touched any row; on an empty table its stamp is all it left).
--
-- Rehearsed on local PG 17 against the prod schema: 0a -> 0r leaves the family's constraints,
--   indexes, triggers, columns, view and routines byte-identical to before 0a, and 0a re-applies
--   cleanly twice after it (README.md).

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. The refusal guard. ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_why    text[] := ARRAY[]::text[];
  v_check  record;
  v_n      bigint;
  v_unit22 boolean := EXISTS (SELECT 1 FROM public.schema_version
                               WHERE version = '5.0.0-preservunit-20260904');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-putupmake-001') THEN
    RAISE EXCEPTION 'v5-putupmake-001 0r refused: 0a (5.0.0-putupmake-001) is not applied here; nothing to roll back';
  END IF;

  FOR v_check IN
    SELECT * FROM (VALUES
      -- V4's four.
      ('put_up or void stage rows',
       $q$SELECT count(*) FROM public.kitchen_stage_log WHERE stage_kind IN ('put_up','void')$q$),
      ('keyed rows',
       $q$SELECT (SELECT count(*) FROM public.preservation_log   WHERE idempotency_key IS NOT NULL)
               + (SELECT count(*) FROM public.kitchen_batch      WHERE idempotency_key IS NOT NULL)
               + (SELECT count(*) FROM public.kitchen_stage_log  WHERE idempotency_key IS NOT NULL)
               + (SELECT count(*) FROM public.kitchen_batch_input WHERE idempotency_key IS NOT NULL)$q$),
      ('jars with a use_by_basis',
       $q$SELECT count(*) FROM public.preservation_log WHERE use_by_basis IS NOT NULL$q$),
      -- Everything else this file would destroy or could not restore.
      ('jars with a value in a 1b column',
       $q$SELECT count(*) FROM public.preservation_log
           WHERE label IS NOT NULL OR container_label IS NOT NULL OR storage_moved_at IS NOT NULL
              OR texture IS NOT NULL OR is_raw IS NOT NULL OR in_oil IS NOT NULL
              OR ph_reading IS NOT NULL OR ph_read_at IS NOT NULL OR put_up_stage_id IS NOT NULL
              OR preserved_at_precision IS NOT NULL$q$),
      ('jars with no size (quantity pair NULL)',
       $q$SELECT count(*) FROM public.preservation_log
           WHERE quantity_value IS NULL OR quantity_unit IS NULL$q$),
      ('stage rows of a 1b kind, precision or void link, or undated',
       $q$SELECT count(*) FROM public.kitchen_stage_log
           WHERE stage_kind NOT IN ('started','tended','moved','finished','failed')
              OR entered_precision IS NOT NULL OR voids_id IS NOT NULL OR entered_at IS NULL$q$),
      ('batch lines with a 1b kind, unit or column value',
       $q$SELECT count(*) FROM public.kitchen_batch_input
           WHERE input_kind NOT IN ('harvest','purchased','pantry','other')
              OR (qty_unit IS NOT NULL
                  AND qty_unit NOT IN ('g','kg','oz','lb','count','cup','tbsp','tsp','fl oz','qt',
                                       'gal','ml','l','other'))
              OR plant_id IS NOT NULL OR preservation_log_id IS NOT NULL
              OR crop_type_slug IS NOT NULL OR source_label IS NOT NULL OR role IS NOT NULL
              OR salt_pct IS NOT NULL OR salt_base IS NOT NULL OR base_g IS NOT NULL
              OR put_up_stage_id IS NOT NULL OR output_id IS NOT NULL OR ordinal IS NOT NULL
              OR deleted_at IS NOT NULL$q$),
      ('batches with a 1b precision word or an unnamed Other',
       $q$SELECT count(*) FROM public.kitchen_batch
           WHERE start_precision IN ('season','year')
              OR (kind = 'other' AND (kind_other IS NULL OR btrim(kind_other) = ''))$q$)
    ) AS c(reason, q)
  LOOP
    EXECUTE v_check.q INTO v_n;
    IF v_n > 0 THEN
      v_why := v_why || format('%s %s', v_n, v_check.reason);
    END IF;
  END LOOP;

  IF v_unit22 THEN
    SELECT count(*) INTO v_n FROM public.preservation_log
     WHERE quantity_unit NOT IN ('lb','oz','count','cup','pint','qt','bushel','half-bushel','peck',
                                 'flat','jar','bag','lbs','cups','pints','quarts','bushels',
                                 'half-bushels','pecks','flats','jars','bags');
    IF v_n > 0 THEN
      v_why := v_why || format('%s jars with a unit outside phase A''s 22-value union', v_n);
    END IF;
  END IF;

  IF cardinality(v_why) > 0 THEN
    RAISE EXCEPTION 'v5-putupmake-001 0r refused, B''s shape is in use: %. Forward-fix only (05-release-train §4).',
      array_to_string(v_why, '; ');
  END IF;
END $$;

-- ── 1. The archive routines, verbatim pre-1b. ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.archive_plant_events(p_plant_id uuid, p_reason text DEFAULT 'hard-delete of planting'::text) RETURNS TABLE(events_archived integer, harvests_archived integer, photos_detached integer)
    LANGUAGE plpgsql
    AS $$
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

  -- Guard 4 (V5-INFLIGHTBATCH-001) — kitchen-batch provenance. Mirrors Guard 3 term for term, and
  -- it is NOT optional: kitchen_batch_input.harvest_log_id is ON DELETE RESTRICT, so from the moment
  -- one input row exists the harvest_log DELETE below aborts with a bare 23503 naming nothing. That
  -- is precisely the failure Guard 2's comment says these guards exist to avoid. RESTRICT was chosen
  -- over the alternatives because that DELETE is a HARD delete into harvest_log_archive as jsonb:
  -- CASCADE would silently destroy a batch's provenance with no archive to recover it from, and SET
  -- NULL would leave an input row saying "something went in" that cannot say what — unlike
  -- preservation_log's single optional link, that column is half this row's identity.
  --
  -- deleted_at SCOPE STATED EXPLICITLY, per the count-discipline rule in
  -- v5-varietyhybridflag-001/gates.yml. A soft-deleted batch is not evidence anyone is protecting,
  -- so it does not block. (Guard 3 above has no such filter, so a soft-deleted put-up DOES block an
  -- archive — pre-existing, out of scope here, and deliberately not "fixed" in passing.)
  SELECT string_agg(DISTINCT b.id::text, ', ') INTO v_blocked
    FROM public.kitchen_batch_input kbi
    JOIN public.harvest_log h    ON h.id = kbi.harvest_log_id
    JOIN public.kitchen_batch b  ON b.id = kbi.batch_id
   WHERE h.event_id = ANY(v_ids)
     AND b.deleted_at IS NULL;
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'archive_plant_events: kitchen_batch row(s) record a batch fed by these harvests; '
                'archiving would strip their provenance',
      DETAIL  = format('kitchen_batch ids: %s', v_blocked),
      HINT    = 'Remove or re-point those batch inputs first (they are evidence, not derived data), '
                'then re-run. Batches are never deleted by this function.';
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
$$;

CREATE OR REPLACE FUNCTION public.archive_container_events(p_container_id uuid, p_reason text DEFAULT 'hard-delete of container'::text) RETURNS TABLE(events_archived integer, harvests_archived integer, photos_detached integer)
    LANGUAGE plpgsql
    AS $$
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
$$;

-- ── 2. v_kitchen_batch_current: DROP + CREATE, grants carried across. ────────────────────────────
CREATE TEMP TABLE putupmake_view_acl ON COMMIT DROP AS
  SELECT a.grantee, a.privilege_type, a.is_grantable
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE n.nspname = 'public' AND c.relname = 'v_kitchen_batch_current'
     AND a.grantee <> c.relowner;

DROP VIEW public.v_kitchen_batch_current;

CREATE VIEW public.v_kitchen_batch_current AS
 SELECT b.id,
    b.user_id,
    b.label,
    b.kind,
    b.kind_other,
    b.started_at,
    b.start_precision,
    b.start_anchor_kind,
    b.start_anchor_id,
    b.first_recorded_at,
    b.expected_days_min,
    b.expected_days_max,
    b.brine_note,
    b.suspended_at,
    b.closed_at,
    b.outcome,
    b.outcome_note,
    b.cover_photo_id,
    b.notes,
    b.created_at,
    b.updated_at,
    b.deleted_at,
    s.stage_kind AS current_stage_kind,
    s.label AS current_stage_label,
    s.entered_at AS current_stage_entered_at,
    s.storage_location_id AS current_storage_location_id,
    ( SELECT count(*) AS count
           FROM public.kitchen_batch_input i
          WHERE (i.batch_id = b.id)) AS input_count,
    ( SELECT count(*) AS count
           FROM public.preservation_log p
          WHERE ((p.batch_id = b.id) AND (p.deleted_at IS NULL))) AS output_count,
    ph.ph_reading AS last_ph_reading,
    ph.ph_read_at AS last_ph_read_at
   FROM ((public.kitchen_batch b
     LEFT JOIN LATERAL ( SELECT sl.stage_kind,
            sl.label,
            sl.entered_at,
            sl.storage_location_id
           FROM public.kitchen_stage_log sl
          WHERE (sl.batch_id = b.id)
          ORDER BY sl.entered_at DESC, sl.id DESC
         LIMIT 1) s ON (true))
     LEFT JOIN LATERAL ( SELECT pl.ph_reading,
            pl.ph_read_at
           FROM public.kitchen_stage_log pl
          WHERE ((pl.batch_id = b.id) AND (pl.ph_reading IS NOT NULL))
          ORDER BY pl.ph_read_at DESC, pl.id DESC
         LIMIT 1) ph ON (true))
  WHERE (b.deleted_at IS NULL);

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT grantee, privilege_type, is_grantable FROM putupmake_view_acl LOOP
    EXECUTE format('GRANT %s ON public.v_kitchen_batch_current TO %s%s',
                   r.privilege_type,
                   CASE WHEN r.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(r.grantee)) END,
                   CASE WHEN r.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END $$;

-- ── 3. storage_location ──────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS public.uq_storage_location_user_kind_label;

-- ── 4. preservation_log ──────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_audit_preservation_log_upd ON public.preservation_log;
DROP TRIGGER IF EXISTS prevent_preservation_log_ownership_transfer ON public.preservation_log;
DROP TRIGGER IF EXISTS set_updated_at ON public.preservation_log;
DROP INDEX IF EXISTS public.uq_preservation_log_idempotency_key;

ALTER TABLE public.preservation_log
  DROP CONSTRAINT IF EXISTS preservation_log_put_up_stage_id_batch_id_fkey,
  DROP CONSTRAINT IF EXISTS preservation_log_put_up_stage_id_fkey,
  DROP CONSTRAINT IF EXISTS preservation_log_batch_id_fkey,
  ADD CONSTRAINT preservation_log_batch_id_fkey
    FOREIGN KEY (batch_id) REFERENCES public.kitchen_batch (id) ON DELETE SET NULL,
  DROP CONSTRAINT IF EXISTS chk_preservation_log_remaining_within_package,
  DROP CONSTRAINT IF EXISTS chk_preservation_log_quantity_unit,
  DROP CONSTRAINT IF EXISTS chk_preservation_log_quantity_pairing,
  DROP CONSTRAINT IF EXISTS chk_preservation_log_preserved_at_precision,
  DROP CONSTRAINT IF EXISTS chk_preservation_log_put_up_stage_batch,
  DROP CONSTRAINT IF EXISTS chk_preservation_log_ph_scale,
  DROP CONSTRAINT IF EXISTS chk_preservation_log_ph_pairing,
  DROP CONSTRAINT IF EXISTS chk_preservation_log_texture_method,
  DROP CONSTRAINT IF EXISTS chk_preservation_log_texture,
  DROP CONSTRAINT IF EXISTS chk_preservation_log_use_by_basis_date,
  DROP CONSTRAINT IF EXISTS chk_preservation_log_use_by_basis,
  DROP CONSTRAINT IF EXISTS chk_preservation_log_label_len,
  DROP CONSTRAINT IF EXISTS chk_preservation_log_label_nonblank,
  DROP CONSTRAINT IF EXISTS chk_preservation_log_method_other,
  ADD CONSTRAINT chk_preservation_log_method_other
    CHECK (method <> 'other' OR (method_other_text IS NOT NULL AND btrim(method_other_text) <> '')),
  DROP CONSTRAINT IF EXISTS chk_preservation_log_attribution,
  ADD CONSTRAINT chk_preservation_log_attribution
    CHECK (crop_type_slug IS NOT NULL OR variety_id IS NOT NULL),
  ALTER COLUMN quantity_value SET NOT NULL,
  ALTER COLUMN quantity_unit  SET NOT NULL,
  DROP COLUMN IF EXISTS idempotency_key,
  DROP COLUMN IF EXISTS preserved_at_precision,
  DROP COLUMN IF EXISTS put_up_stage_id,
  DROP COLUMN IF EXISTS ph_read_at,
  DROP COLUMN IF EXISTS ph_reading,
  DROP COLUMN IF EXISTS in_oil,
  DROP COLUMN IF EXISTS is_raw,
  DROP COLUMN IF EXISTS texture,
  DROP COLUMN IF EXISTS storage_moved_at,
  DROP COLUMN IF EXISTS use_by_basis,
  DROP COLUMN IF EXISTS container_label,
  DROP COLUMN IF EXISTS label;

-- The unit CHECK back to what 0a found (see the header): phase A's union verbatim, or none.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-preservunit-20260904') THEN
    ALTER TABLE public.preservation_log
      ADD CONSTRAINT chk_preservation_log_quantity_unit
      CHECK (quantity_unit IN (
        'lb','oz','count',
        'cup','pint','qt',
        'bushel','half-bushel','peck','flat',
        'jar','bag',
        'lbs','cups','pints','quarts',
        'bushels','half-bushels','pecks','flats',
        'jars','bags'
      ));
  END IF;
END $$;

-- ── 5. kitchen_batch_input ───────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS public.uq_kbi_idempotency_key;

-- CASCADE comes back in the same statement that drops deleted_at (v4-cascadesweep-001).
ALTER TABLE public.kitchen_batch_input
  DROP CONSTRAINT IF EXISTS kitchen_batch_input_batch_id_put_up_stage_id_fkey,
  DROP CONSTRAINT IF EXISTS kitchen_batch_input_output_id_fkey,
  DROP CONSTRAINT IF EXISTS kitchen_batch_input_crop_type_slug_fkey,
  DROP CONSTRAINT IF EXISTS kitchen_batch_input_preservation_log_id_fkey,
  DROP CONSTRAINT IF EXISTS kitchen_batch_input_plant_id_fkey,
  DROP CONSTRAINT IF EXISTS chk_kbi_output_needs_put_up,
  DROP CONSTRAINT IF EXISTS chk_kbi_salt_base,
  DROP CONSTRAINT IF EXISTS chk_kbi_role,
  DROP CONSTRAINT IF EXISTS chk_kbi_put_up_pairing,
  DROP CONSTRAINT IF EXISTS chk_kbi_qty_unit,
  ADD CONSTRAINT chk_kbi_qty_unit
    CHECK (qty_unit IS NULL OR qty_unit IN ('g','kg','oz','lb','count','cup','tbsp','tsp','fl oz',
                                            'qt','gal','ml','l','other')),
  DROP CONSTRAINT IF EXISTS chk_kbi_kind,
  ADD CONSTRAINT chk_kbi_kind
    CHECK (input_kind IN ('harvest','purchased','pantry','other')),
  DROP CONSTRAINT IF EXISTS kitchen_batch_input_batch_id_fkey,
  ADD CONSTRAINT kitchen_batch_input_batch_id_fkey
    FOREIGN KEY (batch_id) REFERENCES public.kitchen_batch (id) ON DELETE CASCADE,
  DROP COLUMN IF EXISTS idempotency_key,
  DROP COLUMN IF EXISTS deleted_at,
  DROP COLUMN IF EXISTS ordinal,
  DROP COLUMN IF EXISTS output_id,
  DROP COLUMN IF EXISTS put_up_stage_id,
  DROP COLUMN IF EXISTS base_g,
  DROP COLUMN IF EXISTS salt_base,
  DROP COLUMN IF EXISTS salt_pct,
  DROP COLUMN IF EXISTS role,
  DROP COLUMN IF EXISTS source_label,
  DROP COLUMN IF EXISTS crop_type_slug,
  DROP COLUMN IF EXISTS preservation_log_id,
  DROP COLUMN IF EXISTS plant_id;

-- ── 6. kitchen_stage_log ─────────────────────────────────────────────────────────────────────────
-- uq_ksl_batch_id_id goes only after every composite FK that depended on it (sections 4 and 5, and
-- the self-FK first in this statement).
DROP INDEX IF EXISTS public.uq_ksl_idempotency_key;

ALTER TABLE public.kitchen_stage_log
  DROP CONSTRAINT IF EXISTS kitchen_stage_log_batch_id_voids_id_fkey,
  DROP CONSTRAINT IF EXISTS uq_ksl_voids_id,
  DROP CONSTRAINT IF EXISTS uq_ksl_batch_id_id,
  DROP CONSTRAINT IF EXISTS chk_ksl_amount_unit,
  DROP CONSTRAINT IF EXISTS chk_ksl_void_pairing,
  DROP CONSTRAINT IF EXISTS chk_ksl_entered_pairing,
  DROP CONSTRAINT IF EXISTS chk_ksl_entered_precision,
  DROP CONSTRAINT IF EXISTS chk_ksl_stage_kind,
  ADD CONSTRAINT chk_ksl_stage_kind
    CHECK (stage_kind IN ('started','tended','moved','finished','failed')),
  ALTER COLUMN entered_at SET DEFAULT now(),
  ALTER COLUMN entered_at SET NOT NULL,
  DROP COLUMN IF EXISTS idempotency_key,
  DROP COLUMN IF EXISTS voids_id,
  DROP COLUMN IF EXISTS entered_precision;

-- ── 7. kitchen_batch ─────────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS public.uq_kitchen_batch_idempotency_key;

ALTER TABLE public.kitchen_batch
  DROP CONSTRAINT IF EXISTS chk_kitchen_batch_kind_other,
  ADD CONSTRAINT chk_kitchen_batch_kind_other
    CHECK (kind IS DISTINCT FROM 'other' OR (kind_other IS NOT NULL AND btrim(kind_other) <> '')),
  DROP CONSTRAINT IF EXISTS chk_kitchen_batch_start_precision,
  ADD CONSTRAINT chk_kitchen_batch_start_precision
    CHECK (start_precision IS NULL
           OR start_precision IN ('exact','hour','day','week','month','unknown')),
  DROP COLUMN IF EXISTS idempotency_key;

-- ── 8. The stamps. ───────────────────────────────────────────────────────────────────────────────
DELETE FROM public.schema_version
 WHERE version IN ('5.0.0-putupmake-001', '5.0.0-putupmake-001-backfill');

COMMIT;
