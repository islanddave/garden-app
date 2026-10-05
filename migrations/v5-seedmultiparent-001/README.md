# v5-seedmultiparent-001 — a saved-seed lot may come from more than one planting

One new table, `seed_lot_parent_planting`: the plantings a saved-seed lot came from, one row per
(lot, planting, role). `inventory_items.source_plant_id` stays, as a **member cache**: NULL exactly when the
lot has no live `seed_parent` row, otherwise the `plant_id` of one of them. Nothing on `inventory_items` or
`plants` changes. The decisions are in the header of `0a-additive-ddl.sql`; the release contract is
`project-state/_seedmultiparent-20261005/R1-CONTRACT.md` in gardening-docs.

**Not applied anywhere by the lane that wrote it. Applying to prod is a prod write and needs Dave's approval.**

| file | what it does |
|---|---|
| `0a-additive-ddl.sql` | The table, two RESTRICT foreign keys, `chk_slpp_role`, three indexes, stamp `5.0.0-seedmultiparent-001`. One transaction. Writes no rows. Idempotent. |
| `0b-reconcile.sql` | Makes the table agree with the column on every lot that has at most one live row; lists, without writing, any lot with two or more whose cache is not one of them. **Run twice by design** (below). Writes no stamp. Idempotent. |
| `0c-arm.sql` | Post-deploy. Refuses unless both row-level invariants return zero rows, then writes stamp `5.0.0-seedmultiparent-001b`. Idempotent. |
| `0r-rollback.sql` | Drops the table and both stamps. Guarded: refuses while any live row exists that the column could not rebuild. Has a window — read its header. |
| `gates.yml` | 4 `pre`, 3 `sweep`, 14 standing `post`. Every `post` gate is catalog-only and self-armed on stamp 001, including the feed gate for the fifth foreign key to `inventory_items`. |
| `gates-rowlevel.yml.pending` | The two row-level gates, armed on stamp 001b. **Not loaded by the runner under this name.** They join `gates.yml` in push 2. |

Stamps are fixed at first apply and never edited: every standing gate arms on one.

## Order of work

There are two pushes and they are not interchangeable.

**Push 1 — to dev, BEFORE any database is touched.** This directory, plus three edits elsewhere that belong
to it:

- `migrations/v5-invrefstrand-001/gates.yml` — the census allowlist gains
  `('seed_lot_parent_planting_inventory_item_id_fkey', 'r')`. The four-name feed gate keeps its `<> 4`.
- `lambda/inventory-items/delete-guard.js` — the new foreign key is classified in `FOLLOWING_RELATIONS`
  (a parent link never blocks a lot delete), with `delete-gate-coverage.test.js` holding the list, the
  allowlist and the two feed gates together.
- `tests/integration/_cleanup.js` — a child-first `seed_lot_parent_planting` step ahead of
  `inventory_items` and `plants`.

Why first: this table's foreign key to `inventory_items` is a fifth one, and
`post_inventory_fk_census_is_unchanged` is armed on prod and staging and reds on any foreign key outside
its allowlist. An extra name in a `NOT IN` list excludes nothing, so the widened census is green before
the table exists and green after. Everything in push 1 is inert on an unapplied database: the new gates are
vacuous without the stamp, the cleanup step checks the table exists before it runs, and `delete-guard.js`
names the table in a list, not in SQL. Measured read-only through `gate_runner` on 2026-10-05, with
neither environment applied: this directory 21/21 on prod and 21/21 on staging; `v5-invrefstrand-001`
standing gates 3/3 on both.

> **The Tuesday cron reads `main`, not dev.** `gate-invariants.yml` runs on every `migrations/**` push to
> dev and on a cron, Tuesdays 13:00 UTC; a scheduled run checks out the default branch. Until a promote
> carries push 1 to `main`, main's copy of the census still lists four names. So an apply on **either**
> environment before that promote turns the next Tuesday run red on that environment
> (`post_inventory_fk_census_is_unchanged`, one row). Either promote push 1 first — it names the table in
> no handler SQL, so the promote's prod schema gate has nothing to refuse — or apply knowing it and record
> the expected red.

**Then the databases** — staging first, then prod with Dave's approval. Commands below.

**Then the Lambda release** that reads and writes the table (not in this directory). The table must be on
staging before that code reaches dev CI and on prod before its promote.

**Then, on each environment, once that release is live there:** `0b-reconcile.sql` again, then `0c-arm.sql`.

**Push 2 — only when BOTH environments carry stamp `001b`.** Append the two gates in
`gates-rowlevel.yml.pending` to the `post:` list of `gates.yml`, delete the pending file, push.

## Applying

Run from the repo root, with the URL in the environment (never on a command line that is logged).

