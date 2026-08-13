-- 0c-guard.sql
-- BUG-ARCHPRESERVGUARD-001 — the archive routines guard calibration evidence and photos, but not
-- preservation provenance. Audit finding I7, with M3 resolved (see §M3). THE FIX.
--
-- ┌─ THE DEFECT ────────────────────────────────────────────────────────────────────────────────┐
-- │ archive_plant_events() and archive_container_events() both DELETE harvest_log rows (moving   │
-- │ them to harvest_log_archive) as a deliberate step. preservation_log.harvest_log_id is        │
-- │ ON DELETE SET NULL, so that delete SILENTLY strips the provenance from every put-up record   │
-- │ made from those harvests: the jar is still recorded, but what it was made from is gone.      │
-- │                                                                                             │
-- │ Both routines already carry guards for the other two evidence classes — cultivar_weight_     │
-- │ sample ("evidence, not derived data") and photos ("never deleted by this function") — each   │
-- │ raising a NAMED error BEFORE any write. Preservation records are the same kind of thing and  │
-- │ had no guard at all.                                                                        │
-- └──────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- A SECOND SET NULL ON THE SAME TABLE, WHICH THE AUDIT DID NOT NAME. preservation_log has TWO
-- SET NULL parents, not one:
--     preservation_log.harvest_log_id -> harvest_log  SET NULL   (audit I7)
--     preservation_log.plant_id       -> plants       SET NULL   (found here, 2026-08-13)
-- Both are filed as V4-PRESERVFKACTION-001 rather than changed here — see section 3 for why that
-- is a product decision and not a defect. Its sibling pointers are already safe: photo_id,
-- variety_id, crop_type_slug and storage_location_id are all NO ACTION and already refuse.
--
-- MEASURED, live prod 2026-08-13, owner DSN, unfiltered by deleted_at:
--   * preservation_log: 1 row. 0 carry a harvest_log_id; 1 carries a plant_id.
--   * So the routine-path defect is latent today: no put-up currently references a harvest, and
--     archive_* is operator-invoked and has never been run in prod (both archives hold 0 rows).
--     That is the cheapest possible moment to close it.
--   * harvest_log_archive preserves the ORIGINAL harvest id, so a preservation row's
--     harvest_log_id value stays meaningful after archiving — the only thing destroying it is the
--     FK's own SET NULL. Nothing needs re-pointing; the pointer just needs to stop being nulled.
--
-- ── §M3 — user_achievements.trigger_event_id: NO CHANGE, and that is the finding ───────────────
-- The audit folded M3 ("archive_* also nulls user_achievements.trigger_event_id") into this row.
-- Re-examined, it is NOT a defect and is deliberately left alone:
--   * It is the standing policy, set by V4-EVTCASCADE-001 and restated by V4-SOFTDELCASCADE-001:
--     "nulling a reward's provenance pointer costs no user-visible data; rewards are never clawed
--     back." V4-CASCADESWEEP-001's post_trigger_event_id_deliberately_still_set_null pins it, so
--     guarding it here would put two migrations in direct contradiction.
--   * It is also strictly LESS harmful than the FK case this file closes: archive_* preserves the
--     event in event_log_archive with its full row_data, so the provenance remains recoverable —
--     whereas a preservation record whose harvest is archived has no other record of its source.
--   * The badge itself is protected: V4-CASCADESWEEP-001 flipped
--     user_achievements.achievement_id to RESTRICT. The asymmetry — badge protected, provenance
--     pointer not — is intended and now asserted in two places.
-- Recorded here so the next sweep does not re-open it as an oversight.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────────────────────────
-- A NAMED GUARD in each routine, matching the house pattern exactly: checked BEFORE any write,
-- raising with MESSAGE/DETAIL/HINT that names the blocking rows. That is what an operator actually
-- sees, and it is precisely the gap the audit filed — I7 is about the ROUTINES' guard list, not
-- about the foreign key. The FK question is separate and deliberately not answered here (section 3).
--
-- ── WHY RAISE RATHER THAN PRESERVE ─────────────────────────────────────────────────────────────
--   * Re-point preservation_log at harvest_log_archive — rejected. The archive deliberately carries
--     NO foreign keys (V4-SOFTDELCASCADE-001: "an FK would make the cold store refuse the very rows
--     it exists to hold"), so this would mean an unenforced pointer into a table nothing validates.
--     A dangling-by-design reference is worse than a refusal.
--   * Let it null and log — rejected for the reason both existing guards give: the routine's
--     contract is that it archives history, not that it quietly damages neighbouring records.
--   * Cascade-delete the preservation rows — rejected outright. A put-up record is user-authored
--     content and Soft-Delete-Only applies; it is not derived from the harvest.
--
-- ── DEPLOY BOUNDARY — the falsifiable test, answered ───────────────────────────────────────────
-- QUESTION: would the CURRENTLY DEPLOYED prod code perform an operation this now rejects?
-- METHOD: all 27 deployed prod bundles grepped for `DELETE FROM` at prod
-- 5c232164616228dfce4f3e669ef8011a2cf7a456 (v4.14.0); plus a repo grep for callers of the two
-- routines.
-- RESULT: no deployed writer hard-deletes harvest_log or plants, and NOTHING in the deployed code
-- calls archive_plant_events() or archive_container_events() at all — they are operator-invoked
-- escape hatches, by design. The only in-database writer that deletes harvest_log IS these two
-- routines, which this file is editing.
-- ANSWER: NO. Safe to apply before or after a code deploy.
--
-- COMPANION EDITS: none required, verified rather than assumed. tests/integration/_cleanup.js
-- already sweeps preservation_log BEFORE harvest_log and plants, and both preservation suites
-- (preservation.int.test.js:77, preservation-authz.int.test.js:78/151) delete preservation_log
-- first. The staging smoke purge never touches preservation_log — and never creates one.
--
-- ── PRESERVED FROM THE EXISTING FUNCTIONS, DO NOT REGRESS ──────────────────────────────────────
-- Both bodies below are the LIVE definitions (pg_get_functiondef, 2026-08-13) with one guard block
-- inserted and nothing else altered. In particular the photo DETACH still happens BEFORE the event
-- delete in both — V4-SOFTDELCASCADE-001's gate
-- post_archive_functions_detach_photos_before_deleting_events asserts that ordering positionally
-- against prosrc, and it is mutation-tested. The new guard is inserted ABOVE the detach, so it
-- cannot move the two relative to each other.
--
-- REVERSIBILITY: 0r restores both function bodies byte-for-byte. No FK is touched in either
-- direction, so there is nothing else to reverse.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 1. archive_plant_events — new Guard 3 ──────────────────────────────────────────────────────
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

-- ── 2. archive_container_events — new Guard 4 ──────────────────────────────────────────────────
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

-- ── 3. THE FK IS DELIBERATELY NOT FLIPPED — and this is a reversal of my own first draft ───────
-- The first version of this migration also flipped preservation_log.harvest_log_id and .plant_id
-- from SET NULL to RESTRICT, as a backstop for callers a routine cannot see. That was over-reach,
-- and v4-putup-001's gates caught it: they assert SET NULL on both, deliberately.
--
-- Reading the original decision rather than assuming it was an oversight (0a-additive-ddl.sql:74-75):
--     plant_id       uuid REFERENCES plants(id)      ON DELETE SET NULL,  -- planting deleted -> keep put-up history
--     harvest_log_id uuid REFERENCES harvest_log(id) ON DELETE SET NULL,  -- OPTIONAL provenance (L8)
-- The intent is explicit and sound: a jar of pickles still exists after its planting record is
-- gone, so the put-up must SURVIVE the parent's deletion — and harvest_log_id is documented as an
-- OPTIONAL link, meaning NULL there is a legitimate state rather than corruption.
--
-- That is materially different from the share_log case V4-CASCADESWEEP-001 reversed. There, the
-- handler's own prose contradicted the schema, so one of the two had to be wrong. Here nothing
-- contradicts anything: a considered design chose SET NULL and said why. RESTRICT would preserve
-- strictly more (the provenance as well as the record), but at the cost of making a planting
-- undeletable for as long as any put-up made from it exists — which is a product decision about how
-- long a jar should pin a planting, not a defect.
--
-- So this migration closes exactly what the audit filed — I7 is "archive_* routines guard
-- calibration evidence and photos but NOT preservation_log" — and the FK question is filed
-- separately as V4-PRESERVFKACTION-001 with both arguments, for Dave.
--
-- The guards above are unaffected by that split: they fire inside the routines, which is where the
-- audit found the gap, and they raise a NAMED error rather than relying on a constraint code.

-- (No FK changes in this migration. See V4-PRESERVFKACTION-001.)

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.10-archpreservguard-001',
  'ARCHPRESERVGUARD: archive_plant_events and archive_container_events gain a named guard refusing '
  'to archive harvests that back a preservation_log put-up (their harvest_log DELETE used to strip '
  'the provenance silently via SET NULL). The FKs are deliberately NOT flipped — v4-putup-001 chose '
  'SET NULL with a stated reason (keep put-up history; harvest_log_id is an OPTIONAL link), so that '
  'is a product decision filed as V4-PRESERVFKACTION-001. M3 (user_achievements.trigger_event_id) NOT '
  'guarded — nulling a reward provenance pointer is standing policy and the event survives in '
  'event_log_archive. Both function bodies are the live definitions with one guard inserted; the '
  'photo DETACH still precedes the event DELETE in both. No row data touched.')
ON CONFLICT DO NOTHING;

COMMIT;
