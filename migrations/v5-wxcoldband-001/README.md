# v5-wxcoldband-001: where tonight's forecast cold range is kept

One new table, `weather_cold_range`: for a night at a Space, the lowest hourly 10th and 50th percentile of
the forecast ensemble's temperature, one row per night per forecast run. It is written each morning by one
job on Dave's Mac and read by the daily-plan read for the Today card. Ledger `V5-WXCOLDBAND-001`. Nothing
on any existing table changes. The decisions are in the header of `0a-additive-ddl.sql`.

**APPLIED to staging and prod on 2026-10-13** (schema sitting, Dave first-hand: "Apply all three"; post gates read ok on both in gate-invariants run 38454285601). The paragraph below is how it stood before that. Written 2026-10-13 by a lane with no database, then rehearsed the same
day on a throwaway local PostgreSQL 17.10 (see "What was rehearsed, and where"). The staging apply is still
the first time these files meet the real `spaces`. Applying to prod is a prod database change and needs
Dave's first-hand OK.

**The writer's own login is a file here now, and has run nowhere.** Dave, 2026-10-13: "the Mac writer gets ITS
OWN NARROW LOGIN: a database role that can add rows to weather_cold_range and nothing else, created from a
re-runnable setup file that he OKs before it is applied once." `1a-writer-role.sql` is that file, and
`scripts/wx-writer-role.py` applies it, sets the role's password and proves the negatives over the wire. Written
2026-10-14 and rehearsed on a throwaway local PostgreSQL only; neither has touched staging or prod. How to run
them, and what could not be checked from here, is under "The writer's login".

| file | what it does |
|---|---|
| `0a-additive-ddl.sql` | The table (8 columns), `PRIMARY KEY (space_id, night_date, init_time)`, one CASCADE foreign key to `spaces(id)`, three CHECKs, stamp `5.0.0-wxcoldband-001`. One transaction. Refuses a relation of the same name that carries no stamp. Writes no rows. Idempotent. |
| `0r-rollback.sql` | Drops the table and the stamp. Guarded: refuses while any row exists. |
| `gates.yml` | 3 `pre`, 2 `sweep`, 9 standing `post`. Every `post` gate is catalog-only and self-armed on the stamp. The three CHECK bodies are pinned by name, validation and the exact text PostgreSQL 17 prints for them. |
| `rehearse_local.py` | The three files above on a throwaway local Postgres, re-runnable: the whole sequence, every line of the constraint table, the INSERT-only writer sketched below, what is locked on `spaces`, and a planted defect for every gate. `python3 migrations/v5-wxcoldband-001/rehearse_local.py`, about 40 s. Writes only to the cluster it creates. |
| `1a-writer-role.sql` | The role `garden_wx_writer`: LOGIN, NOINHERIT, CONNECTION LIMIT 2, no other attribute, a member of nothing, `INSERT` on the seven columns the job sends (never `created_at`), no password. One transaction, re-runnable, run by the table's owner. Ends in an assertion that rolls the whole file back if the role could do anything more, naming each privilege, its grantor and whether PUBLIC gave it. Revokes nothing from PUBLIC. No stamp. |
| `1r-writer-role-rollback.sql` | Revokes the grant and drops the role. Refuses while the role owns anything. Re-runnable; works after `0r` too. |
| `rehearse_writer_role.py` | `1a`, `1r` and `scripts/wx-writer-role.py` on a throwaway local Postgres, run by a NON-superuser owner as Neon's is: 71 checks, about 20 s. `python3 migrations/v5-wxcoldband-001/rehearse_writer_role.py`. Port 55498, so it can run beside `rehearse_local.py`. `scripts/test_wx_writer_role.py` runs it where `initdb` is on PATH. |
| `scripts/wx-writer-role.py` | `apply`, `verify`, `rollback` with `--env staging` or `--env prod --i-have-daves-ok`. See "The writer's login". |

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
"standing permission for that one script to write that one table unattended". And 2026-10-13, first-hand: its
own narrow login, from a re-runnable setup file he OKs before it is applied once. That is option 1 below, and
`1a-writer-role.sql`; "The writer's login" says how to run it.

