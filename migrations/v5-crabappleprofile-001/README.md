# v5-crabappleprofile-001 — the site crabapple: no watering or feeding reminders, one harvest a season

**Status: AUTHORED, NOT APPLIED** (2026-10-09, lane crabprofile, ledger `DATA-CRABAPPLEPROFILE-001`). No statement
here has run against staging or prod, and no gate has been run against a database. Applying is a prod write and
needs Dave's own yes.

Dave's decisions, all first-hand on 2026-10-09:

1. **Watering: no reminders**, the same as the Peach tree. Rainfall only.
2. **Feeding: never feed**, the same as the Peach tree.
3. **Harvest: track it, one gathering per season.** He first said not to track it, then chose this when told a
   harvest is already logged on the tree. No day-of-year window.
4. **Frost: hardy**, next to apple. This one is code (`lambda/daily-plan/frostClass.js`), not this migration.

| file | what it does |
|---|---|
| `0a-data.sql` | One transaction. Replaces the placeholder care profile on the Crabapple cultivar with the decided one, by row id, only while the row is still the exact placeholder. Sets `crop_types.harvest_habit` to `single` for `crabapple`, only while it is NULL. Stamps `5.0.0-crabappleprofile-001`. No DDL. |
| `0r-rollback.sql` | Puts the exact placeholder back and the habit back to NULL, each only while it still holds what 0a wrote and only while the stamp exists; reports what is left. |
| `gates.yml` | 8 `pre` (7 prod-only: the row's md5, a reach guard, the engine premise and the crop type among them), 2 standing `post` invariants (self-armed, prod-only), 4 apply-window receipts (3 prod-only). |

## Why

The crabapple was entered in the app on 2026-10-09 (crop type minted 12:23:48Z). The create path gives a new
cultivar a placeholder care profile and a new crop type no harvest habit, so two standing gates went red, as they
are meant to:

- **`v4-cadencerefill-001 :: post_no_live_planting_rests_on_an_unresearched_placeholder`.** The cultivar's profile
  says `_basis: unresearched` and the database supplies no cadence for the planting (`cadence_scopes` is `{}`). So
  the engine falls to the bundled default: a 3-day watering interval for a mature tree in the ground. (Inferred from
  the code and `cadence-data-v2.json`; the prod plan row was not read.)
- **`v4-harvhabitgap-001 :: post_every_null_habit_is_a_recorded_decision`.** `crabapple` has a NULL harvest habit
  and is on none of the three recorded-NULL lists.

0a makes both true decisions instead of excusing them.

### The rows it touches (prod; nothing else is written)

Read on prod 2026-10-09 ~12:30 ET with a read-only role.

| row | what it is | before | after |
|---|---|---|---|
| `care_profile` `c59f1b2f-fec6-4e17-aea5-5260700f1235` | cultivar scope, cultivar "Crabapple" (`2680ddd1-9f6a-400b-9c3b-2645fb4a39a8`), genus Malus. Reaches one planting: Crabapple (`fbf317f9-20f8-4400-8523-f410d214a959`), in the ground, Drive, not covered, not heated, status harvested. | The 3-key create placeholder (`notes`, `_basis: unresearched`, `_source: cultivar-create`). `md5(profile::text)` = `d5335984e4af2339fe6ee7b4f4946436`. | The 11-key profile below. |
| `crop_types` slug `crabapple` | display name Crabapple, category tree, perennial | `harvest_habit` NULL, `repeat_interval_days` NULL | `harvest_habit` `single`; everything else as it was |

Plus the `schema_version` row `5.0.0-crabappleprofile-001`. There is no leaf-scope profile on the planting.

The placeholder is known byte for byte: `lambda/varieties/index.js` `NEW_CULTIVAR_PROFILE`, rendered the way Postgres
prints jsonb, hashes to the md5 prod reported.

**The cultivar is not identified.** "Crabapple" is a stand-in name. The profile's note says it belongs to "the mature
in-ground crabapple at the site, cultivar not identified", and that it has to move with the tree if the tree is ever
re-pointed to a named cultivar.

### The profile, key by key

The model is the Peach tree's cultivar profile (`care_profile` `d9690105…`, `_tier: P`, "deliberately unmanaged,
rainfall only").

| key | value | why |
|---|---|---|
| `no_calendar_water` | `true` | Decision 1. `engine.waterSuppression` takes the planting off every watering list and lists it under `dormancy_suppressed`. |
| `no_calendar_feed` | `true` | Decision 2. `engine.fertilizeRec` returns no card; the planting is listed under `feed_suppressed`. |
| `water_method` | `rainfall_only` | The Peach's value. Descriptive only: it rides on a watering card, and there is none. |
| `water_interval_days_inground`, `water_interval_days_container` | `14`, `14` | The Peach's fallback. See the next section. |
| `crop`, `_tier` | `crabapple tree`, `P` | The Peach's labels for the legacy in-ground class. `crop` is what the plan row shows. |
| `_basis`, `confidence` | `dave_decision`, `low` | The `v4-cadencerefill-001` label for a ratified judgement: nothing here is a measurement. `_basis` leaving `unresearched` is also what the placeholder gate reads. |
| `_source` | `v5-crabappleprofile-001` | Names this migration. |
| `notes` | see 0a | Whose profile it is, who decided, and what the 14 is for. |

Not written, each on purpose: `cold` (a hardy tree in the ground gets no bring-in card), `drought_tolerance` (the
Peach carries `high`; nobody decided it for this tree, and its one reader is on the branch suppression closes),
`fertilize_interval_days` (`no_calendar_feed` is read first and wins).

### Are the Peach's 14-day fallback keys needed? Not for the two decisions. They are kept for adoption.

Checked in `lambda/daily-plan/engine.js`, `handler.js` and `migrations/v4-seededgate-001/0a-view.sql` at dev
`e0894f51`, and by running the real engine (`lambda/daily-plan/crabappleprofile.test.js`):

- **Suppression does not need them.** `waterSuppression` and `feedSuppression` read two sources, the resolved
  cadence and the raw database profile (`srcs = [c, p.db_cadence]`). The handler selects
  `vrc.resolved_profile as db_cadence` for every planting. So `no_calendar_water` and `no_calendar_feed` suppress
  with no interval key at all, and with `CARE_CADENCE_SCOPES_ENABLED` on or off (the flag only nulls
  `cadence_scopes`). The test runs both cases and both hold.
- **What they do is make the engine adopt the row.** A non-null `water_interval_days*` key is the only thing that
  puts `cultivar` into `v_resolved_care.cadence_scopes`, and the engine uses a database profile whole only when that
  array is non-empty. Adopted, the plan row carries this row's `crop` label ("crabapple tree"; unadopted it reads
  "Malus"), and if `no_calendar_water` is ever taken off, the tree falls to 14 days, not the 3-day house default.
  The planting also stops counting as one "nothing in the database knows how to water".
