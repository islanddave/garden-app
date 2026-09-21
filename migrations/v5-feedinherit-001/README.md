# v5-feedinherit-001 — feed 21 plants on their own schedule, not the house 14 days

**Status: APPLIED on prod 2026-09-21 17:10:19Z** (21 rows `UPDATE 1`, `--phase post` PASS 7/7, whole corpus 0 FAIL)
**and on staging 17:10:12Z (stamp only, `UPDATE 0` x21).** Written, gated and rehearsed on a fork of prod first; Dave
approved the change itself. Do not re-run 0a: it is idempotent (`UPDATE 0` x21) but moves the stamp's `applied_at`,
which re-points the two window-only `updated_at = applied_at` receipts.

Ledger row: `BUG-CAREFEEDINHERIT-001`. Dave's decision (2026-09-21), the option he chose: "Use the care-data intervals
(Recommended) — Set each of the 21 to its own interval from the app's care data. This changes only care records, not
code, and each record can be set back. I rehearse it on a copy of the database first." No code half: the engine already
reads the key this adds.

| file | what it does |
|---|---|
| `0a-data.sql` | One transaction. Adds `fertilize_interval_days` to 21 cultivar care profiles, by row id, only where the key is absent; stamps `5.0.0-feedinherit-001`. No DDL. |
| `0r-rollback.sql` | Removes that key again, only where it still holds exactly what 0a wrote and only while the stamp exists; reports what is left. |
| `gates.yml` | 9 `pre` (8 prod-only: identity, starting md5s, the five rows left out, leaf overrides, a reach guard over every planting of the 21 cultivars, the 21 live, the 5 soft-deleted, the inherited 14), 1 standing `post` invariant (self-armed, prod-only), 6 apply-window receipts (5 prod-only). |

## Why

The care profile the engine reads for a planting is `v_resolved_care`: the system row, then the cultivar row, then any
leaf row, merged key by key (`||`, right wins). The system row says `fertilize_interval_days: 14`. On 2026-08-23
`cadence-backfill-20260823` wrote cultivar profiles that know how often to water and say nothing about feeding, so every
plant under one of them is fed on the house 14 days. `engine.fertilizeRec` cannot tell "the cultivar says 14" from
"nobody said anything".

Read on prod on 2026-09-21 (read-only; the lane-profileshadow census, re-run by this lane with the same result): of 211
live plantings, 208 take their care from a database profile. For 25 of them the feed interval comes from the system row
while the bundled `cadence-data-v2.json` entry for the same plant says something else. Run forward from 2026-09-21 to
2026-11-30 ("Dave feeds the day it is carded"), 21 of those 25 get a different run of feed cards. The other four never
get a card either way (below).

0a gives those 21 cultivar rows the interval their bundled entry carries, **copied, not re-decided**. It is a single-key
`jsonb_set` (the `v5-coldshadow-001`/`-002` method): the 8 or 9 keys already on each row stay byte-identical, and
`gates.yml` checks them by md5. `create_missing` is `true` because the key is absent: with `false`, `jsonb_set` returns
the row unchanged and the `UPDATE` reports a match while writing nothing. The value is a JSON number, because the
engine ignores anything else. `lambda/daily-plan/feedinherit.test.js` parses every value, and the bundled entry each
statement names, out of `0a-data.sql` and fails if one stops matching.

### The rows it touches (prod; nothing else is written)

