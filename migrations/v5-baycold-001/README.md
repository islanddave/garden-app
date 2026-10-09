# v5-baycold-001 — a bring-inside card and a named frost warning for the Sweet Bay Laurel

**Status: WRITTEN, GATED, NOT REHEARSED, UNAPPLIED.** Nothing in this directory has run against staging or prod, and
no gate in it has been run against any database. The apply is Dave's call.

Dave's decision (2026-10-09): warn the Sweet Bay Laurel, with a bring-inside threshold of 32°F. No code half: the
engine already reads the key this adds. `bay` stays an unbanded crop type (`frostClass.UNCERTAIN_SLUGS`).

| file | what it does |
|---|---|
| `0a-data.sql` | One transaction. Adds the `cold` key to one cultivar care profile, by row id, only where the key is absent; stamps `5.0.0-baycold-001`. No DDL. |
| `0r-rollback.sql` | Removes that key again, only where it still holds exactly what 0a wrote and only while the stamp exists; reports what is left. |
| `gates.yml` | 7 `pre` (6 prod-only: the row's md5, the engine premise and a reach guard among them), 1 standing `post` invariant (self-armed, prod-only), 4 apply-window receipts (3 prod-only). |

## Why

The bay gets no frost warning on either channel, for two separate reasons (traced at dev `526eb195`):

- **Today card.** `engine.coldFor` shows a "bring in tonight" card only when the care profile it resolves for the
  planting carries `cold.tender` with a `protect_below_F`, or the crop type has a fallback threshold. The Sweet Bay
  cultivar profile was written on 2026-08-23 by `cadence-backfill-20260823` as a watering-only row with no `cold`.
  The engine uses that profile whole. The crop type `bay` has no fallback entry, and `cadence-data-v2.json` has no
  bay entry either. So there is no number anywhere, and no card at any temperature.
- **Frost email.** `bay` is deliberately unbanded: a woody herb that survives a first frost but is overwintered
  indoors here. An unbanded crop type is counted at the tender trip points and reported as "N unclassified (treated
  as tender)". The email never names it.

0a gives the cultivar profile `cold = {"tender": true, "protect_below_F": 32}`. That one key turns on both channels:
the card reads the threshold, and the email's existing promotion (`handler.js` `cadenceTenderFor`) names an unbanded
crop type whose profile says tender. It uses a single-key `jsonb_set` (the `v5-coldshadow-002` method), so the other
8 keys on the row stay byte-identical, and `gates.yml` checks them by md5.

The value is **decided, not copied**. `v5-coldshadow-002` copied each number from the bundled data its row was
hiding; bay never had a bundled number. The nearest precedent is Pineapple Sage, set to 32°F in `v5-frostband-001`.
`lambda/daily-plan/frostband.test.js` parses the value out of `0a-data.sql` and fails if it stops being 32.

### The row it touches (prod; nothing else is written)

Read on prod 2026-10-09 with a read-only role.

| care_profile row | cultivar | planting it reaches | where | `cold` written |
|---|---|---|---|---|
| `d4c8c7e3-320c-4019-8827-b39894cf02b8` | Sweet Bay (`e890276d-43e6-41cd-9dfe-1fa8e05fcfc1`), crop type `bay` | Sweet Bay Laurel (`0bf82c76-b7c2-4396-bc17-9f95f5138806`) | Trough, not covered, not heated | 32°F |

The row is **cultivar** scope and reaches exactly that one planting. Before the apply its profile has 8 keys (`crop`,
`_tier`, `notes`, `_source`, `confidence`, `water_method`, `drought_tolerance`, `water_interval_days_container`) and
`md5(profile::text)` is `ae1f9608920cf706635dc726cdd44fe8`. The planting adopts it (`cadence_scopes` is
`{cultivar}`), resolves no `cold`, and has no brought-inside event logged. Plus the `schema_version` row
`5.0.0-baycold-001`.

### What is deliberately not here

