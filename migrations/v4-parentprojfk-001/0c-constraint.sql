-- 0c-constraint.sql
-- V4-PARENTPROJFK-001 — the LAST SET NULL on plant_projects: the container HIERARCHY axis.
-- Closes the one FK v4-plantrehomefk-001 deliberately left open, on the policy answer it was
-- waiting for. THE FIX.
--
-- ┌─ THE DEFECT ────────────────────────────────────────────────────────────────────────────────┐
-- │ plant_projects_parent_project_id_fkey  plant_projects.parent_project_id                     │
-- │   -> plant_projects(id)  ON DELETE SET NULL                                                 │
-- │                                                                                             │
-- │ `DELETE FROM plant_projects WHERE id = '<parent>'` — one statement, no warning, no error —  │
-- │ silently promotes every child CONTAINER to top-level. The hierarchy is not archived, not    │
-- │ logged, and not recoverable: nothing anywhere records what the row used to hang off. The     │
-- │ containment axis one level down (plants.project_id, tasks.project_id) refuses the same act   │
-- │ with a clear 23503 since v4-plantrehomefk-001; the history axis (event_log/photos/           │
-- │ harvest_log .project_id) has since V4-SOFTDELCASCADE-001. This was the lone silent flatten.  │
-- └──────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- ── WHY THIS REVERSES A PRIOR DELIBERATE DECISION, AND WHY THAT IS RECORDED HERE ───────────────
-- v4-plantrehomefk-001 EXCLUDED this column, pinned the exclusion in a gate
-- (`post_parent_project_id_deliberately_still_set_null`) and in a test
-- (`tests/integration/plant-rehome-fk.int.test.js`), and wrote at length about why. This migration
-- reverses that. Per the precedent set by V4-CASCADESWEEP-001 over v4-fbshare-p1's
-- `post_photo_fk_cascade`, a reversal is recorded in the open rather than allow-listed away, and the
-- record has to name what changed and what did not:
--
--   * WHAT DID NOT CHANGE — the measurement. The first draft of v4-plantrehomefk-001 excluded this
--     column on a TECHNICAL claim ("RESTRICT is checked immediately, so the same-statement
--     parent+child delete every teardown performs would be refused"). That claim was measured on an
--     ephemeral branch off staging, 2026-08-13, and is FALSE. It stays false. Matrix, verbatim:
--
--       Case                             SET NULL           RESTRICT        NO ACTION
--       -------------------------------- ------------------ --------------- ---------------
--       same-statement parent + child    succeeds           succeeds        succeeds
--       same-statement 3-level chain     succeeds           succeeds        succeeds
--       parent alone, child surviving    flattens silently  refuses 23503   refuses 23503
--
--     RESTRICT and NO ACTION are behaviourally INDISTINGUISHABLE for this column, and the full
--     integration suite was re-run with the column flipped to RESTRICT: ZERO pre-existing failures.
--     The only two reds were v4-plantrehomefk-001's own pins asserting the deviation — which is to
--     say, the two artefacts this migration now supersedes on purpose.
--
--   * WHAT CHANGED — the policy. v4-plantrehomefk-001 recorded, correctly, that the residue was a
--     PRODUCT question and not a safety one: "should deleting a parent container be REFUSED while
--     it still has child containers, or should its children correctly be promoted to top-level?
--     ... That is Dave's call." Dave answered on 2026-08-13, on the evidence-backed recommendation
--     in R1 §5b: FLIP TO RESTRICT. So the exclusion is not being overturned by a later session
--     deciding it knew better — it is being closed by the decision it was explicitly waiting for.
--     Excluded on policy; included on the policy answer.
--
-- ── MEASURED BLAST RADIUS (live prod, 2026-08-13, owner DSN = RLS-exempt; see §RLS below) ──────
-- DELIBERATELY UNFILTERED by deleted_at — a foreign key does not know what a soft delete is, and a
-- soft-deleted container is every bit as flattened as a live one. A MOVING population: re-measure at
-- apply time rather than citing these as current.
--   * 86 containers total; 74 live, 12 soft-deleted.
--   * 76 carry a parent_project_id (88.4%). Depth distribution: 10 roots, 70 at depth 2, 6 at
--     depth 3. Max depth 3.
--   * Containers that actually HAVE children, i.e. the rows this RESTRICT makes undeletable:
--     **7**. Of those, exactly **1** is a MID-LEVEL node (has a parent AND children) — the case
--     where flattening scatters a real hierarchy rather than merely un-nesting a leaf group.
--   * 0 dangling parent_project_id values; 0 self-referencing rows (parent_project_id = id).
--   * The FK is already convalidated = 't'.
--
-- ── WHAT THE SILENT FLATTEN ACTUALLY COSTS, stated precisely ───────────────────────────────────
--   * STRUCTURE: the hierarchy is the only record of it. Unlike the planting case there is no
--     "project-less arm" to land in and no second key to fall back on — parent_project_id nulled is
--     information that existed nowhere else. container_closure rows for the subtree CASCADE away
--     with the deleted parent and are rebuilt from parent_project_id, so they cannot reconstruct
--     what parent_project_id itself forgot. It is a one-way loss with no error.
--   * AUTHORIZATION: unchanged, and worth saying so rather than overstating the case. Unlike
--     BUG-PLANTREHOMEFK-001, flattening does NOT move a row across an ownership boundary — a
--     container's read/write predicate keys on its own created_by whether or not it has a parent
--     (lambda/projects/index.js). This is a DATA-LOSS defect, not an authz defect. The ticket is
--     worth doing on the first ground alone; claiming the second would be the "a guard already
--     covers this" inversion in reverse.
--   * EXPOSURE: no app path can trigger it today. lambda/projects/index.js contains ZERO
--     `DELETE FROM` — the container delete route sets deleted_at. Every reachable caller is an
--     operator running admin SQL. That is precisely the caller RESTRICT is for: "the app is
--     careful" protects nothing when the app is not the writer. Same reasoning EVTANCHORDEL,
--     SOFTDELCASCADE and PLANTREHOMEFK each made.
--
-- ── DOES ANY LIVE ROW MAKE RESTRICT FAIL? NO ───────────────────────────────────────────────────
-- The FK is already convalidated = 't', Postgres's own catalog-level proof that every child value
-- resolves to a live parent. This file keeps the same column and the same parent table and changes
-- only the referential action, so the validation scan run by ADD CONSTRAINT is guaranteed to
-- succeed. Independently swept for 0 dangling and 0 self-referencing rows (gates.yml `sweep`).
-- RESTRICT constrains only FUTURE parent deletes.
--
-- ── WHY RESTRICT AND NOT THE ALTERNATIVES ──────────────────────────────────────────────────────
--   * Leave SET NULL — rejected. It is the only remaining FK on this parent that answers a delete
--     by silently discarding user structure. Every other one of the eleven either refuses (5) or
--     cascades a derived cache (5). Leaving one silent flatten is the inconsistency, not the fix.
--   * NO ACTION — behaviourally IDENTICAL here, and MEASURED so (matrix above) rather than assumed:
--     the two differ only when parent and child are deleted in the SAME statement, and that case
--     succeeds under both even on this self-referential column. RESTRICT is chosen for consistency
--     with the five FKs already flipped on this parent, so the class reads uniformly. A genuine
--     tie, not a hedge.
--   * CASCADE — rejected, and catastrophically worse: it converts a silent flatten of a subtree
--     into its silent DESTRUCTION, and would then collide with the RESTRICT edges one level down
--     (plants/tasks/event_log/photos/harvest_log .project_id) on every non-empty descendant.
--   * A BEFORE DELETE trigger that re-parents children to their grandparent — rejected for the
--     reason EVTANCHORDEL gave: it leaves the destructive act in place and arranges that it does
--     something tidier. The defect survives, defused by a side effect. It would also have to fight
--     v4-plantrehomefk-001's `post_no_writing_before_delete_trigger_on_touched_tables`, which
--     correctly bans exactly this.
--   * An `archive_container_hierarchy()` cold store — rejected as solving the wrong problem, the
--     same call PLANTREHOMEFK made. A subtree does not need preserving somewhere before deletion;
--     it needs a DECISION. See §ESCAPE HATCH.
--
-- ── WHAT RESTRICT BUYS, AND THE ESCAPE HATCH ───────────────────────────────────────────────────
--   The delete is REFUSED (23503, naming plant_projects) instead of silently performed. This file
--   ships NO new routine, deliberately. The supported ways through are one explicit statement each,
--   and the point is that an operator now has to type one:
--     (a) promote on purpose (exactly what SET NULL did implicitly, now stated):
--           UPDATE plant_projects SET parent_project_id = NULL WHERE parent_project_id = '<id>';
--     (b) re-home the subtree to the grandparent, which SET NULL could never do:
--           UPDATE plant_projects SET parent_project_id =
--             (SELECT parent_project_id FROM plant_projects WHERE id = '<id>')
--            WHERE parent_project_id = '<id>';
--     (c) remove the subtree — soft-delete it (SET deleted_at), or hard-delete depth-first, which
--         the plants/tasks/event/photo axes will each RESTRICT in turn unless emptied first.
--   Note (b) is the interesting one: SET NULL's implicit answer was ALWAYS "promote to top-level",
--   which for the 1 live mid-level node is the wrong answer and always was. RESTRICT does not
--   remove a capability; it forces the choice between (a) and (b) to be made rather than assumed.
--
-- ── DEPLOY BOUNDARY — the falsifiable test, answered ───────────────────────────────────────────
-- QUESTION: would the CURRENTLY DEPLOYED prod code perform an operation this RESTRICT rejects?
-- ANSWER: NO.
-- METHOD/RESULT: inherited from v4-plantrehomefk-001's sweep of all 27 deployed prod Lambda bundles
-- (2026-08-13, prod at 5c232164616228dfce4f3e669ef8011a2cf7a456 = v4.14.0) and RE-ASSERTED at apply
-- time by the gates below rather than trusted — the only real DELETE statements in deployed prod
-- code are `DELETE FROM favorites` and `DELETE FROM public.entity_memory` (a child-row delete).
-- There is no `DELETE FROM plant_projects` in any deployed bundle; lambda/projects/index.js has
-- ZERO `DELETE FROM` at all and soft-deletes via `UPDATE public.container SET deleted_at = NOW()`.
-- Note `container` is a VIEW over this table (relkind = 'v'), so a view write cannot bypass the FK.
-- IN-DATABASE WRITERS (a grep of Lambdas cannot see these — the trap SOFTDELCASCADE's audit hit):
-- catalog sweep returns ZERO routines in any non-system schema that delete from plant_projects, and
-- the only BEFORE DELETE trigger on the table is trg_guard_entity_tag_project, a read-only guard.
-- The AFTER DELETE trigger trg_delete_entity_tags_project writes to a CHILD table and is unaffected.
-- CONSEQUENCE: no writer coupling, so this migration is NOT split into pre-deploy and post-deploy
-- files and is SAFE TO APPLY BEFORE OR AFTER a code deploy. It changes only the action taken on a
-- parent DELETE; no INSERT or UPDATE path changes, so the reparent path
-- (lambda/projects/index.js PATCH -> `SET parent_project_id = ...`, and the container_reparent_after
-- trigger it fires) is untouched.
--
-- CI/STAGING: no workflow edit is required, verified rather than assumed. deploy-staging.yml's smoke
-- purge ends at `DELETE FROM plant_projects WHERE name ILIKE '%smoke%'` (:612) — ONE statement, so a
-- smoke parent and its smoke children go together, which the matrix above measures as succeeding
-- under RESTRICT. tests/integration/_cleanup.js:146 has the same single-statement shape. All 26
-- integration files that delete plant_projects were re-swept: every one deletes by created_by /
-- namespace in a single statement, and NONE creates a parent/child container pair at all
-- (parent_project_id appears in no fixture outside this migration's own test additions).
--
-- ── RLS ────────────────────────────────────────────────────────────────────────────────────────
-- plant_projects has relrowsecurity = t. Run the sweep gates as a role subject to RLS (garden_ro via
-- scripts/psql-ro.sh) and they report phantom dangling rows — pure visibility artifacts, because
-- parent rows are filtered from that role while child rows are not, and on a SELF-referential FK
-- both sides of the join sit in the same filtered table, which makes the artifact worse here than
-- anywhere else in the corpus. gate_runner connects with NEON_DATABASE_URL (owner, RLS-exempt,
-- conn.read_only = True) and gets the true answer. Every count in this header was measured that way.
--
-- ── LOCKING ────────────────────────────────────────────────────────────────────────────────────
-- Self-referential: the ALTER takes ACCESS EXCLUSIVE on plant_projects once, as both child and
-- parent. One table, one lock, no ordering hazard against a sibling ALTER — simpler than
-- PLANTREHOMEFK's two-table case. 86 rows; the validation scan is sub-millisecond.
--
-- REVERSIBILITY: pure constraint-action swap. No row is read, written or moved. 0r restores the
-- previous action byte-for-byte.
--
-- ── REQUIRED COMPANION EDIT — OUT OF THIS LANE'S FILE BOUNDARY, NOT APPLIED HERE ───────────────
-- migrations/v4-plantrehomefk-001/gates.yml carries
-- `post_parent_project_id_deliberately_still_set_null`, a CONTINUOUS post gate asserting
-- confdeltype = 'n' on this exact constraint. It WILL FAIL on both prod and staging the moment this
-- migration is applied. It must be superseded in place, in the shape V4-CASCADESWEEP-001 used for
-- v4-fbshare-p1's post_photo_fk_cascade. The exact replacement hunk is prepared, ready to apply, at
--   migrations/v4-parentprojfk-001/COMPANION-EDIT-plantrehomefk-gates.patch
-- Apply it BEFORE the whole-corpus gate run, or the corpus reds. See README §Whole-corpus impact.

BEGIN;

-- Fail fast rather than queue behind a long transaction and stall live writes. Re-adding a
-- self-referential FK takes ACCESS EXCLUSIVE on plant_projects for the duration of the validation
-- scan (86 rows — sub-millisecond). Every dangling-reference predicate the scan will run was
-- verified to return 0 first; see gates.yml `sweep`.
SET LOCAL lock_timeout = '5s';

-- ── plant_projects.parent_project_id — the container hierarchy, 76 of 86 rows parented ─────────
ALTER TABLE public.plant_projects
  DROP CONSTRAINT IF EXISTS plant_projects_parent_project_id_fkey,
  ADD  CONSTRAINT plant_projects_parent_project_id_fkey
       FOREIGN KEY (parent_project_id) REFERENCES public.plant_projects(id) ON DELETE RESTRICT;

-- NOT CHANGED, and deliberately so — with this flip, every FK referencing plant_projects is now
-- either RESTRICT (refuses) or CASCADE (a derived cache rebuilt from live data). There is no
-- SET NULL left on this parent, which is what post_no_setnull_fk_remains_on_plant_projects asserts:
--   * plants.project_id, tasks.project_id            RESTRICT (v4-plantrehomefk-001)
--   * event_log/photos/harvest_log .project_id       RESTRICT (SOFTDELCASCADE / EVTANCHORDEL)
--   * entity_memory.project_id, container_closure.ancestor_id/descendant_id,
--     inactive_project_dismissals.project_id         CASCADE — derived caches and closure rows,
--     rebuilt from live data. Cascading them with the container is correct, and for
--     container_closure it is REQUIRED: those rows exist only to materialise the very hierarchy
--     this FK declares.
--   * plant_varieties.source_proj_rescope_project_id NO ACTION — already refuses. Correct as-is.

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.11-parentprojfk-001',
  'PARENTPROJFK fix: plant_projects.parent_project_id ON DELETE SET NULL -> RESTRICT. A hard delete '
  'of a parent container silently promoted every child container to top-level — an unrecorded, '
  'unrecoverable loss of structure that nothing logged and no error surfaced; 76 of 86 containers '
  'carry a parent, 7 have children, 1 is mid-level. Closes the last SET NULL on plant_projects and '
  'the FK v4-plantrehomefk-001 deferred as an open product question; Dave answered 2026-08-13. '
  'RESTRICT was measured behaviourally identical to NO ACTION and CI-safe (full integration suite, '
  'zero pre-existing failures) before the policy call, not after. Escape hatch: an explicit UPDATE '
  '... SET parent_project_id = NULL (promote) or = grandparent (re-home). Supersedes '
  'v4-plantrehomefk-001 post_parent_project_id_deliberately_still_set_null. No row data touched.')
ON CONFLICT DO NOTHING;

COMMIT;