Every row is **cultivar** scope (`care_scope` is `system | cultivar | leaf`; "genus" below names the bundled entry,
not the row's scope). Every row was written by `cadence-backfill-20260823`, carries `_tier: T2` and notes that say
only how its watering was measured. None carries a decision about feeding: no `no_calendar_feed`, `_basis`,
`_scope_note` or feeding wording. No leaf-scope row exists on any planting of these cultivars.

| care_profile row | cultivar | plantings it reaches | interval written | from | feed cards 09-21..11-30 |
|---|---|---|---|---|---|
| `58586ba5-7080-469d-bf77-3f5746cd2132` | Alaska Mix | Alaska Mix Nasturtium 1 (live), and soft-deleted "Alaska Mix Nasturtium 2", "Alaska Mix Nasturtium" | 45 days (was 14) | `by_variety["Alaska Mix"]` | 5 → 1 |
| `cf4e17cf-d3da-46c9-bf71-a014f35bf2ad` | Chrysanthemum | Chrysanthemum | 28 days (was 14) | `by_genus_fallback["Chrysanthemum"]` | 5 → 3 |
| `834a3a15-bd59-4801-ac2d-1d58bc0c79a3` | Clemson Spineless 80 | Clemson Spineless 80 (live), and soft-deleted "Clemson Spineless 80", "Clemson Spineless 80 Okra Seeds" | 21 days (was 14) | `by_genus_fallback["Abelmoschus"]` | 4 → 3 |
| `9548b3f2-e86c-435e-8ef2-28f5d0e8aa8c` | Cobaea scandens (Violet) | Cobaea scandens (Violet) | 21 days (was 14) | `by_genus_fallback["Cobaea"]` | 3 → 2 |
| `e43739f4-75a6-4ae4-a673-1a8aef0e0f0b` | Contender | Contender Bush Bean | 30 days (was 14) | `by_genus_fallback["Phaseolus"]` | 3 → 2 |
| `f807599b-f4d4-4fff-9703-ff21cbf9981f` | Dwarf Blue Curled (Vates) | Dwarf Blue Curled Kale | 21 days (was 14) | `by_genus_fallback["Brassica"]` | 3 → 2 |
| `04554719-e633-44d7-8791-f3e33c90ed2d` | Easy Wave Berry Velour | Easy Wave Berry Velour Petunia | 7 days (was 14) | `by_genus_fallback["Petunia"]` | 4 → 8 |
| `f86d0c66-7b6d-4a8e-b9de-0132d9e3332a` | Foxglove | Foxglove | 30 days (was 14) | `by_genus_fallback["Digitalis"]` | 4 → 2 |
| `13bcffdc-ac3d-4294-a6a9-b887aa76584e` | Gold Rush | Gold Rush Bush Bean | 30 days (was 14) | `by_genus_fallback["Phaseolus"]` | 3 → 2 |
| `5378c39e-8174-4ce9-85ad-351adc4f1486` | Hosta | Hosta | 45 days (was 14) | `by_genus_fallback["Hosta"]` | 5 → 2 |
| `8cc55d60-10a6-468e-a9af-cfafc7731b65` | Japanese Maple | Japanese Maple | 60 days (was 14) | `by_variety["Japanese Maple"]` | 5 → 1 |
| `2d2bc039-58e4-4ce7-8930-e58a66c4cd5a` | Jewel Mix Nasturtium | Jewel Mix Nasturtium | 45 days (was 14) | `by_genus_fallback["Tropaeolum"]` | 5 → 1 |
| `ebf1aab5-4879-4080-a8aa-4e11b454de31` | Lacinato (Dinosaur) | Lacinato Dinosaur Kale | 21 days (was 14) | `by_genus_fallback["Brassica"]` | 3 → 2 |
| `e74d95b7-df0a-4948-9bf2-d5bfd1bbeeea` | Lemon Verbena | Lemon Verbena | 21 days (was 14) | `by_genus_fallback["Aloysia"]` | 3 → 2 |
| `c848cd0b-48bf-4622-be46-b65903725bc3` | Palla Rossa Mavrik | Palla Rossa Mavrik Radicchio | 21 days (was 14) | `by_genus_fallback["Cichorium"]` | 3 → 2 |
| `315a0e95-0469-4b88-9647-5662c0edc884` | Petunia | Petunia | 7 days (was 14) | `by_genus_fallback["Petunia"]` | 4 → 8 |
| `1d49baf7-103b-4a65-a6f5-81d1034d36a1` | Purple Vienna | Purple Vienna Kohlrabi (live), and soft-deleted "Purple Vienna Kohlrabi Seeds" | 21 days (was 14) | `by_genus_fallback["Brassica"]` | 2 → 2 |
| `ae276aeb-95c1-4dd2-8eab-159aa4dfa262` | Redbor | Redbor Kale | 21 days (was 14) | `by_genus_fallback["Brassica"]` | 3 → 2 |
| `241d3455-8961-4c8c-a7ab-4a73e84fc002` | Spider Plant | Spider Plant | 30 days (was 14) | `by_variety["Spider Plant"]` | 4 → 2 |
| `d44d911e-b57c-40d2-88e9-d35ae16b1c87` | Tavera | Tavera Filet Bush Bean Seeds | 30 days (was 14) | `by_genus_fallback["Phaseolus"]` | 3 → 2 |
| `43162747-b27c-4ac3-bbd8-eadddd48cffc` | Tendersweet | Tendersweet Carrot | 30 days (was 14) | `by_genus_fallback["Daucus"]` | 3 → 2 |

Each bundled entry is about the same plant as the cultivar: the 18 genus entries are keyed by the cultivar's own genus,
and the three variety entries (Alaska Mix, Japanese Maple, Spider Plant) name that genus in their crop text. The
`by_variety["Peach"]` entry, which is a pepper, fails that check. Plus the `schema_version` row
`5.0.0-feedinherit-001`. On staging, only the stamp is written (see Apply).

### Reach: three rows also reach soft-deleted plantings

A cultivar row reaches every planting of its variety, deleted or not (`v_resolved_care` joins every `plants` row). 18 of
the 21 rows reach exactly their one live planting. Three also reach soft-deleted plantings of the same cultivar:

- Alaska Mix: "Alaska Mix Nasturtium" (deleted 2026-07-21) and "Alaska Mix Nasturtium 2" (deleted 2026-08-14).
- Clemson Spineless 80: "Clemson Spineless 80" (a seed record, deleted 2026-07-15) and "Clemson Spineless 80 Okra Seeds"
  (deleted 2026-07-22).
- Purple Vienna: "Purple Vienna Kohlrabi Seeds" (a seed record, deleted 2026-08-14).

Nothing anyone sees changes for them: the daily-plan query drops deleted plantings, and the only other reader of
`v_resolved_care` (the plants route) reads `heat_response` alone. If one were restored it would take the new interval,
and for each of the five the engine's own bundled entry is the same one its live sibling uses. The pre reach guard pins
all 26 plantings by id, so a new planting of any of these cultivars, or a restore, stops the apply.

### Which are left out, and why

| planting | why it is not here |
|---|---|
| Blackberry, Red Raspberries, Wild Wineberry | The legacy in-ground Rubus (`_tier: P`, "deliberately unmanaged, rainfall only"). All three are dormant, so the engine never cards them either way. Their rows (`49ebc111…`, `b973ecee…`, `401f91aa…`) are three of the five `gates.yml` checks this file does **not** write. |
| Lemon Thyme | Its crop is "thyme", which `engine.isMedHerb` never feeds. No card either way. Row `6b8e2195…`. |
| Peach tree | Not among the 25: its row carries `no_calendar_feed: true` (Dave, 2026-09-17), and its bundled entry is a pepper. Row `d9690105…`. |

## What changes for Dave

- **Fewer feed prompts on 18 plants, weekly ones on the two petunias.** Over 2026-09-21 to 2026-11-30 (if each is fed
  the day it is carded), the 21 plants go from 77 feed cards to 53: both nasturtiums and the Japanese maple from 5 to
  1, the hosta from 5 to 2, the chrysanthemum from 5 to 3, spider plant and foxglove from 4 to 2, the okra from 4 to 3,
  and each of the kales, radicchio, carrot, Cobaea, lemon verbena and the three bush beans from 3 to 2. The two
  petunias go from 4 to 8 (every 7 days from 10-11). The kohlrabi keeps two cards, and the second one comes a week
  later (11-26 instead of 11-19).
- **Nothing changes today.** None of the 21 has a feed card on 2026-09-21, and today's plan is identical either way.
- **Each feed card carries its interval in the plan, but the card does not print it.** The card's check-off (a feed
  logged within the interval clears it) uses the new number. What Dave sees is the cadence: those plants' feed cards
  come back less often (or, for the petunias, more often) over the coming weeks.
