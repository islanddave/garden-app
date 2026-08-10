# V4-CACHEMISSINGROW-001 — plantings with events and no cache row

**Status:** authored, gate-validated, and **round-tripped against live prod inside `BEGIN`/`ROLLBACK`**
(`INSERT 0 8`, all six post gates 0, `DELETE 8` with **0 skipped**, state exactly restored).
**Nothing applied.** **BLOCKED on BUG-ROLLUPLIFECYCLE-001 being deployed — see Apply order.**
**Ticket:** V4-CACHEMISSINGROW-001. **schema_version:** `4.23.5-cachemissingrow-001`.
**Found by:** `sweep_capture_plantings_with_events_and_no_cache_row` in `v4-cachefwdgap-001/gates.yml`
— an informational gate that counted this population on its way past and handed it a ticket instead
of leaving it uncounted. This file is that ticket.

## The defect

`entity_memory` caches "when was this planting last watered / fertilized / pruned / observed /
harvested / flagged". 14 plantings on prod carry surviving `event_log` rows and **no plant-keyed
cache row at all**.

They are invisible to both shipped drift detectors, and the reason generalises well past this
ticket. `post_no_cache_behind_event_log` and `post_no_cache_ahead_of_event_log` both enumerate
`FROM entity_memory`, so each is a statement about cache **rows**, not about **plantings**, and each
silently carries the qualifier *"for every entity that HAS a cache row"*. A planting with no row is
neither ahead nor behind — it is not a row.

> **The rule:** an invariant of the form *"for every X, property P holds"* must be enumerated FROM
> the relation that **defines X**, never from the relation that **carries P**.

## Root cause, and it is in the tree

`migrations/care-rekey-001/0b-backfill.sql` built the plant arm with
`WHERE p.deleted_at IS NULL AND p.archived_at IS NULL`. Every planting already non-live at re-key
time was skipped — and because it was archived, no forward write ever came along to create the row.
Nothing papered over it, and nothing could see it.

Forward exposure is already closed: BUG-CACHEGATE-001's arm (inside v4.3.0, events Lambda deployed
2026-08-07 20:59:56Z) creates the row on the next plant-anchored edit. These are historical.

## Scope: archived YES, soft-deleted NO

| | rows | repaired? | why |
|---|---|---|---|
| archived (`deleted_at IS NULL`) | 8 | **yes** | a completed record; still readable at `/plants/:id` |
| soft-deleted | 6 | **no** | a *retracted* record — and the system already says so |
| live | 0 | n/a | measured, not assumed (`sweep_capture_live_plantings_…`) |

The exclusion is not caution. `scripts/integrity-weekly-check.sh`'s **`entity_memory_orphans`**
metric counts, as an orphan, exactly `em.plant_id IS NOT NULL AND NOT EXISTS (plants p WHERE
p.id = em.plant_id AND p.deleted_at IS NULL)`. A cache row on a soft-deleted planting **is** that
predicate. Backfilling the 6 would manufacture six rows a shipped alert metric names as defects,
taking it **5 → 11** against a committed baseline of **4** and turning the Monday
`integrity-weekly` cron red — for no benefit, because a soft-deleted planting is excluded from every
rollup (`gp.deleted_at IS NULL`) and 404s on the by-id read. Zero read surface, 100% of the breach.

The semantics agree with the metric: an **archive is a completion** of a record, a **soft-delete is
a retraction** of it. A repudiated planting should have no care memory.

The excluded 6 are **measured and owned** by
`sweep_capture_soft_deleted_plantings_with_events_and_no_cache_row`. Leaving a defect population
uncounted is exactly how the population *this* file repairs went unowned for three months.

> **Pre-existing finding, not caused by this migration:** `entity_memory_orphans` already reads **5**
> against its committed baseline of **4**. That +1 is unexplained and will alert on the next Monday
> cron regardless of this file. It needs its own look.

## What the repair writes

The seven recency columns, computed exactly as the **deployed plant-keyed writer** computes them —
including its harvest mapping `IN ('harvest','first_harvest')`, which differs from the project arm's
`= 'harvest'`. That asymmetry is real, deployed, and already encoded in the shipped gates.

`next_water_at` / `location_type` / `watering_interval_days` stay NULL because the plant-keyed writer
does not carry them; `post_backfilled_rows_carry_no_engine_columns` asserts that rather than trusting
it.

**One deliberate divergence, and this file does not claim byte-for-byte parity:** the writer's
conflict action is `DO UPDATE SET`, this file's is `DO NOTHING`. `DO UPDATE` would rewrite every
pre-existing plant-keyed row and could annex both `v4-carecacheundo-001`'s AHEAD population and
`v4-cachefwdgap-001`'s BEHIND population, destroying the before/after evidence each owns.
`post_no_preexisting_cache_row_was_touched` catches that edit.

