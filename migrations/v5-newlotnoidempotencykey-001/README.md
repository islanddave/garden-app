# v5-newlotnoidempotencykey-001: a retried "save new seed lot" answers with the first lot

One nullable column, `inventory_items.idempotency_key` (uuid), and one partial unique index,
`uq_inventory_items_idempotency_key`. It is where the server will keep the key the phone now sends with a
new lot's create (`POST /api/inventory-items`, body field `idempotency_key`), so a create that is sent twice
makes one lot. Ledger `BUG-NEWLOTNOIDEMPOTENCYKEY-001`. The decisions are in the header of
`0a-additive-ddl.sql`.

**Not applied to staging or prod.** Written 2026-10-13 by a lane with no database, then rehearsed the same
day on a throwaway local PostgreSQL 17.10 (see "What was rehearsed, and where"). The staging apply is still
the first time these files meet the real `inventory_items`. Applying to prod is a prod database change and
needs Dave's first-hand OK.

| file | what it does |
|---|---|
| `0a-additive-ddl.sql` | The column (uuid, nullable, no default), `uq_inventory_items_idempotency_key` UNIQUE `(idempotency_key) WHERE idempotency_key IS NOT NULL`, stamp `5.0.0-newlotnoidempotencykey-001`. One transaction. Checks the database before and its own result after, and raises rather than commit another shape. Writes no rows. Idempotent. |
| `0r-rollback.sql` | Drops the column (its index goes with it) and the stamp. No refusal guard: a key is not something a person typed (see Rollback). |
| `gates.yml` | 3 `pre`, 1 `sweep`, 4 standing `post`. Every `post` gate is catalog-only and self-armed on the stamp. No row-level gate: the index is the row rule. |
| `rehearse_local.py` | The three files above on a throwaway local Postgres, re-runnable: the whole sequence, what the index does to a write, and a planted defect for every gate and every refusal. `python3 migrations/v5-newlotnoidempotencykey-001/rehearse_local.py`, about 25 s. Writes only to the cluster it creates. |

One stamp. No CHECK and no NOT NULL: every writer deployed today leaves the column NULL.

## In plain words

The app gets a place to remember "I already saved this one", so tapping Save twice on a new seed lot, or
saving again after a dropped connection, can stop making two lots. Nothing changes on screen until the
release that uses it ships.

## Why this shape

It is the shape the three keyed creates already in this database use, read in their migrations and in the
handlers that depend on them:

| table | column | index |
|---|---|---|
| `pantry_item` (`v5-pantry-001`) | `idempotency_key uuid` | `uq_pantry_item_idempotency_key (idempotency_key) WHERE idempotency_key IS NOT NULL` |
| `recipe` (`v5-recipes-001`) | `idempotency_key uuid` | `uq_recipe_idempotency_key`, same |
| `kitchen_batch` (`v5-putupmake-001`) | `idempotency_key uuid` | `uq_kitchen_batch_idempotency_key`, same |

Nullable, no default. Global: no household or owner column in the key. Partial on `IS NOT NULL` only, not on
`deleted_at`, so a soft-deleted row still holds its key. The client half
(`lane/t3-newlotkey-20261012`, `src/components/seed/seedLotKey.js`) sends a uuid v4 from `mintKey()` in the
body field `idempotency_key`, which is the column's name.

## What the server half copies

Not built here. `lambda/preservation/recipeRoutes.js` (`replayRecipe`, `createRecipe`) is the pattern:

1. Validate the key as a uuid when present. A create with no key stays legal (older clients; every non-seed
   create), and writes NULL.
2. `INSERT ... idempotency_key = ${key}::uuid`. Never `ON CONFLICT DO NOTHING` on the row.
3. Catch `err.code === '23505' && err.constraint === 'uq_inventory_items_idempotency_key'`: re-read by key.
   A live row inside `created_by = ANY(householdIds)` is a replay (200, the first lot, `replayed: true`); a
   key held by a row outside the household, or by a soft-deleted row, is a 409 key conflict with no payload.
4. Two things this table has that the three siblings do not, for that lane to decide: the list and detail
   reads select `i.*` and the create answers `RETURNING *`, so once keys are written the key is echoed to
   every reader of the lot (`pantryItems.js` deliberately never echoes its key back); and the create writes
   more than one row (parent links, the stage log), so the replay has to answer with the lot as the first
   request left it.

## Order of work

Independent of every other directory. Ships with the server half of `BUG-NEWLOTNOIDEMPOTENCYKEY-001`.

1. **Staging apply.**
2. **Prod apply**, on Dave's first-hand OK, BEFORE any commit whose Lambda names
   `inventory_items.idempotency_key` reaches `dev`.
3. Only then the server half.

Why: the promote's prod schema gate reads dev's handlers against prod. From the moment a handler that names
this column is on dev, every promote by every session is refused, a hotfix included, until the column is on
prod (a column can be waived in `scripts/schema-audit-allowlist.json`; applying it is the house rule).

This directory by itself is safe in the tree before either database is applied. No gate here names the
column as a SQL identifier, so every `post` gate is vacuous, not erroring, on a database without it.
Measured on the rehearsal database with the DDL absent: `post` 4 of 4, and 4 of 4 under `--continuous-only`.