- **Nothing else changes.** Watering intervals, the bring-inside cards and the frost email read other keys. The other
  keys on each row are untouched and checked by hash.

**Release note:** 21 plants (the hosta, Japanese maple, nasturtiums, kales, beans, carrot and others) now get feed
reminders on their own researched schedule instead of every 14 days — fewer for 18 of them, and weekly for the two
petunias. (This takes effect when the migration is applied, not with a code promote, because there is no code change.)

## Which build: it does not matter

There is no code change. `engine.fertilizeRec` already reads `fertilize_interval_days` from the adopted profile. Prod
runs v4.141.0 (main `628620625dda6f2979eafc54ac7faa2e9d674faa`). Its `lambda/daily-plan/`, `scripts/gate_runner.py`
and `migrations/` are byte-identical to this migration's base, `d9affbebdd9f13aff765effa96b34ea3520ab317` (v4.141.1),
so prod already runs the exact engine the rehearsal used.

## Apply

The apply is a prod write: not part of any ship. URLs come from `garden-app/.env.local` by key name, never by pattern
and never on a command line. Run from a checkout that contains this directory.

```bash
# staging first — expect UPDATE 0 x21, INSERT 0 1: the 21 rows were written on prod on 2026-08-23 and the staging
# branch was cut from prod on 2026-08-11, so staging cannot carry these row ids; only the stamp lands.
python3 scripts/gate_runner.py --migration migrations/v5-feedinherit-001 --env staging --phase pre
psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -f migrations/v5-feedinherit-001/0a-data.sql
python3 scripts/gate_runner.py --migration migrations/v5-feedinherit-001 --env staging --phase post

# prod — expect UPDATE 1 x21, INSERT 0 1. An UPDATE 0 on prod means the wrong host or a changed row: stop, and
# re-run the pre gates.
python3 scripts/gate_runner.py --migration migrations/v5-feedinherit-001 --env prod --phase pre
psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/v5-feedinherit-001/0a-data.sql
python3 scripts/gate_runner.py --migration migrations/v5-feedinherit-001 --env prod --phase post

# both, whole corpus
python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only
python3 scripts/gate_runner.py --all --env staging --phase post --continuous-only
```

