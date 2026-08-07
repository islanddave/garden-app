# V4-CACHEFWDGAP-001 — care cache left behind the event log

**Status:** authored, gate-validated, and **dry-run against live prod inside `BEGIN`/`ROLLBACK`**
(`UPDATE 15`, behind→0, ahead→0, nothing moved backward, rollback clean). **Nothing applied.**
**Ticket:** BUG-CACHEFWDGAP-001. **schema_version:** `4.23.4-cachefwdgap-001`.
**Found:** by the sibling migration's own informational gate,
`sweep_capture_cache_behind_event_log_left_alone` in `migrations/v4-carecacheundo-001/gates.yml`
— a gate written to prove a *different* file was backwards-only happened to count this population
on its way past.

## The defect

`entity_memory` caches "when did this planting last get watered / fertilized / pruned / observed /
harvested / anything". Every forward writer in the codebase is a `GREATEST()` upsert, and every
recompute was gated. That combination is one-way: a cell that ends up **behind** the surviving
event log can never catch up on its own, because `GREATEST` will not lower it and nothing else
recomputes it.

The reason this went unseen for three months is the detector. The canonical drift check —
`post_no_cache_ahead_of_event_log`, and the `staleForward()` copy of it in
`tests/integration/reanchor-carecache.int.test.js` — tests `cached > truth` **only**. BEHIND drift
is structurally invisible to it at any volume. 15 rows / 28 cells accreted with every gate green.

## Four doors, and only one of them is code

Investigated against live prod. Every one of the 15 rows is accounted for; **11 of the 15 are not
the door the ticket was filed under.**

| door | rows | cells | cause | recurs? |
|---|---|---|---|---|
| **A** | 4 | 6 | the events PUT moved `event_date` **forward**; the deployed gate is `projectChanged \|\| plantChanged`, so a date-only edit runs no arm | **yes — live on prod until `e9d8909` promotes** |
| **B** | 5 | 15 | the BUG-DIRECTWRITEDRIFT-001 reversal script (2026-08-04 17:16:30) INSERTed five plant rows with only 3 of 6 recency columns in its column list, and computed even those over the direct-write **subset** of the log | only if another ad-hoc repair repeats it |
| **C** | 4 | 5 | commit `78419e8` (2026-05-25 00:44Z) corrected 13 midnight-UTC `event_date` rows to noon and did not recompute the cache | no — the writer has noon-anchored since May |
| **D** | 2 | 2 | a harvest was written project-anchored and acquired `event_log.plant_id` out of band afterwards; the POST's plant arm self-guards on `plant_id`, so the project arm is right and the plant arm never saw it | yes, on any out-of-band anchor write |

**Three of the four doors were opened by hand-run SQL, not by the application.** That is the durable
lesson here and it outlives the ticket: the writer fix closes door A only. Doors B, C and D are
closed by nothing except `post_no_cache_behind_event_log` running as a standing invariant.

