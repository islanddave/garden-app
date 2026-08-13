-- 0c-constraint.sql
-- V4-CASCADESWEEP-001 — the four remaining destructive CASCADEs from the V4-SOFTDEL-001 audit,
-- closed in one apply window. Closes BUG-PHOTOINVCASCADE-001 (I2), BUG-ACHIEVECASCADE-001 (I4),
-- BUG-SHARELOGCASCADE-001 (I5), BUG-FINDINGSCASCADE-001 (I6). THE FIX.
--
-- ┌─ THE DEFECT ────────────────────────────────────────────────────────────────────────────────┐
-- │ Four foreign keys still carry ON DELETE CASCADE onto user-authored content:                 │
-- │                                                                                             │
-- │   photos.inventory_item_id       -> inventory_items(id)   CASCADE   6 photos                │
-- │   user_achievements.achievement_id -> achievements(id)    CASCADE   33 earned badges        │
-- │   share_log.photo_id             -> photos(id)            CASCADE   0 rows (latent)         │
-- │   findings.garden_node_id        -> plants(id)            CASCADE   0 rows (latent)         │
-- │                                                                                             │
-- │ Each is one `DELETE FROM <parent>` away from destroying rows the application layer promises │
-- │ never to remove. None is reachable from the app; all four are reachable from admin SQL, the │
-- │ CI purge and test teardowns — the caller set every migration in this family has been about.  │
-- └──────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- MEASURED, live prod 2026-08-13, owner DSN (RLS-exempt), unfiltered by deleted_at. Catalog facts
-- read from pg_constraint directly rather than carried over from the audit prose.
--   * photos: 1,257 total; 6 carry an inventory_item_id, spread across 4 of 351 inventory items;
--     0 of those 6 are soft-deleted.
--   * user_achievements: 33 rows against a 39-row `achievements` catalog. Per owner — never pool —
--     Dave 24, the third sub 9. Deleting ONE catalog row destroys every badge earned against it.
--   * share_log: 0 rows. findings: 0 rows. Both flips are latent today; see §LATENT below.
--   * All four FKs are convalidated = 't'.
--
-- ── WHY RESTRICT IS THE ONLY VIABLE ACTION HERE, not merely the preferred one ──────────────────
-- This sweep is unusually easy to argue, because for three of the four the alternatives are not
-- available at all:
--
--   NOT NULL kills SET NULL outright on three of them:
--     findings.garden_node_id            NOT NULL
--     user_achievements.achievement_id   NOT NULL
--     share_log.photo_id                 NOT NULL
--   A SET NULL cascade onto a NOT NULL column does not degrade gracefully — it fails with 23502.
--   So the real choice on those three is CASCADE (destroy) or RESTRICT (refuse). There is no
--   middle option to weigh.
--
--   The fourth is the EVTANCHORDEL class, exactly:
--     photos.inventory_item_id IS an arm of the disjunctive CHECK photos_must_have_parent
--       (event_id OR project_id OR location_id OR plant_id OR inventory_item_id OR space_id
--        OR intake_status = 'pending_tag')
--     and ALL 6 of the photos carrying it have it as their SOLE anchor — every other arm is NULL.
--   So a SET NULL cascade there would null the last anchor and the CHECK would then reject the row
--   the cascade itself just produced (23514) — the precise defect BUG-EVTANCHORDEL-001 was written
--   to eliminate, on 6 of 6 rows rather than latently. evt-anchor-delete.int.test.js already carries
--   a standing class guard forbidding SET NULL on any FK column that is an arm of a disjunctive
--   anchor CHECK; this column passes it today only because it is CASCADE instead, which is worse.
--
-- ── WHY THE TWO ZERO-ROW FLIPS ARE WORTH AN APPLY WINDOW (§LATENT) ─────────────────────────────
-- share_log and findings are both empty, so neither flip changes any behaviour today. They are in
-- this migration because a zero-row constraint is the cheapest one to get right, and because one of
-- them is not merely a gap but a documented CONTRADICTION:
--
--   lambda/photos/photoDelete.js:14-16 states, in prose, that a hard photo delete "would SILENTLY
--   DESTROY share history via share_log.photo_id (ON DELETE CASCADE)", and its DD4 classification
--   records share_log as the one LEDGER pointer: "share_log.photo_id records that an image was
--   posted to an external Facebook page. A soft delete inside this app cannot retract that post, so
--   erasing the local record of it would make the ledger lie. RETAIN is a correctness decision, not
--   laziness."
--
--   The code therefore already declares the intended invariant AND names the schema as violating
--   it. This file makes the schema agree with the prose. That is the same defect shape as
--   BUG-PLANTREHOMEFK-001's false comment, inverted: there the comment claimed a protection that
--   did not exist; here it correctly documents a hazard nobody had closed.
--
--   findings is soft-deletable (it has deleted_at) and holds diagnostic history about a planting.
--   Hard-deleting a planting is already refused by event_log/photos/entity/entity_tag, so this flip
--   is defence in depth — it stops findings being the one child that would still be destroyed if
--   any of those upstream guards were ever relaxed.
--
-- ── WHY NOT THE ALTERNATIVES ───────────────────────────────────────────────────────────────────
--   * Leave CASCADE and rely on the app — rejected, as in every prior file in this family: every
--     app DELETE route soft-deletes, so every reachable caller is OUTSIDE the app. "The app is
--     careful" protects nothing against the callers that actually perform these deletes.
--   * SET NULL — not available on three (NOT NULL) and actively broken on the fourth (23514 on 6 of
--     6 rows). See above.
--   * NO ACTION — behaviourally identical to RESTRICT for all four; none of these parent/child
--     pairs shares a table, so no single statement can delete both, and nothing here runs inside a
--     transaction using SET CONSTRAINTS. RESTRICT is chosen for consistency with the eight FKs this
--     family has already flipped on the same policy. (Measured on 2026-08-13 against the
--     self-referential case, where the two are also indistinguishable — see v4-plantrehomefk-001.)
--   * A per-parent BEFORE DELETE guard, as v4-entitytagorphan-001 shipped — unnecessary here. That
--     migration needed a trigger only because a POLYMORPHIC column cannot carry a declared FK. All
--     four of these are ordinary typed FKs, so the constraint says it directly, is catalog-provable
--     via convalidated, and needs no read-only-ness argument.
--
-- ── DEPLOY BOUNDARY — the falsifiable test, answered ───────────────────────────────────────────
-- QUESTION: would the CURRENTLY DEPLOYED prod code perform a delete these RESTRICTs now reject?
-- METHOD: all 27 deployed prod Lambda bundles (aws lambda get-function Code.Location, staging
-- excluded) downloaded and grepped for `DELETE FROM`, against prod at
-- 5c232164616228dfce4f3e669ef8011a2cf7a456 = v4.14.0.
-- RESULT: the only real DELETE statements in deployed prod code are `DELETE FROM favorites`
-- (unrelated) and `DELETE FROM public.entity_memory` (a child-row delete). NOTHING deployed
-- hard-deletes inventory_items, achievements, photos or plants. A repo-wide grep for
-- `DELETE FROM achievements` returns ZERO hits in any environment — the catalog has never had a
-- delete path at all.
-- IN-DATABASE WRITERS: the catalog sweep run for v4-plantrehomefk-001 found archive_plant_events()
-- as the only routine deleting from any of these tables' neighbourhood; it DETACHES photos
-- (`UPDATE photos SET event_id = NULL`) before deleting events and never deletes a photo row, so
-- share_log.photo_id is untouched by it.
-- ANSWER: NO, for all four. These change only the action taken on a parent DELETE; no INSERT or
-- UPDATE path changes, so no deployed writer's behaviour changes. Safe to apply before a deploy.
--
-- COMPANION EDITS, shipped in the same commit — the non-app callers that DO hard-delete:
--   1. tests/integration/_cleanup.js — the `photos` sweep did not cover inventory_item_id, while
--      `inventory_items` is deleted AFTER it; a photo attached only to a namespaced inventory item
--      would have blocked the parent. Also adds a `share_log` step (there was none) before photos.
--   2. .github/workflows/deploy-staging.yml — same two gaps in the smoke purge (photos at :595,
--      inventory_items at :605). 0-row no-ops today; insurance, not a fix.
--   `findings` and `user_achievements` already precede their parents in both sweeps — verified,
--   not assumed.
--
-- NOT AFFECTED, checked rather than assumed: scripts/preflight-photodelete.sh compares the
-- table.column SET of FKs referencing photos against PHOTO_POINTERS, and does NOT compare
-- confdeltype. Flipping share_log.photo_id's action leaves both its check 1/3 (prod<->staging
-- parity) and check 3/3 (constant sync) untouched. PHOTO_POINTERS' `action: 'retain'` is the
-- APP-level classification and is unchanged — and is now enforced by the schema rather than merely
-- described by it.
--
-- REVERSIBILITY: pure constraint-action swap on four FKs. No row is read, written or moved.
-- 0r restores the previous actions byte-for-byte.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 1. photos.inventory_item_id — 6 photos, every one sole-anchored ────────────────────────────
ALTER TABLE public.photos
  DROP CONSTRAINT IF EXISTS photos_inventory_item_id_fkey,
  ADD  CONSTRAINT photos_inventory_item_id_fkey
       FOREIGN KEY (inventory_item_id) REFERENCES public.inventory_items(id) ON DELETE RESTRICT;