**What the narrowest writer needs**, as PostgreSQL privileges:

- a login role of its own, a member of nothing, with no CREATEDB / CREATEROLE / BYPASSRLS;
- `INSERT` on `public.weather_cold_range`, and it can be column-level so the writer cannot set the
  freshness stamp:
  `GRANT INSERT (space_id, night_date, init_time, p10_min_f, p50_min_f, leads_read, leads_expected)`;
- nothing else: no SELECT, no UPDATE, no DELETE, on this table or any other.

The sketch the decision was taken on. `1a-writer-role.sql` is what it became (the attributes spelled out, a
member of nothing, no password in the file, and an assertion at the end); do not run this sketch:

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

Those three were written from memory of the PostgreSQL documentation and then seen on the rehearsal's
server (PostgreSQL 17.10), as a role holding that column-level INSERT and nothing else: the bare
`ON CONFLICT DO NOTHING` insert is accepted and a re-run leaves the first row; the same insert with the key
named in its conflict target, with `RETURNING`, or naming `created_at`, is "permission denied"; an unknown
space is still 23503. That is PostgreSQL's privilege rule on a local cluster. It says nothing about how
Neon makes a role or what PUBLIC holds on prod (the four checks below still stand).

**Does the repo have a precedent for a restricted role?** Partly.

- A restricted role EXISTS in the database: `garden_ro`, read-only. Migrations grant to it (three rollbacks
  re-grant SELECT on objects they re-create), `v4-roschemaversion-001` wrote a read policy for it, and prod
  has a default ACL that gives it SELECT on every new table (`v5-seedlotaddition-001` README). So on prod
  `garden_ro` can read this table at birth and on staging it cannot; accepted there, accepted here.
- **No migration in this repo creates a role.** `garden_ro` was made outside it. There is no file to copy.
- **No role but the owner writes anything today.** Every writer is a Lambda connecting as the owner. A
  non-owner writer would be the first.

The options as they were put. **Option 1 was taken (Dave, 2026-10-13)** and is `1a-writer-role.sql`:

1. **A dedicated INSERT-only role, as sketched.** The narrowest thing that is still "the script writes the
   table". A leaked credential can add rows to this one table and nothing else: a false but
   Fahrenheit-shaped range for some night (display only; bounded by the CHECKs), or junk rows. It cannot
   read, change or delete anything anywhere. Revoking it is one statement. *Recommended, and taken.*
2. **The script uses the owner's connection string.** No new role, and the widest possible grant: a
   credential on a laptop that can read and rewrite everything. Not recommended.
3. **No database credential on the Mac.** The job POSTs to a route on the existing daily-plan read, which
   checks a shared secret and inserts as the owner. Narrow at the database, but it is new Lambda code, a
   new secret in AWS and a route Clerk does not guard. More to build and review than option 1.
4. **A function the role may EXECUTE, and no table privilege at all.** Narrower than option 1 and able to
   refuse a night that is not near today, at the cost of a function to maintain. The repo's
   SECURITY DEFINER functions are all audit triggers; none is a write path.

Four things to check before choosing option 1, none of which the lane that wrote this could read. What the
files now do about each (2026-10-14):

- **How the role is made on Neon.** As this lane remembers Neon's documentation, a role created in the
  Neon console or API is made a member of `neon_superuser`, which is the opposite of narrow; a role created
  with SQL is not. Unverified. Check, then prove the negative as the role.
  *Now:* `1a` makes it with SQL, revokes every membership it holds, and rolls back if one remains. Still
  unverified on Neon; the assertion catches it either way.
- **What PUBLIC can do in this database.** A new role gets whatever PUBLIC has. Prod's default ACL names
  `garden_ro`, not PUBLIC, by the sibling README; nobody has listed PUBLIC's grants.
  *Now:* still not listed. `1a` revokes nothing from PUBLIC (that changes every role); its assertion counts
  what PUBLIC holds and refuses, naming each line "granted to PUBLIC", if any of it reaches past the seven
  columns. The first staging `apply` is the first reading.