- **They are not harmful.** Nothing bundled is shadowed by adopting: `cadence-data-v2.json` has no Crabapple
  variety entry, no Malus genus entry, and its default has no `cold` block. The 19 standing gates in the corpus that
  read care profiles were read against the new row: none goes red. `v5-feedinherit-001`'s gate, the one aimed at
  adopted rows that silently inherit the 14-day feed interval, exempts a row with `no_calendar_feed`.

The cost is one number nobody measured sitting in the row, which is why the row is labelled `dave_decision` / `low`
and the note says the interval is a fallback that is never expected to fire.

### Why a whole-object replace, not a single-key `jsonb_set`

`v5-coldshadow-001` and `v5-baycold-001` add one key and leave the rest byte-identical, because the rest was
curated. Here all three keys on the row are machine-written placeholder text and all three are superseded. 0a's
`WHERE` carries the placeholder's md5, so it replaces the row only while nothing else is on it; a profile anyone has
written since is left alone.

### The harvest habit

`single` is the field contract's value for one harvest, and the value dogwood's flip condition already names for a
landscape tree that ripens once. Picks are counted per grow year (Nov 1 to Oct 31, `lambda/harvests/watch-route.js`).
`repeat_interval_days` stays NULL (a CHECK forbids `single` with an interval). `loss_horizon_hours`,
`set_to_first_pick_days` and the day-of-year bounds are **not written**, the bee_balm precedent: the decision named a
habit and nothing else, and NULL means unknown, so no readiness rule may fire on it. `first_year_harvest` is not
touched.

The same value is in `src/data/harvest-attributes-v1.json` (`by_crop_type.crabapple`) and in
`migrations/v4-harvattr-001/0b-data.sql`; `src/__tests__/harvestAttributesSync.test.js` holds those two equal.
`crabapple` is on no recorded-NULL list and is not in `src/lib/harvestTracked.js`: it stays harvest-tracked.

## What changes for Dave

When 0a is applied (no code promote needed for these):

