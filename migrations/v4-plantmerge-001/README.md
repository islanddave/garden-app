# V4-PLANTMERGE-001 — planting merge

Folds N sibling plantings into one surviving row, keeping the combined history.

Canon: `Projects/Gardening/planting-merge-plan-V003-20260814.md`. Ledger: `V4-PLANTMERGE-001`.

## What ships here

| File | Purpose |
|---|---|
| `0a-additive-ddl.sql` | `merge_event` — durable record + full pre-state snapshot, `op_id` unique |
| `0c-routines.sql` | `archive_events_subset(uuid[], text, text)` — event-SUBSET archive+soft-delete |
| `0r-rollback.sql` | drops both; **refuses** while an unrestored merge exists |
| `gates.yml` | 6 pre / 10 post schema gates |
| `../../lambda/plants/merge.js` | `mergeCore` — the operation |
| `../../scripts/merge-surface-inventory.py` | derives the surface list from live schema; CI tripwire |

## Status

**AUTHORED, NOT APPLIED.** No DDL has run on staging or prod. Pre-gates verified green against live
prod 2026-08-14 (6/6), so the apply is safe to sequence.

## Why not model on reparentCore

`reparentCore` is one CTE on one table — its atomicity is free because a single neon request is one
transaction, and its snapshot is five scalars. This operation touches 13 surfaces and soft-deletes
hundreds of event rows. Three things had to change:

1. **Explicit transaction.** All writes go through one `sql.transaction([...])`. The serverless
   client issues one request per tagged call, so a sequence of awaits is a sequence of
   transactions — i.e. a partially-applied merge on any mid-flight error.
2. **Set-level concurrency guard.** A row-level `version` check cannot protect a set operation: a
   concurrent write to a loser between the caller's read and the cutover produces no row-level
   conflict and would be swept into the winner invisibly. We fingerprint `(rows, max(updated_at))`
   per surface and re-assert it inside the operation; drift 409s.
3. **Full snapshot.** `merge_event.snapshot` holds every moved row's prior value, every dropped
   event id, the superseded anchors and the deleted `entity_memory` rows — not a field list.

## The two things most likely to be got wrong

**The dedup key must be group-scoped.** `metadata.batch_id` is a *garden-wide* bulk-action marker,
not a sibling fan-out marker: 368 batches over 11,960 events, ~32 plants each; the largest spans 157
plants across 10 merge groups, and 137 batches include plants in no merge group at all. A key of
`(event_type, batch_id)` applied globally deletes events on plantings that are not being merged.

**Same-day water must collapse too.** `lambda/daily-plan/ledger.js` folds water credit *per event
row* keyed on `plant_id`, with no same-day dedup. Siblings watered in *different* batches on the same
day both survive batch dedup and both land on the winner, so the ledger over-credits and the app
stops telling the user a thirsty plant needs water. 14 of 15 approved groups exhibit this. It is a
wrong-verdict regression, not a calibration nudge.

## Surface policy

`SURFACES` in `merge.js` classifies every plant-referencing surface as
`repoint | supersede | delete | leave`. It is **derived, not remembered** —
`scripts/merge-surface-inventory.py` regenerates it from `pg_constraint` plus every
plant-id-bearing column and exits non-zero on drift. Current: 26 live surfaces
(repoint=12, leave=12, supersede=1, delete=1).

Non-obvious calls, each of which was wrong in an earlier draft:

- `entity.planting_ref_id` → **leave.** `entity_planting_uniq` makes a repoint a certain 23505 on
  every group; `plants_entity_softdel` retires the loser's entity row when we soft-delete it.
- `plant_anchor_derivation` → **supersede.** `uq_plant_anchor_derivation_live` is UNIQUE(plant_id)
  WHERE `superseded_at IS NULL`, and two approved groups already hold 2 live rows.
- `entity_memory` → **delete.** 1-row-per-plant, columns are scalar timestamps/smallints/jsonb so
  "concat" is type-invalid, and it has no `deleted_at` — leaving the loser's row strands a live
  `next_water_at` on an invisible planting. The inference job recomputes the winner's.
- `plants.succession_group_id` / `parent_plant_id` → **leave.** All 211 succession values garden-wide
  are self-references; the one live parent link is a clone pair on the never-merge list.
- `entity_tag.entity_id`, `slug_redirects.target_entity_id` → **leave, different id space.** Both
  hold `plant_varieties.id` (verified 1016/1016 and 5/5), not `plants.id`.
- Four surfaces whose unique index has no `deleted_at` escape (`favorites`, `watch_impression`,
  `harvest_watch_dismissal`, `findings`) get a **conflict-prune**: a loser row that would collide
  with an existing winner row is deleted rather than moved. All four are derived
  impression/dismissal/favourite state, and the snapshot holds the row for restore.

## Rehearsal (required before any prod merge)

Gates here are **schema** gates. They do not prove a merge is correct — that is a per-group invariant
set which cannot live in a static file. Before merging real data:

1. Branch prod: `scripts/neon_branch_select.py`; verify with `scripts/restore-verify.py`
   (use **that** copy — `Projects/Gardening/snap-build/restore-verify.py` has stale `SANITY_TABLES`
   naming `projects`/`events`, which do not exist; tracked as `OPS-RESTOREVERIFY-001`).
2. `POST /api/plants/:id/merge` with `dry_run: true` — returns the full plan, writes nothing.
3. Run the merge, then assert the invariants in canon §7 (harvest count and weight sum unchanged;
   photo count unchanged; zero live rows referencing a loser; event delta == the computed drop-set
   size, *not* a hardcoded constant; zero events changed for non-group plants; exactly one live
   `entity` and one live anchor row per winner).
4. Run the merge a second time — it must change 0 rows and return the first run's outcome.
5. Restore, and re-run the invariants.

**A green branch rehearsal is not full verification.** A branch does not exercise Lambda side
effects, `user_stats`/XP recompute, or the app's read paths. The water-ledger check in particular
needs **staging with a deployed build**, diffing the per-plant water verdict pre/post.

## Known accepted consequence

`user_stats.total_events` is an absolute recompute on every logging action
(`lambda/events/index.js`), not an increment. The next event logged after a merge drops the
Dashboard "Total events" tile by the drop-set size. Nothing to recompute; it fires on the next write
regardless. Snapshot `user_stats` before merging.

## Post-merge runbook

1. `scripts/rerun-daily-plan.sh --region us-east-1` — today's persisted plan references soft-deleted
   ids and the dashboard water tile will otherwise flag `water_due_source='schema_mismatch'`.
2. Re-baseline `scripts/integrity-weekly-check.sh` — `event_unattached_new_7d` and the
   anchor/photo-parent predicates shift under a bulk repoint.
3. Diff harvest-watch anchor coverage — `scripts/measure-anchor-coverage.mjs`.
