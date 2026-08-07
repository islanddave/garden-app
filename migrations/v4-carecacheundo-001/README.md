# V4-CARECACHEUNDO-001 — care cache left ahead of the event log by undo

**Status:** authored + dry-verified against live prod. **Nothing applied.**
**Ticket:** BUG-CARECACHEUNDO-001. **schema_version:** `4.23.2-carecacheundo-001`.
**Found:** while executing V4-CAREKEY-001 Step D/E, via the informational gate
`sweep_capture_care_cache_drift_vs_event_log` in `migrations/v4-carekey-001/gates.yml`.

## The defect

All four `entity_memory` recompute arms in the undo paths of `lambda/events/index.js` recomputed
**only `last_watered_at`**:

| arm | line (pre-fix) |
| --- | --- |
| batch undo, project-keyed | ~719 |
| batch undo, plant-keyed | ~750 |
| single undo, project-keyed | ~1341 |
| single undo, plant-keyed | ~1366 |

The single-event arm was worse than incomplete — the whole recompute sat behind
`if (event_type === 'watering' || event_type === 'rain')`, so undoing a harvest soft-deleted the
event and then updated nothing at all.

Undoing a harvest, fertilizing, pruning or observation therefore left `last_harvested_at` /
`last_fertilized_at` / `last_pruned_at` / `last_observed_at` / `last_event_at` pointing at a date the
log no longer contains. **Every forward upsert is `GREATEST()`**, so the cache cannot walk backwards
on its own, and nothing else repairs it. The drift is permanent, and it accretes one cell per undone
event forever.

## Blast radius on prod (2026-08-07, read-only)

6 rows / 12 cells cached ahead of the log. Every one carries the undo signature: a soft-deleted
event at *exactly* the cached timestamp.

| arm | row | cells ahead | evidence |
| --- | --- | --- | --- |
| plant | Beefsteak Rescue 2 | `last_harvested_at` | cached `2026-07-31`, true max `2026-07-14`; event `01665d2f` (harvest, 2026-07-31) soft-deleted `2026-07-31 14:41` |
| plant | Pineapple Tomato | `last_harvested_at` | cached `2026-08-04 11:36:42.852667+00`, **no surviving harvest at all**; event `7c7e9937` (harvest, same instant) soft-deleted `2026-08-04 19:25` |
| project | Basil | event | container soft-deleted |
| project | Bitter Melon | harvested | container live |
| project | Build Out | event, watered, pruned, observed | container soft-deleted |
| project | Chilis | event, watered, observed, harvested | container soft-deleted |

## Direction is the design — and it is what keeps two tickets apart

This repair **walks the cache backwards only.** A cell is rewritten if and only if it is strictly
ahead of the surviving-event truth (including *cached non-NULL, truth NULL*). A cell that is
**behind** the truth is left exactly as found.

That is deliberate, and it is the whole reason this file is not simply "set every cell to truth":

| | this migration | `care-rekey-001/0b-backfill.sql` re-run |
| --- | --- | --- |
| ticket | **BUG-CARECACHEUNDO-001** (undo recompute too narrow) | **BUG-DIRECTWRITEDRIFT-001** (harvests written straight to the DB, bypassing the Lambda) |
| drift direction | cache **ahead** of the log | cache **behind** the log |
| mechanism | explicit `CASE` lowering to truth | `ON CONFLICT … GREATEST` |
| movement | backwards only | forwards only |
| prod population | 6 rows | 15 rows |

The two are exact complements: disjoint by construction, commutative, and each leaves the other's
before/after evidence intact. Re-running `0b-backfill.sql` **cannot** fix what this file fixes —
`GREATEST` cannot lower a value — and this file will not silently close the other ticket's rows out
from under it. A row can be ahead on one column and behind on another, which is why the decision is
made per **cell**, not per row.

`LEAST(cached, truth)` would have been the obvious shorthand and is **wrong**: Postgres `LEAST`
ignores NULL inputs, so `LEAST(ts, NULL) = ts`. The single worst row on prod — Pineapple Tomato, a
cached harvest date with no surviving harvest — is precisely the NULL-truth case, and `LEAST` would
have skipped it while looking correct. `0b-data.sql` uses an explicit `CASE`.

## Per-arm writer parity on the harvest mapping

The two arms use different harvest filters, on purpose, because their forward writers do:

* plant-keyed → `event_type IN ('harvest','first_harvest')` (`0b-backfill.sql`; `index.js` ~1717)
* project-keyed → `event_type = 'harvest'` (`index.js` ~1673)

A recompute must be the exact inverse of **its own arm's** writer. Unifying them would compute a
"truth" for the project arm that no forward write has ever produced, so an unrelated undo would move
`last_harvested_at` to a date the app never set. This applies to the Lambda fix and to this
migration alike; `lambda/events/undo-recompute.test.js` asserts both filters separately so a
"consistency" refactor cannot quietly merge them.

