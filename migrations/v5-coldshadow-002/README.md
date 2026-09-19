# v5-coldshadow-002 — bring-inside cards for the potted plants the care profiles silenced

**Status: WRITTEN, GATED, REHEARSED ON A FORK OF PROD, UNAPPLIED.** Nothing in this directory has run against
staging or prod. The apply is Dave's call.

Ledger row: `V5-COLDSHADOWCENSUS-001`. Dave's decisions (2026-09-19): "card the potted ones", and for the three
15-gallon terracotta coleus, "No, leave them off". The sequel to `v5-coldshadow-001` (Graptosedum, Pachyphytum;
applied on prod 2026-09-19): same method, different rows, no overlap. No code half: the engine already reads the key
this adds.

| file | what it does |
|---|---|
| `0a-data.sql` | One transaction. Adds the `cold` key to eight cultivar care profiles, by row id, only where the key is absent; stamps `5.0.0-coldshadow-002`. No DDL. |
| `0r-rollback.sql` | Removes that key again, only where it still holds exactly what 0a wrote and only while the stamp exists; reports what is left. |
| `gates.yml` | 8 `pre` (7 prod-only: two reach guards and a check that the coleus rows still carry no `cold` among them), 1 standing `post` invariant (self-armed, prod-only), 5 apply-window receipts (4 prod-only, one of them proving 0a left the coleus rows alone). |

## Why

When a care profile in the database knows how often to water a plant, `engine.resolveCadence` uses that profile
**whole** and never reads `cadence-data-v2.json`. On 2026-08-23 `cadence-backfill-20260823` wrote watering-only
profiles for many cultivars. None of them carries `cold`, so every bring-inside threshold in the bundled data under
them stopped reaching the engine. Read on prod on 2026-09-19 (read-only): 19 live plantings were in that position
(17 once `v5-coldshadow-001` was applied that afternoon). The live plan shows the change. On 2026-07-24 (low 49°F) the
coleus got "tender tropical — bring in tonight (low 49°F ≤ 50°F)" from the bundled data. From 2026-08-23 the plan
uses the database wording for all of these plants, and none of them has had a card since, apart from Spider Plant,
which gets one at 45°F through the crop-type fallback.

0a gives the potted ones among the 19 that Dave wants carded their bundled `cold` value, **copied, not re-decided**.
It uses a single-key `jsonb_set` (the `v5-coldshadow-001` method), so the other 8 keys on each row stay
byte-identical, and `gates.yml` checks them by md5. `lambda/daily-plan/coldcards.test.js` parses every value out of
`0a-data.sql` and fails if one stops matching its bundled entry.

### The rows it touches (prod; nothing else is written)

Every row is **cultivar** scope. The database has no genus scope (`care_scope` is `system | cultivar | leaf`). The
"genus:Coleus" labels in the census name the bundled entry each row hides, not the row's scope. A cultivar row
reaches every planting of its variety, so every planting of each variety was read. Each row reaches exactly the one
planting below. There are no other plantings of these varieties, live or deleted, and none has a leaf-scope row.

| care_profile row | cultivar | planting it reaches | pot | where | `cold` written | from |
|---|---|---|---|---|---|---|
| `9548b3f2-e86c-435e-8ef2-28f5d0e8aa8c` | Cobaea scandens (Violet) | Cobaea scandens (Violet) | plastic, 6 in | Trough | 40°F | `by_genus_fallback["Cobaea"]` |
| `04554719-e633-44d7-8791-f3e33c90ed2d` | Easy Wave Berry Velour | Easy Wave Berry Velour Petunia | plastic, 6 in | Trough | 35°F | `by_genus_fallback["Petunia"]` |
| `2d2bc039-58e4-4ce7-8930-e58a66c4cd5a` | Jewel Mix Nasturtium | Jewel Mix Nasturtium | plastic, 6 in | Bag Area | 32°F | `by_genus_fallback["Tropaeolum"]` |
| `315a0e95-0469-4b88-9647-5662c0edc884` | Petunia | Petunia | hanging basket, 8 in | Trough | 35°F | `by_genus_fallback["Petunia"]` |
| `54187824-9ea7-4c5c-9fbf-da5f2326b84e` | Silver (Licorice Plant) | Silver Helichrysum | plastic, 4 in | Trough | 40°F | `by_genus_fallback["Helichrysum"]` |
| `241d3455-8961-4c8c-a7ab-4a73e84fc002` | Spider Plant | Spider Plant | plastic, 4 in | Stable | 50°F (was 45°F) | `by_variety["Spider Plant"]` |
| `f9a3ca14-5a9e-4cd9-8294-babd6e90279f` | Sunny Susy White Halo | Sunny Susy White Halo Thunbergia | plastic, 4 in | Trough | 45°F | `by_genus_fallback["Thunbergia"]` |
| `19c81d1a-c313-4ae2-bc82-5069eee72fe6` | Wishbone Flower | Wishbone Flower (Torenia) | plastic, 3 in | Trough | 45°F | `by_genus_fallback["Torenia"]` |

