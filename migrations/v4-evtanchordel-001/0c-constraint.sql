-- 0c-constraint.sql
-- V4-EVTANCHORDEL-001 — remove the SET-NULL/anchor-CHECK contradiction. THE FIX.
--
-- ┌─ THE DEFECT ────────────────────────────────────────────────────────────────────────────────┐
-- │ event_log carries CHECK event_log_has_anchor (plant_id IS NOT NULL OR project_id IS NOT      │
-- │ NULL), and event_log.plant_id is ON DELETE SET NULL. Those two cannot both be honoured. Hard-│
-- │ deleting a planting makes the FK's own cascade UPDATE write plant_id = NULL; if that row's   │
-- │ project_id is also NULL, the row the cascade just produced violates the table's own CHECK and│
-- │ the DELETE aborts with 23514 — an error that names a CHECK and says nothing about which      │
-- │ delete caused it. This is not a data problem to be cleaned up; it is a schema that declares  │
-- │ an action it is not allowed to take.                                                          │
-- └──────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- THE GENERAL RULE THIS ENCODES
--   An FK column that participates in a disjunctive "must have at least one parent" CHECK must never
--   be ON DELETE SET NULL. SET NULL asserts "this parent is optional"; the CHECK asserts "some parent
--   is mandatory". They are only compatible when a SIBLING anchor is guaranteed non-null — and a
--   disjunctive CHECK is precisely the statement that no such guarantee exists. The correct actions
--   for an anchor column are RESTRICT (refuse, force an explicit decision) or CASCADE (the child is
--   meaningless without this parent). Never SET NULL.
--
-- WHY RESTRICT AND NOT THE ALTERNATIVES
--   * CASCADE — rejected. It destroys history, and destroys MORE of it than the bug does: it would
--     delete events that carry a project anchor and could have survived untouched. event_log is the
--     only record that an observation ever happened.
--   * Relax/drop the anchor CHECK — rejected. It does not fix anything, it legalises the damage. An
--     anchorless event is unreachable: every read path in lambda/events/index.js resolves both
--     ownership and visibility through `JOIN public.container pp ON pp.id = e.project_id`, so a row
--     with neither anchor is invisible to the app AND has no authorization path. Nulling the last
--     anchor does not orphan a row, it silently deletes it from the user's point of view while
--     leaving it on disk. The CHECK is the thing correctly refusing to let that happen.
--   * Re-anchor plant -> project via a trigger — rejected, and this one is a trap worth naming.
--     plant_projects hold MULTIPLE SIBLING plantings, so plant_id and project_id are NOT
--     interchangeable scopes. Promoting a planting-scoped observation to project scope would
--     silently re-attribute it across every sibling planting in that container and corrupt exactly
--     the per-planting harvest and maturity queries the split exists to serve. It looks like data
--     preservation and is actually data corruption.
--   * BEFORE DELETE trigger that archives automatically — rejected as the PRIMARY fix. It leaves the
--     contradictory SET NULL in place and merely arranges that no rows are ever present for it to
--     act on: the defect survives, defused by a side effect, and returns the moment the trigger's
--     predicate is narrowed or a row arrives that it did not match. It also makes
--     `DELETE FROM plants` silently move user history, which is the same silent-lossy-choice
--     failure mode the original bug is made of. The archive is the right IDEA; 0a ships it as an
--     EXPLICIT operator call (archive_plant_events) rather than an implicit consequence of a DELETE.
--   * Soft-delete-only enforcement in the app — rejected, and not a fix at all: the app already
--     soft-deletes exclusively. The reachable callers are admin SQL, the staging smoke purge and
--     test teardowns, none of which go through the app.
--
-- WHAT RESTRICT BUYS
--   The delete is REFUSED (23503, naming event_log) instead of half-performed and then rolled back
--   by an unrelated-looking CHECK. Nothing can be lost by accident, the error points at the actual
--   obstacle, and 0a's archive_plant_events() is the supported way through. It also aligns
--   event_log.plant_id with the three FKs that ALREADY guard plants this way —
--   entity.planting_ref_id, entity_memory.plant_id and evidence.garden_node_id are all RESTRICT.
--   SET NULL was the outlier, not the norm.
--
-- ── SEQUENCING / DEPLOY BOUNDARY (load-bearing) ────────────────────────────────────────────────
-- This file changes ONLY the referential action for a parent DELETE. It does not touch INSERT or
-- UPDATE, so the currently-deployed Lambda writers are entirely unaffected — there is no
-- writer-first requirement of the "arming a CHECK breaks the old writer" kind, because no app path
-- hard-deletes plants or locations (every route soft-deletes: lambda/plants/index.js:500,
-- lambda/locations/index.js:172, lambda/projects/index.js:624).
--
-- It DOES break every non-app caller that hard-deletes a planting without clearing its events first.
-- Those are the "old writers" here, and they must be fixed BEFORE this file is applied:
--   1. tests/integration/** teardowns  — must delete event_log/photos by plant_id before plants.
--   2. .github/workflows/deploy-staging.yml smoke purge — deletes event_log by project_id only.
-- Order: writers first (already committed with this migration), constraint second. Applying 0c to an
-- environment whose purge/teardowns have not landed will red the next CI run, not corrupt data.
--
-- REVERSIBILITY: pure constraint-action swap. No row is read, written or moved. 0r restores the
-- previous actions byte-for-byte.

BEGIN;

-- Fail fast rather than queue behind a long transaction and stall live writes. Re-adding an FK takes
-- ACCESS EXCLUSIVE on the child and SHARE ROW EXCLUSIVE on the parent for the duration of the
-- validation scan (12,100 event_log rows / 993 photos at authoring time — milliseconds).
SET LOCAL lock_timeout = '5s';

-- ── 1. event_log.plant_id — the reported bug ───────────────────────────────────────────────────
ALTER TABLE public.event_log
  DROP CONSTRAINT IF EXISTS event_log_plant_id_fkey,
  ADD  CONSTRAINT event_log_plant_id_fkey
       FOREIGN KEY (plant_id) REFERENCES public.plants(id) ON DELETE RESTRICT;

-- ── 2. photos.plant_id / photos.location_id — the same defect, one table over ───────────────────
-- Found by sweeping pg_constraint for every (SET NULL FK column) x (CHECK referencing that column)
-- pair. photos_must_have_parent is a 7-way disjunctive anchor CHECK and is VALIDATED (stricter than
-- event_log_has_anchor, which is still NOT VALID), and both of these columns are SET NULL, so the
-- identical 23514 fires when the column is a photo's SOLE anchor. Unlike the event_log case this one
-- has LIVE exposure right now: 6 photos in prod are anchored only by plant_id and 1 only by
-- location_id. A photo is irreplaceable user content, so RESTRICT — refuse the parent delete — is if
-- anything more obviously correct here than it is for events.
ALTER TABLE public.photos
  DROP CONSTRAINT IF EXISTS photos_plant_id_fkey,
  ADD  CONSTRAINT photos_plant_id_fkey
       FOREIGN KEY (plant_id) REFERENCES public.plants(id) ON DELETE RESTRICT;

ALTER TABLE public.photos
  DROP CONSTRAINT IF EXISTS photos_location_id_fkey,
  ADD  CONSTRAINT photos_location_id_fkey
       FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE RESTRICT;

-- NOT CHANGED, and deliberately so:
--   * event_log.location_id (SET NULL) — location_id is not an arm of event_log_has_anchor, so
--     nulling it can never violate the CHECK. Out of the class.
--   * event_log.project_id (CASCADE) — no contradiction (the row goes away rather than being left
--     anchorless), so it is out of scope for THIS ticket. It is however the same family of
--     history-destroying action and is called out as follow-up work in README.md.
--   * preservation_log.plant_id (SET NULL) — the sweep flags it because
--     chk_preservation_log_source_plant references plant_id, but that CHECK is
--     (source_kind IS NULL OR source_kind='own_garden' OR plant_id IS NULL): nulling plant_id
--     SATISFIES it. Not a member of the class; a false positive worth recording so the next sweep
--     does not re-litigate it.
--   * critter_state.plant_id, plants.parent_plant_id, plants.succession_group_id (SET NULL) — no
--     anchor CHECK on those columns at all.

INSERT INTO public.schema_version (version, description)
VALUES ('4.21.3-evtanchordel-001',
  'EVTANCHORDEL fix: event_log.plant_id, photos.plant_id and photos.location_id ON DELETE '
  'SET NULL -> RESTRICT. An FK column inside a disjunctive anchor CHECK cannot be SET NULL — the '
  'cascade''s own UPDATE nulls the last anchor and the CHECK then rejects it (23514). RESTRICT '
  'refuses the parent delete instead, matching the three FKs that already guard plants that way. '
  'Escape hatch: archive_plant_events() from 0a. No row data touched.')
ON CONFLICT DO NOTHING;

COMMIT;