- **No watering reminder for the crabapple.** It is off Today's watering lists for good, like the Peach tree.
- **No feed card for it.**
- **A dry-spell note can appear for it**, as it can for the Peach tree: after 20 days in a row with no day of
  0.60 in of rain or more, Today's drought note includes plantings that are never watered by interval.
- **The two red gates clear** on the next gate run.

With the next code promote:

- **The frost email stops counting it.** Until then an unbanded crop type is counted as "unclassified (treated as
  tender)". Banded hardy, it is never counted and never named.

What does not change:

- **The planting page.** Harvested and Put up stay. `single` never fires "ready to pick", and the harvest-end
  estimate takes the same path for `single` as for no habit.
- **The harvest watch, this grow year.** A harvest is logged on the tree (its date and type were not read). If it
  falls in this grow year, the watch leaves the tree out until 2026-11-01. After that it can be watched again;
  whether a row appears depends on an anchor date the watch can resolve, which was not traced for this tree.
- **End of season.** A hardy perennial is not listed there, and an unbanded one was not listed either.
- **Cold cards.** None before, none after, at any temperature.
- **Every other plant.** The cultivar row reaches one planting, and the reach guards keep it that way.

**Release note (suggested):** The crabapple tree no longer gets watering or feeding reminders, the same as the
Peach tree, and its harvest is tracked as one gathering a season. The frost email no longer counts it. (The first
two take effect when the migration is applied; the frost change ships with the next release.)

## Which build: it does not matter for the data

No code change is needed for 0a to take effect. Both suppression keys are already read by the engine: the Peach
tree is listed under `dormancy_suppressed` and `feed_suppressed` in the prod plan of 2026-09-24
(`tests/harness/_todaymeasure/dailyplan.dave.json`). The readers of `harvest_habit` already handle `single`. The
build actually running on prod was not read.

Unlike `v5-baycold-001`, **the two decisions do not depend on `CARE_CADENCE_SCOPES_ENABLED`.** With the flag off
the engine does not adopt the row (so the label and the 14-day fallback are not used), and it still suppresses
both. The flag affects no gate either: gates read the database, not the Lambda. So step 2 of the apply is
informational, not a hold condition as it was for baycold. It tells you whether the plan row will be labelled
"crabapple tree" (adopted) or "Malus" (not adopted).

Data and code can land in either order. The frost band, the JSON and the seed row neither need nor are needed by 0a.

## Apply

The apply is a prod write: Dave's call, not part of any ship. URLs come from `garden-app/.env.local` by key name,
never by pattern and never on a command line. 0a and 0r write `schema_version`, which is owner-write only: run them
under the owner DSN. Run from a checkout that contains this directory.

```bash
# 1. offline: the whole corpus parses (expect "OK: 140 gate file(s), 1859 gate(s)" at this commit)
python3 scripts/gate_runner.py --all --env prod --validate-only

# 2. read-only: what the daily-plan Lambda's flag says (informational here, see "Which build")
aws lambda get-function-configuration --function-name garden-daily-plan \
  --query 'Environment.Variables.CARE_CADENCE_SCOPES_ENABLED'

# 3. staging first. Staging has no crabapple rows: expect UPDATE 0, UPDATE 0, INSERT 0 1.
#    (If the branch was re-cut from prod after 2026-10-09 12:24Z: UPDATE 1, UPDATE 1. Both are correct.)
python3 scripts/gate_runner.py --migration migrations/v5-crabappleprofile-001 --env staging --phase pre    # 1 PASS, 7 n/a
psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -f migrations/v5-crabappleprofile-001/0a-data.sql
python3 scripts/gate_runner.py --migration migrations/v5-crabappleprofile-001 --env staging --phase post   # 1 PASS, 5 n/a

# 4. prod, read-only: every premise. Any FAIL or ERROR: stop.
python3 scripts/gate_runner.py --migration migrations/v5-crabappleprofile-001 --env prod --phase pre       # 8 PASS

# 5. prod, read-only DRY RUN of the post phase, before anything is written. Require ZERO ERROR.
#    Expected: post_schema_version_recorded FAIL, both standing gates PASS (unarmed), three receipts FAIL.
python3 scripts/gate_runner.py --migration migrations/v5-crabappleprofile-001 --env prod --phase post

# 6. prod write. Must print UPDATE 1, UPDATE 1, INSERT 0 1, COMMIT.
psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/v5-crabappleprofile-001/0a-data.sql

# 7. prod, read-only: 6 PASS.
python3 scripts/gate_runner.py --migration migrations/v5-crabappleprofile-001 --env prod --phase post

# 8. both, whole corpus: no new red, and the two gates in "Why" are green on prod.
python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only
python3 scripts/gate_runner.py --all --env staging --phase post --continuous-only
```