```bash
# --- staging -----------------------------------------------------------------------------------
python3 scripts/gate_runner.py --migration migrations/v5-seedmultiparent-001 --env staging --phase pre
python3 scripts/gate_runner.py --migration migrations/v5-seedmultiparent-001 --env staging --phase sweep
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-seedmultiparent-001/0a-additive-ddl.sql
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-seedmultiparent-001/0b-reconcile.sql
python3 scripts/gate_runner.py --migration migrations/v5-seedmultiparent-001 --env staging --phase post
python3 scripts/gate_runner.py --migration migrations/v5-invrefstrand-001   --env staging --phase post

# staging only — rehearse the rollback, then put it back:
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-seedmultiparent-001/0r-rollback.sql
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-seedmultiparent-001/0a-additive-ddl.sql
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-seedmultiparent-001/0b-reconcile.sql
python3 scripts/gate_runner.py --migration migrations/v5-seedmultiparent-001 --env staging --phase post

# --- prod (Dave's approval) --------------------------------------------------------------------
python3 scripts/gate_runner.py --migration migrations/v5-seedmultiparent-001 --env prod --phase pre
python3 scripts/gate_runner.py --migration migrations/v5-seedmultiparent-001 --env prod --phase sweep
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-seedmultiparent-001/0a-additive-ddl.sql
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-seedmultiparent-001/0b-reconcile.sql
python3 scripts/gate_runner.py --migration migrations/v5-seedmultiparent-001 --env prod --phase post
python3 scripts/gate_runner.py --migration migrations/v5-invrefstrand-001   --env prod --phase post
```

Any `pre` or `sweep` failure is a stop. After `0a`, the `pre` phase reads 2 of 4 by design
(`pre_table_absent`, `pre_not_already_applied`) and the `sweep` name-collision gates find the migration's
own objects; neither is run again.

`0a` sets `lock_timeout = '5s'`. Adding a foreign key takes a brief lock on `inventory_items` and on
`plants`; behind a long-open transaction the file fails fast having changed nothing. Run it again.

`0b` takes two locks, in the order the new handler takes its own: `FOR KEY SHARE` on the lot rows that
carry a `source_plant_id` (it blocks a parent edit on those lots for the milliseconds the file runs, and
nothing else — an ordinary update of the lot goes through), then `SHARE ROW EXCLUSIVE` on the new table
(link-row writers wait; readers do not). Same 5s timeout, same answer: psql exits 3, nothing was written,
run it again. The order matters and must stay: taken the other way round, `0b` and a parent edit on the same
lot deadlock, and Postgres may abort the edit instead of `0b`.

## Expected counts

`0b` prints one row per step: what it did, how many rows it wrote, and which lots.

| | R1 (retired) | R2 (inserted) | R3 (listed) |
|---|---|---|---|
| **prod, first run** | 0 | **24** — 22 live lots + 2 soft-deleted | none |
| prod, an immediate second run | 0 | 0 | none |
| **staging, first run** | 0 | **0** | none |
| either, the post-deploy run | one per lot whose parent was changed or cleared in the window | one per lot whose parent was saved or changed in the window | none |

Measured read-only on 2026-10-05: prod has 24 `inventory_items` rows with a `source_plant_id` (2 of them
soft-deleted lots), all with the same owner as their parent planting; staging has none. So `0b` on staging
exercises no row, and R1, R2 and R3 were proven on a local Postgres instead (below). The "after" row must
read `0 | 0` before `0c` will stamp.

`0b` is **not filtered by the lot's `deleted_at`**: a soft-deleted lot that still carries the column gets
its row too, because a link row follows its lot and a restored lot must come back consistent.

## The window, and why 0b runs twice

Between `0a` and the new Lambda, the deployed Lambda keeps writing `inventory_items.source_plant_id` and
has never heard of the table. It **writes the column only.** Three things follow, and an insert-if-missing
backfill repairs only the first:

- a **new** lot saved with a parent: column set, no row;
- a lot whose parent is **changed** from A to B: column B, live row A — read later as a two-parent lot
  nobody recorded;
- a lot whose parent is **cleared**: column NULL, live row A — the parent Dave removed comes back.

Nothing reads the table during the window, so none of this is visible; it becomes wrong the moment the new
Lambda starts reading. That is why the second run is a reconcile, and why it comes straight after the new
Lambda is live and before `0c`. On a lot with at most one live row the column wins (the old Lambda can
produce no other kind of lot); a lot with two or more live rows was written by the new Lambda on purpose
and is never rewritten — if its cache is NULL or not one of its parents it is listed for a person (R3).

The window **reopens on a Lambda revert**: a reverted fleet writes the column only. After any revert and
re-promote, run `0b` again before trusting the row-level gates.

## After the Lambda release is live on an environment

"Live" means the deployed `inventory-items` and `plants` functions are the promoted build
(`scripts/verify-deploy.py`), not that the promote reported success.

