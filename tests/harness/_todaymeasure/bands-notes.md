# Today-shape fixtures — provenance of the 2026-09-24 prod dump

Produced read-only from live prod Neon by `dump-prod.mjs` (this directory) on 2026-09-24 at ~10:35
America/New_York, then scrubbed by `scripts/layout-gate/todayshape-fixture-scrub.mjs` and cleared by
`scripts/layout-gate/todayshape-fixture-preflight.mjs` (0 findings). Handler code was
read from `origin/dev` = `bcb4d1f4d49bf19e52742802e368f0279041c7c5` (v4.145.0), fetched the same
morning. Supersedes the hand-run 2026-09-08 dump, whose SQL lived in a session scratchpad and is
gone; `dump-prod.mjs` is that recipe made executable.

## Read-only, three ways

1. Every statement runs inside `BEGIN TRANSACTION READ ONLY … ROLLBACK`.
2. The tagged-template `sql` handed to the real handlers refuses anything that is not a
   `SELECT`/`WITH` before it reaches psql. The watch route's two impression writers
   (`recordWatchImpressions`, `recordWatchExclusions`) are non-fatal by design, so they logged a
   warning and the GET body was unaffected — the same outcome the 09-08 run documented by skipping
   them by hand. No `watch_impression` / exclusion rows were written for this simulated request.
3. Nothing in the script opens a write-capable path.

The connection string is selected from `.env.local` by KEY NAME (`NEON_DATABASE_URL`), split into
`PG*` environment variables for psql, and never printed or passed on a command line.

## What each fixture is

| file | endpoint | produced by | on the wire |
|---|---|---|---|
| `dailyplan.dave.json` | `GET /api/daily-plan` | daily-plan-read's plan SELECT, verbatim predicate | 168 water_due / 58 fertilize / 7 pest / 5 cold / 9 dormant / 0 rain_skipped / 9 feed_suppressed / 2 dormancy_suppressed; `generated_at` 2026-09-24T14:00:25.318Z (the 10:00 ET run) |
| `dailyplan.jen.json` | household lens plan | same SELECT for the second household member | 8 water_due |
| `plants.json` | `GET /api/plants` | the list read's own predicates (ownership arms, deleted/archived, archived-container gate), projected to the fields Today reads | 244 plantings, 235 with a featured photo |
| `locations.json` | `GET /api/locations/with-path` | verbatim | 21 |
| `harvestwatch.json` | `GET /api/harvests/watch?limit=200` | the REAL `handleWatchGet`, injected read-only `sql` | 26 candidates, 0 snoozed |
| `sowcandidates.json` | `GET /api/inventory-items/sow-candidates` | `SELECT * FROM v_sow_candidates` for the household (the handler does no post-processing) | 331 |
| `usesoon.json` | `GET /api/preservation/use-soon` | verbatim SQL + the real `classifyUseBy` | 0 (4 stored rows with a use-by target, none in the window) |
| `harvests.json`, `harvests.batchwindow.json` | `GET /api/harvests?…` | **carried unchanged from the 2026-09-08 dump** (see below) | 0 entries / the 20-entry 2026-09-07 batch |
| `busyfull-grafts.json` | — | real payload fragments from other prod days, plus one engine-generated synthetic (below) | 5 keys |

## Household scope

Every handler scopes with `householdScope(userId)`, which returns the whole `GARDEN_HOUSEHOLD_IDS`
array for a member. The dump reads that array off the live `garden-harvests` Lambda configuration
(two ids) and uses it for every `= ANY(...)`, exactly as prod does; the viewer is the first id. The
scrub maps the most frequent sub in the corpus to `harness_user`, the id the harness Clerk stub
serves; in this dump only the viewer's sub occurs (331 times, all in `sowcandidates.json`), so the
mapping is unambiguous. The plan's `coords` (both plans) were replaced with the declared synthetic
site, 4 values.

## Driver fidelity

The Lambdas read through `@neondatabase/serverless`, which hands a handler numeric and int8 columns
as STRINGS (`"2.000"`, not `2`) and date/timestamp columns as `Date` objects (Lambdas run
`TZ=UTC`). `dump-prod.mjs` reads each query's column types with psql's `\gdesc`, selects numeric/int8
columns `::text`, and rebuilds dates and timestamps as `Date`s before any handler code sees a row,
so the real projectors run on driver-shaped input and the JSON written is what `JSON.stringify`
would have put on the wire. The script also forces `TZ=UTC` so a zone-less timestamp parsed on a
New York laptop does not land four hours off.

## The daily plan is the plan as WRITTEN

`annotateDone` (the read Lambda's check-off from today's event log) is deliberately not applied: the
fixture is the list before anything was logged today, and the harness has no event log to check
items off against. A plan read later in the day on the phone is shorter by whatever was logged.

