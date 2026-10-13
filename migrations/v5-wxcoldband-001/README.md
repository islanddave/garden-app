# v5-wxcoldband-001: where tonight's forecast cold range is kept

One new table, `weather_cold_range`: for a night at a Space, the lowest hourly 10th and 50th percentile of
the forecast ensemble's temperature, one row per night per forecast run. It is written each morning by one
job on Dave's Mac and read by the daily-plan read for the Today card. Ledger `V5-WXCOLDBAND-001`. Nothing
on any existing table changes. The decisions are in the header of `0a-additive-ddl.sql`.

**Not applied anywhere by the lane that wrote it (2026-10-13). No SQL in this directory has been run
against PostgreSQL**: the lane had no database. The files were parsed with the PostgreSQL grammar
(libpg_query) for syntax, and `gates.yml` passes `gate_runner.py --validate-only`; that is all. Rehearse on
staging before anything else. Applying to prod is a prod database change and needs Dave's first-hand OK.

**This directory creates no role and makes no grant.** The writer's access is described under "The writer's
access" and is a decision still to be taken.

| file | what it does |
|---|---|
| `0a-additive-ddl.sql` | The table (8 columns), `PRIMARY KEY (space_id, night_date, init_time)`, one CASCADE foreign key to `spaces(id)`, three CHECKs, stamp `5.0.0-wxcoldband-001`. One transaction. Refuses a relation of the same name that carries no stamp. Writes no rows. Idempotent. |
| `0r-rollback.sql` | Drops the table and the stamp. Guarded: refuses while any row exists. |
| `gates.yml` | 3 `pre`, 2 `sweep`, 9 standing `post`. Every `post` gate is catalog-only and self-armed on the stamp. The three CHECK bodies are pinned by name, validation and the columns they read, **not by text** (see "What was checked"). |

One stamp. No `0b` and no `0c`: nothing is backfilled, and the three CHECKs ship armed with the table,
because no deployed code names it and it is born empty.

## In plain words

The app gets a small drawer where your Mac can leave one note each morning: how cold the forecast says
tonight could get. Nothing changes on screen until the release that shows it ships, and on a morning the
Mac did not run, that part of the card stays blank.

## The table

| column | type | |
|---|---|---|
| `space_id` | uuid, NOT NULL | The place the forecast is for. Foreign key to `spaces(id)`, ON DELETE CASCADE. |
| `night_date` | date, NOT NULL | The ET civil day the night BEGINS on. The night of 2026-10-13 runs 18:00 that day to 08:00 on the 14th. |
| `init_time` | timestamptz, NOT NULL | When the forecast run started. A later run for the same night is another row. |
| `p10_min_f` | numeric(5,2), NOT NULL | Fahrenheit. The lowest value, over the night's hourly steps, of the ensemble's 10th percentile temperature: the cold end. |
| `p50_min_f` | numeric(5,2) | Fahrenheit. The same for the 50th percentile: the middle. NULL = not pulled. |
| `leads_read` | smallint, NOT NULL | How many hourly steps went into the minimum. |
| `leads_expected` | smallint, NOT NULL | How many hourly steps of the night this run covers (15; 14 and 16 on the clock-change nights). |
| `created_at` | timestamptz, NOT NULL, DEFAULT now() | When the row landed, on the database clock. The card's freshness stamp. Not sent by the writer. |

Where each came from:

- **The key** `(night_date, init_time)` is the September decision (handoff 2026-09-15, Decision 5): a
  night-only key would keep one forecast per night and foreclose run-to-run comparison. `space_id` leads it
  because that is how the one existing weather series is scoped (`weather_daily`, key `(space_id, "date")`).
- **What the writer can supply** is what `project-state/tools/wn3_pull.py` prints today: the night, the run's
  init hour, a minimum per percentile (p10 and p50 by default), and the number of hourly steps.
- **What the card needs** (recon A3, "Decisions already taken") is the low, its night, and its own freshness
  stamp, served through the existing daily-plan read, with nothing shown when absent or stale.