**An `UPDATE 0` on prod in step 6 means the wrong host or a changed row, and the stamp has already committed.** Run
0r (it removes the stamp and matches nothing else), then read the pre gates.

### What each environment does

- **Staging.** Every gate except `pre_not_already_applied` and `post_schema_version_recorded` is `env: prod` and
  reports NOT_APPLICABLE. 0a writes the stamp and nothing else. That rehearses 0a's statement text (both JSON
  literals are parsed even when no row matches) and the stamp. It does not rehearse the gates: each names a prod
  id or the prod-only crop type.
- **Prod.** All 14 gates run. Their first execution is step 4 and step 5, both read-only.

### If a `pre` gate fails on prod, do not apply

| gate | it means |
|---|---|
| `pre_profile_is_the_untouched_create_placeholder` | The row changed since 2026-10-09. 0a would match nothing. |
| `pre_cultivar_is_the_row_read_at_authoring` | The cultivar was renamed, retyped or deleted: someone may have identified the tree. Decide where the profile belongs. |
| `pre_no_other_live_planting_reaches_this_row` | A second planting is filed under "Crabapple" and would inherit never-water, never-feed. |
| `pre_no_leaf_override_decides_water_or_feed` | The planting has its own watering or feeding key, which would win over the cultivar row. |
| `pre_the_planting_is_live_in_the_ground_and_under_open_sky` | The tree was ended, re-filed as a container or moved under a cover. |
| `pre_the_engine_resolves_no_database_cadence_for_the_planting` | Something already decides this planting. Find out what. |
| `pre_crop_type_is_the_row_read_at_authoring_with_no_habit` | The crop type changed, or a habit was set by hand. |

**Push and apply can happen in either order.** Both continuous post gates arm themselves on this migration's stamp,
so pushing the directory before the apply cannot turn `gate-invariants.yml` red. Pushing `migrations/**` to dev does
run the whole continuous corpus, read-only, against prod and staging. The weekly run reads the default branch, so it
carries these two gates only after the next promote.

Keep the staging and prod applies close together: a stamp on staging with none on prod may show as drift
(`check-staging-drift.py` was not read).

## Rollback

```bash
psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/v5-crabappleprofile-001/0r-rollback.sql
python3 scripts/gate_runner.py --migration migrations/v5-crabappleprofile-001 --env prod --phase pre
# staging: the same two lines with NEON_STAGING_URL / --env staging
```

The report at the end of 0r should show `basis_now` `unresearched`, `md5_now` equal to `md5_before`
(`d5335984e4af2339fe6ee7b4f4946436`) and `habit_now` empty. The `pre` gates pass again after a clean rollback.

Rolling back puts the tree back on the 3-day watering default and turns both gates in "Why" red again. It is for
unwinding a bad apply. No code needs to be rolled back.

## The standing gates, and what would turn them red

- **`post_the_crabapple_gets_no_calendar_watering_or_feeding`** (the decision, keyed on the planting). Red if the
  profile the handler selects for the tree stops saying both keys are exactly `true`: a rewrite of the row that
  drops one, a leaf override that turns one off, or **the tree being re-pointed to a newly named cultivar**, whose
  fresh placeholder has neither key. That last one is the likely one, since the cultivar is unidentified. The remedy
  is to move this profile to the new cultivar, not to retire the gate. (`v5-rekeystrand-001`'s gate goes red for the
  profile left behind in the same event.) A deliberate "start watering it" needs this gate retired in that change.
- **`post_no_other_planting_inherits_the_unmanaged_tree_profile`** (the reach, keyed on the cultivar). Red if any
  other live planting of the stand-in "Crabapple" cultivar resolves either key `true`. It fires on ordinary data
  entry, by design: a second crabapple filed under this name would get no watering reminders at all. The remedy is
  in the gate's note.

Neither turns red for: ending or deleting the tree, renaming the cultivar, logging a harvest, setting an
overwintering regime on the planting (that leaf row carries only `overwintering`), or changing the habit.

The habit has no standing gate of its own. `v4-harvhabitgap-001 :: post_every_null_habit_is_a_recorded_decision`
already goes red on both environments if it returns to NULL.

## Verification at authoring (2026-10-09)

**Nothing was applied to staging or prod, no gate was run against a database, and none of this SQL has been
executed anywhere.** The lane that wrote it was cleared to connect to nothing. The first `--phase pre` run on prod
is the gates' first execution, and it is read-only.

