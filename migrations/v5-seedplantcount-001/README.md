# v5-seedplantcount-001 — how many plants a saved-seed lot was taken from

One nullable column, `inventory_items.seed_parent_plant_count`, and two CHECKs. It records the number of
PLANTS seed was taken from, which is neither the number of parent plantings (count the live `seed_parent`
rows of `seed_lot_parent_planting`) nor their summed quantity. The decisions are in the header of
`0a-additive-ddl.sql`; the release contract is
`project-state/_seedmultiparent-20261005/r2/R2A-CONTRACT.md` sections 1 and 3 in gardening-docs.

**Applied to STAGING on 2026-10-06 by the orchestrator** (pre, sweep, `0a`, post; all three rollbacks rehearsed newest first, pre green again, re-applied; the stats receipts clean; the whole standing corpus green). **Applied to PROD on 2026-10-06 at 16:25Z on Dave's approval** (AskUserQuestion, first-hand: "Yes, apply them"): pre gates green, `0a`, post gates green, the stats receipts clean on real rows (29 lots, 274 plantings, every difference 0), pre-apply copy `sitting-seedr2a-prod-preapply-20261006` (expires 2026-10-13).

| file | what it does |
|---|---|
| `0a-additive-ddl.sql` | The column (integer, nullable, no default), `chk_inventory_seed_parent_plant_count_seeds_only`, `chk_inventory_seed_parent_plant_count_positive`, stamp `5.0.0-seedplantcount-001`. One transaction. Writes no rows. Idempotent. |
| `0r-rollback.sql` | Drops the two CHECKs, the column and the stamp. Guarded: refuses while any row has a recorded count. |
| `gates.yml` | 4 `pre`, 1 `sweep`, 4 standing `post`. Every `post` gate is catalog-only and self-armed on the stamp. No row-level gate: the two CHECKs are the row rules. |

One stamp. Both CHECKs ship with the column: every writer deployed today leaves it NULL, and both admit
NULL.

## Order of work

One of three directories in release 2a (`v5-varietyblend-001`, `v5-seedplantcount-001`,
`v5-seedstatsparents-001`). Independent of the other two; roll back newest first.

1. **The databases first.** Staging, then prod with Dave's approval.
2. **Only then the dev push** that carries this directory and the Lambda code that names the column.

That order is what the two sibling directories need, and this one follows it so the release has one order.
On its own this directory would also be safe pushed first: no gate here names the column as a SQL
identifier, so every `post` gate is vacuous (not erroring) on a database without it. Measured on the
rehearsal database with the DDL absent: `post` 4 of 4.

## Applying

Run from the repo root, with the URL in the environment (never on a command line that is logged).

```bash
# --- staging -----------------------------------------------------------------------------------
python3 scripts/gate_runner.py --migration migrations/v5-seedplantcount-001 --env staging --phase pre
python3 scripts/gate_runner.py --migration migrations/v5-seedplantcount-001 --env staging --phase sweep
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-seedplantcount-001/0a-additive-ddl.sql
python3 scripts/gate_runner.py --migration migrations/v5-seedplantcount-001 --env staging --phase post

# staging only — rehearse the rollback, then put it back:
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-seedplantcount-001/0r-rollback.sql
python3 scripts/gate_runner.py --migration migrations/v5-seedplantcount-001 --env staging --phase pre
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-seedplantcount-001/0a-additive-ddl.sql
python3 scripts/gate_runner.py --migration migrations/v5-seedplantcount-001 --env staging --phase post

# --- prod (Dave's approval; outside 07:00-08:00 UTC; after the pre-apply copy) -------------------
# the copy is made once for the release: migrations/v5-varietyblend-001/README.md "Applying"
python3 scripts/gate_runner.py --migration migrations/v5-seedplantcount-001 --env prod --phase pre
python3 scripts/gate_runner.py --migration migrations/v5-seedplantcount-001 --env prod --phase sweep
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-seedplantcount-001/0a-additive-ddl.sql
python3 scripts/gate_runner.py --migration migrations/v5-seedplantcount-001 --env prod --phase post
```

Prod gets `0a` only; the rollback is rehearsed on staging and not on prod.