On staging, every gate except `pre_not_already_applied` and `post_schema_version_recorded` is `env: prod` and reports
NOT_APPLICABLE. That is by design: each of those gates names a prod id, and on staging 0a writes only the stamp.
Staging's contents were not read, because this lane was cleared to read prod only.

**If a `pre` gate fails on prod, do not apply.** The reach guard, the "21 live" and "5 soft-deleted" gates and the
excluded-rows gate protect the decision itself: a failure means the decision no longer covers exactly these plants and
has to be made again. The md5 gate means a row changed since it was reviewed; the "inherits 14" gate means the defect
has changed shape (the system default moved, or feeding was switched off somewhere).

**Push and apply can happen in either order.** The one continuous post gate arms itself on this migration's stamp, so
pushing the directory before the apply cannot turn `gate-invariants.yml` red. Applying on prod before the directory
reaches `main` does not change a single result in main's own corpus either (the Tuesday cron runs main's corpus).
Both were checked on a fork of today's prod.

## Rollback

```bash
psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/v5-feedinherit-001/0r-rollback.sql
python3 scripts/gate_runner.py --migration migrations/v5-feedinherit-001 --env prod --phase pre
# staging: the same two lines with NEON_STAGING_URL / --env staging (there it only removes the stamp)
```

Rolling back puts the 21 plants back on the house 14 days. The report at the end of 0r should show every `feed_now`
empty and every `md5_now` equal to `md5_before`. The `pre` gates pass again after a clean rollback. No code needs to
be rolled back. The rollback never touches the five rows left out.

## Verification at authoring (2026-09-21)

**At authoring, nothing had been applied to staging or prod** (it was applied later the same day; see Status).
Read-only against prod (gate_runner, owner DSN by key name, read-only
connection): `--validate-only` clean; `--phase pre` PASS 9/9; `--phase post --continuous-only` PASS 1 (the standing
gate, vacuous until the stamp exists) with 6 apply-window receipts skipped. The full `--phase post` on unapplied prod
fails the stamp receipt and the three value receipts, so none of them passes on data that was never written; the two
absence receipts pass. The standing gate with its arming clause removed returns exactly the 21 plantings on today's
prod, so it detects the defect.

Rehearsed on an **ephemeral Neon fork of today's prod** (branch `br-winter-term-ambevd6l`, deleted afterwards and
confirmed gone by re-listing the project's branches). The fork matched prod: identical fingerprints of every care
profile, planting and cultivar, the same schema_version rows, and a byte-identical live-planting census (211). `pre`
PASS 9/9.

