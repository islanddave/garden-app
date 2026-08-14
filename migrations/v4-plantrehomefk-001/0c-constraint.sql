-- 0c-constraint.sql
-- BUG-PLANTREHOMEFK-001 — close the PLANTING-CONTAINMENT axis that V4-SOFTDELCASCADE-001 deferred.
-- Folds BUG-TASKDETACHFK-001 (tasks.project_id, 0 live rows) — rationale in §SCOPE below. THE FIX.
--
-- ┌─ THE DEFECT ────────────────────────────────────────────────────────────────────────────────┐
-- │ V4-SOFTDELCASCADE-001 hardened the HISTORY axis off plant_projects: event_log.project_id,    │
-- │ photos.project_id and photos.event_id are ON DELETE RESTRICT in prod today (verified live).  │
-- │ The CONTAINMENT axis immediately beside it was left on SET NULL:                            │
-- │                                                                                             │
-- │   plants_project_id_fkey  plants.project_id -> plant_projects(id)  ON DELETE SET NULL        │
-- │   tasks_project_id_fkey   tasks.project_id  -> plant_projects(id)  ON DELETE SET NULL        │
-- │                                                                                             │
-- │ So `DELETE FROM plant_projects WHERE id = '<container>'` — one statement, no warning, no     │
-- │ error — silently strips every child planting out of its container and drops it into the      │
-- │ project-less arm, where the read/write predicate keys on the planting's OWN created_by       │
-- │ instead of the container's. It is destructive (containment is lost for good; nothing         │
-- │ records what the row used to belong to) AND it moves the authorization boundary.             │
-- │ The history axis refuses the same act with a clear 23503.                                    │
-- └──────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- MEASURED BLAST RADIUS (live prod, 2026-08-13, owner DSN = RLS-exempt; see §RLS below).
-- DELIBERATELY UNFILTERED by deleted_at — a foreign key does not know what a soft delete is, so a
-- soft-deleted planting is every bit as re-homed as a live one. These are a MOVING population;
-- re-measure at apply time rather than citing these numbers as current.
--   * 310 plants rows; 305 carry a project_id (98.4%) — this axis is essentially the whole
--     planting table, not a corner of it. 5 rows are already project-less.
--   * 86 containers; 76 hold at least one planting. One `DELETE FROM plant_projects` with no
--     WHERE clause re-homes 305 plantings; the largest single container is one statement away
--     from silently detaching its whole contents.
--   * 24 plantings sit in a container owned by someone else — and today ALL 24 are the
--     rescue-intake-longriver-20260712 sentinel inside containers owned by Dave's sub. Per owner:
--     Dave 269 own-in-own, sentinel 24 in-Dave's, second sub 11 own-in-own, third sub 1 own-in-own.
--     There is currently NO user-to-user crossing. Any pooled figure here is one user's.
--   * tasks: 0 rows in the entire table (dormant feature — src/pages/Tasks.jsx exists, no Lambda
--     route serves it). The tasks flip is therefore a zero-row change today.
--   * Both FKs are convalidated = 't'.
--
-- ── WHAT THE RE-HOME ACTUALLY COSTS, stated precisely (the ticket's framing needed correcting) ──
-- The row this migration closes describes the defect as "ownership-widening". That is the right
-- name for the MECHANISM but it overstates today's EXPOSURE, and the difference matters for anyone
-- deciding how hard to hold this line:
--   * EXPOSURE, today: effectively nil. The project-less arm resolves through householdScope(),
--     which is membership-gated and fail-closed. Household members already read and write each
--     other's project-less plantings, so a re-homed Jen-planting is no more visible to Dave than
--     it was. And a genuinely foreign user can no longer manufacture the crossing case: POST
--     /api/plants gates body.project_id through loadOwnedProject() and returns 400 (index.js:999).
--   * AVAILABILITY, today: this is the real live harm. The 24 sentinel-owned rows have a created_by
--     that matches NO caller, so re-homing them makes them permanently unreachable through the API
--     — present in the table, invisible to every user, with nothing to point them back at a
--     container. Fail-closed is the right default and it is what makes these rows unrecoverable.
--   * CONTAINMENT, today: 305 plantings silently lose the grouping that every project-scoped
--     query, the watch band and the harvest roll-ups are built on. Unlike the event axis, nothing
--     is deleted — which is exactly why it would go unnoticed.
--   * EXPOSURE, tomorrow: the mechanism is still a live authorization defect. It is one dropped
--     ownership check on any future write path away from mattering, and the FK is the layer that
--     should not depend on that check being right.
--
-- ── THREE INHERITED CLAIMS, RE-TESTED AND FOUND FALSE ──────────────────────────────────────────
-- This ticket exists because a source comment claimed a ticket covered it and none did. In that
-- spirit every claim this migration inherited was re-tested rather than carried forward. Three did
-- not survive (L-367 / crucible-inverts-recon-claims: "a guard already covers this" is the class of
-- claim most likely to be wrong):
--   1. V4-SOFTDELCASCADE-001/0c-constraint.sql says: "the integration teardowns at
--      plants.int.test.js:60 and cal1-indep.int.test.js:130 currently DEPEND on that SET NULL.
--      Flipping it without fixing them first reds CI." FALSE, and it names the wrong two files.
--      Both already delete plants BEFORE plant_projects (plants.int.test.js:63 < :64;
--      cal1-indep.int.test.js:134 < :139). All 21 integration files that delete plant_projects were
--      swept: 15 are child-first, 5 create no plantings at all, and exactly ONE is parent-first —
--      preservation.int.test.js (plant_projects:80 before plants:83), which passes only because its
--      5 fixture plantings are inserted with no project_id. Green by property, not by construction;
--      hardened to child-first in the same commit as this file.
--   2. lambda/plants/index.js:451 says: "the POST path does not verify that body.project_id is a
--      container you own, so a foreign user can create such a row today." FALSE — :999-1002 gates
--      it through loadOwnedProject(householdIds) and returns 400. Corrected in the same commit.
--   3. lambda/plants/index.js:463 says: "Tracked as a separate FK ticket." False when written (the
--      audit verified no such row existed). Now true: BUG-PLANTREHOMEFK-001, closed by this file.
--
-- DOES ANY LIVE ROW MAKE RESTRICT FAIL? NO. Both FKs are already convalidated = 't', which is
-- Postgres's own proof that every child row resolves to a live parent; this file keeps the same
-- columns and the same parent table and changes only the referential action, so the validation scan
-- run by ADD CONSTRAINT is guaranteed to succeed. RESTRICT constrains only FUTURE parent deletes.
--
-- ── SCOPE — what is flipped, and the one that deliberately is NOT ──────────────────────────────
-- FLIPPED: plants.project_id (BUG-PLANTREHOMEFK-001) and tasks.project_id (BUG-TASKDETACHFK-001).
-- The tasks fold-in is not scope creep: same parent table, same referential action, same defect
-- class, 0 rows in the table and no Lambda route that writes it. A separate apply window for a
-- zero-row constraint flip buys nothing and costs a second prod migration.
--
-- NOT FLIPPED — plant_projects.parent_project_id (SET NULL, 76 live rows). Named alongside the
-- other two by SOFTDELCASCADE. It is excluded on a POLICY question, and it is worth being precise
-- about that, because the first draft of this file excluded it for a TECHNICAL reason that testing
-- destroyed:
--   THE CLAIM (mine, wrong): "it is self-referential, and RESTRICT is checked immediately, so a
--   same-statement delete of a parent and its child — what every teardown's
--   `DELETE FROM plant_projects WHERE created_by = $1` does — would be refused."
--   MEASURED on an ephemeral branch off staging, 2026-08-13, all three actions, seeds verified
--   present before each delete (the first run of this probe silently inserted nothing and returned
--   a confident zero — the numbers below are from the corrected run):
--     * same-statement parent+child delete .... SUCCEEDS under SET NULL, RESTRICT and NO ACTION
--     * same-statement 3-level chain .......... SUCCEEDS under all three
--     * parent alone, child surviving ......... SET NULL flattens silently; RESTRICT and NO ACTION
--                                               BOTH refuse with 23503
--   So RESTRICT and NO ACTION are behaviourally IDENTICAL for this column here, and neither breaks
--   a teardown. Confirmed end to end: the full integration suite was re-run with parent_project_id
--   flipped to RESTRICT — 32 of 33 files pass, and the only two failures are this migration's own
--   pins asserting the deviation. ZERO pre-existing tests break. The CI risk claimed above does not
--   exist.
--   WHY IT IS STILL EXCLUDED: the remaining question is a product decision, not a safety one.
--   Should deleting a parent container be REFUSED while it still has child containers, or should
--   its children correctly be promoted to top-level? Flattening a hierarchy is not self-evidently
--   a defect the way silently moving user content across an ownership boundary is — SET NULL may
--   well be the RIGHT behaviour here. 76 containers carry a parent. That is Dave's call, so it gets
--   its own row carrying this evidence rather than being folded in on the assumption that what is
--   right for the other two is right for it.
--
-- WHY RESTRICT AND NOT THE ALTERNATIVES
--   * Leave SET NULL and rely on the app — rejected, and not a fix: the app already soft-deletes
--     exclusively (lambda/projects/index.js has ZERO `DELETE FROM`; the delete route sets
--     deleted_at at :718). Every reachable caller is OUTSIDE the app, so "the app is careful"
--     protects nothing. This is the same reasoning EVTANCHORDEL and SOFTDELCASCADE both made.
--   * CASCADE — rejected, and it is catastrophically worse rather than stricter: it converts a
--     silent re-home of 305 plantings into their silent destruction, taking the plant-side history
--     that EVTANCHORDEL protects down with it via RESTRICT conflicts.
--   * NO ACTION — behaviourally IDENTICAL to RESTRICT here, and worth saying why rather than
--     leaving it to look arbitrary. The two differ only when parent and child rows are deleted in
--     the SAME statement; plants and tasks are different tables from plant_projects, so no single
--     statement can delete both. RESTRICT is chosen for consistency with the three FKs already
--     flipped on this parent. MEASURED 2026-08-13: the two are indistinguishable even on the
--     SELF-referential parent_project_id, where a same-statement parent+child delete succeeds
--     under both — so this bullet is a genuine tie, not a hedge. The deferral difference surfaces
--     only inside an explicit transaction using SET CONSTRAINTS, which nothing here does.
--   * BEFORE DELETE trigger that re-homes deliberately, or auto-archives — rejected as the PRIMARY
--     fix for the reason EVTANCHORDEL gave: it leaves the destructive action in place and merely
--     arranges that it does something tidier. The defect survives, defused by a side effect.
--   * A `container_id_history` / archived_project_id column so re-homing is reversible — rejected
--     as solving the wrong problem. It makes an unintended act recoverable instead of making it
--     not happen. RESTRICT plus an explicit operator statement is both simpler and stricter.
--
-- WHAT RESTRICT BUYS, AND THE ESCAPE HATCH
--   The delete is REFUSED (23503, naming the blocking table) instead of silently performed.
--   Unlike SOFTDELCASCADE this file ships NO new routine, deliberately: the events case needed
--   archive_container_events() because the rows had to be PRESERVED somewhere before deletion,
--   whereas a planting needs no cold store — it needs a DECISION. The two supported ways through
--   are both one explicit statement, and the point is that an operator now has to type one:
--     (a) re-home on purpose:  UPDATE plants SET project_id = NULL WHERE project_id = '<id>';
--     (b) remove the contents: soft-delete the plantings (SET deleted_at), or hard-delete them —
--         which the event/photo axis will itself RESTRICT unless their history is archived first.
--   The transition SET NULL performed implicitly is still available; it is now stated rather than
--   inferred, which is the whole of the fix.
--
-- ── DEPLOY BOUNDARY — the falsifiable test, answered ───────────────────────────────────────────
-- QUESTION: would the CURRENTLY DEPLOYED prod code perform an operation that this RESTRICT would
-- now reject? Asked of the deployed artifact, not of the branch in hand.
-- METHOD: all 27 deployed prod Lambda bundles (aws lambda get-function Code.Location, staging
-- excluded) downloaded and grepped for `DELETE FROM`, re-run 2026-08-13 against prod at
-- 5c232164616228dfce4f3e669ef8011a2cf7a456 = v4.14.0. Not inherited from the SOFTDELCASCADE audit;
-- prod has shipped three times since that grep ran.
-- RESULT: the only real DELETE statements in deployed prod code are `DELETE FROM favorites`
-- (garden-favorites/index.js, unrelated) and `DELETE FROM public.entity_memory`
-- (garden-plants/index.js:709 — a CHILD-row delete, and no parent-side RESTRICT can block one).
-- The `DELETE FROM plant_projects` that the grep reports in the deployed garden-plants bundle is
-- the source COMMENT at :463 predicting this very ticket — verified line by line, not assumed;
-- everything else matching is test-file assertion text shipped inside the bundles.
-- IN-DATABASE WRITERS (a grep of Lambdas cannot see these — the trap SOFTDELCASCADE's audit hit):
-- catalog sweep of every routine in every non-system schema returns ZERO that delete from plants or
-- plant_projects, and there is no BEFORE DELETE trigger on either table. The only AFTER DELETE
-- trigger, trg_delete_entity_tags_project, deletes from entity_tags (a child) and is unaffected.
--   [HISTORICAL, amended 2026-08-13] That trigger, its two siblings and the plural `entity_tags`
--   table itself are DROPPED by OPS-ENTITYTAGSDROP-001 (migrations/v4-entitytagsdrop-001). The
--   conclusion above is unchanged and gets STRONGER: after that migration there is no AFTER DELETE
--   trigger on plant_projects at all. This migration's own trigger allow-list still names it —
--   deliberately, see the comment at that gate in gates.yml.
-- ANSWER: NO, for both flips. There is no writer coupling with the deployed artifact, so this
-- migration is NOT split into pre-deploy and post-deploy files, and is SAFE TO APPLY BEFORE a code
-- deploy. It changes only the action taken on a parent DELETE; no INSERT or UPDATE path changes.
--
-- CI/STAGING: the deploy-staging.yml smoke purge is ALREADY correctly ordered — it deletes plants
-- (:604, predicate covers `project_id IN (smoke projects)`) before plant_projects (:610), and never
-- touches tasks. No workflow edit is required by this migration. Verified, not assumed.
--
-- ── RLS ────────────────────────────────────────────────────────────────────────────────────────
-- plants and plant_projects both have relrowsecurity = t. Run the sweep gates as a role subject to
-- RLS (garden_ro via scripts/psql-ro.sh) and they report phantom dangling rows — pure visibility
-- artifacts, because parent rows are filtered from that role while child rows are not. gate_runner
-- connects with NEON_DATABASE_URL (owner, RLS-exempt, conn.read_only = True) and gets the true
-- answer. Every count in this header was measured on the owner DSN for the same reason.
--
-- REVERSIBILITY: pure constraint-action swap. No row is read, written or moved. 0r restores the
-- previous actions byte-for-byte.

BEGIN;

-- Fail fast rather than queue behind a long transaction and stall live writes. Re-adding an FK takes
-- ACCESS EXCLUSIVE on the child and SHARE ROW EXCLUSIVE on the parent for the duration of the
-- validation scan (310 plants rows / 0 tasks rows — sub-millisecond). Every dangling-reference
-- predicate the scan will run was verified to return 0 first; see gates.yml `sweep`.
SET LOCAL lock_timeout = '5s';

-- ── 1. plants.project_id — containment for 305 of 310 plantings ────────────────────────────────
ALTER TABLE public.plants
  DROP CONSTRAINT IF EXISTS plants_project_id_fkey,
  ADD  CONSTRAINT plants_project_id_fkey
       FOREIGN KEY (project_id) REFERENCES public.plant_projects(id) ON DELETE RESTRICT;

-- ── 2. tasks.project_id — same defect, zero rows, folded per §SCOPE ────────────────────────────
ALTER TABLE public.tasks
  DROP CONSTRAINT IF EXISTS tasks_project_id_fkey,
  ADD  CONSTRAINT tasks_project_id_fkey
       FOREIGN KEY (project_id) REFERENCES public.plant_projects(id) ON DELETE RESTRICT;

-- NOT CHANGED, and deliberately so:
--   * plant_projects.parent_project_id (SET NULL, 76 rows) — excluded on a POLICY question, not a
--     technical one. RESTRICT there is measured CI-safe (full suite re-run with it flipped: zero
--     pre-existing failures) and behaviourally identical to NO ACTION. What is undecided is whether
--     a parent container SHOULD be undeletable while it has children. Full evidence in §SCOPE.
--   * entity_memory.project_id, container_closure.ancestor_id/descendant_id,
--     inactive_project_dismissals.project_id (CASCADE) — derived caches and closure rows, rebuilt
--     from live data. Cascading them with the container is correct.
--   * event_log.project_id, photos.project_id, harvest_log.project_id — already RESTRICT
--     (SOFTDELCASCADE and EVTANCHORDEL). This file makes the containment axis agree with them.
--   * plant_varieties.source_proj_rescope_project_id (NO ACTION) — already refuses. Correct as-is.

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.7-plantrehomefk-001',
  'PLANTREHOMEFK fix: plants.project_id and tasks.project_id ON DELETE SET NULL -> RESTRICT. A hard '
  'container delete silently stripped 305 of 310 plantings out of their containers and into the '
  'project-less arm, moving each one''s authorization key from the container''s created_by to its '
  'own — destructive of containment and a live authorization defect; 24 sentinel-owned rows would '
  'have become permanently unreachable. Completes the axis V4-SOFTDELCASCADE-001 deferred. Folds '
  'BUG-TASKDETACHFK-001 (0 rows). Escape hatch: an explicit UPDATE ... SET project_id = NULL. '
  'plant_projects.parent_project_id deliberately excluded — measured CI-safe, but whether a parent '
  'container should be undeletable while it has children is an open product question. '
  'No row data touched.')
ON CONFLICT DO NOTHING;

COMMIT;