## Applying

Run from the repo root, with the URL in the environment (never on a command line that is logged).

```bash
# --- staging -------------------------------------------------------------------------------------
python3 scripts/gate_runner.py --migration migrations/v5-newlotnoidempotencykey-001 --env staging --phase pre
python3 scripts/gate_runner.py --migration migrations/v5-newlotnoidempotencykey-001 --env staging --phase sweep
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-newlotnoidempotencykey-001/0a-additive-ddl.sql
python3 scripts/gate_runner.py --migration migrations/v5-newlotnoidempotencykey-001 --env staging --phase post

# staging only: rehearse the rollback, then put it back
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-newlotnoidempotencykey-001/0r-rollback.sql
python3 scripts/gate_runner.py --migration migrations/v5-newlotnoidempotencykey-001 --env staging --phase pre
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-newlotnoidempotencykey-001/0a-additive-ddl.sql
python3 scripts/gate_runner.py --migration migrations/v5-newlotnoidempotencykey-001 --env staging --phase post
python3 scripts/gate_runner.py --all --env staging --phase post --continuous-only

# --- prod (Dave's first-hand OK; outside 07:00-08:00 UTC; after the pre-apply copy) ----------------
python3 scripts/neon_safety_branch.py --env-file .env.local create --slug newlotkey --days 7
python3 scripts/gate_runner.py --migration migrations/v5-newlotnoidempotencykey-001 --env prod --phase pre
python3 scripts/gate_runner.py --migration migrations/v5-newlotnoidempotencykey-001 --env prod --phase sweep
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-newlotnoidempotencykey-001/0a-additive-ddl.sql
python3 scripts/gate_runner.py --migration migrations/v5-newlotnoidempotencykey-001 --env prod --phase post
python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only
```

Prod gets `0a` only; the rollback is rehearsed on staging and not on prod.

Do not apply prod DDL between 07:00 and 08:00 UTC (the nightly dump at 07:00 and `restore-verify` at 08:00).
This file adds no table, so it would not red that run by itself; the rule is kept so there is one rule.

Any `pre` or `sweep` failure is a stop. After `0a` the `pre` phase reads 1 of 3 by design
(`pre_column_absent` and `pre_not_already_applied` are `continuous: false` and false once applied) and the
`sweep` gate finds the migration's own index; neither is run again except after a rollback, where `pre`
must read 3 of 3.

## What it locks, and for how long

`ADD COLUMN` takes an ACCESS EXCLUSIVE lock on `inventory_items` and holds it to COMMIT; the index is built
under it. The column is nullable with no default, so the table is not rewritten, and every existing key is
NULL, so the index is born empty. The table is small (its seed lots alone were 260 in August, per
`v4-seedsaveflow-001/gates.yml`; this lane counted nothing), so the transaction should be milliseconds, and
inventory reads and writes wait for that long. Not measured on the real table. `0a` sets
`lock_timeout = '5s'`: behind a long-open transaction the file fails fast (psql exits 3, `55P03`, after
5.0 s in the rehearsal) having changed nothing. Run it again.

## Would the currently deployed code break on this?

No. Read on `origin/dev` `1f58a9d8`, which is what prod runs.

- **Writers.** One statement inserts into `inventory_items` (`lambda/inventory-items/index.js`, the POST arm)
  and it is an explicit column list without this column. The wide PUT and every other UPDATE are explicit SET
  lists. So every row a deployed writer makes or changes leaves the column NULL, and NULL is outside the
  index: no deployed write can raise 23505 here. `validateCreate` and `validateUpdate` do not refuse unknown
  body keys, so a client that already sends `idempotency_key` is ignored exactly as today.
- **Readers.** The list and detail reads select `i.*`, and POST and PUT answer `RETURNING *`. From the apply
  on, each lot in an API answer carries one more key, `"idempotency_key": null`. No client code reads it.
  Every column added to this table before did the same.
- **Views.** `v_sow_candidates` and the others list their columns; none changes.
- **Triggers.** `prevent_ownership_transfer` and `set_updated_at` fire on row writes. This file writes no row.

## What the index does to a writer

| write | answer |
|---|---|
| anything that does not name the column (every deployed writer) | unaffected: the column stays NULL |
| a create with a key no row holds | accepted |
| a second create with the same key, even after the first row was soft-deleted | 23505 `uq_inventory_items_idempotency_key` |
| two creates with one key at the same instant | one is accepted; the other waits, then 23505 |
| any number of rows with a NULL key | accepted |
| a key that is not a uuid | 22P02 at the bind, before the index is reached |

## Rollback

`0r-rollback.sql` drops the column, and with it the index, and removes the stamp.

1. **Nothing in the repo has to move first.** Every gate here is catalog-only and returns to vacuous with the
   stamp gone.
2. **Code back before schema back.** It is a clean undo only while no code on dev names the column. Once the
   server half is on dev, the create's INSERT and its replay read name it; with the column gone both are a
   42703 and nothing can be added to inventory. After that the holding state is "leave the column".