What was checked, offline:

- `gates.yml` parses with PyYAML and loads through `gate_runner.load_gate_file` (14 gates, each a single read-only
  statement). `gate_runner.py --all --env prod --validate-only`, which parses and opens no connection, prints
  `OK: 140 gate file(s), 1859 gate(s) parsed and schema-valid.` `scripts/test_gate_runner.py` passes under pytest
  (77 with `test_count_ratchets.py`). `yamllint -d relaxed` exits 0 with line-length warnings only.
- The placeholder md5: `NEW_CULTIVAR_PROFILE` rendered as jsonb text hashes to the value read on prod. The same
  rendering of 0r's literal does too, and the test fails if it stops.
- `lambda/daily-plan/crabappleprofile.test.js`, 37 tests, with the profile parsed out of `0a-data.sql` and run
  through the real engine: a watering card on the 3-day default and a feed card before; neither after; each key
  shown to do its own work; both suppressions holding with the flag off and with no interval keys; no cold card at
  any temperature; the frost alert not counting it. The same file binds 0r and `gates.yml` to 0a, and 0a's habit to
  the JSON and the seed row.
- 39 mutations of 0a, 0r, `gates.yml`, `frostClass.js`, `engine.js`, the JSON, the seed row, `harvestTracked.js`
  and the `v4-harvhabitgap-001` gate list (a key set false, the md5 guard dropped, a merge instead of a replace, a
  `cold` block added, the standing gates weakened five ways, and others). Every one turned a test red; each file
  was restored and its hash checked. The list is in the test file's header.
- A wider run over `lambda/daily-plan`, `lambda/harvests`, `lambda/varieties`, `lambda/plants`, the harvest, frost,
  slug and season tests in `src/__tests__`, and the tests under `migrations/`: 249 files, 5215 tests, all passing.
- The 19 standing gates elsewhere in the corpus that read care profiles, and the standing gates that read the
  harvest columns, were read against the new row and the new habit: none goes red. They were not run.
- The gate SQL reuses shapes that ran on prod on 2026-10-09 in `v5-baycold-001` (the `VALUES` joins, the reach
  guard, the planting premise, `v_resolved_care` reads). New in this file and never executed: `l.covered`,
  `cardinality(vrc.cadence_scopes) = 0` under this join, the `crop_types` column list, and jsonb equality against a
  whole-profile literal. Each column is one the deployed handler or an existing gate already reads.

What the reviewer and the rehearsal still have to check:

1. Step 5 above returns zero `ERROR` on prod. That is the only proof the gate SQL is valid there.
2. Step 3 on staging: 0a runs clean and prints `UPDATE 0`, `UPDATE 0`, `INSERT 0 1`. Then run 0r on staging and
   confirm it also runs clean: its dollar-quoted placeholder literal contains `\"` and the sequence
   `:"unresearched"`, which psql must pass through untouched (it does not substitute variables inside a quoted
   body, and none of that name is set). Both data literals are pure ASCII (the placeholder's one em dash is
   written as a JSON unicode escape), so the client encoding cannot change what is written.
3. `care_profile` and `crop_types` carry no trigger that needs a session variable (`select tgname from pg_trigger
   where tgrelid = 'public.care_profile'::regclass and not tgisinternal`). `v5-baycold-001` and
   `v4-harvhabitgap-001` wrote the same two tables with plain UPDATEs.
4. `locations.covered` for Drive is still false, and the planting is still `in_ground` (pre gate 6 checks both).
5. After step 6, the next daily plan lists the tree under `dormancy_suppressed` and `feed_suppressed` with crop
   "crabapple tree", and on no watering list.

## Not in scope, noticed

- `migrations/v4-harvhabitgap-001/gates.yml` keeps a dated paragraph for every crop type that tripped its gate. It
  was not edited for crabapple (the slug is seeded, not listed, so the gate's SQL does not change).
- The slug-universe pin in `src/__tests__/slugUniverseConsistency.test.js` gained `crabapple` alone. It is not a
  re-pull, so any other crop type minted since 2026-09-18 is still invisible to that guard.
- `scripts/test_gate_runner.py` run directly with `python3` prints nothing and exits 0: it has no `__main__` block.
  Use `python3 -m pytest scripts/test_gate_runner.py`.
- The create path gives every new cultivar this placeholder and every new crop type a NULL habit, so both gates go
  red again on the next new cultivar that reaches a planting. That is their contract.