Do not apply prod DDL between 07:00 and 08:00 UTC (the nightly dump at 07:00 and `restore-verify` at 08:00).
This file adds no table, so it would not red that run by itself; the rule is kept so the three directories
of the release are applied in one sitting under one rule.

Any `pre` or `sweep` failure is a stop. After `0a` the `pre` phase reads 2 of 4 by design
(`pre_column_absent`, `pre_not_already_applied`) and the `sweep` gate finds the migration's own
constraints; neither is run again except after a rollback, where `pre` must read 4 of 4.

`0a` sets `lock_timeout = '5s'`. Adding the column and each CHECK takes a brief ACCESS EXCLUSIVE lock on
`inventory_items`; behind a long-open transaction the file fails fast having changed nothing. Run it again.

## What the two CHECKs do to a writer

| write | answer |
|---|---|
| a seeds lot with a count of 1 or more | accepted |
| a count of 0 or below | 23514 `chk_inventory_seed_parent_plant_count_positive` |
| a count on a row whose category is not `seeds` | 23514 `chk_inventory_seed_parent_plant_count_seeds_only` |
| re-filing a lot that has a count out of Seeds (the wide PUT assigns `category`) | 23514 `chk_inventory_seed_parent_plant_count_seeds_only`, until the count is cleared |
| anything that does not name the column | unaffected: the column stays NULL and both CHECKs pass on NULL |

Both names are keys in the inventory-items constraint-message map. There is no upper bound in the database;
the handler caps at 9999. Nothing ties the count to the lot's parent plantings: a lot may carry a count and
no parent row.

## Rollback

**Revert the public site first (since gam-site `23e4a87`, 2026-10-07).** The Gardens at Mathews site's export now reads what this migration added. Put gam-site's saved-seed generator back to its `1ef08da` form and publish that BEFORE running this rollback, or the site's Gate 1 stops every publish, not only `/seed/`.

`0r-rollback.sql` drops the CHECKs, the column and the stamp. Three things to know before using it:

1. **Nothing in the repo has to move first.** Every gate here is catalog-only and returns to vacuous with
   the stamp gone.
2. **Code back before schema back.** It is a clean undo only while no deployed code names the column. Once
   the release-2a inventory-items Lambda is live, `PUT /api/inventory-items/:id/seed-measure` names it and
   echoes it; with the column gone that statement is a 42703. After that the holding state is "leave the
   column".
3. **It refuses while it would lose something.** A recorded plant count is something a person counted; it
   exists nowhere else. The file stops, changing nothing, while any row (live or soft-deleted) has one, and
   says how many. Getting past that is Dave's decision, with the values exported first.

## Other surfaces this touches

- The public site's export gate (`gam-site/tools/gates.py`) reads the live columns of `inventory_items`.
  `seed_parent_plant_count` matches none of its row-filter stems, so it prints PENDING CLASSIFICATION, not
  a failure, until the manifest lists it under `excluded:`. No grant is needed while it is not published.

## What was rehearsed, and where

On a throwaway local PostgreSQL 17.10, loaded from a schema-only read of staging (17.11) on 2026-10-06, with
staging's 161 stamps copied in:

- unapplied: `pre` 4/4, `sweep` 1/1, `post` 4/4 (vacuous, none erroring); `0a`; `post` 4/4; `0a` again
  leaves the catalog dump and `applied_at` byte-equal;
- every line of the table above, against real rows, with both `inventory_items` triggers
  (`prevent_ownership_transfer`, `set_updated_at`) enabled for the updates;
- `0r` refusing with two counted lots (one of them soft-deleted); with the counts cleared, `0r` leaving a
  schema dump byte-equal to the one before `0a`; `0r` again a no-op; `pre` 4/4, `0a`, `post` 4/4 again;
- 8 single defects injected one at a time (stamp deleted, a default, the column retyped, a CHECK dropped,
  loosened, re-added NOT VALID or given another term, a pairing CHECK added), each turning exactly the gate
  written for it red and clearing on undo;
- the whole standing corpus before and after all three release-2a directories were applied: no existing
  gate changed status.

**Not rehearsed:** anything on staging or prod; the seed-measure route itself.