`last_event_at` is deliberately **unfiltered** by `event_type` — it means "any activity", including
the `status_change` rows `lambda/plants/index.js` and `lambda/projects/index.js` write. Both of those
also insert an `event_log` row at the same instant, so `last_event_at` stays fully derivable from
`event_log` alone.

## Out of scope, and why

* **`next_water_at`** — not a recency cache. The nightly daily-plan engine owns "due"; recomputing it
  from `last_watered + interval` here would overwrite that engine's value with a fiction. The Lambda
  fix keeps it watering-gated for the same reason: the gate moved from JS into the SQL `CASE` rather
  than disappearing with the recency gate.
* **`last_issue_at`** — driven by `event_log.flagged_as_issue`, not by `event_type`, so it has no
  mapping in `0b-backfill.sql`. Measured rather than repaired blind, and the measurement found
  something worth its own ticket: on the **project** arm it is perfectly consistent (0 ahead,
  0 behind of 76 rows), but on the **plant** arm it is 0 ahead / **72 behind** of 262 rows — because
  the plant-keyed forward upsert never writes the column at all (it is absent from that INSERT's
  column list). That is a structural Phase-A/Step-D gap, not undo drift. Latent today: nothing reads
  `last_issue_at` anywhere in `lambda/` or `src/`. It becomes real the moment the Step-D read
  cutover, or Phase F's removal of the project arm, makes the plant row the only surface.
* **Location-keyed `entity_memory` rows** — no undo path writes them.

## Scope

Every `entity_memory` row on either arm, **including** rows whose planting is archived or
soft-deleted and rows whose container is soft-deleted (3 of the 4 project rows above). A stale cache
on a hidden row is still a lie, it costs nothing to correct, and leaving it would make the post gate
assert "zero except the ones we chose not to look at".

## Apply order

The Lambda fix and this repair are **not** coupled in the breaking sense — the new recompute arms
compute from `event_log`, never from the cache, so they are correct against repaired and unrepaired
data alike, and the repair is correct against old and new Lambda alike. Stated as an artifact
property, never as a date:

1. **Code first.** The deployed events Lambda still has the narrow recompute, so any undo of a
   harvest / fertilizing / pruning / observation between a repair and the promote re-opens exactly
   one cell. Applying the data repair long before the promote wastes it.
2. **Then prod:** `pre` gates → `0b-data.sql` → `post` gates.
3. **Then staging**, whenever it is next refreshed. Nothing reads these counts there.

Re-running the repair is the cheap, correct remedy if drift reappears — it is idempotent.

## Verification performed (live prod, read-only, all rolled back)

* All four rewritten Lambda arms `PREPARE`d successfully against live prod; the batch project arm's
  `EXPLAIN` plan uses `idx_event_log_project_date` / `idx_event_log_harvest` for every `MAX()`.
* `gate_runner.py --validate-only` → 11 gates schema-valid.
* `--phase pre` → 4/4 pass. `--phase sweep` → 2/2 pass, reporting **ahead = 6**, **behind = 15**.
* `0b-data.sql` applied inside a transaction: snapshot 6 rows (2 plant, 4 project), `UPDATE 6`.
  All 5 `post` gates pass. The **behind** population is **unchanged at 15** — the proof that the
  repair is backwards-only and did not annex the other ticket's rows.
* **Idempotency:** a second `0b` in the same transaction → `UPDATE 0`.
* **Out-of-scope columns:** `next_water_at` and `last_issue_at` unchanged across all 344 rows.
* **Rollback fidelity:** `0r-rollback.sql` restored all 344 rows cell-for-cell to the pre-repair
  state (0 differences), and removed the `schema_version` row.
* `ROLLBACK` — nothing was written to prod.

## Files

| file | what |
| --- | --- |
| `0b-data.sql` | snapshot + backwards-only repair + `schema_version` row |
| `0r-rollback.sql` | exact reversal from the snapshot, by row identity and stored value |
| `gates.yml` | 4 `pre`, 2 `sweep` (the two drift populations, measured separately), 5 `post` |

The snapshot table `public.snap_carecacheundo001_entity_memory` is rollback scaffolding and the only
object this migration creates. `0r` leaves it in place — dropping it would make a second rollback
impossible. Drop it manually once the repair has soaked.

## Companion code change

`lambda/events/index.js` — all four arms extended to every recency column; the JS watering gate
removed from the single-event path. Guarded by `lambda/events/undo-recompute.test.js` (45 static
source assertions, L-072 house style), which pins: every arm recomputes all six columns; no arm
assigns via `GREATEST`; each arm's six `MAX()`es are all `deleted_at IS NULL`-scoped;
`last_event_at` is unfiltered; the per-arm harvest filters differ; the JS gate is gone; the
`plantId` guard remains; and `next_water_at` never appears in either plant-keyed arm.