Door B deserves its own note, because it is a repair script that made things worse in a way its own
authors could not see: its "recompute from truth" was scoped to the rows it was repairing, so **the
repair's scope silently became its definition of truth**. `cached == MAX(event_date) FILTER (WHERE
source IS NULL)` holds exactly for all five rows. That is the same failure shape `e9d8909`'s commit
message names ("when a guard is derived from a locally-available subset, the subset silently becomes
the specification"), one layer up, in human-written SQL. Those five plantings were archived on
2026-07-20 and have had no events since, so no forward write ever came along to paper over it.

## Direction is the whole design

This file walks the cache **forwards only**. It is the exact complement of
`v4-carecacheundo-001/0b-data.sql`, which walks it **backwards only** and was applied to prod on
2026-08-07 14:47:59Z.

`carecacheundo` could not use `LEAST`, because Postgres `LEAST` ignores NULL inputs and
`LEAST(ts, NULL) = ts` would have skipped its single worst row. **The identical NULL-ignoring
behaviour is what makes `GREATEST` exactly correct in this direction:**

| cached | truth | `GREATEST` | wanted |
|---|---|---|---|
| behind | later | truth | repair ✓ |
| NULL | non-NULL | truth | repair ✓ (door B's 10 cells) |
| ahead | earlier | cached | leave alone ✓ |
| non-NULL | NULL | cached | leave alone ✓ |

The bottom two rows are the non-interference proof, and they are an algebraic identity rather than a
promise: `GREATEST` **cannot lower a cell**, so this file cannot annex `carecacheundo`'s population
even if someone later widens the `WHERE` clause. Confirmed empirically as well — applying this
file's predicate to the six pre-repair rows still stored in `snap_carecacheundo001_entity_memory`
matches **0 of 6**.

Do **not** rewrite this as "set every cell to truth". That merges the two tickets, destroys the
before/after measurement each owns, and silently lowers any cell the deployed undo path has put
ahead since. `post_no_repaired_cell_moved_backward` exists to catch exactly that edit.

## Scope

`last_issue_at` is **in**, unlike in `carecacheundo`, which excluded it for want of an
`event_type` mapping. BUG-LASTISSUEPLANT-001 (`4.23.3`, applied 2026-08-07 19:08Z) shipped that
mapping identically on both arms. It currently measures 0 behind and 0 ahead, so including it costs
nothing and closes the "asserts zero except the column we chose not to look at" hole.
`pre_last_issue_at_mapping_shipped` refuses to run without it.

`next_water_at` stays out — not a recency cache; the nightly daily-plan engine owns "due".
Location-keyed rows (6 on prod) stay out — no writer touches them.

Archived and soft-deleted parents are **in scope**. Ten of the 28 cells belong to five archived
plantings; excluding them would leave the post gate unable to run as a durable invariant.

## Apply order

1. **Promote `e9d8909` (BUG-CACHEGATE-001) first.** Door A is the only door still open and it is open
   *on prod right now* — the deployed events Lambda still gates its whole recompute on
   `projectChanged || plantChanged`. Prod took three such edits in the 72h before authoring. Applying
   the repair before the promote wastes part of it. There is no breaking coupling either way: the new
   arms compute from `event_log`, never from the cache.
2. **Then prod:** `--phase pre` → `--phase sweep` (records 15 / 0) → `0b-data.sql` → `--phase post`.
3. **Then staging**, whenever next refreshed.

Re-running is the cheap, correct remedy if drift reappears — the repair is idempotent.

```bash
export NEON_DATABASE_URL=...   # never on the command line (L-067)
python3 scripts/gate_runner.py --migration migrations/v4-cachefwdgap-001 --env prod --phase pre
python3 scripts/gate_runner.py --migration migrations/v4-cachefwdgap-001 --env prod --phase sweep
psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/v4-cachefwdgap-001/0b-data.sql
python3 scripts/gate_runner.py --migration migrations/v4-cachefwdgap-001 --env prod --phase post
```

## User-visible effect

26 of 28 cells move by ≤12 hours **within the same calendar day** — cosmetic. The two that matter are
door D, both on live plantings currently showing a stale last-harvest date in the app:

- Italian Parsley: last harvest `2026-07-11` → `2026-07-22`
- Strawberries: last harvest `2026-06-21` → `2026-07-29`

Door B's 15 cells land on five archived plantings with no live surface, and `next_water_at` stays
NULL, so the daily-plan engine is unaffected.

Per-user: **Dave 15 rows / 28 cells, Jen 0.** Jen's zero is genuine but sits on a 35-event sample —
evidence of no exposure yet, not of immunity.

## Follow-ups this investigation opened

- `post_no_cache_ahead_of_event_log` (already applied, and copied verbatim into
  `reanchor-carecache.int.test.js`'s `staleForward()`) is one column short — it does not test
  `last_issue_at` in the AHEAD direction. Test-and-gate-only change.
- `reanchor-carecache.int.test.js` should gain a `staleBehind()` twin. It asserts a vacated anchor
  walks *down* and never asserts a target anchor walks *up* — which is why GAP 1 shipped.
- `e9d8909`'s commit message says "NO MIGRATION… the exposure is entirely forward-looking." That was
  wrong, and wrong for precisely the reason this ticket exists: it rested on the ahead-only detector
  reading 0. Three prod rows had already drifted behind before that commit was written.