Left out on purpose: `p90` (warm side; not pulled by default; about 0.9 GB more download a day by the
recon's estimate), a model or source column (one source exists; see Open points), `created_by` and any user
column (a forecast has no owner, and `created_by` arms the ownership-transfer trigger), `updated_at` and
`deleted_at` (rows are never updated or soft-deleted).

**Soft delete.** The neighbours' soft-delete convention does not apply. These rows are derived forecast
data, not user-authored: the Soft-Delete-Only Rule's first carve-out, "genuinely ephemeral / regenerable /
derived data". `weather_daily` and `weather_cue_impression` have no `deleted_at` either.

## What the constraints do to a writer

| write | answer |
|---|---|
| a row with p10, and p50 at or above it or NULL, `leads_read` from 1 to `leads_expected` | accepted |
| a second row with the same `(space_id, night_date, init_time)` | 23505 `weather_cold_range_pkey`; with `ON CONFLICT DO NOTHING`, no row and no error. The first row stands. |
| a `space_id` that is not a space | 23503 `weather_cold_range_space_id_fkey` |
| p50 below p10 | 23514 `weather_cold_range_p10_le_p50_chk` |
| a temperature left in Kelvin (anything 150 or above), or p10 at -100 or below | 23514 `weather_cold_range_fahrenheit_chk` |
| `leads_read` of 0, or more than `leads_expected` | 23514 `weather_cold_range_leads_chk` |
| a row with no p10, no night, no run time or no step counts | 23502 |
| a value of 1000 or more | 22003: the column is `numeric(5,2)` |

The three CHECKs exist because there is no handler between this writer and the Today card. They are the
only validation the row gets. `fahrenheit_chk` is a unit guard and nothing finer: the archive is in Kelvin,
and every Kelvin temperature at the ground is above 150.

## The writer's access

Dave's ruling (2026-10-12): a background job on the Mac "writes one row to the live database", with
"standing permission for that one script to write that one table unattended".

**What the narrowest writer needs**, as PostgreSQL privileges:

- a login role of its own, a member of nothing, with no CREATEDB / CREATEROLE / BYPASSRLS;
- `INSERT` on `public.weather_cold_range`, and it can be column-level so the writer cannot set the
  freshness stamp:
  `GRANT INSERT (space_id, night_date, init_time, p10_min_f, p50_min_f, leads_read, leads_expected)`;
- nothing else: no SELECT, no UPDATE, no DELETE, on this table or any other.

Not to be run from here; a sketch of the option for whoever decides:

```sql
-- by the database owner, by hand, with Dave's OK. The name is a suggestion.
CREATE ROLE garden_wx_writer LOGIN PASSWORD '<set out of band>' CONNECTION LIMIT 2;
GRANT INSERT (space_id, night_date, init_time, p10_min_f, p50_min_f, leads_read, leads_expected)
  ON public.weather_cold_range TO garden_wx_writer;
-- then prove the negative, as that role: SELECT, UPDATE and DELETE here, and SELECT on any other
-- table, must each answer "permission denied".
```

What follows from "INSERT and nothing else", for the lane that builds the job:

- **`ON CONFLICT DO NOTHING` with no column list.** Naming the key columns in the conflict target needs
  SELECT on them; the bare form needs only INSERT. No `RETURNING` either.
- **The foreign key needs no privilege on `spaces`.** Postgres runs the referential check as the table's
  owner. The job is configured with the Space's id; it cannot look it up.
- **A re-run cannot correct a row.** The first row for a key stands. A correction is a different `init_time`
  or an operator.

Those three are from this lane's memory of the PostgreSQL documentation, not from a server. The rehearsal
is where they get proved.

**Does the repo have a precedent for a restricted role?** Partly.

- A restricted role EXISTS in the database: `garden_ro`, read-only. Migrations grant to it (three rollbacks
  re-grant SELECT on objects they re-create), `v4-roschemaversion-001` wrote a read policy for it, and prod
  has a default ACL that gives it SELECT on every new table (`v5-seedlotaddition-001` README). So on prod
  `garden_ro` can read this table at birth and on staging it cannot; accepted there, accepted here.
- **No migration in this repo creates a role.** `garden_ro` was made outside it. There is no file to copy.
- **No role but the owner writes anything today.** Every writer is a Lambda connecting as the owner. A
  non-owner writer would be the first.

So this directory does not create one. The options, for the decision:

1. **A dedicated INSERT-only role, as sketched.** The narrowest thing that is still "the script writes the
   table". A leaked credential can add rows to this one table and nothing else: a false but
   Fahrenheit-shaped range for some night (display only; bounded by the CHECKs), or junk rows. It cannot
   read, change or delete anything anywhere. Revoking it is one statement. *Recommended.*
2. **The script uses the owner's connection string.** No new role, and the widest possible grant: a
   credential on a laptop that can read and rewrite everything. Not recommended.
3. **No database credential on the Mac.** The job POSTs to a route on the existing daily-plan read, which
   checks a shared secret and inserts as the owner. Narrow at the database, but it is new Lambda code, a
   new secret in AWS and a route Clerk does not guard. More to build and review than option 1.
4. **A function the role may EXECUTE, and no table privilege at all.** Narrower than option 1 and able to
   refuse a night that is not near today, at the cost of a function to maintain. The repo's
   SECURITY DEFINER functions are all audit triggers; none is a write path.

Four things to check before choosing option 1, none of which this lane could read:

- **How the role is made on Neon.** As this lane remembers Neon's documentation, a role created in the
  Neon console or API is made a member of `neon_superuser`, which is the opposite of narrow; a role created
  with SQL is not. Unverified. Check, then prove the negative as the role.
- **What PUBLIC can do in this database.** A new role gets whatever PUBLIC has. Prod's default ACL names
  `garden_ro`, not PUBLIC, by the sibling README; nobody has listed PUBLIC's grants.
- **The nightly backup does not carry the grant.** `backup.yml` dumps with `--no-owner --no-privileges`,
  and the globals dump carries roles without passwords. After a restore the table and the role come back
  and the grant does not: the job's INSERT is refused and the card is blank. The grant has to live in a
  file someone can run again.
- **Row security stays off on this table.** Enabled with no policy it is deny-all for a non-owner
  (`v4-roschemaversion-001` found `schema_version` like that). `post_no_trigger_and_no_row_security`
  holds it.

## Order of work

Independent of every other directory. Ships ahead of the `V5-WXCOLDBAND-001` code.

1. **Staging apply.**
2. **Prod apply**, on Dave's first-hand OK, BEFORE any commit that names `weather_cold_range` under
   `lambda/**` reaches `dev`.
3. Only then the read. The Mac job can be built in parallel; it needs the table and its access, not the
   read.

Why: the promote's prod schema gate reads dev's handlers against prod. From the moment a handler that names
this table is on dev, every promote by every session is refused, a hotfix included, until the table is on
prod; a missing relation cannot be waived. The table is inert on prod before its code: nothing deployed
names it and it is empty.

This directory by itself is safe in the tree before either database is applied. No gate here names the
table or one of its columns as a SQL identifier, so every `post` gate is vacuous, not erroring, on a
database without it. **By construction, not measured.**

## Applying

Run from the repo root, with the URL in the environment (never on a command line that is logged).

```bash
# --- staging -------------------------------------------------------------------------------------
python3 scripts/gate_runner.py --migration migrations/v5-wxcoldband-001 --env staging --phase pre
python3 scripts/gate_runner.py --migration migrations/v5-wxcoldband-001 --env staging --phase sweep
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-wxcoldband-001/0a-additive-ddl.sql
python3 scripts/gate_runner.py --migration migrations/v5-wxcoldband-001 --env staging --phase post

# staging only: rehearse the rollback, then put it back
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-wxcoldband-001/0r-rollback.sql
python3 scripts/gate_runner.py --migration migrations/v5-wxcoldband-001 --env staging --phase pre
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-wxcoldband-001/0a-additive-ddl.sql
python3 scripts/gate_runner.py --migration migrations/v5-wxcoldband-001 --env staging --phase post
python3 scripts/gate_runner.py --all --env staging --phase post --continuous-only

# --- prod (Dave's first-hand OK; outside 07:00-08:00 UTC; after the pre-apply copy) ----------------
python3 scripts/neon_safety_branch.py --env-file .env.local create --slug wxcoldband --days 7
python3 scripts/gate_runner.py --migration migrations/v5-wxcoldband-001 --env prod --phase pre
python3 scripts/gate_runner.py --migration migrations/v5-wxcoldband-001 --env prod --phase sweep
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-wxcoldband-001/0a-additive-ddl.sql
python3 scripts/gate_runner.py --migration migrations/v5-wxcoldband-001 --env prod --phase post
python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only
```

Prod gets `0a` only; the rollback is rehearsed on staging and not on prod.

**Do not apply prod DDL between 07:00 and 08:00 UTC**: the nightly dump runs at 07:00 and `restore-verify`
at 08:00 compares table sets, so a table added between them could red that one run. This file adds a table.
(v4.185.3 on dev makes the check compare with the backup's own table list; the scheduled run uses main's
copy of the workflow, so keep the rule until that has been promoted.)

While rehearsing on staging, put the three printed CHECK definitions into
`post_three_checks_validated_and_no_others` (see "What was checked").

Any `pre` or `sweep` failure is a stop. After `0a` the `pre` phase reads 1 of 3 by design
(`pre_table_absent` and `pre_not_already_applied` are `continuous: false` and false once applied) and the
`sweep` gates find the migration's own objects (0 of 2); neither is run again except after a rollback,
where `pre` must read 3 of 3.

## What it locks, and for how long

Creating the table locks nothing that exists. Its foreign key takes a brief SHARE ROW EXCLUSIVE lock on
`spaces`, held to COMMIT: a write to `spaces` (setting a featured photo) waits for milliseconds; reads do not
wait. `0a` sets `lock_timeout = '5s'`: behind a long-open transaction the file fails fast (psql exits 3,
`55P03`) having changed nothing. Run it again.

## Would the currently deployed code break on this?

No. Read on `origin/dev` `1f58a9d8`, which is what prod runs.

- **Nothing deployed names the table.** `git grep weather_cold_range origin/dev` returns nothing.
- **Nothing is added to a table deployed code reads or writes**, except the foreign key's hold on `spaces`.
  A foreign key constrains deleting a space and changing its `id`. No deployed code does either: the only
  writes to `spaces` are UPDATEs of `featured_photo_id` in `lambda/photos`, which no key check touches.
- **The daily-plan read** (`lambda/daily-plan-read`) does not name it, so Today is unchanged until the
  read is built.

So the CHECKs are armed at birth on an empty table with no deployed writer to break.

## For the two lanes that follow

**The read** (recon A3): its own module and its own statement in a try/catch, never a JOIN onto the plan
read, because `index.test.js` reads that file's SQL templates by position and a missing table must blank
the range, not Today. Find the place through `spaces.created_by = ANY(householdIds)`, as
`household.js` `loadOwnedSpace` does. Show a row only when `night_date` is tonight,
`leads_read = leads_expected`, and `init_time` is before the night began and not in the future; take the
newest `init_time`; serve `created_at` as the range's own freshness stamp. `PLAN_SCHEMA_VERSION` is not
involved.

**The job**: send the seven columns in the grant and never `created_at`. `night_date` is the evening's date
in America/New_York. `leads_read` is the fewest steps any stored percentile was read over. Bare
`ON CONFLICT DO NOTHING`.

## Rollback

`0r-rollback.sql` drops the table and removes the stamp.

1. **Stop the writer first.** Unload the Mac job before running it. If a role was made for the job, drop it
   afterwards, by hand; this directory created neither.
2. **Code back before schema back.** It is a clean undo only while no code on dev names the table. The
   holding state "leave the table" starts when the read is ON DEV, not when it is live.
3. **It refuses while any row exists**, and says how many and for which nights. The rows are derived data
   and the carve-out allows removing them; the guard is there because "regenerable" rests on Google keeping
   its archive, and that retention is unverified (`OPS-WN3ARCHIVERETENTION-001`). To go on: export the rows,
   delete them deliberately, run it again.
4. **Nothing in the repo has to move first.** Every gate here is catalog-only and returns to vacuous with
   the stamp gone.

## Other surfaces this touches

- **The public site is not involved.** `gam-site` (read at its local `abecec2`) names no such table; its
  export reads only what its manifest lists.
- **The staging drift check** reports a staging-only table as information between the two applies, never as
  a finding: its three CHECKs read only columns that are themselves staging-only, which is the case
  `scripts/check-staging-drift.py` sets aside.
- **`garden_ro`** can read the table on prod from birth (default ACL) and not on staging. Not asserted.
- Not tripped, by reading: `scripts/merge-surface-inventory.py` (no uuid column here matches its planting
  pattern), the `inventory_items` foreign-key census, `tests/schema/check-schema.sh` (a hand list of core
  tables; this is not added to it, as the two sibling weather tables were not).

## Open points, for whoever reviews this

- **`space_id` in the key.** The brief and the September decision say "keyed `(night_date, init_time)`";
  this adds `space_id` in front, as `weather_daily` does. Taking it out is a smaller table that is served
  to whoever asks. Decide before the first apply: the key cannot be changed additively.
- **No model column.** One source exists (WeatherNext 3, station head). A second model for the same night
  and run time would collide on the key, and adding it to the key later is not additive.
- **Two step counts rather than a rule in the job.** `leads_read` and `leads_expected` could be dropped if
  the job simply never writes a partial night. They are kept so the read can refuse a partial row without
  trusting the job.

## What was checked, and what was not

Checked, with no database:

- `python3 scripts/gate_runner.py --all --env prod --validate-only` (the CI step) and
  `scripts/test_gate_runner.py`: this `gates.yml` parses and meets the strict schema;
- every statement in `0a`, `0r` and every gate parses under the PostgreSQL grammar (libpg_query through
  `pglast`), the `DO` bodies as PL/pgSQL. Syntax only: no catalog, no types, no execution;
- the catalog reads in the gates are the forms `v5-seedlotaddition-001` and `v5-recipes-001` run green on
  prod, with names changed.

**Not rehearsed, anywhere:** `0a`, `0r`, any gate, every line of the constraint table above, the lock on
`spaces`, the refusal paths, a second run being a no-op, the `post` gates being vacuous on an unapplied
database, and the whole standing corpus before and after. **And one thing the sibling directories have that
this one does not:** the exact text of each CHECK as Postgres prints it. `post_three_checks_validated_and_no_others`
pins name, validation and columns; it would not notice a moved bound or a reversed inequality until the
printed definitions are added to it.