- **The nightly backup does not carry the grant.** `backup.yml` dumps with `--no-owner --no-privileges`,
  and the globals dump carries roles without passwords. After a restore the table and the role come back
  and the grant does not: the job's INSERT is refused and the card is blank. The grant has to live in a
  file someone can run again.
  *Now:* it does. After a restore: `1a` again, through `wx-writer-role.py apply`, which also sets a new
  password.
- **Row security stays off on this table.** Enabled with no policy it is deny-all for a non-owner
  (`v4-roschemaversion-001` found `schema_version` like that). `post_no_trigger_and_no_row_security`
  holds it.
  *Now:* `1a`'s assertion also refuses if it is enabled or forced.

## The writer's login

What exists: `1a-writer-role.sql`, `1r-writer-role-rollback.sql`, `scripts/wx-writer-role.py`, and their
rehearsal. The role is `garden_wx_writer`. Its URL goes in `.env.local` as `WX_WRITER_DATABASE_URL_STAGING` /
`WX_WRITER_DATABASE_URL_PROD`, which is where the Mac job reads it.

**How to run it.** Staging first, then prod, and prod only on Dave's first-hand OK of `1a-writer-role.sql`
for that step. From the main checkout (the one with `.env.local`); the table must be there (it is, on both,
since 2026-10-13).

```bash
python3 scripts/wx-writer-role.py apply  --env staging      # 1a as the owner, a password, the URL line, the probes
python3 scripts/wx-writer-role.py verify --env staging      # the probes again, any time
# --- prod: Dave's first-hand OK -------------------------------------------------------------------
python3 scripts/wx-writer-role.py apply  --env prod --i-have-daves-ok
```

`apply` runs `1a` with the owner's URL (`NEON_STAGING_URL` / `NEON_DATABASE_URL`, read by key name), sets a
random 32-byte password on stdin, writes the role's URL (the owner URL's host, database and parameters, the
role and password substituted) into `.env.local`, then logs in as the role and checks, over the wire: it is
`garden_wx_writer`; INSERT on the seven columns and not on `created_at`, not table-level; SELECT on
`weather_cold_range`, SELECT on `plants`, UPDATE and DELETE on `weather_cold_range` each 42501. It prints
PASS / FAIL lines and the role name, never a URL, host or password, and passes none on a command line. A
refusal from `1a` is printed with its findings and leaves no role, no password and no line. Exit 0 only if
every line is PASS.

- **Running `apply` again rotates the password.** The job must then read the new line.
- **After a restore** (the backup carries neither the grant nor the password): `apply` again.
- **If staging is recreated**, `apply --env staging` again.
- **Rollback:** unload the Mac job, then `python3 scripts/wx-writer-role.py rollback --env staging` (prod:
  `--env prod --i-have-daves-ok`). It runs `1r` and removes the `.env.local` line.

**Not verified, because nothing here can reach Neon:**