3. **The public site.** If gam-site's `public-export.yaml` has listed `idempotency_key` by then, take it out
   there and publish first: its gate fails on a column the manifest names and the table no longer has.
4. **It does not refuse on data, on purpose.** A key is a random uuid the phone made; the client lets go of
   it ten minutes after its create last went out, and it names nothing. It is under the Soft-Delete-Only
   Rule's carve-out by name ("idempotency keys"). The file prints how many keys it dropped.

## Other surfaces this touches

- **The public site's export gate** (`gam-site/tools/gates.py`, read at its local `abecec2`) reads the live
  columns of `inventory_items`. `idempotency_key` matches none of its row-filter stems, so it prints PENDING
  CLASSIFICATION, not a failure, until the manifest lists it under `excluded:`. No producer emits an unnamed
  column, so it reaches no page.
- **The staging drift check** reports a staging-only column as information between the two applies, never as
  a finding.
- Not tripped, by reading: the `inventory_items` foreign-key census (`v5-invrefstrand-001`; this adds no
  key), `scripts/merge-surface-inventory.py` (the column name matches none of its patterns), the column
  gates of `v5-seedqty-001` and its neighbours (none counts the table's columns), and the gates that find
  this table's other indexes by name.

## What was rehearsed, and where

On a throwaway local PostgreSQL 17.10 (the sibling directories record prod and staging as 17.11), loopback
only, on 2026-10-13, by `rehearse_local.py` in this directory, against a minimal schema: `schema_version`
created by the repo's own statement (`v2-mvp-critter/0a-additive-ddl.sql`), and `inventory_items` cut down
to ten columns chosen for the rehearsal, because no migration in this repo creates that table. Gates were
run through `scripts/gate_runner.py`. 62 checks, all holding, in 24 s.

- unapplied: `pre` 3/3, `sweep` 1/1, `post` 4/4 (vacuous, none erroring), and 4/4 for the
  `--phase post --continuous-only` run `gate-invariants.yml` makes; `0a`; `post` 4/4; `pre` 1/3 and `sweep`
  0/1, as "Applying" says; `0a` again leaves the schema dump, the stamp row (`applied_at` included) and every
  row byte-equal;
- `0r` leaving the schema dump, `schema_version` and every row byte-equal to the state before `0a`; `0r`
  again a no-op; `pre` 3/3, `0a`, `post` 4/4 again; `0r`, `0a` and `0a` again arriving with an empty
  `search_path`, each exit 0;
- `0a` behind a reader's open transaction on `inventory_items`: psql exit 3 with 55P03 after 5.0 s, schema
  dump and rows as before, no stamp; the same file again, exit 0;
- every line of the table in "What the index does to a writer", against real rows: five rows with a NULL key
  side by side; a key accepted once; the same key refused on INSERT and on UPDATE, and again **after its row
  was soft-deleted**, each time 23505 naming `uq_inventory_items_idempotency_key`; a second key accepted; a
  key that is not a uuid, 22P02; two creates with one key in two sessions, the second waiting 1.5 s for the
  first and then 23505 on the same name, or accepted when the first rolls back;
- the index statements of `pantry_item`, `recipe` and `kitchen_batch`, read out of their own migrations and
  built on stub tables beside this one: the server prints all four definitions as the same text with the
  names changed, `... USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL)`. None is partial on
  `deleted_at`;
- 8 starting states `0a` must refuse (the column already there as text, with a default, NOT NULL; the index
  name taken by an index on another table or by a table; the index already there partial on `deleted_at` or
  not unique; no `inventory_items`): each refused with the schema dump and `schema_version` as before, and
  each announced first by a red `pre` or `sweep` gate. A ninth (the column in the right shape, no index) is
  completed, `post` 4/4;
- 19 single defects on an applied database (the stamp deleted; a default, NOT NULL, text; the index dropped,
  not unique, partial on `deleted_at`, unpartial, given an owner column, NULLS NOT DISTINCT, moved to another
  table, left INVALID by a failed concurrent build; a second index, plain, unique, composite, on an
  expression, or reading the column in its predicate; a CHECK; a UNIQUE constraint), each turning exactly
  the gate written for it red and no other; two controls green;
- `0r` with two keyed rows, one soft-deleted: no refusal, by design; it prints 2, drops the column and
  keeps every row. With a view reading the column: 2BP01, nothing changed. On a database `0a` never ran on:
  a no-op;
- two mutated copies of `0a` (a default on the column; the index also partial on `deleted_at`): `0a`'s own
  step 3 refuses each, and the script exits 1.

**Found by the rehearsal and fixed here:** `post_nothing_else_names_the_column` read an index's key columns
only. A second unique index on an expression over the column (`(idempotency_key::text)`), or any index whose
predicate reads it, left the gate green: the first would answer a replay with a 23505 under a name the
handler does not test for. The gate now also reads the index's expressions and predicate. Nothing else in
`0a`, `0r` or the gates changed.

**Not rehearsed:** anything on staging or prod; the real `inventory_items` (its two triggers, its CHECKs,
the views over it, row security, and the columns the fixture leaves out); how long the lock is held on the
real table; the whole standing corpus (`--all`) against a real schema; the handler that will write the key.
