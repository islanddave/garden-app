-- 0c-constraint.sql
-- V4-SOFTDELCASCADE-001 — close the CONTAINER delete axis that BUG-EVTANCHORDEL-001 left open. THE FIX.
--
-- ┌─ THE DEFECT ────────────────────────────────────────────────────────────────────────────────┐
-- │ BUG-EVTANCHORDEL-001 hardened the PLANTING delete axis: event_log.plant_id, photos.plant_id  │
-- │ and photos.location_id are ON DELETE RESTRICT in prod today (verified live). The CONTAINER   │
-- │ axis immediately beside it was left on CASCADE:                                             │
-- │                                                                                             │
-- │   event_log_project_id_fkey  event_log.project_id -> plant_projects(id)  ON DELETE CASCADE   │
-- │   photos_project_id_fkey     photos.project_id    -> plant_projects(id)  ON DELETE CASCADE   │
-- │   photos_event_id_fkey       photos.event_id      -> event_log(id)       ON DELETE CASCADE   │
-- │                                                                                             │
-- │ So `DELETE FROM plant_projects WHERE id = '<container>'` — one statement, no warning, no     │
-- │ error — deletes every event_log row anchored to that container, and that deletion CASCADES   │
-- │ AGAIN through photos_event_id_fkey into those events' photos. Two hops, both silent, both    │
-- │ irrecoverable. The planting axis refuses the same act with a clear 23503.                    │
-- └──────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- MEASURED BLAST RADIUS (live prod, read-only, FULL tables — no deleted_at filter):
--   * 12,447 event_log rows carry a project_id. That is 100.0% of event_log — not a subset, THE
--     TABLE. Per owner: 12,393 / 36 / 18 across the three subs. Any pooled figure is one user's.
--   * 976 photos carry a project_id; 742 carry an event_id; 1,094 photos exist in total.
--   * 76 containers have events. 27 are incidentally protected — a harvest_log row (project_id or
--     event_id, both already RESTRICT) or a cultivar_weight_sample (NO ACTION) happens to block the
--     delete. That protection is a SIDE EFFECT of unrelated tickets, not a policy.
--   * 49 containers are wholly unprotected: 2,432 events and 199 photos are one DELETE away from
--     silent destruction, with nothing in the database refusing.
--
-- NOT REACHABLE FROM THE APP, WHICH IS EXACTLY WHY IT SURVIVED. Every app DELETE route soft-deletes
-- (lambda/projects/index.js:637 sets deleted_at on the container view). It is reachable from admin
-- SQL, backfill scripts and test teardown — the same caller set that made EVTANCHORDEL real.
--
-- WHY RESTRICT AND NOT THE ALTERNATIVES
--   * Leave CASCADE and rely on the app — rejected, and not a fix: the app already soft-deletes
--     exclusively. Every reachable caller is outside it, so "the app is careful" protects nothing.
--   * SET NULL on event_log.project_id — rejected, and it is the WORSE bug, not a milder one.
--     project_id is an arm of the disjunctive CHECK event_log_has_anchor (plant_id IS NOT NULL OR
--     project_id IS NOT NULL), so this is the precise defect class EVTANCHORDEL was written to
--     eliminate: the cascade's own UPDATE nulls the last anchor and the CHECK then rejects the row
--     it just produced (23514). 79 prod rows have project_id with plant_id NULL and would hit it.
--   * Re-anchor project -> plant via a trigger — rejected, and this one is a trap worth naming
--     twice. plant_projects hold MULTIPLE SIBLING plantings, so project_id and plant_id are NOT
--     interchangeable scopes. Demoting a container-scoped observation onto one sibling planting
--     silently re-attributes it and corrupts exactly the per-planting harvest and maturity queries
--     the split exists to serve. It looks like preservation and is corruption.
--   * BEFORE DELETE trigger that archives automatically — rejected as the PRIMARY fix, for the
--     reason EVTANCHORDEL gave: it leaves the destructive action in place and merely arranges that
--     no rows are present for it to act on. The defect survives, defused by a side effect, and
--     returns the moment the predicate narrows. 0a ships the archive as an EXPLICIT operator call.
--
-- WHAT RESTRICT BUYS
--   The delete is REFUSED (23503, naming the blocking table) instead of silently performed. Nothing
--   can be lost by accident, and 0a's archive_container_events() is the supported way through. It
--   also makes the two axes agree: after this file, deleting a planting and deleting a container
--   fail the same way, for the same reason, with the same escape hatch.
--
-- ── DEPLOY BOUNDARY — the falsifiable test, answered ───────────────────────────────────────────
-- QUESTION: would the CURRENTLY DEPLOYED prod code perform an operation that this RESTRICT would
-- now reject? Asked of the deployed artifact, not of the branch in hand.
-- METHOD: downloaded the live deployed bundles (aws lambda get-function Code.Location) for
-- garden-projects, garden-events, garden-plants, garden-photos and garden-harvests and grepped
-- every one for `DELETE FROM`.
-- RESULT: the ONLY `DELETE FROM` of any kind in the deployed prod bundles are
-- `DELETE FROM favorites` (unrelated), a source COMMENT in garden-plants/index.js:378 that predicts
-- this very ticket, and an assertion STRING inside garden-events/undo-route.test.js which exists to
-- forbid the thing. Zero deployed writers hard-delete plant_projects, event_log, photos or
-- harvest_log.
-- ANSWER: NO, for all three flips. There is no writer coupling with the deployed artifact, so this
-- migration is NOT split into pre-deploy and post-deploy files. This file changes only the
-- referential action taken on a parent DELETE; it does not touch INSERT or UPDATE, so no deployed
-- writer's behaviour changes at all.
--
-- The old writers that DO break are non-app and CI-only. They must land BEFORE this file is applied
-- to the environment they run against — see gates.yml §DEPLOY BOUNDARY and README §Prod runbook:
--   1. .github/workflows/deploy-staging.yml smoke purge — deletes event_log (lines 560, 562) BEFORE
--      photos (line 569), and its photos sweep covers plant_id/location_id/project_id but NOT
--      event_id. Under flip 3 a smoke photo hanging off a smoke event refuses the event delete.
--      0-row no-op against staging today (verified live: 0 smoke photos with an event_id, 0 smoke
--      residue rows), so it is latent, not currently firing.
--   2. tests/integration/** teardowns — audited file by file against all three flips; none breaks
--      today. Three are green by property rather than by construction and are worth hardening.
--      See README §Required companion edits.
-- Applying this file to an environment whose purge has not been reordered reds the next staging
-- deploy. It cannot corrupt data — RESTRICT only ever refuses.
--
-- REVERSIBILITY: pure constraint-action swap. No row is read, written or moved. 0r restores the
-- previous actions byte-for-byte.

BEGIN;

-- Fail fast rather than queue behind a long transaction and stall live writes. Re-adding an FK takes
-- ACCESS EXCLUSIVE on the child and SHARE ROW EXCLUSIVE on the parent for the duration of the
-- validation scan (12,447 event_log rows / 1,094 photos at authoring time — milliseconds). Every
-- dangling-reference predicate the scan will run was verified to return 0 first; see gates.yml
-- `sweep`.
SET LOCAL lock_timeout = '5s';

-- ── 1. event_log.project_id — the whole event log ──────────────────────────────────────────────
ALTER TABLE public.event_log
  DROP CONSTRAINT IF EXISTS event_log_project_id_fkey,
  ADD  CONSTRAINT event_log_project_id_fkey
       FOREIGN KEY (project_id) REFERENCES public.plant_projects(id) ON DELETE RESTRICT;

-- ── 2. photos.project_id — the container's own photos ──────────────────────────────────────────
ALTER TABLE public.photos
  DROP CONSTRAINT IF EXISTS photos_project_id_fkey,
  ADD  CONSTRAINT photos_project_id_fkey
       FOREIGN KEY (project_id) REFERENCES public.plant_projects(id) ON DELETE RESTRICT;

-- ── 3. photos.event_id — the second cascade hop, and a contradiction in its own right ──────────
-- This one is not merely risky, it CONTRADICTS every other layer of the system. The single-event
-- undo, the batch undo and archive_plant_events() all deliberately DETACH and re-parent a photo
-- rather than delete it, each with a fail-loud guard against leaving it parentless. The FK quietly
-- does the opposite. 742 prod photos carry an event_id. A photo is irreplaceable user content, so
-- the schema is brought into line with the code rather than the other way round.
ALTER TABLE public.photos
  DROP CONSTRAINT IF EXISTS photos_event_id_fkey,
  ADD  CONSTRAINT photos_event_id_fkey
       FOREIGN KEY (event_id) REFERENCES public.event_log(id) ON DELETE RESTRICT;

-- NOT CHANGED, and deliberately so (each is a real observation, none is safe to fold in unreviewed):
--   * plants.project_id, tasks.project_id, plant_projects.parent_project_id (SET NULL) — a hard
--     container delete silently re-homes child plantings into the project-less ownership arm,
--     handing each to its own created_by. Called out at lambda/plants/index.js:378 as a separate FK
--     ticket and left there: it is an AUTHORIZATION defect, not a history-destruction one, and the
--     integration teardowns at plants.int.test.js:60 and cal1-indep.int.test.js:130 currently DEPEND
--     on that SET NULL. Flipping it without fixing them first reds CI.
--   * entity_memory.project_id, container_closure.ancestor_id/descendant_id,
--     inactive_project_dismissals.project_id (CASCADE) — derived caches and closure rows, rebuilt
--     from live data. Cascading them with the container is correct.
--   * harvest_log.project_id / harvest_log.event_id — already RESTRICT. They are the reason 27 of
--     the 76 containers were incidentally protected.
--   * cultivar_weight_sample.source_event_id (NO ACTION) — already refuses, and carries its own
--     immutability trigger. Correct as-is.
--   * user_achievements.trigger_event_id (SET NULL) — nulling a reward's provenance pointer costs
--     no user-visible data; rewards are never clawed back. Deliberate, matches V4-EVTCASCADE-001.

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.2-softdelcascade-001',
  'SOFTDELCASCADE fix: event_log.project_id, photos.project_id and photos.event_id ON DELETE '
  'CASCADE -> RESTRICT. A hard container delete silently destroyed 100% of the event log anchored '
  'to it and cascaded a second hop into those events'' photos; 49 containers / 2,432 events / 199 '
  'photos were unprotected. Completes the axis BUG-EVTANCHORDEL-001 opened on plants. Escape hatch: '
  'archive_container_events() from 0a. No row data touched.')
ON CONFLICT DO NOTHING;

COMMIT;