| not changed | why |
|---|---|
| `frostClass.js` (`bay` stays in `UNCERTAIN_SLUGS`) | Banding bay tender would list a perennial under "finished" on the End of season page, which ends plantings in bulk. Banding it light-frost-tolerant would move the email's trip points later and still give no card. |
| Rosemary, penstemon and the other unbanded crop types | The same kind of plant, but not part of this decision. |
| An email label such as "bay laurel" | The email will say "bays (1)", the default plural. Cosmetic, and a code change. |

## What changes for Dave

- **A "bring in tonight" card on Today when tonight's low is 32°F or below.** It appears in Today's care list with
  the existing card text, "tender tropical — bring in tonight (low 32°F ≤ 32°F)". It comes back each qualifying night
  until the plant is logged as brought inside, and stays away until it is logged as brought outside. At 33°F and
  above there is no card.
- **The frost email names it.** It says "bays (1)" in the crop list instead of counting the plant in "N unclassified
  (treated as tender)".
- **The card and the email use different temperatures.** The email names bay from its usual trip points (a "protect
  tonight" email at 38°F and below); the card waits for 32°F. Between 33°F and 38°F the email names it and Today
  has no card for it.

What does not change:

- **The nights the email fires.** Unclassified plants and bay-as-tender use the same trip points (advisory 40°F,
  protect 38°F, hard freeze 33°F). Only the wording changes.
- **Frost bands.** No crop type is banded or re-banded.
- **End of season.** Bay is still not listed there.
- **Everything else about the plant.** Watering stays every 2 days; the other 8 keys are untouched and checked by
  hash.

One thing to know about the day of the apply: if a frost email has already gone out for that night and 0a is
applied before the afternoon's later checks, one more email goes out naming "bays", because a newly named crop
counts as news. Applying on a day with no frost email, or in the morning, avoids it.

**Release note:** The Sweet Bay Laurel now gets a "bring in tonight" card when the low is 32°F or below, and the
frost email names it instead of counting it as unclassified. (This takes effect when the migration is applied, not
with a code promote, because there is no code change.)

## Which build: it does not matter

There is no code change. `engine.coldFor` reads `cold` from the adopted profile, and `handler.js` promotes an
unbanded crop type whose profile says tender. `main` at `7ec97f6a938a9894a24379d98d5940eef9691ebd` (v4.177.0,
fetched 2026-10-09) carries a `lambda/daily-plan/` and a `scripts/gate_runner.py` byte-identical to this migration's
base, dev `526eb195`. The build actually running on prod was not read. Both readers are older than this: they are
what `v5-frostband-001` and `v5-coldshadow-002` relied on in September.

It does depend on one setting: `CARE_CADENCE_SCOPES_ENABLED` must be true, which is prod's value in
`scripts/lambda-config-expected.json`. With it off the engine does not use the database profile, and bay has no
bundled entry to fall back on, so it would be silent again.

## Apply

The apply is a prod write: Dave's call, not part of any ship. URLs come from `garden-app/.env.local` by key name,
never by pattern and never on a command line. Run from a checkout that contains this directory.

```bash
# staging first — expect UPDATE 0 or UPDATE 1, then INSERT 0 1. Staging was not read. If it does not carry this
# row id only the stamp lands (UPDATE 0); if the branch was re-cut from prod after 2026-08-23 the row is there and
# gets the key (UPDATE 1). Both are correct.
python3 scripts/gate_runner.py --migration migrations/v5-baycold-001 --env staging --phase pre
psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -f migrations/v5-baycold-001/0a-data.sql
python3 scripts/gate_runner.py --migration migrations/v5-baycold-001 --env staging --phase post

# prod — expect UPDATE 1, INSERT 0 1. An UPDATE 0 on prod means the wrong host or a changed row: stop, and
# re-run the pre gates.
python3 scripts/gate_runner.py --migration migrations/v5-baycold-001 --env prod --phase pre
psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/v5-baycold-001/0a-data.sql
python3 scripts/gate_runner.py --migration migrations/v5-baycold-001 --env prod --phase post

# both, whole corpus
python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only
python3 scripts/gate_runner.py --all --env staging --phase post --continuous-only
```

On staging, every gate except `pre_not_already_applied` and `post_schema_version_recorded` is `env: prod` and reports
NOT_APPLICABLE. That is by design, and it is what `v5-coldshadow-002` does: each of those gates names a prod id, so
on a staging without the row it would judge something this file never wrote.

**If a `pre` gate fails on prod, do not apply.** `pre_profile_is_the_backfill_row_without_cold` means the row changed
since 2026-10-09. `pre_the_engine_adopts_a_profile_without_cold` means the engine no longer sees the row the way
this fix assumes. `pre_no_other_live_planting_reaches_this_row` means a second Sweet Bay exists and would inherit the
card. `pre_the_planting_is_live_potted_and_unheated` means the plant has been planted out, moved somewhere heated or
ended; the pot type was not part of the 2026-10-09 read (it is `plastic_pot` in the 2026-09-24 prod dump on dev), so
this gate is where it is confirmed.

**Push and apply can happen in either order.** The one continuous post gate arms itself on this migration's stamp, so
pushing the directory before the apply cannot turn `gate-invariants.yml` red.

## Rollback

```bash
psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/v5-baycold-001/0r-rollback.sql
python3 scripts/gate_runner.py --migration migrations/v5-baycold-001 --env prod --phase pre
# staging: the same two lines with NEON_STAGING_URL / --env staging
```

Rolling back removes the card and puts the plant back in the email's "unclassified" count. The report at the end of
0r should show `cold_now` empty and `md5_now` equal to `md5_before`. The `pre` gates pass again after a clean
rollback. No code needs to be rolled back.

## Verification at authoring (2026-10-09)

**Nothing was applied to staging or prod, and no gate was run against a database.** The lane that wrote this was
cleared to connect to neither. That is less than `v5-coldshadow-002` had: it was rehearsed on a fork of prod, and
this is not. The SQL in the gates is that directory's, cut down to one row, and has not been executed in this form.
The first `--phase pre` run on prod is its first execution, and it is read-only.

What was checked, offline:

- `gates.yml` parses with PyYAML and loads through `gate_runner.load_gate_file` (12 gates, every one a single
  read-only statement). `scripts/test_gate_runner.py` passes over the tracked corpus with this file in it.
- `lambda/daily-plan/frostband.test.js`, 80 tests (33 new), with `coldcards`, `coldshadow` and `frostClass`: 251
  pass. Through the real engine and classifier, with the value parsed out of `0a-data.sql`: a card at 32°F and none
  at 33°F; email class tender through the cadence promotion, named "bays"; the alert fires or stays silent on the
  same nights before and after; the same trip points; no card and no naming before the apply; no card once logged
  as brought inside. The same file checks that 0a is one guarded single-key statement on this row, that 0r undoes
  only that, and that `gates.yml` carries the same row, value, floor and md5.
- 22 mutations of 0a, 0r, `gates.yml`, `frostClass.js` and `engine.js` (the value changed to 33, the guard dropped,
  `create_missing` false, a whole-object merge, the standing gate weakened four ways, bay banded, and others). Every
  one turned a test red; each file was restored and its hash checked. The list is in `frostband.test.js`.
- The 18 standing gates elsewhere in the corpus that read care profiles were read: none depends on whether this row
  has a `cold` key. They were not run.

## Not in scope, noticed

- The card says "tender tropical" for every profile-driven threshold. That is the existing wording and was not
  changed.
- If a second Sweet Bay is planted in the ground later, it inherits the card through the cultivar row, as with every
  cultivar row that carries `cold`. The reach guard stops the apply if that happens first.
- The fix lives only in the database profile. A future whole-profile rewrite of this row would drop it; the standing
  gate is what would catch that.
