# v5-varietyblend-001 — a named mix is a variety row

`plant_varieties.blend_key` (the mix's leaf variety ids, sorted and comma-joined), the `public.cultivar` view
widened 47 → 48 so the varieties Lambda can see it, and one new table, `variety_blend_component`, listing the
leaves with foreign keys. The decisions are in the header of `0a-additive-ddl.sql`; the release contract is
`project-state/_seedmultiparent-20261005/r2/R2A-CONTRACT.md` section 1 in gardening-docs.

**Applied to STAGING on 2026-10-06 by the orchestrator** (pre, sweep, `0a`, post; all three rollbacks rehearsed newest first, pre green again, re-applied; the stats receipts clean; the whole standing corpus green). **Applied to PROD on 2026-10-06 at 16:25Z on Dave's approval** (AskUserQuestion, first-hand: "Yes, apply them"): pre gates green, `0a`, post gates green, the stats receipts clean on real rows (29 lots, 274 plantings, every difference 0), pre-apply copy `sitting-seedr2a-prod-preapply-20261006` (expires 2026-10-13).

| file | what it does |
|---|---|
| `0a-additive-ddl.sql` | The column, its format CHECK, the partial unique index, the view widen, the table with two RESTRICT foreign keys, `chk_vbc_not_self` and three indexes, stamp `5.0.0-varietyblend-001`. One transaction. Refuses unless the live view is the definition it captured. Writes no rows. Idempotent. |
| `0r-rollback.sql` | Narrows the view back to 47 columns (re-issuing its grants), drops the table, the index, the CHECK, the column and the stamp. Guarded: refuses while any variety carries a `blend_key` or any component row exists, and while the view is wider than this migration left it. |
| `gates.yml` | 9 `pre`, 2 `sweep`, 23 `post`. Two `post` gates are apply-window receipts. Seventeen are catalog-only and self-armed on the stamp (one of them prod-only). **The last four are row-level and name the new column and table** — see "The row-level gates". |

One stamp. There is no second, arming stamp: no deployed or reverted writer can produce a row that breaks a
gate here (each leaves `blend_key` NULL and writes no component row).

## Order of work

This is one of three directories in release 2a (`v5-varietyblend-001`, `v5-seedplantcount-001`,
`v5-seedstatsparents-001`). They do not depend on each other and may be applied in any order; roll back
**newest first**.

1. **The databases first.** Staging, then prod with Dave's approval. Commands below.
2. **Only then the dev push** that carries this directory, its `gates.yml` and the Lambda code that names
   `blend_key`.

This is the opposite order from `v5-seedmultiparent-001`, which pushed first because its table added a
foreign key under a census that was already armed. Nothing here is censused, and four of this file's gates
name the new column and table as SQL identifiers, so they error wherever the DDL is missing.

> **Two runs read the gate corpus, and they read different branches.** `gate-invariants.yml` runs on every
> `migrations/**` push to dev and on a cron, Tuesdays 13:00 UTC; the scheduled run checks out `main`. With
> the DDL on both databases before the push, both are green: dev's copy has the gates and the databases
> have the objects; main's copy gets the gates only at the promote, by which time prod has had them longest.

## Applying

Run from the repo root, with the URL in the environment (never on a command line that is logged).

```bash
# --- staging -----------------------------------------------------------------------------------
python3 scripts/gate_runner.py --migration migrations/v5-varietyblend-001 --env staging --phase pre
python3 scripts/gate_runner.py --migration migrations/v5-varietyblend-001 --env staging --phase sweep
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-varietyblend-001/0a-additive-ddl.sql
python3 scripts/gate_runner.py --migration migrations/v5-varietyblend-001 --env staging --phase post

# staging only — rehearse the rollback, then put it back:
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-varietyblend-001/0r-rollback.sql
python3 scripts/gate_runner.py --migration migrations/v5-varietyblend-001 --env staging --phase pre
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-varietyblend-001/0a-additive-ddl.sql
python3 scripts/gate_runner.py --migration migrations/v5-varietyblend-001 --env staging --phase post

# --- prod (Dave's approval; outside 07:00-08:00 UTC; after the pre-apply copy) -------------------
python3 scripts/neon_safety_branch.py --env-file .env.local create --slug seedr2a --days 7   # once for the release
python3 scripts/gate_runner.py --migration migrations/v5-varietyblend-001 --env prod --phase pre
python3 scripts/gate_runner.py --migration migrations/v5-varietyblend-001 --env prod --phase sweep
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-varietyblend-001/0a-additive-ddl.sql
python3 scripts/gate_runner.py --migration migrations/v5-varietyblend-001 --env prod --phase post
python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only
```

Prod gets `0a` only; the rollback is rehearsed on staging and not on prod.

**The pre-apply copy** is one Neon branch off prod for the whole release, made by
`scripts/neon_safety_branch.py`, which stamps its expiry at creation. Make it once, before the first of the
three `0a` files touches prod.

**Do not apply prod DDL between 07:00 and 08:00 UTC**: the nightly dump runs at 07:00 and `restore-verify`
at 08:00 compares table sets, so a table added between them reds that one run.

Any `pre` or `sweep` failure is a stop. After `0a` the `pre` phase reads 4 of 9 by design
(`pre_blend_key_absent`, `pre_table_absent`, `pre_not_already_applied` and the two view receipts are
`continuous: false` and false once applied), and the `sweep` gates find the migration's own objects (0 of
2); neither is run again except after a rollback, where `pre` must read 9 of 9 — that is the receipt that
`0r` restored the view exactly.

