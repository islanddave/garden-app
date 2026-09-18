# v5-coldshadow-001 — give Graptosedum and Pachyphytum their 40°F bring-inside card

**Status: WRITTEN, GATED, UNAPPLIED.** Nothing in this directory has run against staging or prod. The
apply is Dave's call.

Ledger row: `BUG-COLDPROFILESHADOWSBUNDLED-001`. Dave's decision (2026-09-18): both plants get a
bring-inside card at 40°F. No code half: the engine already reads the key this adds.

| file | what it does |
|---|---|
| `0a-data.sql` | One transaction. Adds the `cold` key to two cultivar care profiles, by row id, only where the key is absent; stamps `5.0.0-coldshadow-001`. No DDL. |
| `0r-rollback.sql` | Removes that key again, only where it still holds exactly what 0a wrote and only while the stamp exists. |
| `gates.yml` | 7 `pre` (6 prod-only), 1 standing `post` invariant (self-armed, prod-only), 5 apply-window receipts (4 prod-only). |

## Why

Read on prod 2026-09-18, read-only:

| planting (id) | cultivar (id) | care profile row | what the engine adopts today | cold card today |
|---|---|---|---|---|
| Graptosedum (`931f80a6…`) | "Graptosedum" (`f4919a6f…`), `succulent` | `bdbf05dd-0239-4ac0-b0d1-b0cbc816a62c` | that row, whole: 13 keys, no `cold` | none, at any temperature |
| Pachyphytum (`fdeb1317…`) | "Pachyphytum" (`b3666254…`), `succulent` | `5a179436-7feb-4e3d-9f29-bbf5272b9414` | that row, whole: 13 keys, no `cold` | none, at any temperature |

Both plants are potted, in the unheated Stable, never logged as brought inside.

`cadence-data-v2.json` gives both a threshold: `by_variety["Graptosedum"].cold` and
`by_variety["Pachyphytum"].cold` are `{"tender": true, "protect_below_F": 40}` ("Indoor year-round").
Until 2026-08-22 the engine used those entries. On 2026-08-23 `cadence-backfill-20260823` wrote a
cultivar care profile for each ("Cloned from the succulent crop baseline"): watering keys, no `cold`.
Once a database profile supplies a watering interval, `engine.resolveCadence` returns it **whole** and
never reads the bundled file (`CARE_CADENCE_SCOPES_ENABLED` is on in prod). The live plan shows the
switch: its `crop` for these two plantings read "succulent (Graptosedum)" / "succulent (Pachyphytum,
moonstones)", the bundled wording, through 2026-08-22 and "succulent", the database wording, from
2026-08-23 on. The crop-type fallback under a missing `cold` is empty on purpose
(`frostClass.COLD_BY_CROP_TYPE` has no `succulent`, because hardy species share the slug), so
`engine.coldFor` has no threshold and stays silent at every temperature. No leaf-scope profile exists
on either planting, so the cultivar row is the only thing to fix.

0a adds `cold` to those two rows with the bundled value, **copied, not re-decided**. It is a single-key
`jsonb_set` (the `v5-heatrespcabbage-001` / `v5-frostband-001` method). The other 13 keys stay
byte-identical; `gates.yml` checks their md5. `create_missing` is `true`, because the key is absent:
with `false`, `jsonb_set` returns the row unchanged, and the `UPDATE` would report a match while writing
nothing. `lambda/daily-plan/coldshadow.test.js` parses both values out of `0a-data.sql` and fails if
either stops matching the bundled entry.

### Why data, and not a change to the resolver

The underlying problem is in the code: the resolver treats a profile that only knows the watering
schedule as though it also knew the cold tolerance. A per-key code fallback would fix all 19 live
plantings in this position at once. It would also reach the 17 that Dave has not decided on. One of
them is the in-ground Peach tree, whose bundled entry is a *pepper* profile filed under the name
"Peach" (`frostClass.js` records this collision); it would get a "bring inside" card at 50°F. Most of
the rest are summer annuals, which would all start getting nightly cards at once. The per-cultivar
data fix is scoped to Dave's decision. The lane findings (`_mainsync4_20260918/coldshadow.md`) list all
19 and describe the code option.

## What changes for Dave

