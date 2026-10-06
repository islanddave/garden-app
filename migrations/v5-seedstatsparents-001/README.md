# v5-seedstatsparents-001 — two stats views learn that a seed lot can have several parents

Replaces two of the season-stats views. `stat_saved_lot` keeps its 22 columns and gains `parent_count` last;
`stat_source_card` keeps its 12 columns and counts a planting as "saved" when it is a recorded seed parent
of a live lot **or** the lot's cached parent. No table, no column on a table, no row. The decisions are in
the header of `0a-replace-views.sql`; the release contract is
`project-state/_seedmultiparent-20261005/r2/R2A-CONTRACT.md` sections 1 and 5 in gardening-docs.

**Applied to STAGING on 2026-10-06 by the orchestrator** (pre, sweep, `0a`, post; all three rollbacks rehearsed newest first, pre green again, re-applied; the stats receipts clean; the whole standing corpus green). **Applied to PROD on 2026-10-06 at 16:25Z on Dave's approval** (AskUserQuestion, first-hand: "Yes, apply them"): pre gates green, `0a`, post gates green, the stats receipts clean on real rows (29 lots, 274 plantings, every difference 0), pre-apply copy `sitting-seedr2a-prod-preapply-20261006` (expires 2026-10-13).

| file | what it does |
|---|---|
| `0a-replace-views.sql` | `CREATE OR REPLACE` of both views, stamp `5.0.0-seedstatsparents-001`. One transaction. Refuses unless `seed_lot_parent_planting` exists and both live views are the definitions it captured. Idempotent. |
| `0v-verify-receipts.sql` | Read-only. Compares each new view with the old definition in one statement (`EXCEPT ALL`, both directions) and prints twelve numbered lines. Run after `0a` on each environment. |
| `0r-rollback.sql` | Puts both views back to the `v5-seasonstats-001` definitions (re-issuing `stat_saved_lot`'s grants) and removes the stamp. Guarded: refuses while `stat_saved_lot` is wider than this migration left it. |
| `gates.yml` | 7 `pre`, no `sweep`, 7 `post`: one apply-window receipt, five catalog-only standing gates armed on the stamp, one row-level gate that names only the existing view and `lot_id`. |

Needs `v5-seedmultiparent-001` (the views read its table). One stamp.

## What changes for a reader

| | before | after |
|---|---|---|
| `stat_saved_lot` columns | 22 | the same 22, then `parent_count integer` |
| `stat_saved_lot` rows | one per lot | one per lot |
| `parent_planting_id`, `parent_name`, `parent_lb` | the cached parent | unchanged: the cached parent |
| `parent_count` | — | `GREATEST(live seed_parent link rows for the lot, 1 if the cache is set else 0)` |
| `stat_source_card.saved_lots` | plantings that are the cached parent of a live lot | plantings that are a live seed parent of a live lot, or the cached parent of one |
| every other `stat_source_card` column | | unchanged |

**With no pooled lot in the data, both views return what they returned before.** A pooled lot's second and
later parents each raise one source card's `saved_lots` by one; nothing else moves.

`parent_count`, cell by cell: a live `seed_parent` row counts whether or not its **planting** is
soft-deleted or archived (deleting a planting does not unsay that seed was taken from it); a soft-deleted
link row (a parent removed from the lot) and a `pollen_parent` row do not count; a lot whose cache is set
and whose link row is missing reads 1, not 0; a lot with no parent at all reads 0. It counts plantings, not
plants — the number of plants is `inventory_items.seed_parent_plant_count` (`v5-seedplantcount-001`).

`lot_parent` is a `UNION`, never `UNION ALL`: `count(*)` and `sum(quantity)` ride the join to it, so a
planting listed twice doubles its card. On the rehearsal fixture, swapping in `UNION ALL` took one card
from 2 plantings / 5 plants / 2.000 lb to 5 / 14 / 8.000.

## Order of work

One of three directories in release 2a (`v5-varietyblend-001`, `v5-seedplantcount-001`,
`v5-seedstatsparents-001`). Independent of the other two; roll back newest first.

1. **The databases first.** Staging, then prod with Dave's approval.
2. **Only then the dev push** that carries this directory and the harvests reader that selects
   `parent_count`.

`migrations/v5-seasonstats-001/gates.yml` is **not edited**. Its `post_stat_saved_lot_columns` counts 22
named columns, not the view's width, so the 23rd column leaves it green on either database in either
order; adding a 23rd name there would red on whichever database had not had this file applied.
`parent_count` is asserted in this directory's `gates.yml`, on this stamp, and
`lambda/harvests/stat-views-columns.test.js` reads both files. The spelling of that gate's
`table_name = 'stat_saved_lot' AND column_name IN ('parent_count')` line is what the test matches; keep it.

## Applying

Run from the repo root, with the URL in the environment (never on a command line that is logged).

```bash
# --- staging -----------------------------------------------------------------------------------
python3 scripts/gate_runner.py --migration migrations/v5-seedstatsparents-001 --env staging --phase pre
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-seedstatsparents-001/0a-replace-views.sql
python3 scripts/gate_runner.py --migration migrations/v5-seedstatsparents-001 --env staging --phase post
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-seedstatsparents-001/0v-verify-receipts.sql
python3 scripts/gate_runner.py --migration migrations/v5-seasonstats-001 --env staging --phase post

# staging only — rehearse the rollback, then put it back:
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-seedstatsparents-001/0r-rollback.sql
python3 scripts/gate_runner.py --migration migrations/v5-seedstatsparents-001 --env staging --phase pre
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-seedstatsparents-001/0a-replace-views.sql
python3 scripts/gate_runner.py --migration migrations/v5-seedstatsparents-001 --env staging --phase post

# --- prod (Dave's approval; outside 07:00-08:00 UTC; after the pre-apply copy) -------------------
# the copy is made once for the release: migrations/v5-varietyblend-001/README.md "Applying"
python3 scripts/gate_runner.py --migration migrations/v5-seedstatsparents-001 --env prod --phase pre
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-seedstatsparents-001/0a-replace-views.sql
python3 scripts/gate_runner.py --migration migrations/v5-seedstatsparents-001 --env prod --phase post
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-seedstatsparents-001/0v-verify-receipts.sql
python3 scripts/gate_runner.py --migration migrations/v5-seasonstats-001 --env prod --phase post
```

There is no `sweep` phase: nothing is created by name. Prod gets `0a` only; the rollback is rehearsed on
staging and not on prod.

Do not apply prod DDL between 07:00 and 08:00 UTC (the nightly dump at 07:00 and `restore-verify` at 08:00).

Any `pre` failure is a stop. After `0a` the `pre` phase reads 2 of 7 by design; it is not run again except
after a rollback, where it must read 7 of 7 — that is the receipt that `0r` restored both views exactly.

**The prod `pre` phase is the first read of prod's two views.** The definitions were read on staging
(PostgreSQL 17.11): `stat_saved_lot` md5 `84bb54726a6f72a67374bb163167664e`, `stat_source_card` md5
`fff2cb4c63b310668ca186902948e48b`. Prod was not read by the lane that wrote this. The two
`pre_*_is_the_captured_definition` gates on prod are that check, and `0a` repeats it inside its transaction
and refuses, changing nothing, on a mismatch. If one fails: diff `pg_get_viewdef(..., true)` against
`migrations/v5-seasonstats-001/0a-additive-ddl.sql`.

`0a` sets `lock_timeout = '5s'`. Each replace takes a brief ACCESS EXCLUSIVE lock on its view; behind a
long season-stats read the file fails fast having changed nothing. Run it again.

## Receipts

`0v-verify-receipts.sql` is the apply receipt the regression review asked for (finding R2-05): "before
`EXCEPT ALL` after, both ways". It evaluates the old definition and the new view in one statement, so the
two sides see one snapshot and a seed lot saved mid-apply cannot appear as a difference. It opens a
read-only transaction and rolls it back. Keep its output with the apply record.

| line | measures | must be |
|---|---|---|
| 1, 2 | `stat_saved_lot`, its 22 original columns, old minus new and new minus old | 0 and 0, always |
| 3, 4 | `stat_source_card`, all 12 columns, old minus new and new minus old | 0 and 0 when line 5 is 0; otherwise equal to each other and at most line 5 |
| 5 | plantings that are a seed parent of a live lot and the cached parent of none | information; 0 while no lot is pooled |
| 6 | lots with a cached parent and `parent_count` below 1 | 0 |
| 7 | lots whose `parent_count` is not `GREATEST(live seed_parent rows, cache set)` | 0 |
| 8, 9 | rows, and distinct lots, of `stat_saved_lot` | equal |
| 10 | lots with `parent_count` above 1 | information: the pooled lots |
| 11, 12 | sum of `plantings` across `stat_source_card`, and rows of `stat_planting` | equal |

**Expected on staging and on prod today: lines 1-4 all 0.** That holds exactly while line 5 is 0. If line 5
is not 0, a lot has already been pooled through the release-1 set route; lines 3 and 4 then count the
source cards whose `saved_lots` rose, which is the change working, and each such card differs from its old
row in `saved_lots` alone. On every lot with a cached parent `parent_count` is at least 1 (line 6), and
exactly 1 unless the lot is pooled (line 10).

## Rollback

`0r-rollback.sql` restores both views and removes the stamp. No data is lost: views hold none. Three things
to know before using it:

1. **Nothing in the repo has to move first.** Five standing gates are catalog-only and return to vacuous
   with the stamp gone. The row-level gate names only `public.stat_saved_lot` and `lot_id`, which are still
   there afterwards. (That one gate would have to move to a `.pending` file before a rollback of
   `v5-seasonstats-001` itself, which drops the view.)
2. **Code back before schema back.** Once the release-2a harvests Lambda is live it selects `parent_count`;
   with the column gone the season-stats read is a 42703. After that the holding state is "leave the
   views".
3. **Newest first, both ways.** A later migration that appends another column to `stat_saved_lot` is rolled
   back before this one (the file refuses unless the view is exactly the 23 columns `0a` left). And this
   file is what `migrations/v5-seedmultiparent-001/0r-rollback.sql` waits for: while these views read
   `seed_lot_parent_planting`, that rollback refuses up front and names them.

`stat_saved_lot` is narrowed with `DROP VIEW` + `CREATE VIEW` (Postgres cannot remove a view column with
`CREATE OR REPLACE`), the one path that loses grants; the file reads the view's own grants before the drop
and re-issues each one after. `stat_source_card` keeps its columns, so it is a `CREATE OR REPLACE` and
keeps its grants.

## What was rehearsed, and where

On a throwaway local PostgreSQL 17.10, loaded from a schema-only read of staging (17.11) on 2026-10-06 —
the view md5 values reproduce there byte for byte — with staging's 161 stamps copied in:

- `pg_get_viewdef` of the new views diffed against the live ones: `stat_saved_lot` differs only by the
  appended expression, `stat_source_card` only inside `lot_parent`;
- **no pooled lot** (a one-parent lot, a lot with a cache and no link row, a lot with a stage and no
  parent, a soft-deleted lot, a non-seed row): `pre` 7/7, `0a`, `post` 7/7; a snapshot of both views taken
  before `0a`, `EXCEPT ALL` against the views after, both directions: 0 rows for the lot view's 22 columns
  and 0 rows for the card; `parent_count` 1, 1 and 0;
- `0a` again leaves the catalog dump and `applied_at` byte-equal; `0r`, after which both md5 values are the
  captured ones and the schema dump is byte-equal to the one before `0a`; `0r` again changes nothing;
- **a planted two-parent lot** (parents A, the cache, and B, link only, under different sources; one
  retired link; one `pollen_parent` row) and a lot one of whose two parents is a soft-deleted planting:
  the lot view's 22 columns 0 rows both directions; the card 1 row each direction — B's source,
  `saved_lots` 0 → 1 — and nothing else; card totals for plantings, plants and lb equal before and after,
  with A a parent of two lots and both a link parent and the cache; `parent_count` 2 on both pooled lots;
  the receipts file agreeing line for line;
- `0a` refusing without the link table and on a view changed in place; `0r` refusing with a 24th column
  appended; `0a` giving up after 5s behind a held lock; grants on both views identical after `0a` and after
  `0r`;
- `migrations/v5-seedmultiparent-001/0r-rollback.sql` refusing while these views are in place and
  proceeding after this directory's `0r`;
- 8 single defects injected one at a time (stamp deleted, `UNION ALL`, either arm of `lot_parent` removed,
  a view option set on either view, `parent_count` rewritten as a join, both views put back with the stamp
  left), each turning exactly the gates written for it red and clearing on undo;
- the whole standing corpus before and after all three release-2a directories were applied: no existing
  gate changed status, `v5-seasonstats-001`'s 22-name gate included.

**Not rehearsed:** anything on staging or prod beyond catalog reads of staging — in particular the receipts
file has not been run against real rows; the harvests reader.