Every value is `{"tender": true, "protect_below_F": N}`. Each bundled entry is about the same plant as its cultivar:
its crop names the cultivar's genus. The `by_variety["Peach"]` entry, which is a pepper, fails that check. Plus the
`schema_version` row `5.0.0-coldshadow-002`. On staging, only the stamp is written (see Apply).

### Which of the 19 are left out, and why

| planting | why it is not here |
|---|---|
| Fairway Orange Coleus, Fairway Orange Coleus Clone 1, Kiwi Fern Coleus | 15-gallon terracotta. Dave, 2026-09-19: "No, leave them off" — he will not move them. Their two cultivar rows (`573c512c-f98a-4b1f-9fc6-c18afced8306` Fairway Orange, `56d1cef3-b0ab-4556-b926-93f61fc8304b` Kiwi Fern) are the only rows `gates.yml` checks this file does **not** write. |
| Alaska Mix Nasturtium 1 | A 6x2 ft trough planter. It cannot be carried in (Dave's decision). |
| Clemson Spineless 80 (okra), Peach tree | In the ground. The Peach's bundled entry is a pepper (a name collision). |
| Graptosedum, Pachyphytum | `v5-coldshadow-001`. |
| Echeveria | The crop-type fallback already cards it at 40°F, which is its bundled value. Writing the row would change no card at any temperature (checked with the engine). |
| Ginger | Logged as brought inside on 09-17, so it gets no card either way. Once it goes back out, the crop-type fallback gives it 55°F, which is its bundled value, so writing the row changes nothing. (V4-GINGERCOLD-001 already pins the bundled 55 and the crop-type 55 equal in a test. A copy in the database would be a third copy that no test pins.) |
| Jade Plant | It is in the heated House, which gets no card. Its bundled 40°F would **lower** the 45°F the crop-type fallback gives it whenever it leaves the House. |

**Spider Plant is the one row that raises an existing card, from 45°F to 50°F.** 45°F is the crop-type fallback, and
the plant gets that number only because its profile hides its own entry. The engine's precedence makes the per-variety
value authoritative over the crop-type table: "the fallback beneath it, never an override" (frostClass.js,
V4-TROPICALCOLD-001).

## What changes for Dave

- **Seven potted plants get a bring-inside card, and Spider Plant's comes on 5° sooner.** It appears in Today's care
  list on any night forecast at or below the plant's number: Spider Plant 50°F, thunbergia and torenia 45°F, Cobaea and
  licorice plant 40°F, both petunias 35°F, Jewel Mix nasturtium 32°F. The wording is the existing card text, "tender
  tropical — bring in tonight (low 45°F ≤ 45°F)". The card comes back each qualifying night until the plant is logged
  as brought inside. After that it stops until the plant is logged as brought outside.
- **The three coleus still get no card**, as decided. Nothing about them changes.
- **The frost email does not change.** Every crop type here already has its own frost band, and the only other reader
  of `cold` (the email's cadence promotion) acts only on crop types without one. Same plants, same labels, same
  trip temperatures.
- **Nothing else about these plants changes.** Watering intervals, feeding and every other care setting stay the
  same. The other 8 keys are untouched and checked by hash.

**Release note:** Seven potted plants (both petunias, the Cobaea, the licorice plant, the thunbergia, the torenia and
the Jewel Mix nasturtium) get their "bring in tonight" card back on cold nights, each at its own temperature, and
Spider Plant's card now comes at 50°F instead of 45°F. (This takes effect when the migration is applied, not with a
code promote, because there is no code change.)

## Which build: it does not matter

There is no code change. `engine.coldFor` already reads `cold` from the adopted profile. Prod runs v4.139.0 (main
`6a630cdd292d19e15017ea059f17b56b2f96afe6`). Its `lambda/daily-plan/`, `scripts/gate_runner.py` and `migrations/`
are byte-identical to this migration's base, `10452156` (v4.138.0), so prod already runs the exact code the
rehearsal used. The build before that, v4.136.0, differed in two coldFor branches: dev drops the card for a heated
location and for an in-ground plant that the frost alert names. Neither branch can touch these eight plantings,
because all are potted and none is in a heated location. The first rehearsal ran the v4.136.0 engine too and got the
same cards.

## Apply

The apply is a prod write: Dave's call, not part of any ship. URLs come from `garden-app/.env.local` by key name,
never by pattern and never on a command line. Run from a checkout that contains this directory.

```bash
# staging first — expect UPDATE 0 x8, INSERT 0 1: the eight rows were written on prod on 2026-08-23 and the staging
# branch was cut from prod on 2026-08-11, so staging cannot carry these row ids; only the stamp lands.
python3 scripts/gate_runner.py --migration migrations/v5-coldshadow-002 --env staging --phase pre
psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -f migrations/v5-coldshadow-002/0a-data.sql
python3 scripts/gate_runner.py --migration migrations/v5-coldshadow-002 --env staging --phase post

# prod — expect UPDATE 1 x8, INSERT 0 1. An UPDATE 0 on prod means the wrong host or a changed row: stop, and
# re-run the pre gates.
python3 scripts/gate_runner.py --migration migrations/v5-coldshadow-002 --env prod --phase pre
psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/v5-coldshadow-002/0a-data.sql
python3 scripts/gate_runner.py --migration migrations/v5-coldshadow-002 --env prod --phase post

# both, whole corpus
python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only
python3 scripts/gate_runner.py --all --env staging --phase post --continuous-only
```

On staging, every gate except `pre_not_already_applied` and `post_schema_version_recorded` is `env: prod` and reports
NOT_APPLICABLE. That is by design: each of those gates names a prod id, and on staging 0a writes only the stamp.
Staging's contents were not read, because this lane was cleared to read prod only.

**If a `pre` gate fails on prod, do not apply.** Three of them protect the decision itself. The first checks that no
other live planting of these eight cultivars exists (a petunia bedded out later, for example). The second checks that
all eight plantings are still live, potted and not in a heated location. The third checks that the two coleus rows
still carry no `cold`. A failure means the decision no longer covers exactly these plants, and it has to be made
again.

**Push and apply can happen in either order.** The one continuous post gate arms itself on this migration's stamp, so
pushing the directory before the apply cannot turn `gate-invariants.yml` red. Applying on prod before the directory
reaches `main` does not change a single result in main's own corpus either; the Tuesday cron runs main's corpus.
Both were checked on a fork of today's prod, and main's corpus is fully green there (0 FAIL).

## Rollback

```bash
psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/v5-coldshadow-002/0r-rollback.sql
python3 scripts/gate_runner.py --migration migrations/v5-coldshadow-002 --env prod --phase pre
# staging: the same two lines with NEON_STAGING_URL / --env staging (there it only removes the stamp)
```

Rolling back removes the seven cards and puts Spider Plant back at 45°F. The report at the end of 0r should show every
`cold_now` empty and every `md5_now` equal to `md5_before`. The `pre` gates pass again after a clean rollback. No
code needs to be rolled back. The rollback leaves `v5-coldshadow-001`'s rows alone and never touches the coleus rows.

## Verification at authoring (2026-09-19)

**Nothing was applied to staging or prod.** Read-only against prod (gate_runner, owner DSN by key name, read-only
connection), after the coleus came out: `--validate-only` clean (corpus 118 files / 1467 gates); `--phase pre` PASS
8/8; `--phase post --continuous-only` PASS 1 (the standing gate, vacuous until the stamp exists) with 5 apply-window
receipts skipped. The full `--phase post` on unapplied prod fails the stamp receipt and the three value receipts, so
none of them passes on data that was never written. The coleus receipt passes, because it asserts an absence.

Rehearsed on an **ephemeral Neon fork of today's prod** (branch `rehearse-coldcards-20260919-b`, after
`v5-frostband-001` and `v5-coldshadow-001` had been applied on prod). It was deleted afterwards, and re-listing the
project's branches confirmed it was gone. The fork matched prod: a byte-identical live census (209 plantings) and
identical fingerprints of the eight rows, the two coleus rows and every care profile. `pre` PASS 8/8.