## `/api/plants` — projected, not the wide row

The default list returns ~0.5–1 MB of wide rows with two presigned URLs each. Today reads nine
fields: `id`, `name`, `status`, `location_id`, `container_type`, `featured_photo_id`, the two photo
URLs (CareNeeded's thumbnail) and `variety_ref.crop_type_slug` (StorageDeadlineAlert). The dump
selects exactly those under the list read's predicates and hero-photo joins. Presigned URLs expire
and cannot be replayed, so only their PRESENCE is kept (`presigned-url-elided`); the harness swaps
any non-null URL for a 4x4 PNG, which paints the same 30px box.

## The watch list — the real handler

`handleWatchGet` from `lambda/harvests/watch-route.js` ran end to end (its query, `buildWatchList`,
the nursery and fruiting resolvers) against the injected read-only `sql`. Census printed by the
handler's own heartbeat line: `et_today` 2026-09-24, `total_watching` 26, `snoozed` 0,
`excluded` = already_harvested 104, not_yet_open 9, no_anchor 6, habit_not_watched 57
(202 rows evaluated). `nursery_offset` = 35 days, household median, n = 47.

## `harvests.json` / `harvests.batchwindow.json` — carried from 2026-09-08

Not re-dumped. `ComposeHarvestBand` is the only consumer and it is gated on two clocks — the read
model's 24h `created_since` and its own 18h `MAX_BATCH_AGE_MS` — so at the pinned 10:30 ET the
freshest real batch (2026-09-23 14:14 ET) is already outside the 18h window and the band renders
nothing in `busy` whatever the payload holds. `busyfull` serves `harvests.batchwindow.json` — the
real 20-entry batch Dave logged 2026-09-07 (`created_at` 14:53:51Z → 15:00:03Z, one batch under the
90-minute gap rule) — with every timestamp rebased so the newest sits one hour before the pinned
clock and `created_by` set to the harness viewer. Its `aggregates` block (season chips) is the
09-08 one. Both files were scrubbed in the 09-08 lane (subs → `harness_user`) and pass this preflight.

## `busyfull-grafts.json` — every conditional line at once

Today is an ambient page: most of its lines render on few days, and on 2026-09-24 none of the
weather lines rendered. `busy` is today verbatim. `busyfull` is today PLUS each conditional payload,
taken from the latest real prod plan that carried it (the dump's `lastWith` query), so every region
the gate guards is on screen in one state:

| key | source plan date | renders |
|---|---|---|
| `alerts_sent` | 2026-09-23 | FrostAlertLine: "Frost watch tonight — clear and calm, low 42°F…" (a radiative advisory, `nightOffset` 0). On a tonight-line Today also re-words the cue and the card's night low at the agreed low (V5-FROSTTWOMODELS-001). |
| `weather.callout` | 2026-09-23 | WeatherCueLine: "Cool night (42°F) — protect flowering peppers/tomatoes" (stored as 44°F; re-worded at the agreed low) |
| `leaf_wetness` | 2026-09-12 | LeafWetnessLine: "1 day ahead look like 8+ modelled hours of leaf wetness…" |
| `rain_skipped` | 2026-09-22 | RainNote: "Rain handled watering for 70 plantings…" (only the count is read) |
| `drought` | **none — SYNTHETIC** | DroughtLine + the two-row "Dry — no deep soak" list |

**Drought has never fired on prod**: 0 `daily_plan` rows with a `drought` key and 0
`dormancy_suppressed` items carrying one, all time, checked 2026-09-24. So that graft is synthetic,
but it is not typed by hand: `dump-prod.mjs` feeds `lambda/daily-plan/droughtSignal.js` twenty-one
zero-rain days after one deep-soak day (the smallest run that fires, so the sentence is the
ordinary one rather than the truncated "at least N" form), takes the plan-level payload from
`gardenDrought()` and the per-item shape from engine.js's `dormancy_suppressed` spread, and marks it
`synthetic: true` in the file.

## Privacy sweep (2026-09-24)

Before tracking, the raw dump and every tracked file here were swept for emails, surnames, street
addresses, phone numbers and live identifiers. Findings: no emails, no surnames, no addresses, no
phone numbers. Kept deliberately: plant, cultivar and location names (load-bearing for row geometry,
already throughout the repo's own tests), vendor/extension source URLs in seed notes, the public site
name as a seed source, and two seed-provenance notes that name Jen by first name only. The harness's
member list is first names only. The preflight now also refuses any email-shaped string.

## Honest limits

- `/api/plants` is a projection, not the wide row: a Today consumer that starts reading a new plant
  field will read `undefined` here until the projection adds it.
- `annotateDone` not applied (above).
- The compose-band payloads are the 09-08 ones (above).
- The watch handler's writers were refused, so this dump cannot tell you what the impression log
  would have recorded — only what the GET returned.
