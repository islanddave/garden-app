# v5-newlotnoidempotencykey-001: a retried "save new seed lot" answers with the first lot

One nullable column, `inventory_items.idempotency_key` (uuid), and one partial unique index,
`uq_inventory_items_idempotency_key`. It is where the server will keep the key the phone now sends with a
new lot's create (`POST /api/inventory-items`, body field `idempotency_key`), so a create that is sent twice
makes one lot. Ledger `BUG-NEWLOTNOIDEMPOTENCYKEY-001`. The decisions are in the header of
`0a-additive-ddl.sql`.

**Not applied anywhere by the lane that wrote it (2026-10-13). No SQL in this directory has been run
against PostgreSQL**: the lane had no database. The files were parsed with the PostgreSQL grammar
(libpg_query) for syntax, and `gates.yml` passes `gate_runner.py --validate-only`; that is all. Rehearse on
staging before anything else. Applying to prod is a prod database change and needs Dave's first-hand OK.

| file | what it does |
|---|---|
| `0a-additive-ddl.sql` | The column (uuid, nullable, no default), `uq_inventory_items_idempotency_key` UNIQUE `(idempotency_key) WHERE idempotency_key IS NOT NULL`, stamp `5.0.0-newlotnoidempotencykey-001`. One transaction. Checks the database before and its own result after, and raises rather than commit another shape. Writes no rows. Idempotent. |
| `0r-rollback.sql` | Drops the column (its index goes with it) and the stamp. No refusal guard: a key is not something a person typed (see Rollback). |
| `gates.yml` | 3 `pre`, 1 `sweep`, 4 standing `post`. Every `post` gate is catalog-only and self-armed on the stamp. No row-level gate: the index is the row rule. |

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
column as a SQL identifier, so every `post` gate is vacuous, not erroring, on a database without it. **That
is by construction and has not been measured**: see "What was checked".

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
inventory reads and writes wait for that long. Not measured. `0a` sets `lock_timeout = '5s'`: behind a
long-open transaction the file fails fast (psql exits 3, `55P03`) having changed nothing. Run it again.

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

## What was checked, and what was not

Checked, with no database:

- `python3 scripts/gate_runner.py --all --env prod --validate-only` (the CI step) and
  `scripts/test_gate_runner.py`: this `gates.yml` parses and meets the strict schema;
- every statement in `0a`, `0r` and every gate parses under the PostgreSQL grammar (libpg_query through
  `pglast`), the two `DO` bodies as PL/pgSQL. Syntax only: no catalog, no types, no execution;
- the index assertion is the one `v5-pantry-001` runs green on prod for the same predicate, with the table
  and index names changed.

**Not rehearsed, anywhere:** `0a`, `0r`, any gate, the lock behaviour, the refusal paths of `0a` step 0 and
step 3, a second run being a no-op, the `post` gates being vacuous on an unapplied database, and the whole
standing corpus before and after. The sibling directories record all of those on a local PostgreSQL 17;
this one records none.