**The prod `pre` phase is the first read of prod's view.** The 47-column definition in `0a` was read on
staging (md5 `4f70e4aac68cc4945bb70d7cae54f2b5`, PostgreSQL 17.11) and is byte-equal to
`migrations/v5-scovillesource-001/0a-additive-ddl.sql:102-149`. Prod was not read by the lane that wrote
this. `pre_cultivar_view_is_the_captured_definition` on prod is that check, and `0a` repeats it inside its
transaction and refuses, changing nothing, on a mismatch. If it fails: diff
`pg_get_viewdef('public.cultivar', true)` against the list in `0a`.

`0a` sets `lock_timeout = '5s'` and locks the view first (which also locks `plant_varieties`), the order every
reader uses. Behind a long-open transaction the file fails fast having changed nothing. A lock timeout and a
deadlock report (40P01) mean the same thing here: nothing changed, run it again. Apply in a quiet hour; the
locks are held from the first statement to COMMIT (well under a second at this table's size), and variety,
planting and inventory reads wait for that long.

`post` on staging reads 22 of 23 with one `n/a`: `post_garden_ro_can_still_read_cultivar` is prod-only
(staging has no `garden_ro` role). On prod it reads 23 of 23.

From this apply on, `migrations/v5-scovillesource-001`'s own apply-window receipt
`post_cultivar_view_column_count_47` reads 48 when that directory's `post` phase is run in full. It is
`continuous: false`, so the standing run (`--continuous-only`) never executes it; it is the same thing that
migration did to `v5-varietyhybridflag-001`'s count of 46.

## The row-level gates

The last four gates in `gates.yml` are statements about rows, which a catalog cannot answer:

| gate | a row means |
|---|---|
| `post_keyed_row_has_rank_blend` | a variety carries a `blend_key` and its `variety_rank` is not `blend` |
| `post_blend_key_equals_live_components` | a mix's key is not exactly its live component ids, sorted and comma-joined |
| `post_no_live_component_under_an_unkeyed_row` | a variety has live component rows and no key |
| `post_every_live_component_is_a_leaf` | a live component is itself a mix (the key was not flattened) |

They sit in `gates.yml` from the first push, armed on this directory's stamp, because the DDL is on both
databases before that push. On a database without the DDL they do not go vacuous under the stamp guard:
Postgres resolves a column and a relation name at parse time, so they **error** (42703 / 42P01), and an
erroring gate reds the run for every migration in the tree. Measured on the rehearsal database with the
DDL absent: 16 `post` gates vacuous, 2 apply-window receipts failing, these 4 erroring.

**They move to `gates-rowlevel.yml.pending` before any rollback** (next section).

None of the four filters on the mix's own `deleted_at`: a soft-deleted mix can be revived and must come
back consistent. A component that is a soft-deleted variety is an accepted state.

## Rollback

**Revert the public site first (since gam-site `23e4a87`, 2026-10-07).** The Gardens at Mathews site's export now reads what this migration added. Put gam-site's saved-seed generator back to its `1ef08da` form and publish that BEFORE running this rollback, or the site's Gate 1 stops every publish, not only `/seed/`.

`0r-rollback.sql` restores the 47-column view, drops the table, the index, the CHECK, the column and the
stamp. Four things to know before using it:

1. **Move the four row-level gates out first.** Cut them from `gates.yml` into
   `gates-rowlevel.yml.pending` (a name the runner does not load), push, and let that reach the branch whose
   corpus runs against the database — dev for the push-triggered run, `main` for the cron. Every other gate
   here is catalog-only and returns to vacuous with the stamp gone.
2. **Code back before schema back.** It is a clean undo only while no deployed code names `blend_key` or
   the table. Once the release-2a Lambdas are live (varieties, plants, inventory-items all read the column
   through the view), dropping it turns those reads into a 42703. After that the holding state is "leave the
   schema": it is inert to code that does not name it.
3. **Newest first.** A later migration that widens `public.cultivar` again is rolled back before this one
   (the file refuses unless the view is exactly the 48 columns `0a` left, `blend_key` last), and
   `migrations/v5-scovillesource-001/0r-rollback.sql`, which re-creates the view at 46 columns, only after
   this one.
4. **It refuses while it would lose something.** A named mix cannot be rebuilt from anything else. The file
   stops, changing nothing, while any variety (live or soft-deleted) carries a `blend_key` or any component
   row exists, and says how many. Getting past that is Dave's decision, with the rows exported first.

The view narrow is a `DROP VIEW` + `CREATE VIEW` (Postgres cannot remove a view column with
`CREATE OR REPLACE`), which is the one path that loses grants. The file reads the view's own grants before
the drop and re-issues each one after, then the guarded `garden_ro` grant the sibling files carry. (That
guarded grant is unconditional on the role existing: where `garden_ro` exists and did not have SELECT on the
view, `0a` gives it and `0r` leaves it given — as `v5-scovillesource-001` and `v5-varietyhybridflag-001` do.)

To disarm the gates without touching the schema, delete the stamp row only; `post_schema_version_recorded`
then reds, on purpose.

## A hand-run variety dedup

There is no merge tool for varieties. Whoever writes the next one-off (the precedent is
`migrations/v4-varietydedup-001`) must, in one transaction: prune then repoint `variety_blend_component`
rows, recompute `blend_key` on every mix it touched, and merge two mixes that now share a key.
`post_blend_key_equals_live_components` reds if it forgets. Both foreign keys are RESTRICT, so a hard
delete of the losing variety fails until its component rows are repointed.

## Other surfaces this touches

- `tests/integration/_cleanup.js` hard-deletes `plant_varieties`; two RESTRICT keys from the new table make
  that fail 23503 once a test creates a mix. It needs a child-first step for `variety_blend_component`,
  behind the same table-exists check the `seed_lot_parent_planting` step uses. Not in this directory.
- The public site's export gate (`gam-site/tools/gates.py`) reads the live columns of `plant_varieties`.
  `blend_key` matches none of its row-filter stems, so it prints PENDING CLASSIFICATION, not a failure,
  until the manifest lists it under `excluded:`. `variety_blend_component` is not a manifest table.

## What was rehearsed, and where

On a throwaway local PostgreSQL 17.10, loaded from a schema-only read of staging (17.11) on 2026-10-06 —
the three view md5 values reproduce there byte for byte — with staging's 161 stamps copied in:

- `pre` 9/9 and `sweep` 2/2 unapplied; `0a`; `post` 22/23 + 1 n/a; `0a` again leaves the catalog dump and
  `applied_at` byte-equal;
- `0r`, after which the view's md5 is the captured one and the schema dump is byte-equal to the schema read
  from staging; `0r` again a no-op; `pre` 9/9, `0a`, `post` again;
- `0a` refusing on a view changed in place (md5 mismatch, nothing changed); `0a` giving up after 5s behind
  a held lock, nothing changed;
- `0r` refusing with 3 keyed rows and 6 component rows; `0r` refusing with a 49th column appended;
- with `garden_ro`, `garden_export_ro`, a `WITH GRANT OPTION` role and `PUBLIC` granted on the view: the
  grants are identical after `0a` and after `0r`, and the prod-only gate passes;
- `INSERT INTO public.cultivar ... ON CONFLICT (created_by, blend_key) WHERE blend_key IS NOT NULL AND
  deleted_at IS NULL DO NOTHING`: accepted through the view, arbiter index
  `uq_plant_varieties_creator_blend_key_live`; the same creator and key again inserts 0 rows with no error;
  another creator inserts; a soft-deleted mix frees its key; a NAME collision is not swallowed (23505 on
  `uq_plant_varieties_name_species`); the same target without its `WHERE` is refused (42P10);
- the format CHECK refusing one uuid, thirteen, upper case, a trailing comma, a space and the empty string,
  and accepting two and twelve;
- 35 single defects injected one at a time, each turning exactly the gate written for it red and clearing
  on undo;
- the whole standing corpus before and after all three release-2a directories were applied: no existing
  gate changed status.

**Not rehearsed:** anything on staging or prod beyond catalog reads of staging; prod's view definition and
grants (the prod `pre` phase and `0r`'s grant re-issue exist for that reason); the varieties Lambda itself.
