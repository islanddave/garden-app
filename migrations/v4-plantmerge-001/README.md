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

**APPLIED — staging and prod, 2026-08-14.** Pre 6/6, post 10/10 on both. `0r` rollback rehearsed
including its refuse-if-used guard; `archive_events_subset` smoke-tested end-to-end on staging and
the probe event restored. Prod's guard was verified via the REFUSAL path only, so no prod event data
has been touched. Live state re-verified 2026-08-14: `merge_event` and `archive_events_subset` exist
on both envs, `merge_event` is empty — **no planting has been merged**.

`post_starts_empty` in `gates.yml` stays `continuous: false` forever: `merge_event` populates on the
first merge, so that gate's truth decays by design. The other 10 post gates are continuous, and a
continuous-only sweep correctly reports `APPLY_WINDOW_ONLY=1, PASS=9`.

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

**Same-day water must NOT collapse — this reversed on 2026-08-14.** An earlier draft collapsed
same-day water on the premise that `lambda/daily-plan/ledger.js` folds credit *per event row* and
would over-credit a merged plant. Two independent specialists measured that premise against prod and
refuted it, converging on the same mechanical bug:

- The ledger's per-row *accumulating* branches need `water_depth` `light` or `deep`. Prod has **zero**
  such rows — 10,114 water/rain rows are 9,711 null + 403 `normal`, and both take the `normal` branch,
  which **assigns** rather than accumulates. (Exception: `normal` on a long-dry in-ground profile,
  `ledger.js:267-269`, decrements per row — bounded and self-limiting.)
- **25.24% of all plant-day water buckets garden-wide already hold multiple rows**, 1,996 of them on
  the 278 plantings in no merge group. The collapse imposed on 34 plants an invariant the other 278
  never had. If multi-row same-day water broke the ledger it would already be broken everywhere.
- It bucketed by **UTC** while the ledger buckets by **America/New_York**, so it both missed 42
  same-ET-day pairs it was meant to catch and erased 80 water rows that were the only record on their
  ET day. It also had no cross-sibling scoping (19 of 37 drops were already on one planting, 9 of
  them the winner deleting its own history) and always dropped the *later* row, moving the last-water
  reset backwards.

With batch fan-out alone the drop set matches plan §1 **exactly** (group 1: 96, group 6: 55, and so
on down the table). Do not re-add the collapse without first re-measuring `water_depth` on prod — the
entire argument turns on that distribution.

**Divergent scalars are refused, not defaulted.** Plan §4.1 listed `container_type`,
`container_size`, `location_id`, `variety_id` and `archived_at` as "still needing an explicit rule",
and none was written, so they fell to winner-takes-all. For the vessel columns that is a silent wrong
water verdict — `vesselProfile` (`ledger.js:109-128`) derives drying behaviour from them, and group 3
Habanero spans a whiskey barrel, a 5-gal fabric bag and an unsized plastic pot. `mergeCore` now
returns **422** listing the divergence, and the caller must supply `overrides.<column>`. Only the
gardener knows which pot the plant is actually in. `featured_photo_id` and `notes` are deliberately
NOT guarded — they diverge on nearly every group and lose nothing, since the losers' photos repoint
to the winner regardless.

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