```bash
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-seedmultiparent-001/0b-reconcile.sql
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-seedmultiparent-001/0c-arm.sql
# and the same two against "$NEON_DATABASE_URL" once prod's release is live
```

`0c` refuses, writing nothing (psql exits 3), while either invariant returns a row, and says how many:

1. every `inventory_items` row with a non-NULL `source_plant_id` has a live `seed_parent` row for that
   plant;
2. every lot with a live `seed_parent` row has a non-NULL `source_plant_id`.

Neither filters on the lot's `deleted_at`. A refusal is answered by running `0b`; if `0b` lists lots under
R3, a person decides those. Do not arm around them.

## Push 2 — the row-level gates

Only when this returns two rows on prod **and** two rows on staging:

```sql
SELECT version FROM public.schema_version WHERE version LIKE '5.0.0-seedmultiparent-001%';
```

Then append the two items under `post:` in `gates-rowlevel.yml.pending` to the `post:` list of `gates.yml`,
delete the pending file, validate, push:

```bash
python3 scripts/gate_runner.py --migration migrations/v5-seedmultiparent-001 --env prod --validate-only
python3 scripts/gate_runner.py --migration migrations/v5-seedmultiparent-001 --env staging --phase post
python3 scripts/gate_runner.py --migration migrations/v5-seedmultiparent-001 --env prod --phase post
```

Why they wait: both `SELECT FROM public.seed_lot_parent_planting`, and Postgres resolves a relation name at
parse time. On a database without the table they do not go vacuous under their stamp guard, they error
(42P01), and an erroring gate reds the run for every migration in the tree. Why the second stamp: armed on
001 they would be red from the first save in the window.

## Rollback

`0r-rollback.sql` drops the table and removes both stamps. Three things to know before using it:

1. **If push 2 has happened, undo it first.** Move the two row-level gates out of `gates.yml` (back to the
   pending file), push, and let that reach the branch whose corpus runs against the database — dev for the
   push-triggered run, `main` for the cron. With the table gone they error rather than pass.
2. **It is a clean undo only while no deployed code names the table.** Once the Lambda release is live, or
   on dev, dropping the table turns every seed read into a 42P01. After that the holding state is "leave
   the table": it is inert to code that does not name it.
3. **It refuses while it would lose something.** The column can rebuild one link per lot. Any other live
   row — a second parent, a pollen parent, a row that disagrees with its lot's column — exists only in the
   table, and the file stops, changing nothing, while one is there. Window drift is cleared by running `0b`
   first. Real pooled lots are Dave's decision.

What may stay in the repo after a rollback: the census allowlist line (a name that matches no constraint
excludes nothing), this directory's `gates.yml` (every gate returns to vacuous with the stamp gone), the
`FOLLOWING_RELATIONS` entry, and the `_cleanup.js` step.

To disarm the row-level gates without touching the table, delete the `001b` row only.

## What was rehearsed, and where

On a throwaway local PostgreSQL 17.10 (prod and staging are 17.11), against a minimal schema whose
definitions were copied from a read-only read of the prod catalog, 2026-10-05:

- `0a` twice — the second run leaves the catalog and the stamp row (including `applied_at`) byte-equal;
- `0b` as a backfill, then again writing nothing; then after a simulated window: R1 retired the changed and
  the cleared parent, R2 inserted the changed and the new one, R3 listed a pooled lot with a NULL cache and
  one whose cache was not a member, and a pooled lot whose cache was a member, a pollen-parent row and a
  soft-deleted lot were handled as described;
- `0c` refusing with the right counts, then stamping once the two R3 lots were settled by hand, then again
  changing nothing;
- the row-level gates erroring without the table, vacuous without `001b`, green when armed and clean, red
  when a column-only write broke the rule;
- every `post` gate green after the apply and vacuous before it; 25 single defects injected one at a time,
  each turning exactly the gate written for it red (and the census in `v5-invrefstrand-001` where a foreign
  key to `inventory_items` was involved);
- `0r` refusing over pooled lots, refusing over window drift until `0b` ran, then dropping cleanly; a
  second run a no-op; `0a` + `0b` + `post` again afterwards;
- `tests/integration/_cleanup.js`, driven through its own `sweepFixtures`: without the new step the teardown
  fails 23503 on `inventory_items` and `plants`; with it the fixtures go and no other row is touched; on a
  database without the table the step is skipped.

- `0b`'s locks: a 5s timeout with nothing written when either lock is held elsewhere; and against a
  transaction shaped like the handler's (lot `FOR UPDATE`, then link-row writes) on the same drifted lot —
  both commit with the locks in this order, and the handler's transaction is aborted (40P01) with the lot
  locks left out.

**Not rehearsed:** anything on staging or prod beyond read-only gate runs; the two triggers on
`inventory_items` (no file here writes that table); `0b` racing the deployed Lambda itself (the handler's
lock order was imitated from `lambda/inventory-items/seed-lot-parents.js`, not run).