- `0a` printed `UPDATE 1` x21 and `INSERT 0 1`. Read back in a separate session: each row has one more key, the value
  as a number, and with that key taken away it hashes to the pre-apply md5. The five rows left out were unchanged.
  `post` PASS 7/7. After the apply, `pre` fails the three gates that describe the unapplied state, as designed.
- Whole gate corpus, `--all --phase post --continuous-only`, before and after the apply: 953 results each time, **zero**
  status or detail changes, zero failures. In the full (runbook) form, one result outside this directory flips:
  `v5-coldshadow-002`'s apply-window receipt `post_cold_fix_was_single_key_not_a_full_replace`, which pins 9 keys on
  eight rows, reads 3 of 8 once five of those rows carry this key too. It is `continuous: false`, so the nightly sweep
  skips it.
- The real engine over all 211 live plantings, prod's rows against the fork's applied rows, forward from 2026-09-21 to
  2026-11-30: exactly the 21 plantings above changed, 77 feed cards became 53, and today's plan was identical.
- Re-running `0a` wrote nothing (`UPDATE 0` x21; row fingerprint identical).
- `0r` printed `UPDATE 1` x21 and `DELETE 1`. Afterwards every care profile on the fork matched prod's
  byte-for-byte (a fingerprint over id and profile for all rows, read from prod at the same time; `updated_at` is the
  one column that moves). `pre` PASS 9/9. Re-running `0r` wrote nothing.
- **An excluded row sneaking in is refused.** Applied through the command above with a Lemon Thyme UPDATE added, the
  file printed `UPDATE 1` x22 after a passing `pre`. Five post gates passed; `post_the_excluded_rows_were_left_alone`
  and `post_zero_a_wrote_no_other_care_profile_row` failed.
- Red proofs, each run on the fork and restored afterwards. Every gate was seen failing at least once:

  | mutation | gates that go red |
  |---|---|
  | Hosta's interval removed | standing, value, single-key, engine view |
  | whole-object replace keeping 45 | single-key |
  | whole-object replace without the interval (what a future backfill would do) | standing, value, single-key, engine view |
  | Hosta's interval 0, or the string "45" | standing, value, engine view |
  | Petunia 7 → 10 (a later, deliberate change) | value, engine view (standing stays green, by design) |
  | a leaf row on the Hosta planting stating the interval as null | standing, engine view |
  | a leaf row with `no_calendar_feed` on the Hosta planting | none after the apply (by design); before it, the pre leaf guard and the "inherits 14" gate |
  | the Lemon Thyme row written in the apply transaction / given 45 later | excluded-rows receipt (+ no-other-row receipt for the first) |
  | stamp deleted | `post_schema_version_recorded` |
  | a soft-deleted kohlrabi planting restored | pre five-soft-deleted guard |
  | an unrelated planting re-pointed to the Hosta cultivar | pre reach guard |
  | the Hosta planting ended | pre "21 live" |
  | the system default 14 → 21 | pre "inherits 14" |
  | Lemon Thyme given an interval before the apply | pre excluded-rows gate |
  | the Hosta row given 30, or its notes edited, before the apply | pre md5 gate |
  | the Hosta cultivar re-genused | pre cultivar identity |

- `lambda/daily-plan/feedinherit.test.js`: 145 tests, green under `TZ=UTC` and `TZ=America/New_York`. 27 mutations were
  run against 0a, 0r, gates.yml, the bundled file, the engine and the test's own fixture: none survived.

## Not in scope, noticed

- After this apply, 25 more live plantings still take 14 days from the system row, where their own bundled entry also
  says 14, so nothing they show would change. The resolver-level question (a profile that omits a key inherits the
  house default) is still open; see lane-profileshadow's findings.
- The three legacy Rubus rows carry no `no_calendar_feed`. Only their dormant status keeps them silent; set one active and
  it gets feed cards every 14 days (the Peach's leak before 2026-09-17).
- Five of the 21 are `harvested` annuals (three bush beans, the okra, lemon verbena). They keep getting feed cards, on
  the new intervals. Whether they should get `no_calendar_feed` instead was not part of this decision.
