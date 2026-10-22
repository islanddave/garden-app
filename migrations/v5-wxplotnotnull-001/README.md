# v5-wxplotnotnull-001: every weather row names its plot, by the catalog's word

Ledger **V5-SPACEPLOTTIER-001**, multi-space plan V204 step **3.2d** ("Re-run the backfill; VALIDATE both composite
FKs; NOT NULL by CHECK → VALIDATE → SET NOT NULL → drop the helper CHECK in the same file (DSA-20;
`post_three_checks_validated_and_no_others` joins §2.2's table)"; plan of record
`project-state/_multispace-20261015/multispace-prep-plan-V204-20261019.0900.md` §2.2, §3.0, row 3.2d). Class:
**post-deploy arm**. Two files, two stamps (named for the expected next release, v5.3.14; rename them here and in
the gates if it differs):

| File | Stamp | What |
|---|---|---|
| `0a-weather-daily.sql` | `5.3.14-wxplotnotnull-001-weather-daily` | VALIDATE `weather_daily_plot_id_space_id_fkey`; `plot_id` NOT NULL via the helper CHECK, dropped in the same file |
| `0b-weather-cold-range.sql` | `5.3.14-wxplotnotnull-001-weather-cold-range` | the same for `weather_cold_range`; also refuses until 3.2c's grant is recorded |
| `0r-rollback.sql` | | `plot_id` NULLable again on both, the stamps go (DESTRUCTIVE by the house's definition: NOT NULL off an FK column) |
| `gates.yml` | | 7 pre gates (read BEFORE the backfill re-run), 2 sweep gates (after it), 3 post gates self-armed per table |
| `rehearse_local.py` | | the local PostgreSQL 17 rehearsal (below) |

Not applied to staging or prod.

**Why a new directory**, not `v5-wxplotid-001`: that directory's pre gates are 3.2a's and are red since its apply,
so a 3.2d sitting could not read a clean `--phase pre` there; this step has its own stamps, its own rollback, and is
the separate post-deploy file `gardening-deploy.md` "Migration ordering" asks for. **Why one file per table:**
`weather_daily`'s writers stamp `plot_id` since v5.3.13 (3.2b, live; prod has 0 NULL rows, read 2026-10-21), while
`weather_cold_range`'s one writer stamps it only after 3.2c's job switch. Each table arms when its own writer is
ready.

## What each file does

1. **Step 0 refuses, changing nothing**, unless 3.2a is applied as written against (stamp, column, key exact),
   `plot_id` is still NULLable (or the file's stamp is there: a re-apply), the helper's name is free, and **the
   all-row sweep** (no `deleted_at` filter: the tables have none, and L-058) finds no NULL `plot_id` and no row whose
   `(plot_id, space_id)` is not a plot of that Space. It names the rows. `0b` also refuses unless
   `5.3.14-wxwriterplot-001` exists and `garden_wx_writer` holds INSERT on `plot_id`.
2. `VALIDATE CONSTRAINT <table>_plot_id_space_id_fkey`: a cross-Space pair raises **23503**.
3. `ADD CONSTRAINT <table>_plot_id_not_null_chk CHECK (plot_id IS NOT NULL) NOT VALID` → `VALIDATE` it →
   `ALTER COLUMN plot_id SET NOT NULL` (PostgreSQL reads the validated CHECK and skips its scan) → **`DROP
   CONSTRAINT <table>_plot_id_not_null_chk`, in the same file** (DSA-20). An insert without `plot_id` then raises
   **23502**. In one transaction the CHECK's ACCESS EXCLUSIVE lock is held from the ADD to COMMIT: milliseconds at
   prod's 164 + 8 rows; `lock_timeout` 5s.
4. The stamp, same transaction.

## The arming check (V204 §3.0, DSA-25): every deployed writer, by rule

Rule: `git grep -n -i -E "insert into (public\.)?weather_(daily|cold_range)" -- lambda scripts tests migrations`,
plus the off-repo job. At this lane's HEAD:

| Writer | Writes `plot_id`? | From |
|---|---|---|
| `lambda/daily-plan/handler.js:351` (writeWeatherDaily, hourly) | yes: the row's Space's live default plot (scalar subquery on the same Space bind), and the SET heals a NULL | v5.3.13 (3.2b, live) |
| `scripts/backfill-weather-daily.mjs:232` | yes, the same | v5.3.13 |
| `project-state/tools/wn3_send.py` (off-repo, as `garden_wx_writer`) | yes once `lanes-p2/3.2c-wn3_send.patch` is applied: `WX_WRITER_PLOT_ID_<ENV>` | 3.2c S3 |
| `tests/integration/season-stats.int.test.js:136`, `:140` | yes: its test Space gets a (coordinate-less) default plot | this lane |
| `tests/integration/spaces-guards.int.test.js:105`, `:112` | yes: `ensureDefaultPlot` (from the Space's own place, as 3.1 made Plot 1), then the writers' subquery | this lane |
| `migrations/v5-plottier-001/rehearse_local.py:183/:188`, `v5-spaceguard-001/rehearse_local.py:164/:169`, `v5-wxcoldband-001/rehearse_local.py:115`, `v5-wxplotid-001/rehearse_local.py` | not deployed: throwaway clusters. plottier's and spaceguard's would need a plot if re-run on a post-3.2d base; wxplotid's is historical (pinned to its base) | |
| `lambda/daily-plan/weather-daily-conflict-sync.test.js:34`, `weatherdaily.test.js:396`, `:567`; `v5-wxplotid-001/README.md:106` | not writers (regexes, a mock matcher, prose) | |

No database function writes either table (`prosrc` over `public`, `gv`, `extensions`: 0). Rehearsed after the files:
this tree's hourly writer (a new day and D-1) and backfill script, the switched job's `send()`, and the fixtures'
own SQL read out of the test files each write on their Space's default plot; the **red controls**, v5.3.12's
hourly writer (before 3.2b) and the unswitched job's seven-column INSERT, are each refused 23502. Hence the revert
floor `{floor: v5.3.13, since: v5.3.14}` (pre-promote v5.3.13 MINOR-2) and 3.2c's `{floor: v5.3.14}`.

The integration fixtures' teardown changes with them: each file deletes its plots after its weather rows and before
its Spaces, and `tests/integration/_cleanup.js` gains a `plots` step between `spacetheme` and `spaces` and a residue
probe. In `spaces-guards`, a weather row is no longer a Space's only child (it names the default plot), so its
1.3b weather cases now assert the chain: the plot refuses to go naming the weather table (`plots_delete_guard`),
the Space refuses naming `public.plots` (`spaces_delete_guard` reads its children in table-name order).

## Sitting (exact order)

**D0. Before either file:** this directory, the fixture changes, `_cleanup.js` and the revert floors reach main by
the v5.3.14 promote; `integration-test.yml` on that dev SHA is green with FIXTURE LEAK 0; the latest gate-invariants
run is green. No existing gate is edited for this step (C-CONV below). The `WeatherDailyRowSkipped` metric filter
(`scripts/weather-observability.sh`, pre-promote v5.3.13 IMPORTANT-2) should be provisioned first: after NOT NULL a
writer that sends no plot shows as skipped rows (the session's call: an AWS write).

**0a (weather_daily): any time after D0**, staging then prod, outside :55-:05 and 07:00-08:00 UTC:
1. `python3 scripts/gate_runner.py --migration migrations/v5-wxplotnotnull-001 --env <env> --phase pre` **before
   step 2**. For 0a these must PASS: `pre_weather_daily_not_already_applied`, `pre_wxplotid_applied`,
   `pre_newest_weather_daily_row_carries_plot_id` (staging: no rows, passes), `pre_helper_check_names_free`. The
   cold-range pre gates belong to 0b and may be red until 3.2c S3.
2. The backfill re-run: `psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-wxplotid-001/0a-wxplotid.sql` (its
   re-apply changes nothing but NULL rows of Dave's Space; it prints the counts).
3. `--phase sweep`: for 0a, no `weather_daily` line in `sweep_no_null_plot_id`; `sweep_no_cross_space_pair` PASS.
4. `psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-wxplotnotnull-001/0a-weather-daily.sql`.
5. `--phase post` for this directory, then `--all --phase post --continuous-only`: all PASS.

**0b (weather_cold_range): only after 3.2c S1-S3** (both envs granted, the job switched) **and one night sent by the
switched job:**
1. `--phase pre` before the backfill: every gate PASS, `pre_cold_range_writer_holds_plot_id` and
   `pre_newest_cold_range_row_carries_plot_id` included (prod read 2026-10-21: the latter is red, nights 2026-10-20
   and -21 have no plot; staging's only row was backfilled by 3.2a, and staging has no scheduled writer).
2. The backfill re-run, as above (it gives every pre-switch night Plot 1).
3. `--phase sweep`: all PASS.
4. `psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-wxplotnotnull-001/0b-weather-cold-range.sql`, staging then
   prod (any hour but the job's own tick; a lock wait fails fast, changing nothing).
5. Post gates as for 0a.

**Rollback:** `0r-rollback.sql` (refuses while `plot_id` is in a primary key: roll 3.4 back first), then, if 3.2c
is also being undone, the job's patch reversed and `v5-wxwriterplot-001/0r-rollback.sql` (which refuses while this
step is applied).

## C-CONV pre-scan (V204 §2.8, §3.0; §2.2's table)

Every post gate in `migrations/*/gates.yml` that reads either weather table or `plot_id` together with
nullability, CHECKs or key validation (a script over the corpus): 8 gates, each read. None needs an edit:

| Gate | After 3.2d | Why unchanged |
|---|---|---|
| `v5-wxcoldband-001` `post_three_checks_validated_and_no_others` (DSA-20, §2.2) | PASS | the helper CHECK never outlives its file. **Positive control:** with 0b's DROP CONSTRAINT line removed the corpus's newly red set is exactly this gate and this directory's `post_no_plot_id_helper_check` |
| `v5-wxcoldband-001` `post_exactly_one_fk_cascade_validated_to_spaces` (§2.2) | PASS | its 3.2a tolerant arm already requires the plot key validated once `plot_id` is NOT NULL; 0b validates it (with 0b's VALIDATE removed it reds, rehearsed) |
| `v5-wxplotid-001` `post_plot_keys_exact` | PASS | the same arm, both tables (reds with the VALIDATE removed) |
| `v4-weatherdaily-001` `post_check_constraints_present` | PASS | counts its four named CHECKs; a fifth would not red it, which is why `post_no_plot_id_helper_check` exists |
| `v5-wxcoldband-001` `post_columns_have_these_shapes`, `post_only_created_at_has_a_default`; `v5-wxbackfillvars-001` `post_five_columns_nullable_undefaulted_numeric` | PASS | they name other columns |
| `v5-wxplotid-001` `post_weather_plot_is_of_the_rows_own_space` | PASS | a data gate over non-NULL plots; VALIDATE makes it the catalog's word too |

V204 keys the "must be validated" arm on 3.2d's `schema_version` row; the two existing gates key it on `attnotnull`,
which is the same event in these files, so instead of re-pinning them (an edit that would have to ride main first)
the stamp-keyed form is a new gate here, `post_plot_id_not_null_and_key_validated`. **Measured on the whole corpus,
prod and staging: newly red {} and newly green {} across 0a + 0b.** No (c) gate file is touched.

## Rehearsal

```
python3 migrations/v5-wxplotnotnull-001/rehearse_local.py --port <port> --base-db <prod-shaped db> \
  --wn3-send <scratch copy of wn3_send.py with the 3.2c patch applied>
```

Local PostgreSQL 17.10, prod's schema-only dump owned by a NOSUPERUSER role, a read-only copy of prod's rows; 3.2c
applied on the clone first. **45/45 PASS.** Precondition red on prod's data and green once both writers stamp (red
control: v5.3.12's hourly writer); sweep red before the backfill re-run, green after; corpus set difference empty
after both files; 23502 for all four no-plot writes after (all four written before); 23503 for a cross-Space pair
after VALIDATE, and a pair planted past the key refused by step 0 (and by VALIDATE itself with step 0 cut); the
arming check above; the DROP-line and VALIDATE-line mutants red exactly the gates named; 0r refusals (3.4's primary
key; 3.2c's 0r while NOT NULL), 0r, corpus back to before, re-applies idempotent; staging's shape NO_EVIDENCE.