- **Whether a role created with SQL on Neon is put in `neon_superuser`.** The assertion refuses either way.
  If it is, and the owner cannot revoke it (a grant made by Neon's own superuser), `apply` stops at `1a` with
  "member of neon_superuser (granted by ...)" and nothing is created.
- **Whether Neon's pooler accepts a password set with SQL on a role made with SQL.** The `apply` probe over the
  wire answers it on staging. Its first login is tried up to five times over 30 s, in case the proxy answers
  from what it knew a moment before the password was set (also unverified).
- **What PUBLIC holds on staging and prod**, and whether any object in schema `public` there belongs to a role
  the owner cannot speak for (`1a` skips those when revoking, and its assertion still reads them).
- **That Neon's owner can do what `1a` does**: CREATE ROLE and set attributes (CREATEROLE), GRANT on the table
  (it owns it), REVOKE CREATE on schema `public` (as the database's owner). Rehearsed with a non-superuser
  owner holding CREATEROLE and CREATEDB, not on Neon. PostgreSQL 16 and later refuse a non-superuser that
  names REPLICATION, BYPASSRLS or SUPERUSER in ALTER ROLE even to turn it off (seen locally), so `1a` sets
  only attributes that differ.
- **Where the password goes on the server.** `ALTER ROLE ... PASSWORD` carries it in plain text once, as
  Neon's documentation does it; a statement log or `pg_stat_statements` could keep it, readable only by roles
  that already hold more than this one. A SCRAM verifier made on the Mac would avoid that, but whether Neon
  accepts one is unverified too, so the documented form is used.

What `1a`'s assertion holds, and what it reports instead of refusing, is in its header. In short: the role is
LOGIN, NOINHERIT, CONNECTION LIMIT 2 and nothing else; a member of nothing; owns nothing; no table or view
privilege anywhere outside the system schemas, table- or column-level, except INSERT on the seven columns; no
sequence privilege; no CREATE on any schema or on the database; USAGE on `public`; row security off on this
table; no callable SECURITY DEFINER function that is not a trigger. EXECUTE, which PUBLIC holds on functions
by default, is a NOTICE.

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
database without it. Measured on the rehearsal database with the DDL absent: `post` 9 of 9, and 9 of 9 under
`--continuous-only`.

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

The three CHECK definitions in `post_three_checks_validated_and_no_others` are the text PostgreSQL 17.10
printed in the local rehearsal. Staging and prod are PostgreSQL 17, so the same text is expected; the first
`post` run on staging is where that is confirmed on the real server. If it differs, that gate is red and
names the constraint: read the definition off staging and correct the gate before prod.

Any `pre` or `sweep` failure is a stop. After `0a` the `pre` phase reads 1 of 3 by design
(`pre_table_absent` and `pre_not_already_applied` are `continuous: false` and false once applied) and the
`sweep` gates find the migration's own objects (0 of 2); neither is run again except after a rollback,
where `pre` must read 3 of 3.

## What it locks, and for how long

Creating the table locks nothing that exists. Its foreign key takes a brief SHARE ROW EXCLUSIVE lock on
`spaces`, held to COMMIT: a write to `spaces` (setting a featured photo) waits for milliseconds; reads do not
wait. `0a` sets `lock_timeout = '5s'`: behind a long-open transaction the file fails fast (psql exits 3,
`55P03`) having changed nothing. Run it again.

Measured in the rehearsal: `0a` holds `ShareRowExclusiveLock` on `spaces` and nothing stronger; it does not
wait for a reader's open transaction on `spaces`; behind a writer's (the featured-photo UPDATE, left open)
it exits 3 with 55P03 after 5.0 s, no table and no stamp. **`0r` is the heavier one:** dropping the table
takes ACCESS EXCLUSIVE on `spaces` to COMMIT, so reads of `spaces` wait for those milliseconds, and `0r`
itself waits behind any open transaction that has touched `spaces`, a reader's included (55P03 after 5.0 s,
nothing dropped).

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
`ON CONFLICT DO NOTHING`. It connects as `garden_wx_writer` with `WX_WRITER_DATABASE_URL_PROD` from `.env.local`
(by key name; never on a command line), and must expect that URL to change whenever `apply` is run again. At
most two connections at once.

## Rollback

`0r-rollback.sql` drops the table and removes the stamp.

1. **Stop the writer first.** Unload the Mac job before running it. Then, or afterwards, drop the job's
   role with `scripts/wx-writer-role.py rollback` (`1r-writer-role-rollback.sql`); it works whether or not
   the table is still there.
2. **Code back before schema back.** It is a clean undo only while no code on dev names the table. The
   holding state "leave the table" starts when the read is ON DEV, not when it is live.
3. **It refuses while any row exists**, and says how many and for which nights. The rows are derived data
   and the carve-out allows removing them; the guard is there because "regenerable" rests on Google keeping
   its archive, and that retention is unverified (`OPS-WN3ARCHIVERETENTION-001`). To go on: export the rows,
   delete them deliberately, run it again.
4. **Nothing in the repo has to move first.** Every gate here is catalog-only and returns to vacuous with
   the stamp gone.
5. **It takes ACCESS EXCLUSIVE on `spaces` until its COMMIT** (measured; see "What it locks"). Reads of
   `spaces` wait for those milliseconds, and behind any open transaction on `spaces` the file fails after
   5 s having dropped nothing. Run it again.

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

## What was rehearsed, and where

On a throwaway local PostgreSQL 17.10 (the sibling directories record prod and staging as 17.11), loopback
only, on 2026-10-13, by `rehearse_local.py` in this directory, against a minimal schema: `schema_version`
created by the repo's own statement (`v2-mvp-critter/0a-additive-ddl.sql`); `weather_daily` made by running
`v4-weatherdaily-001/0a-additive-ddl.sql` whole, so the foreign key this table copies is in the starting
state as the repo wrote it; and `spaces` cut down to four columns chosen for the rehearsal, because no
migration in this repo creates that table. Gates were run through `scripts/gate_runner.py`. 105 checks, all
holding, in 39 s.

- unapplied: `pre` 3/3, `sweep` 2/2, `post` 9/9 (vacuous, none erroring), and 9/9 for the
  `--phase post --continuous-only` run `gate-invariants.yml` makes; `0a`; `post` 9/9; `pre` 1/3 and `sweep`
  0/2, as "Applying" says; `0a` again leaves the schema dump, the stamp row (`applied_at` included) and every
  row byte-equal;
- the three CHECKs as that server prints them, which is the text the gate now pins:
  `CHECK (((leads_read >= 1) AND (leads_read <= leads_expected)))`,
  `CHECK (((p50_min_f IS NULL) OR (p10_min_f <= p50_min_f)))` and
  `CHECK (((p10_min_f > ('-100'::integer)::numeric) AND (p10_min_f < (150)::numeric) AND ((p50_min_f IS NULL) OR (p50_min_f < (150)::numeric))))`;
  the same text under an empty `search_path`, where only the foreign key's printed form changes;
- `0r` leaving the schema dump (`spaces` included), `schema_version` and every row byte-equal to the state
  before `0a`; `0r` again a no-op; `pre` 3/3, `0a`, `post` 9/9 again; `0r`, `0a` and `0a` again arriving
  with an empty `search_path`, each exit 0;
- every line of the table in "What the constraints do to a writer", against real rows: a complete row, a
  later run for the same night, the same run at another space; a duplicate key, 23505
  `weather_cold_range_pkey`, and with `ON CONFLICT DO NOTHING` no error and the first row standing; an
  unknown space, 23503; **each of the three CHECKs refused by name** (p50 below p10; p10 in Kelvin, p10 of
  exactly 150 and of exactly -100, p50 of exactly 150; `leads_read` of 0 and of 16 over 15), with the value
  just inside each bound accepted; four NULLs, 23502; 1000, 22003;
- deleting a space takes its forecast rows with it (and its `weather_daily` row, by that table's own key)
  and leaves the other space's; the deployed featured-photo UPDATE of `spaces` is unaffected;
- `0r` with seven rows: refused ("7 forecast row(s) exist in weather_cold_range, for nights 2026-10-13 to
  2026-10-15"), nothing dropped; with the rows deleted, the table and the stamp go. With a view or a later
  foreign key resting on the table: 2BP01, nothing changed. Where `0a` never ran: a no-op;
- the writer of "The writer's access", made by hand on that cluster (a role with INSERT on the seven columns
  and nothing else): 10 checks, summarised in that section; with row security enabled and no policy its
  INSERT is refused while `post_no_trigger_and_no_row_security` reds;
- what is locked on `spaces`, read from `pg_locks` inside each file's own transaction, and what waits: see
  "What it locks, and for how long";
- 6 starting states `0a` cannot apply to (a table or a view of the name already there; no `spaces`; `spaces`
  with no primary key; `spaces.id` as text; the key's index name taken): `0a` stops each time with the schema
  dump and `schema_version` as before, and a `pre` or `sweep` gate is red first. A CHECK of one of the three
  names on another table reds `sweep_no_constraint_name_collisions`; Postgres allows it, so `0a` is not
  stopped by it;
- 36 single defects on an applied database, at least one per `post` gate (the stamp; six column shapes;
  three extra columns, a model column among them; three defaults; five keys; a second unique index; seven
  foreign keys; seven CHECK defects; a trigger and row security, enabled or forced), each turning exactly
  the gate written for it red and no other; two controls green;
- one mutated copy of `0a` per CHECK (`leads_read >= 0`; `p10_min_f >= p50_min_f`; `< 1500`): `post` reads
  8/9 with `post_three_checks_validated_and_no_others` red, and the script exits 1.

**Owed by the lane that wrote this, and done here:** the three CHECK bodies are pinned as printed text.
Before the pin the gate matched each CHECK by the columns it reads, and the rehearsal's three wrong bodies
(a bound moved on two, the inequality turned round on the third) each read 9/9. They now red that gate.
The pin is the text of one major version; see "Applying" for where it is confirmed on staging.

**A gap the gates state, measured and left:** `numeric(5,2)` is not pinned, only `numeric`. `p10_min_f`
widened to `numeric(7,2)` reads 9/9.

**The writer's login, 2026-10-14**, by `rehearse_writer_role.py` on the same kind of cluster (PostgreSQL
17.10), every table owned by a NON-superuser owner with CREATEROLE and CREATEDB, a member of a stand-in
`neon_superuser`, as Neon's owner is. 71 checks, all holding, in 19 s:

- `1a` refused where `0a` never ran, and when run by a CREATEROLE login that does not own the table, each
  leaving no role. As the owner: exit 0; the role LOGIN, NOINHERIT, limit 2, no password, a member of
  nothing; `pg_dump` with privileges naming it in exactly seven lines, INSERT on each column; a table in
  `public` the owner holds no privilege on not in the way. Again, and again with an empty `search_path`:
  unchanged, the role's oid included. Attributes drifted (NOLOGIN, INHERIT, CREATEDB, no limit): set back.
  Grants made directly (`neon_superuser` granted by the owner; table, column, view, sequence, schema and
  function grants): each taken back;
- as the role, over TCP with a password: the bare `ON CONFLICT DO NOTHING` insert accepted and a re-run
  keeping the first row; naming `created_at`, `RETURNING`, a conflict target with columns, SELECT, UPDATE,
  DELETE and TRUNCATE here, SELECT on `plants`, `spaces`, `weather_daily`, a view and a table in another
  schema, `nextval`, CREATE TABLE and CREATE SCHEMA: each 42501. An unknown space still 23503, Kelvin
  23514. A third concurrent login refused ("too many connections for role");
- 16 planted states `1a` refuses with exit 3, naming the finding, the schema with privileges and the role
  unchanged: `neon_superuser` granted by the superuser (the owner cannot revoke it); another role granted by
  the superuser; SELECT on a table in another schema granted to the role; granted to PUBLIC: SELECT on
  `plants`, SELECT on one column of `spaces`, TRUNCATE on `weather_daily`, table-level INSERT on this table,
  USAGE on a sequence, CREATE on `public`, CREATE on the database; a SECURITY DEFINER function that is not a
  trigger; row security enabled, and forced; the role owning a table (and `1r` refusing it too); the role
  made BYPASSRLS by a superuser (the owner may not clear it: 42501 from ALTER ROLE); and, with no role yet,
  a PUBLIC grant in the way: the CREATE ROLE rolled back with the rest;
- `1r`: the role gone and `pg_dump` with privileges equal to before `1a`; again, a no-op; after `0r`, still
  drops it;
- the script: `--env prod` without the flag refused before anything is read or run; `apply`, `verify`,
  `apply` again (the password rotated, the old one refused), `verify` with a wrong password, `rollback`
  twice, `verify` with no line, `apply`/`rollback --env prod --i-have-daves-ok` (on a local database), and
  `apply` where `1a` refuses. The env file's other lines and its mode kept. psql was wrapped to record its
  command lines: 31 calls, none carrying a password, URL, host or database name, and no output did either.

**Not rehearsed:** anything on staging or prod; the real `spaces` (its triggers, policies and other
columns); how Neon makes a role and what PUBLIC holds; the Mac job and the read; `garden_ro`'s default ACL;
the whole standing corpus (`--all`) against a real schema.