Writing a *deliberately false* value instead — e.g. leaving `last_watered_at` NULL so the dashboard's
`COALESCE` fallback could not fire — was considered and is **foreclosed**, not merely undesirable:
`post_no_cache_behind_event_log` is already applied and continuous, and its `IS NOT NULL` guards
make a NULL cell over a non-NULL truth count as BEHIND. The backfill would ship its own gate red on
the day of apply. Fix the reader, not the cache.

## Apply order — this one IS order-sensitive

`v4-cachefwdgap-001` opens with *"No ordering constraint. Apply whenever convenient."* **That does
not transfer.** It was a `GREATEST` UPDATE with an algebraic non-interference proof; this file
creates rows, and a new row enters the container rollups immediately.

**BUG-ROLLUPLIFECYCLE-001 (code) must be deployed first.** Until it is, the 8 new archived-planting
rows drag the dashboard's legacy water-due `MIN(COALESCE(next_water_at, last_watered_at + interval))`
backwards and flip the **Lettuce** container from not-due (2026-08-12) to falsely water-due
(2026-06-26). Measured. `pre_rollup_lifecycle_fix_is_deployed` refuses to run without it.

The asymmetry is worth stating plainly, because it inverts the usual intuition: **the half that needs
a promote carries zero standalone risk** (the rollup fix strictly improves prod today — it removes a
live false positive on Peppers), **and the half that needs no approval carries all of it.** Sequence
on risk, not on ceremony cost. Data-applied + code-stalled is the one state strictly worse than doing
nothing.

Note that `promote-gate.yml`'s coupled deploy job is the **SPA only** — `deploy-lambda.yml` is a
separate `push:main` workflow. "Promote succeeded" does **not** mean the rollup fix is live.

```bash
export NEON_DATABASE_URL=...   # never on the command line (L-067)
# 0. BUG-ROLLUPLIFECYCLE-001 promoted AND deploy-lambda settled AND Peppers verified no longer due
python3 scripts/gate_runner.py --migration migrations/v4-cachemissingrow-001 --env prod --phase pre
python3 scripts/gate_runner.py --migration migrations/v4-cachemissingrow-001 --env prod --phase sweep
psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/v4-cachemissingrow-001/0b-data.sql
python3 scripts/gate_runner.py --migration migrations/v4-cachemissingrow-001 --env prod --phase post
# then STAGING, same session — see below
```

**Staging is not optional and not "whenever next refreshed."** `gate-invariants.yml` runs the
continuous post gates against prod **and** staging on the same Tuesday cron. A prod-only apply leaves
post-1/2/3 permanently red on staging, which is how a gate corpus decays into background noise
everyone learns to ignore. Staging's population is its own — re-measure, never assume 8.

## Rollback

An INSERT's undo is a **DELETE**, so it needs its own contract rather than the siblings' UPDATE one.
`0r` carries five guards (provenance / untouched / no-activity-since / **footprint** / parent
stability) and reports rather than force-deletes anything that fails one. The footprint guard has no
sibling analogue and is the important one: the repair writes 8 columns and a DELETE destroys 11+, so
a non-NULL value in a column the repair never touched means another writer adopted the row.

Round-tripped against prod inside `BEGIN`/`ROLLBACK`: `INSERT 8` → six post gates all 0 → `DELETE 8`,
**0 skipped** → rowless population back to 14, orphans back to 5.

## User-visible effect

Small and honest: the 8 archived plantings' detail pages (`/plants/:id`) gain a real care history
where they showed none. No live planting is affected, no container rollup `MAX()` moves on prod
today (verified across all seven columns), and after BUG-ROLLUPLIFECYCLE-001 the new rows are inert
on every actionable surface by construction.

Per-user: **Dave 7, Jen 1** (Baby Spinach) of the repaired 8.

## What this closes and what it opens

- **Closes V4-DRIFTDETECTBOTH-001.** `post_no_cache_ahead_of_event_log` here is
  `v4-carecacheundo-001`'s invariant widened to 7 columns, adding `last_issue_at`. Causal, not
  tidiness: this file is the first bulk writer of plant-keyed `last_issue_at` on rows that never
  carried one, so the one column with no ahead-detector is the one column it newly populates. The
  two applied 6-column copies stay as historical records of what was asserted at their apply; **this
  file carries the current invariant.** The integration twins (`staleForward()` / `staleBehind()`)
  were already 7-column — only the migration-gate half was outstanding.
- **Opens:** the project arm of the same class is now measured for the first time
  (`sweep_capture_projects_with_events_and_no_cache_row`). If it reads non-zero it needs its own
  ticket rather than a silent fold-in here.
- **Opens:** `entity_memory_orphans` at 5 vs a baseline of 4, pre-existing and unexplained.