- `0a` printed `UPDATE 1` x8 and `INSERT 0 1`. Care profiles with a `cold` key went from 197 to 205, and the coleus
  rows were unchanged. `post` PASS 6/6. After the apply, `pre` fails the three gates that describe the unapplied
  state, as designed.
- Whole gate corpus, `--all --phase post --continuous-only`, before and after the apply, with both dev's corpus (936
  results) and prod main's (930): **zero** status or detail changes and zero failures.
- The real engine over all 209 live plantings, before and after, for every low from 70°F down to 0°F: exactly the
  eight plantings above changed, each to a card at its bundled number and below. The coleus did not change, and no
  card disappeared anywhere. The watering profile each plant adopts is unchanged, and the frost email summary is
  identical.
- `0r` printed `UPDATE 1` x8 and `DELETE 1`. Afterwards every care profile on the fork matched prod's byte-for-byte (a
  fingerprint over id and profile for all rows, read from prod at the same time; `updated_at` is the one column that
  moves). `pre` PASS 8/8. Re-running `0r` wrote nothing.
- **A coleus row sneaking back in is refused.** Applied through the command above, with the Fairway Orange UPDATE put
  back, the file printed `UPDATE 1` x9 after a passing `pre`. Five post gates passed and
  `post_the_coleus_rows_were_left_alone` failed. Read-only on prod, a copy of the gates with the coleus cultivars
  added to the reach guard's variety list fails that guard, because it finds the three live coleus plantings.