- **Graptosedum and Pachyphytum get a bring-inside card** in Today's care list on any night forecast
  at 40°F or colder. It uses the existing wording, "tender tropical — bring in tonight (low 38°F ≤
  40°F)". The card comes back each qualifying night until the plant is logged as brought inside, and
  after that it stops until the plant is logged as brought outside. Nothing changes at 41°F and above.
- **The frost email names them.** Today they are counted in "N unclassified (treated as tender)".
  After the apply they are listed as **"succulents (2)"**. The frost email trips at the same
  temperatures (40/38/33°F) on the same nights, because a succulent with no band is already counted as
  tender. What changes is the label, and the card and the email now agree. On today's prod data
  (before `v5-frostband-001` is applied), plants the email calls unclassified go from 15 to 13, there
  is one more named crop type, and the total at risk stays at 142.
- **Nothing else about either plant changes.** Watering stays at every 14 days in the pot, and
  feeding and every other care setting stay the same. The other 13 keys are untouched, and gates
  check that by hash.
- **Not covered:** Love's Fire (Echeveria agavoides) is also a `succulent` in the Stable. Neither its
  profile nor the bundled file gives it a threshold, so it still gets no card and stays "unclassified"
  in the email.

## Window — no ordering against the code

- There is no code change. `engine.coldFor` and the handler's email promotion already read `cold` from
  the adopted profile, so the change takes effect on the next nightly plan after the apply, whatever
  build is running.
- No column is added or removed, so no read path can 500.
- **One timing note.** The frost email re-sends in the same evening only when things get worse
  (OPS-PLANHOURLY-001), and a crop it has not named yet that night counts as worse. If 0a is applied
  between 14:00 and 17:59 ET on an evening when the frost email has already gone out, the next run
  names "succulents" for the first time that night and sends **one more email**. To avoid it, apply
  outside that window or on a night with no frost email.

## Apply

URLs come from `garden-app/.env.local` by key name, never by pattern and never on a command line.

```bash
# staging — expect UPDATE 0, UPDATE 0, INSERT 0 1: staging cannot carry these prod row ids (they were
# written on prod on 2026-08-23; the staging branch was cut 2026-08-11), so only the stamp lands.
python3 scripts/gate_runner.py --migration migrations/v5-coldshadow-001 --env staging --phase pre
psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -f migrations/v5-coldshadow-001/0a-data.sql
python3 scripts/gate_runner.py --migration migrations/v5-coldshadow-001 --env staging --phase post

# prod — expect UPDATE 1, UPDATE 1, INSERT 0 1. An UPDATE 0 on prod means the wrong host or a changed
# row: stop, and re-run the pre gates.
python3 scripts/gate_runner.py --migration migrations/v5-coldshadow-001 --env prod --phase pre
psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/v5-coldshadow-001/0a-data.sql
python3 scripts/gate_runner.py --migration migrations/v5-coldshadow-001 --env prod --phase post

# both, whole corpus
python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only
python3 scripts/gate_runner.py --all --env staging --phase post --continuous-only
```

On staging, every gate but `pre_not_already_applied` and `post_schema_version_recorded` is `env: prod`
and reports NOT_APPLICABLE. That is by design: each of those gates names a prod id, and on staging 0a
writes only the stamp. Staging's actual contents were not read (this lane was cleared to read prod
only).

## Rollback

```bash
psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/v5-coldshadow-001/0r-rollback.sql
python3 scripts/gate_runner.py --migration migrations/v5-coldshadow-001 --env prod --phase pre
# staging: the same two lines with NEON_STAGING_URL / --env staging (it only removes the stamp there)
```

Rolling back takes the two cards away again and puts the two plants back under "unclassified" in the
email. They are still named there, at the same trip temperatures. The `pre` gates pass again after a
clean rollback, because the rows go back byte-identical. No code needs to be rolled back.

## Verification at authoring (2026-09-18)

**Nothing was applied to staging or prod.** Read-only against prod (gate_runner, owner DSN by key
name): `--validate-only` clean; `--phase pre` PASS 7/7; `--phase post --continuous-only` PASS 1 (the
standing gate, vacuous until the stamp exists) with 5 apply-window receipts skipped. Pushing this
directory therefore cannot red `gate-invariants.yml`. The full `--phase post` on the unapplied prod
fails the 5 receipts, as it should, which shows they do not pass on data that was never written.

