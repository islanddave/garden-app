# v5-seedlotaddition-001: seed picked later goes into a seed lot that already exists

One new table, `seed_lot_addition`: one row per later picking put into an existing saved-seed lot. A row
names the parent link it came off (`seed_lot_parent_planting.id`, which names the lot and the planting),
the day, and the amounts as they were typed. The lot's own total stays on `inventory_items` and is moved by
the handler in the same statement that writes the row. Nothing on `inventory_items`, `plants` or
`seed_lot_parent_planting` changes. The decisions are in the header of `0a-additive-ddl.sql`; the release
contract is `project-state/_seedmultiparent-20261005/r3/R3-CONTRACT.md` section 1 in gardening-docs.

**Not applied anywhere by the lane that wrote it. Applying to prod is a prod database change and needs Dave's first-hand OK.**

| file | what it does |
|---|---|
| `0a-additive-ddl.sql` | The table (13 columns), one RESTRICT foreign key to `seed_lot_parent_planting(id)`, five CHECKs, `uq_sla_addition_key` (unique, not partial), `idx_sla_parent_link` (plain), stamp `5.0.0-seedlotaddition-001`. One transaction. Writes no rows. Idempotent. |
| `0r-rollback.sql` | Drops the table and the stamp. Guarded: refuses while any picking row exists, live or soft-deleted. Goes before `v5-seedmultiparent-001`'s rollback. |
| `gates.yml` | 3 `pre`, 2 `sweep`, 11 standing `post`. Every `post` gate is catalog-only and self-armed on the stamp. No row-level gate: the five CHECKs and the foreign key are the row rules. |

One stamp, fixed at first apply and never edited. No `0b` and no `0c`: nothing is backfilled, and all five
CHECKs ship armed with the table, because no deployed code names it and it is born empty.

## Order of work

This order is binding, and step 3 is not negotiable.

1. **Nothing of this release is pushed to dev before step 3.** The lane branch is the only remote ref that
   carries it.
2. **Staging apply**, before the server lane starts.
3. **Prod apply**, on Dave's first-hand OK, BEFORE any commit that names `seed_lot_addition` under
   `lambda/**` (the module, `index.js`, or the contract key) reaches `dev`.

Why: the promote's prod schema gate reads dev's handlers against prod. From the moment a handler that names
this table is on dev, every promote by every session is refused, a hotfix included, until the table is on
prod; a missing relation cannot be waived. The table is inert on prod before its code: nothing deployed
names it and it is empty, so no CHECK and no RESTRICT can fire.

This directory by itself is safe in the tree before either database is applied. No gate here names the
table or one of its columns as a SQL identifier, so every `post` gate is vacuous (not erroring) on a
database without it. Measured on the rehearsal database with the DDL absent: `post` 11 of 11.

## Applying

Run from the repo root, with the URL in the environment (never on a command line that is logged).

```bash
# --- staging (before the server lane) ------------------------------------------------------------
python3 scripts/gate_runner.py --migration migrations/v5-seedlotaddition-001 --env staging --phase pre
python3 scripts/gate_runner.py --migration migrations/v5-seedlotaddition-001 --env staging --phase sweep
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-seedlotaddition-001/0a-additive-ddl.sql
python3 scripts/gate_runner.py --migration migrations/v5-seedlotaddition-001 --env staging --phase post

# staging only: rehearse the rollback, then put it back
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-seedlotaddition-001/0r-rollback.sql
python3 scripts/gate_runner.py --migration migrations/v5-seedlotaddition-001 --env staging --phase pre
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-seedlotaddition-001/0a-additive-ddl.sql
python3 scripts/gate_runner.py --migration migrations/v5-seedlotaddition-001 --env staging --phase post
python3 scripts/gate_runner.py --all --env staging --phase post --continuous-only

# --- prod (Dave's first-hand OK; outside 07:00-08:00 UTC; after the pre-apply copy) ----------------
python3 scripts/neon_safety_branch.py --env-file .env.local create --slug seedr3 --days 7
python3 scripts/gate_runner.py --migration migrations/v5-seedlotaddition-001 --env prod --phase pre
python3 scripts/gate_runner.py --migration migrations/v5-seedlotaddition-001 --env prod --phase sweep
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-seedlotaddition-001/0a-additive-ddl.sql
python3 scripts/gate_runner.py --migration migrations/v5-seedlotaddition-001 --env prod --phase post
python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only
```