- Red proofs, each run on the fork and restored afterwards. Every gate was seen failing at least once:

  | mutation | gates that go red |
  |---|---|
  | Cobaea's `cold` removed | standing, value, single-key, engine view |
  | whole-object replace with the bundled Petunia entry (keeps `cold` 35) | single-key |
  | whole-object replace without `cold` (what a future backfill would do) | standing, value, single-key, engine view |
  | Spider Plant back to 45°F | standing, value, engine view |
  | Torenia raised to 50°F (more protective) | value, engine view (standing stays green, by design) |
  | leaf-scope hardy override on the licorice plant | standing, engine view; pre leaf guard |
  | the same override on Petunia moved into a trough | engine view only (a fixed planter is not judged, by design) |
  | the same override with Petunia back in its basket | standing, engine view |
  | stamp deleted | `post_schema_version_recorded` |
  | a `cold` block written to either coleus row | `post_the_coleus_rows_were_left_alone`; pre coleus check |
  | the in-ground okra re-pointed to the Petunia cultivar | pre reach guard |
  | licorice plant planted out / Spider Plant moved into the heated House | pre eight-potted guard |
  | the licorice plant's cultivar retyped | pre cultivar identity |

  A first rehearsal (the ten-row version, before the coleus came out, on the morning's prod) also proved a hardy
  clone, a non-numeric threshold and `jsonb_set(..., false)` red, and ran prod's then-current v4.136.0 engine: same
  cards.
- `lambda/daily-plan/coldcards.test.js`: 64 tests. 32 mutations were run against the engine, 0a, 0r, gates.yml, the
  bundled file and frostClass. Eleven of them target the coleus decision: a coleus statement or id sneaking back into
  0a, 0r or a gate list, the coleus checks weakened, a count drifting, or the engine starting to card coleus with no
  data. None survived.

## Not in scope, noticed

- The resolver-level fix (engine.resolveCadence adopts a profile whole on watering evidence alone) is still open.
  Keys other than `cold` on the bundled entries, such as feeding and dormancy flags, are hidden the same way.
- If a new planting of one of these eight cultivars goes in the ground, it inherits the bring-inside card. The reach
  guard stops the apply if that happens first. After the apply, the engine drops the card for an in-ground plant
  only when the frost alert names it. Every other cultivar row that carries `cold` works the same way.
- The card says "tender tropical" for every profile-driven threshold, petunias and nasturtiums included. That is the
  existing wording and was not changed.