-- ── 2. user_achievements.achievement_id — 33 earned badges against a 39-row catalog ────────────
-- Rewards are never clawed back (the policy V4-EVTCASCADE-001 set when it left
-- user_achievements.trigger_event_id on SET NULL: nulling a reward's PROVENANCE pointer costs no
-- user-visible data). Destroying the reward itself because a catalog row was tidied is a different
-- act entirely, and the opposite of that policy.
ALTER TABLE public.user_achievements
  DROP CONSTRAINT IF EXISTS user_achievements_achievement_id_fkey,
  ADD  CONSTRAINT user_achievements_achievement_id_fkey
       FOREIGN KEY (achievement_id) REFERENCES public.achievements(id) ON DELETE RESTRICT;

-- ── 3. share_log.photo_id — the schema catches up with photoDelete.js's stated invariant ───────
ALTER TABLE public.share_log
  DROP CONSTRAINT IF EXISTS share_log_photo_id_fkey,
  ADD  CONSTRAINT share_log_photo_id_fkey
       FOREIGN KEY (photo_id) REFERENCES public.photos(id) ON DELETE RESTRICT;

-- ── 4. findings.garden_node_id — soft-deletable diagnostic history ─────────────────────────────
ALTER TABLE public.findings
  DROP CONSTRAINT IF EXISTS findings_garden_node_id_fkey,
  ADD  CONSTRAINT findings_garden_node_id_fkey
       FOREIGN KEY (garden_node_id) REFERENCES public.plants(id) ON DELETE RESTRICT;