Prod gets `0a` only; the rollback is rehearsed on staging and not on prod.

**Do not apply prod DDL between 07:00 and 08:00 UTC**: the nightly dump runs at 07:00 and `restore-verify`
at 08:00 compares table sets, so a table added between them reds that one run. This file adds a table.

Any `pre` or `sweep` failure is a stop. After `0a` the `pre` phase reads 1 of 3 by design
(`pre_table_absent` and `pre_not_already_applied` are `continuous: false` and false once applied) and the
`sweep` gates find the migration's own objects (0 of 2); neither is run again except after a rollback,
where `pre` must read 3 of 3.

`0a` sets `lock_timeout = '5s'`. Adding the foreign key takes a brief lock on `seed_lot_parent_planting`;
behind a long-open transaction the file fails fast (psql exits 3, `55P03`) having changed nothing. Run it
again.

**The two databases differ on one grant from the first minute.** `0a` grants nothing. Prod has a default
ACL for the owner role that gives `garden_ro` SELECT on new tables (live read, 2026-10-07), so `garden_ro`
can read `seed_lot_addition` on prod at birth; staging has no such default ACL. Accepted, same as the
sibling table. No gate asserts the grant or its absence.

## What the constraints do to a writer

| write | answer |
|---|---|
| a count of 1 or more with its basis (`seed_count_estimated` true or false) | accepted |
| a weight above 0 (after rounding to 3 places) | accepted |
| neither a count nor a weight, both `_applied` flags false | accepted: the planting and the day are still recorded |
| an amount with its `_applied` flag false (the lot had no total of that kind) | accepted |
| a count of 0 or below | 23514 `chk_sla_seed_count_positive` |
| a count with no basis, or a basis with no count | 23514 `chk_sla_count_basis_pairing` |
| a weight of 0 or below, or one that rounds to 0.000 (0.0004) | 23514 `chk_sla_seed_weight_positive` |
| `count_applied` true with no count | 23514 `chk_sla_count_applied_needs_count` |
| `weight_applied` true with no weight | 23514 `chk_sla_weight_applied_needs_weight` |
| an INSERT that leaves out `count_applied` or `weight_applied` | 23502: neither has a default |
| a second row with the same `addition_key`, even after the first was soft-deleted | 23505 `uq_sla_addition_key` |
| a `parent_link_id` that names no link row | 23503 `seed_lot_addition_parent_link_id_fkey` |
| a HARD delete of a link row that has pickings | 23503 `seed_lot_addition_parent_link_id_fkey`: delete the pickings first |
| a soft delete of a link row, or a merge repointing its `plant_id` | unaffected: the pickings stay on the link row |
| a weight of 10,000,000 g or more | 22003: the column is `numeric(10,3)` |

`seed_weight_g` is rounded by Postgres to 3 places before the CHECK runs. Nothing in the database ties a
picking's amounts to the lot's total.

## Rollback

`0r-rollback.sql` drops the table and removes the stamp. Four things to know before using it:

1. **This directory's `0r` goes before `migrations/v5-seedmultiparent-001/0r-rollback.sql`.** This table's
   foreign key points at `seed_lot_parent_planting`, and that file's `DROP TABLE` has no CASCADE: while this
   table exists it stops on the dependent foreign key with a raw 2BP01, changing nothing. It fails closed;
   no guard was added there. Newest first.
2. **Nothing in the repo has to move first.** Every gate here is catalog-only and returns to vacuous with
   the stamp gone.
3. **Code back before schema back.** It is a clean undo only while no code on dev names the table. The
   release-3 inventory-items Lambda reads `seed_lot_addition` on every add and writes it in the statement
   that moves the lot's total; with the table gone both are a 42P01. The holding state "leave the table"
   starts when that handler is ON DEV, not when it is live, because the promote's prod schema gate reads
   dev's handlers against prod.