Rehearsed on an **ephemeral Neon fork of prod** (branch `rehearse-coldshadow-20260918`, deleted
afterwards, and confirmed gone by re-listing the project's branches). The fork matched prod: 321
plantings, the same profile md5, and `pre` PASS 7/7.

- `0a` printed `UPDATE 1`, `UPDATE 1`, `INSERT 0 1`. Read back in a separate session: both rows have
  14 keys, the new `cold` value, the md5 of the profile minus `cold` equal to the pre-apply md5, and
  `_source` intact. The engine view shows `cadence_scopes {cultivar}`, the cold block present, and
  watering still every 14 days. `post` PASS 6/6. After the apply, `pre` fails the 4 gates that describe
  the unapplied state, as designed.
- Whole corpus `--all --phase post --continuous-only`, before and after the apply: 930 results each
  time (769 PASS, 144 window-only, 13 manual, 4 retired, **0 FAIL, 0 ERROR**), with **zero** status or
  detail changes.
- The real engine (unchanged code) ran over all 209 live plantings, before (prod) and after (the
  fork). Exactly two changed their cold card at any low from 70°F down to 0°F: Graptosedum and
  Pachyphytum. Each gets a `protect` card at 40°F and none at 41°F. In the frost email, 15 → 13
  unclassified, one new "succulents (2)" line, and 142 at risk before and after.
- Re-running `0a` wrote nothing (`UPDATE 0` ×2; row fingerprint identical).
- `0r` printed `UPDATE 1`, `UPDATE 1`, `DELETE 1`. Both rows went back to 13 keys and md5
  `5a9cf94b4257eaed1cbf17042cc9387a`, byte-identical to prod before the apply. `pre` PASS 7/7 again.
  Re-running `0r` wrote nothing. Re-applying after the rollback gave a result identical to the first
  apply.
- Red proofs. Each mutation was committed on the fork, then the rows were restored and `post` 6/6 plus
  the row fingerprint were re-verified. Every post gate went red at least once:

  | mutation | gates that go red |
  |---|---|
  | Graptosedum's `cold` removed | standing, Graptosedum value, single-key, engine view |
  | whole-object replace with the bundled Graptosedum entry (keeps `cold` at 40°F) | single-key |
  | whole-object replace without `cold` | standing, Graptosedum value, single-key, engine view |
  | threshold 32°F | standing, Graptosedum value, engine view |
  | threshold 45°F (more protective) | Graptosedum value, engine view (standing stays green, by design) |
  | hardy clone `{"tender": false, "protect_below_F": 10}` | standing, Graptosedum value, engine view |
  | non-numeric threshold `"forty"` | standing (FAIL, not ERROR), Graptosedum value, engine view |
  | Pachyphytum threshold 39°F | standing, Pachyphytum value, engine view |
  | leaf-scope hardy override on the Graptosedum planting | standing, engine view |
  | stamp deleted | `post_schema_version_recorded` |
  | `0a` with `jsonb_set(..., false)` — prints `UPDATE 1` twice and writes nothing | standing, both values, single-key, engine view |

- `lambda/daily-plan/coldshadow.test.js`: 13 tests. 12 mutations were run against the engine, 0a, 0r,
  gates.yml, the bundled file and frostClass: 0 survived. `lambda/daily-plan` passes as a directory,
  79 files and 1704 tests, under both `TZ=UTC` and `TZ=America/New_York`.

## Not in scope, noticed

- The 17 other live plantings whose bundled tender `cold` is shadowed the same way. They are listed
  in the lane findings, along with the resolver-level option and why it is not a one-line change.
- Love's Fire: no threshold on any surface (see above).
- `lambda/daily-plan/frostband.test.js` (`TENDER_SIX`) and the BUG-COLDCARDDISCARD-001 comment in
  `engine.coldFor` both describe these two plantings as having no threshold on any surface. After this
  apply that is no longer true of prod. The test still passes, because it tests its own fixtures. Both
  were left as they are and reported.
- The card says "tender tropical" for every profile-driven threshold, succulents included. This is
  existing wording and was not changed.
