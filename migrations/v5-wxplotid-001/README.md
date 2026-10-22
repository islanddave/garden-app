# v5-wxplotid-001: the weather tables learn their plot

Ledger **V5-SPACEPLOTTIER-001**, multi-space plan V204 step **3.2a** (§2.2, §2.8, §3.0; plan of record
`project-state/_multispace-20261015/multispace-prep-plan-V204-20261019.0900.md`). Stamp **`5.3.12-wxplotid-001`**,
written by `0a-wxplotid.sql` in the same transaction as its DDL (named for the expected next release, v5.3.12; the
session renames it if the release number differs: the stamp string appears in this directory and in the five edited
gates listed below). Class: **pre-deploy additive**.

| File | What |
|---|---|
| `0a-wxplotid.sql` | `plot_id` on both weather tables, the composite keys into plots (NOT VALID), the plot unique indexes, the backfill of Dave's Space behind its pre-gate, `guard_plots_repoint()` reading `plot_id`, the stamp |
| `0r-rollback.sql` | puts 3.1's guard body back and drops the indexes, keys and columns; refuses while later steps or non-derivable data depend on `plot_id` |
| `gates.yml` | 7 pre gates (the backfill pre-gate and the definition pre-gate among them); 6 post gates, each self-armed on the stamp, one apply-window receipt |
| `rehearse_local.py` | the local PostgreSQL 17 rehearsal (below). **Historical from 3.2b on** (amended 2026-10-21, pre-promote v5.3.13 MINOR-1): it reads the writers at its base `a2083805` (3.2b's stamp re-reads `$1`, 3.2c's job names `plot_id`), needs a pre-3.2a `--base-db` (a post-3.2a one with `0r` applied will do), and its extractor maps a repeated bind to one, which `v5-wxplotnotnull-001/rehearse_local.py` reuses on the current writers. Re-run on such a base 2026-10-21: 156/158, the 2 reds being its step-2 base-SHA-vs-tree corpus comparison on a post-2.1 database (2.1's own tolerant edits), not this step |
| `rehearse_fork.py` | the same rehearsal on a prod fork, for the session to run (below) |

Not applied to staging or prod. No JS writer is changed here (3.2b does that).

## What it adds

- **`plot_id uuid`**, NULLable, no default, on `weather_daily` and `weather_cold_range`: the plot the row's weather
  was recorded for. NULL means "not stamped yet" (rows a deployed writer adds before 3.2b's promote).
- **`weather_daily_plot_id_space_id_fkey`** and **`weather_cold_range_plot_id_space_id_fkey`**: `(plot_id, space_id)
  → plots(id, workspace_id)` (3.1's `plots_id_workspace_id_key`), ON DELETE RESTRICT, ON UPDATE NO ACTION, MATCH
  SIMPLE, **NOT VALID**. A row's Space is its plot's Space by a DB fact (V204 §2.2). MATCH SIMPLE skips the check
  while `plot_id` is NULL; NOT VALID skips only the scan of the rows present when the key is added (all NULL then):
  every row written or updated afterwards is checked, the backfill's UPDATEs included. 3.2d VALIDATEs both. The keys
  point into plots, not spaces, so `spaces_delete_guard`'s single-column rule (C-BLOCK) is untouched, and 3.1's
  `plots_delete_guard` walks them column by column: a plot with weather refuses a delete with P0001 before RESTRICT
  (23503) is reached.
- **`weather_daily_plot_id_date_key`** `(plot_id, "date")` and **`weather_cold_range_plot_id_night_date_init_time_key`**
  `(plot_id, night_date, init_time)`: plain unique indexes (not constraints), NULLS DISTINCT, no predicate, the only
  shape `ADD PRIMARY KEY USING INDEX` (3.4) accepts and the arbiters 3.3a names. A NULL `plot_id` never collides.
  The primary keys stay `(space_id, "date")` and `(space_id, night_date, init_time)` until 3.4.
- **The backfill**: each row of Dave's Space gets that Space's live default plot (Plot 1), `WHERE space_id = <Dave's
  Space>` and `plot_id IS NULL`, joined to plots, never a literal (below).
- **`guard_plots_repoint()` reads `plot_id`** (3.1's C-GUARD; 3.1 handed this to 3.2a in its header, its COMMENT ON
  FUNCTION and its README "Later consumers"). Same trigger, same OF list, same P0001 and message prefix.
- No trigger, no CHECK, no default, no grant, no row security. No Space literal and no `sentinel_workspace()` call in
  the guard body or anywhere in this directory (N12).

### Dave's Space and the backfill pre-gate

Dave's Space is taken from the data: **the one `public.spaces` row** (V204 §0: one Space on both envs;
`post_no_second_owner_until_approved` holds that until Phase 7). The pre-gate runs per env twice: as `gates.yml`'s pre
gates before the apply, and as 0a's step 0 inside the transaction, which prints the counts with `RAISE NOTICE`:

```
v5-wxplotid-001 backfill pre-gate: Dave's Space <id> (the one spaces row), default plot <id>; weather_daily N row(s), n without plot_id; weather_cold_range M row(s), m without plot_id; rows naming any other Space: 0.
```

- A table with no row prints `weather_daily NO_EVIDENCE (no row to backfill)` (or `weather_cold_range ...`) and is
  not a failure. Read 2026-10-19 (read-only): **prod** 162 `weather_daily` and 6 `weather_cold_range` rows, all of
  Dave's Space; **staging** 0 `weather_daily` (NO_EVIDENCE) and 1 `weather_cold_range` row (night 2026-10-14), which
  is backfilled onto staging's coordinate-less Plot 1.
- **Any other `space_id` aborts the whole file**, changing nothing, naming each Space and its counts: a second
  `spaces` row (whether or not it has weather: with two Spaces the data no longer says which is Dave's), or any
  weather row naming a Space other than Dave's. The file attributes Dave's Space's rows only.
- Dave's Space must have exactly one live default plot (3.1's continuous gate); otherwise 0a refuses.

### The C-GUARD rule from here (what `plots_repoint_guard` refuses)

P0001 when `(lat, lng, postal_code, timezone)` changes (IS DISTINCT FROM) on:
1. a plot that any `weather_daily` or `weather_cold_range` row names (`plot_id = plot.id`), or
2. a plot that is or becomes its Space's default while any weather row of that Space has no plot yet (`plot_id IS
   NULL`; 3.2b's writers and 3.2d's re-run attribute those to the default plot).

3.1's rule froze the default plot for every row of its Space and nothing else. The two are the same until a Space has
weather at a second plot (3.3b); then the new rule also freezes that plot, and stops freezing the default plot for
weather that is not its own (both rehearsed against 3.1's body). The escape template is unchanged (COMMENT ON
FUNCTION). **Definition pre-gate (V204 §3.0, DSA-18):** 0a refuses unless the live body's md5 is
`0845482dfbb48a94ec3cd81bddd6d62f` (3.1's, read live on prod and staging 2026-10-19), or on a re-apply its own
`467a31ca4b105064f4996442d900c7e3`; `pre_guard_plots_repoint_is_the_3_1_body` says the same before the apply.

## Why the deployed code is unaffected (the arming test, V204 §3.0, DSA-25)

Asked of every writer below, at garden-app `a2083805` (v5.3.11): would it produce a row the file refuses? No:
`plot_id` is NULLable with no default and no CHECK; MATCH SIMPLE does not check a key with a NULL column; a unique
index never matches a NULL; no trigger is added on either weather table. The hourly writer's arbiter stays the
primary key `on conflict (space_id, "date")` and its SET list does not name `plot_id`, so a backfilled row keeps its
plot. `garden_wx_writer` holds INSERT on seven named columns only: an INSERT that does not name `plot_id` needs no
privilege on it, and its bare `ON CONFLICT DO NOTHING` meets no new conflict while `plot_id` is NULL. No reader does
`SELECT *` on either table (`git grep`), and gam-site exports neither. **Rehearsed**: each census writer's column list,
the hourly writer's and the backfill script's exact statements (new day and backfilled day), and `wn3_send.py`'s
INSERT as a role holding only its seven grants, all succeed after 0a; the same writes against a mutant carrying
`CHECK (plot_id IS NOT NULL) NOT VALID` are each refused 23514, so the test can red.

## Writers, enumerated by rule (RIA-B4), and what 3.2b, 3.2c and 3.2d do to each

Rule: `git grep -n -i -E "insert into (public\.)?weather_(daily|cold_range)" -- lambda scripts tests migrations`, plus
the off-repo `project-state/tools/wn3_send.py`. Run at `a2083805` before this directory existed (V204's positive
control, `handler.js:335`, `backfill-weather-daily.mjs:230`, `season-stats.int.test.js:130/:134`,
`spaces-guards.int.test.js:91/:93`, `v5-wxcoldband-001/rehearse_local.py:115`, is all found; `rehearse_local.py`
asserts it on every run):

| Writer | Statement | Today | Must do |
|---|---|---|---|
| `lambda/daily-plan/handler.js:335` (writeWeatherDaily; SET list `WEATHER_DAILY_CONFLICT_SET` `:205-291`) | hourly upsert, 13 columns, `on conflict (space_id, "date") do update` | writes `plot_id` NULL; a backfilled row keeps Plot 1 | **3.2b**: stamp the Space's default plot, keep the arbiter, SET list gains `plot_id = coalesce(weather_daily.plot_id, excluded.plot_id)` (heals the D-2/D-1 rows written NULL since 3.2a); POLICY regex in `weather-daily-conflict-sync.test.js:27` in the same commit. **3.3a**: arbiter `(plot_id, "date")`. **3.3b**: the plant's plot |
| `scripts/backfill-weather-daily.mjs:230` (reads `spaces` `:181`) | the same upsert, mirrored verbatim (sync test) | same | **3.2b**: as handler.js, same commit (the sync test reds a one-writer commit). **3.3a/3.3b**: as handler.js |
| `project-state/tools/wn3_send.py:81-83` (off-repo; `SPACE_ID` hardcoded `:66`) | `INSERT ... (7 columns) ... ON CONFLICT DO NOTHING` as `garden_wx_writer` | writes `plot_id` NULL | **3.2c** (Dave OK): W3 grant gains `plot_id` (staging, then prod), then the job sends `PLOT_ID` (and `SPACE_ID`) from its config by key name; `scripts/wx-writer-role.py` probes updated. Its bare `ON CONFLICT DO NOTHING` already meets 3.4's precondition |
| `tests/integration/season-stats.int.test.js:130`, `:134` | fixture rows for a test Space made without a plot | `plot_id` NULL | **before 3.2d**: the test Space gets its default plot (4.1's `createSpace`, or a plot in the fixture) and the rows name it, or 3.2d's NOT NULL reds them 23502 |
| `tests/integration/spaces-guards.int.test.js:91`, `:93` | same | same | same |
| `migrations/v5-wxcoldband-001/rehearse_local.py:115` | a rehearsal on a schema it builds itself | never sees `plot_id` | nothing (historical, self-contained) |
| `migrations/v5-plottier-001/rehearse_local.py:183`, `:188`; `migrations/v5-spaceguard-001/rehearse_local.py:164`, `:169` | rehearsals of their own steps on a prod dump | `plot_id` NULL on a post-3.2a base | historical; re-run on a post-3.2d base they need a plot (and plottier's 0r refuses while 3.2a's keys exist) |
| `migrations/v5-wxplotid-001/rehearse_local.py`, `rehearse_fork.py` | this step's own cases | name `plot_id` where a case needs it | none |
| `lambda/daily-plan/weatherdaily.test.js:548` | a mock matcher (`/insert into weather_daily/i.test(sql)`) | not a writer | 3.2b's mock-pg tests see the new parameter |

UPDATE writers found beside them (not INSERTs, not in the rule): `v4-rainbackfill-001/0b-data.sql:173` and its `0r:35`,
one-time precip re-sourcing, applied 2026-08-28 (stamp `4.62.0-rainbackfill-001`); they do not name `plot_id`. The harness (`scripts/space-harness/**`)
names neither table.

## C-CONV pre-scan (V204 §2.8, widened)

Searched every `migrations/*/gates.yml` (154 before this directory): for the target relations (`weather_daily`,
`weather_cold_range`: 7 files, 47 gates across pre, sweep and post); for the new column (`plot_id`: none); for `plots` (3.1's file and the
2.0b relkind gate); for catalog-wide shapes over `pg_attribute` / `information_schema.columns` / `pg_constraint` /
`pg_index` / `pg_trigger` with no single-object filter (a script lists every post gate that reads a catalog without a
name filter: each was read, and none reaches a nullable column, a composite RESTRICT key into plots or a unique index
on a weather table, except those below); for `prosrc` / md5 pins by object name (`guard_plots_repoint`: 3.1's
`post_plots_guard_functions_pinned`); for trigger gates on the tables touched (none changes: no trigger is added).
Then the whole corpus ran before and after 0a on the rehearsal, `--env prod` and `--env staging`, **twice**: as it is
at `a2083805` (the gates unedited) and as it is in this tree.

**Gates that change, each edited in this push in its tolerant form** (green before the apply and after it; tighter
than before on the stamp; V204 §3.0):

| Gate | Reds at 3.2a unedited (rehearsed) | Edited expected value |
|---|---|---|
| `v4-weatherdaily-001/gates.yml` `post_no_extra_columns` (V204 §2.2) | yes: `plot_id` | NOT IN list gains `plot_id`, admitted only once `5.3.12-wxplotid-001` exists |
| `v5-wxcoldband-001/gates.yml` `post_no_column_outside_the_eight` (§2.2) | yes: `plot_id` | nine columns: `plot_id` admitted only with the stamp |
| `v5-wxcoldband-001/gates.yml` `post_primary_key_is_the_only_unique_index` (§2.2) | yes: the new index | PK plus `weather_cold_range_plot_id_night_date_init_time_key`, admitted only with the stamp and only in its exact definition (valid, no predicate, NULLS DISTINCT); its absence after the stamp is a row |
| `v5-wxcoldband-001/gates.yml` `post_exactly_one_fk_cascade_validated_to_spaces` (§2.2) | yes: count 2 | the spaces key as before plus, with the stamp, `weather_cold_range_plot_id_space_id_fkey` exactly: `(plot_id, space_id) → public.plots TABLE (id, workspace_id)`, RESTRICT / NO ACTION / MATCH SIMPLE; NOT VALID allowed while `plot_id` is NULLable, validated required once it is NOT NULL; any other key a row |
| `v5-plottier-001/gates.yml` `post_plots_guard_functions_pinned` (found by the pre-scan: 3.2a replaces the body) | yes: md5 | `guard_plots_repoint` md5 is 3.1's without the stamp, this step's with it |

**V204 difference, on the fourth:** §2.2 arms "must be validated" on 3.2d's `schema_version` row. 3.2d's stamp is not
named yet, so the arm keys on `plot_id` being NOT NULL, which 3.2d's one file sets together with the VALIDATE; the same
event, with no stamp invented for a later lane. 3.2d may re-key the arm on its stamp. `post_plot_keys_exact` here uses
the same rule.

**In scope, unchanged** (each read in full; green before and after on the rehearsal):

| Gate | Why in scope | Expected value after 3.2a |
|---|---|---|
| `v4-weatherdaily-001` `post_all_columns_present`, `post_no_created_by_column`, `post_date_column_is_date_not_timestamp`, `post_pk_columns_are_space_id_and_date`, `post_pk_has_exactly_two_columns`, `post_check_constraints_present` | weather_daily shape | unchanged (PK and CHECKs untouched; the PK gates move at 3.4) |
| `v4-weatherdaily-001` `post_fk_to_spaces_on_delete_cascade` | FKs of weather_daily | 1 row: it counts keys **into spaces**; the new key goes into plots |
| `v5-wxcoldband-001` `post_columns_have_these_shapes`, `post_only_created_at_has_a_default` | cold-range shape | unchanged (`plot_id` has no default) |
| `v5-wxcoldband-001` `post_primary_key_is_space_night_init` | PK | unchanged until 3.4 |
| `v5-wxcoldband-001` `post_three_checks_validated_and_no_others` | CHECKs | unchanged (no CHECK added; 3.2d's helper CHECK is its own) |
| `v5-wxcoldband-001` `post_no_trigger_and_no_row_security` | triggers on cold range | unchanged: no trigger added (the keys' RI triggers are internal) |
| `v5-wxbackfillvars-001` `post_five_columns_*`, `post_original_ten_columns_intact`, `post_no_physically_impossible_value` | weather_daily columns, `to_jsonb(w)` | unchanged (IN-lists; a new key in the JSON is ignored) |
| `v5-spaceguard-001` `post_weather_truncate_guards_present_and_enabled`, `post_weather_*_kept_prod`, `post_weather_cold_range_kept_staging` | truncate guards, row counts | unchanged (the backfill changes no count) |
| `v5-spaceguard-001` `post_foreign_keys_into_spaces_are_single_column_on_id` | keys into spaces | unchanged: the new keys go into plots |
| `v5-plottier-001` `post_plots_constraints_exact`, `post_plots_indexes_exact`, `post_plots_has_no_other_trigger`, `post_plots_triggers_exact_and_enabled` | plots | unchanged: the keys are on the weather tables; their triggers on plots are internal |
| `v4-cascadesweep-001` `post_no_cascade_onto_a_soft_deletable_table`, `v4-evtanchordel-001` `post_no_setnull_fk_inside_an_anchor_check` | catalog-wide over keys | 0 rows: the new keys are RESTRICT |
| `v5-tenantgates-001` `post_sentinel_callers` | every function body | unchanged: the new body holds no Space literal and no `sentinel_workspace()` |
| `v5-tenancyclasses-001` `post_tenancy_classes_closed_world` | relation set | unchanged: indexes are not classed relations |
| `v5-seasonstats-001` (pre column presence), `v4-rainbackfill-001` (pre and data gates over dates and precip) | name weather_daily | unchanged: they read named columns and rows the backfill does not change |

**Rehearsal set difference (both envs, prod's data and staging's shape):** base-SHA corpus newly red = exactly the five
above; this tree's corpus newly red = newly green = {}; 0 ERROR in any before-run (no FAULT).

**Non-gate consumers checked:** `lambda/tenancy-classes.json` and `tests/tenancy-catalog.prod.json` (2.0b) class the
weather tables "D via plot" with tenancy column `space_id`, and the snapshot holds only class-named columns, so
`plot_id` changes neither file and the class, attnotnull and VALUES sync tests stay green (run). 2.0e classifies the two
new unique indexes in `scripts/tenancy-index-exemptions.json` (its lane). `tests/integration/_cleanup.js` (MF3): not
changed; no integration helper gives a test Space a plot, its weather rows (NULL `plot_id`) are deleted before the
Space as today, and nothing references them.

## Rehearsal

### Local (done)

Local PostgreSQL 17.10 only (`initdb … -A trust --no-locale -E UTF8`, 127.0.0.1:55491). Replica: prod's
`pg_dump --schema-only --no-owner --no-privileges -n public -n gv -n extensions` (`NEON_DATABASE_URL` by key name;
pg_dump only reads), and a read-only data copy of prod (`pg_dump --data-only -t public.schema_version -t public.spaces
-t public.plots -t public.spacetheme -t public.weather_daily -t public.weather_cold_range`, plus the `audit_events`
rows of spaces and plots by `\copy` inside `BEGIN TRANSACTION READ ONLY`), loaded with `session_replication_role =
replica`: 189 stamps, 1 Space, 1 plot, 162 + 6 weather rows. Then:

```bash
python3 migrations/v5-wxplotid-001/rehearse_local.py --port 55491 --base-db base
```

**Result 2026-10-19 at this directory's HEAD: 168/168 PASS, exit 0** (158/158 before its own files were tracked: the
census rule then also finds this directory's fixture inserts). Pre 7/7 on the base; C-CONV before on both corpora and
envs, no ERROR, the corpora agree; 0a exit 0 with the pre-gate counts printed (162 and 6, none elsewhere); post 6/6 with
the receipt; C-CONV after: base corpus newly red = the five, edited corpus {} / {}. Arming: every census writer whose
column list does not name `plot_id` (11 at `a2083805`, 16 with this directory's fixtures) × 2 Spaces (Dave's and a
plot-less fixture Space) succeeds, and each is refused 23514 by the NOT VALID CHECK mutant; handler.js and the backfill
script, exact text, new day (plot NULL) and backfilled day (keeps Plot 1); wn3_send.py's INSERT as a seven-grant role:
1 / 0 / 0 rows. Keys: a cross-Space plot 23503 on insert and on update, NULL unchecked, Plot 1 delete P0001
`plots_delete_guard`, Plot 1 moved to another Space 23503, with the delete guard dropped the key itself 23503 (RESTRICT).
C-GUARD: Plot 1 lat / postal_code→NULL / timezone P0001; same-value passes; a non-default plot named by weather_daily
or by weather_cold_range P0001; a default plot with NULL-plot daily or cold rows P0001; a default plot whose Space's
weather all names its second plot moves; a non-default plot beside NULL rows moves; a plot becoming default under NULL
rows P0001; 3.1's body lets the first through and refuses the second (what 3.2a fixes) and reds the md5 pin; five body
mutants each killed and each red on the pin. Tightened arms, each green then red on a planted violation after the
stamp: extra column (both tables), extra unique index, plot index dropped, NULLS NOT DISTINCT, partial, plot key dropped,
plot key CASCADE, NOT NULL with the key NOT VALID, an extra key; this directory's: a default on `plot_id`, key CASCADE,
key MATCH FULL, NOT NULL unvalidated, index dropped, a cross-Space pair planted past the key (2 rows named), the receipt
false on a NULL row; 3.2d's end state (NOT NULL + VALIDATE) green. Self-arm: stamp deleted → only
`post_schema_version_recorded` reds here, and every edited gate reds on this step's objects. Later steps: 3.2b's
coalesce upsert heals a NULL row and keeps a stamped one; 3.3a's two arbiters infer the indexes; 3.2d's VALIDATE and
NOT NULL succeed and then an insert without `plot_id` is 23502, and a planted cross-Space pair makes VALIDATE 23503;
3.4's ADD PRIMARY KEY USING INDEX takes both indexes. **0a refusals (positive controls)**, each with its pre gates red
and nothing changed: a second Space with weather (named, with its counts), a second Space without weather, a weather
row naming a Space other than Dave's, Plot 1 soft-deleted, a changed guard body (md5), a `plot_id` made by something
else. **NO_EVIDENCE shapes:** staging's (coordinate-less Space and Plot 1, no weather_daily, one cold-range row):
`weather_daily NO_EVIDENCE` printed, 0a exit 0, the cold row on the coordinate-less Plot 1, post 6/6, C-CONV as above on
both envs; no weather at all: both NO_EVIDENCE, 0a exit 0, post 6/6. **0r** refuses a row on a non-default plot,
`plot_id` NOT NULL, a constraint taking a plot index, an unknown guard body, nothing dropped each time; 0r exit 0 with
the catalog (comments included) equal to the base and 3.1's md5 back; post vacuous with no 42703; edited corpus as on
the base; 0r again a no-op; 0a after 0r and twice more idempotent, catalog equal to the first apply.

### Live, read-only (2026-10-19)

0a's step 0 alone, inside `BEGIN TRANSACTION READ ONLY … ROLLBACK` (`NEON_DATABASE_URL` / `NEON_STAGING_URL` by key
name): passes on both envs. Prod prints Dave's Space, its Plot 1, `weather_daily 162 row(s), 162 without plot_id;
weather_cold_range 6 row(s), 6 without plot_id; rows naming any other Space: 0`; staging prints its Plot 1,
`weather_daily 0 … weather_cold_range 1 row(s), 1 without plot_id`, then `weather_daily NO_EVIDENCE`.
`gate_runner.py --migration migrations/v5-wxplotid-001` (read-only connection): 13/13 PASS on both envs (pre gates
ready, post gates vacuous). The three edited gate files, `--phase post --continuous-only` as gate-invariants runs
them: all PASS on both envs (the tolerant forms are green on today's databases).

### On a prod fork (for the session)

V204 §2.8 wants the weather steps rehearsed on a prod fork. This lane may not create Neon branches, so
`rehearse_fork.py` is written for the session to run on one it creates (a `neon_safety_branch.py` copy or a harness
pair's A side, inside the fleet budget):

```bash
# <scratch>/fork.env holds one line: WXPLOTID_FORK_URL=<the fork's owner connection string>
python3 migrations/v5-wxplotid-001/rehearse_fork.py \
  --fork-env-file <scratch>/fork.env --fork-key WXPLOTID_FORK_URL \
  --prod-env-file /Users/davenichols/AI/Claude/Projects/Gardening/garden-app/.env.local
```

**PASS = the last line reads `VERDICT: PASS (n/n)` and the exit status is 0.** Exit 1 = a FAIL line (read it); exit 2
= FAULT: the target's Neon endpoint is prod's or staging's, `NEON_DATABASE_URL` / `NEON_STAGING_URL` could not be read
to prove otherwise, or the target is not a fresh prod copy (it must carry `5.3.6-plottier-001` and not this stamp).
Never a pass. Two `SKIP` lines are expected on Neon (planting a row past the key needs a superuser; the local run covers
them). It runs: the preflight counts; pre gates; C-CONV before on both corpora; the positive control (a planted second
Space with its plot and weather, then 0a's statements in the same transaction: refused naming it, rolled back, nothing
left); 0a for real through psql (`-v ON_ERROR_STOP=1`, the connection string in libpq's environment, never argv) with
its counts equal to the preflight; post gates; **each listed gate red before its edit and green after** (the set
difference above, on prod's data); every case of the local run on prod's rows, rolled back; 0r for real (catalog equal
to the preflight, 3.1's body back); 0a again. It leaves the fork with 0a applied; let it expire. Rehearsed here against
a local clone owned by a NOSUPERUSER CREATEROLE role (Neon's shape) with a fake prod env file: **VERDICT: PASS
(129/129)**, the two SKIPs; and its two refusals (an endpoint equal to the prod key's, a target already stamped) each
exit 2.

## The DDL sitting (V204 §2.8, §3)

- **Step 0:** main carries the five tolerant gate edits (they reach main by promote before the sitting:
  gate-invariants' Tuesday cron runs main's copy) and the latest gate-invariants run is green. The prod-fork rehearsal
  above has passed on the day.
- **Envs:** staging, then prod, one sitting, Dave's first-hand OK naming `v5-wxplotid-001` and both envs. One prod
  safety copy for the day (`python3 scripts/neon_safety_branch.py --env-file .env.local create --slug ms2`), `list`
  plus both fleet caps (`harness.py fleet`).
- **Window:** outside :55-:05 (daily-plan's hourly writer) and 07:00-08:00 UTC; not during `wn3_send.py`'s nightly
  run. 0a adds no trigger (2.0c has landed, so the restore-verify ordering no longer applies to trigger DDL either).
  `SET LOCAL lock_timeout = '5s'`: a 55P03 changed nothing; run it again.
- **Apply:** `gate_runner.py --migration migrations/v5-wxplotid-001 --env <env> --phase pre` (the backfill pre-gate);
  `psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-wxplotid-001/0a-wxplotid.sql` (read the NOTICE counts: staging
  `weather_daily NO_EVIDENCE` and 1 cold-range row, prod 162+ and 6+ at the day's counts, other Spaces 0); then
  `--phase post` (the receipt included, right after the apply). Stamp `5.3.12-wxplotid-001`.
- **After:** 3.2b's code promote (both JS writers stamp `plot_id`; its first run logs `skipped: 0` and heals the
  NULL-plot window rows). 3.2c and 3.2d follow their rows.

## Rollback

`0r-rollback.sql`, after the rollback of anything that reads or writes `plot_id` (3.4, 3.3b, 3.3a, 3.2d, 3.2c's job
change, 3.2b's code: a deployed writer that names `plot_id` fails every write once the column is gone, and nothing in
the database can tell which code is live), and before v5-plottier-001's 0r. It refuses, changing nothing, while
`plot_id` is NOT NULL (3.2d), while any constraint or index besides this file's is built on `plot_id` (3.4's primary
keys: DROP COLUMN would drop them without CASCADE and leave the tables with no key), while any row names a plot that is
not its Space's live default (that attribution exists nowhere else), or while the guard body is neither 3.2a's nor
3.1's. Otherwise it puts 3.1's body and comment back byte for byte (md5 checked in the file), then drops the indexes,
the keys, the columns and the stamp. Rehearsed (above).

## Later consumers of this file

- **3.2b:** both JS writers stamp `plot_id` and keep `on conflict (space_id, "date")`; the SET list's `coalesce` heals
  the NULL rows written between this apply and its promote (rehearsed shape). `spaces-columns.test.js` gains its plots key.
- **3.2c:** the W3 grant gains `plot_id`; until then the job's rows are NULL and the backfill re-run picks them up.
- **3.2d:** re-runs the backfill (0a is idempotent and does exactly that on a re-apply), VALIDATEs both keys, NOT NULL
  by CHECK → VALIDATE → SET NOT NULL → drop the helper CHECK; `post_exactly_one_fk_cascade_validated_to_spaces` and
  `post_plot_keys_exact` then require the keys validated (they key on NOT NULL). The integration fixtures above must
  stamp a plot first.
- **3.3a:** the arbiters are these indexes (rehearsed inference).
- **3.4:** `ADD PRIMARY KEY USING INDEX` on these indexes renames them: re-pin `post_plot_unique_indexes_exact`, the
  wxcoldband unique-index gate and the PK gates in the same push. This file's 0r refuses while 3.4 is applied.
- **2.0e:** classifies `weather_daily_plot_id_date_key` and `weather_cold_range_plot_id_night_date_init_time_key`.
- **3.1's README / rehearsal:** its `rehearse_local.py` and 0r assume no key into plots; on a post-3.2a base its 0r
  refuses (as designed) until this 0r runs.

## Decisions

Engineering choices this lane made (not for Dave):
- **Dave's Space = the one spaces row**; a second Space aborts the file even without weather (the data then does not
  say which Space is Dave's). Alternatives read and rejected: the platform operator's Space (adds a P-class dependency
  to a weather migration), a literal (the brief forbids it).
- **The guard body is replaced here**, as 3.1's file says, not left for 3.3b: until a second plot has weather the two
  rules agree, but the new one is the rule the data now supports, and leaving it would leave 3.1's COMMENT ON FUNCTION
  untrue.
- **"Validated" keyed on NOT NULL**, not on an unnamed 3.2d stamp (above).
- ON UPDATE NO ACTION (the default) beside ON DELETE RESTRICT, as 3.1's key into spaces; MATCH SIMPLE (required while
  writers send NULL).
- The unique indexes are created in the same transaction before the backfill (a few hundred rows), so the backfill is
  checked by them and by the keys row by row; not CONCURRENTLY (a transaction cannot).
- The stamp name `5.3.12-wxplotid-001` follows COMMON.md's expected release; rename at push time if it differs.