4. **It refuses while it would lose something.** A picking row is the only record of that picking. The file
   stops, changing nothing, while any row exists, live or soft-deleted, and says how many of each. Getting
   past that is Dave's decision, with the rows exported first.

## Other surfaces this touches

- **The public site is not involved.** `gam-site` does not read this table in this release. That was read
  at gam-site's local `b8bba5f` by the release contract; its remote head is re-checked by the orchestrator
  before the ship ask (contract section 8.3).
- **A planting merge does not repoint this table and never needs to.** Merge repoints link rows; a picking
  follows its link row. Read "this planting's pickings in this lot" by joining link rows on
  `(inventory_item_id, plant_id)`, never on a link id.
- **Anything that hard-deletes link rows now has to delete pickings first.** That is tests and operators
  only: `tests/integration/_cleanup.js` and the staging smoke sweep in `deploy-staging.yml` each gain a
  child-first step in the server lane of this release, not here.
- Not tripped: the `inventory_items` foreign-key census (`v5-invrefstrand-001`), `delete-guard.js`,
  `lambda/plants/merge.js` SURFACES, the `cascade-sweep` class guard (the key is RESTRICT).

## What was rehearsed, and where

On a throwaway local PostgreSQL 17.10 (the sibling directories record prod and staging as 17.11), loopback
only, on 2026-10-07, against a minimal schema:
`schema_version`, `plants` and `inventory_items` cut down to the columns and constraints these files and
the sibling's read, and `seed_lot_parent_planting` created by the repo's own
`v5-seedmultiparent-001/0a-additive-ddl.sql`. Its 4 constraints and 4 indexes were compared with the live
prod read of 2026-10-07 and are equal. Gates were run through `scripts/gate_runner.py`.

- unapplied: `pre` 3/3, `sweep` 2/2, `post` 11/11 (vacuous, none erroring); `0a`; `post` 11/11; `0a` again
  leaves the schema dump and the stamp row (`applied_at` included) byte-equal;
- `0a` behind a held lock on `seed_lot_parent_planting`: psql exit 3 with 55P03 after 5.0 s, schema dump
  byte-equal to before, no stamp;
- every line of the table above, against real rows: 11 legal shapes accepted, 19 refused each with the
  SQLSTATE and constraint name shown; the replay key refused twice (once after its row was soft-deleted);
- `0r` refusing with 13 rows, with exactly one live row, and with one row that was soft-deleted, each time
  leaving the table, the rows and the stamp as they were; with none, `0r` leaving a schema dump byte-equal to
  the one before `0a`; `0r` again a no-op; `pre` 3/3, `0a`, `post` 11/11 again;
- 32 single defects injected one at a time, at least one per `post` gate, each turning exactly the gate
  written for it red and no other, and clearing on undo; the schema dump byte-equal afterwards;
- the rollback order: `v5-seedmultiparent-001/0r-rollback.sql` with this table present exits 3 with 2BP01
  and changes nothing; this directory's `0r` first, then that one, both exit 0; `0a` with the link table
  gone exits 3 and leaves nothing behind, and `pre_link_table_present` says so first;
- the staging sequence above (pre, sweep, `0a`, post, `0r`, pre, `0a`, post) on a fresh database, every
  step exit 0;
- prod's default ACL shape: `garden_ro` has SELECT on the new table at birth and no INSERT; `post` 11/11
  either way;
- `v5-seedmultiparent-001` `post` 16/16 before and after this `0a`, and the `inventory_items` foreign-key
  census of `v5-invrefstrand-001` (armed for the rehearsal) green before and after; a foreign key from this
  table to `inventory_items` reds both that census and `post_no_fk_to_inventory_items_or_plants`.

**Not rehearsed:** anything on staging or prod; the whole standing corpus (`--all`) against a real schema;
the handler that writes the table; the two triggers on `inventory_items` (no file here writes that table).