-- NOT CHANGED, and deliberately so:
--   * user_achievements.trigger_event_id (SET NULL) — nulling a reward's provenance pointer costs
--     no user-visible data and rewards are never clawed back. Deliberate, matches V4-EVTCASCADE-001
--     and restated by V4-SOFTDELCASCADE-001. Note this is the SAME TABLE as flip 2 — the badge is
--     protected, its provenance pointer is not, and that asymmetry is the intended one.
--   * entity_memory.*, container_closure.*, inactive_project_dismissals.* (CASCADE) — derived
--     caches and closure rows, rebuilt from live data.
--   * plant_projects.parent_project_id (SET NULL) — open product question, V4-PARENTPROJFK-001.
--   * The remaining audit rows are not FK-action defects and are not closable here:
--     BUG-ENTITYTAGORPHAN-001 (closed by v4-entitytagorphan-001, a polymorphic edge with no FK),
--     BUG-ARCHPRESERVGUARD-001 (a routine's guard list), V4-SPACESOFTDEL-001 (a missing column),
--     V4-RESTORESURFACE-001 (a missing feature), BUG-DELNOOPOK-001 (a route return value).

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.9-cascadesweep-001',
  'CASCADESWEEP: the four remaining destructive CASCADEs from the V4-SOFTDEL-001 audit flipped to '
  'RESTRICT — photos.inventory_item_id (6 photos, all sole-anchored so SET NULL would 23514 on '
  'every one), user_achievements.achievement_id (33 earned badges vs a 39-row catalog), '
  'share_log.photo_id (0 rows; closes a contradiction photoDelete.js:14-16 documents in prose) and '
  'findings.garden_node_id (0 rows, defence in depth). SET NULL was not an available alternative: '
  'three of the four columns are NOT NULL. Closes BUG-PHOTOINVCASCADE-001, BUG-ACHIEVECASCADE-001, '
  'BUG-SHARELOGCASCADE-001, BUG-FINDINGSCASCADE-001. No row data touched.')
ON CONFLICT DO NOTHING;

COMMIT;
