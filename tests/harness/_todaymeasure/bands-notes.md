# Today-band API payloads — real prod data, 2026-09-08

Produced read-only from live prod Neon via `Projects/Gardening/scripts/psql-ro.sh` (role `garden_ro`,
SELECT-only). No app source touched, no DB write of any kind.

Worktree anchored at `/Users/davenichols/AI/Claude/Projects/garden-app-worktrees/read2-20260908`,
`git rev-parse HEAD` = `78911ebc24f9cafbdfd65711a15b99cbc6d5329b`. All handler line references below
are to that SHA's files. NOT re-anchored to `origin/dev` — no fetch was run, so if `dev` has moved,
these payloads reflect the worktree's handler code, not necessarily current `dev`.

## Row counts (headline)

| file | endpoint | DB rows read | items on the wire |
|---|---|---|---|
| `usesoon.json` | `GET /api/preservation/use-soon` | 4 | **0** |
| `harvestwatch.json` | `GET /api/harvests/watch?limit=200` | 212 | **28** candidates (+0 snoozed) |
| `harvests.json` | `GET /api/harvests?...` | 1301 agg / 275 weight / 30 hero / **0 entries** | 0 entries, 30 crops |
| `sowcandidates.json` | `GET /api/inventory-items/sow-candidates` | 310 | **310** |

## HOUSEHOLD SCOPE IS TWO IDS, NOT ONE — read this before regenerating

Every one of these handlers scopes with `householdScope(userId)` (`lambda/*/household.js:14`), which
returns the **whole** `GARDEN_HOUSEHOLD_IDS` env array when the caller is a member of it. Verified
live on all three prod Lambdas this run:

```
aws lambda get-function-configuration --region us-east-1 --function-name garden-harvests \
  --query 'Environment.Variables.GARDEN_HOUSEHOLD_IDS' --output text
→ harness_user,harness_member_2
```

Same value on `garden-preservation` and `garden-inventory-items`. So every `= ANY(${householdIds})`
below was run as
`ANY(ARRAY['harness_user','harness_member_2'])`,
not as Dave's sub alone. Using only Dave's sub would be a different (and wrong) query.

`ctx.userId` — the single-user axis used by the watch route's dismissal CTEs — is Dave's sub
`harness_user`.

## Wire-shape conventions used when rendering psql output as JSON

The prod path is neon-serverless → `JSON.stringify`. psql's `row_to_json` differs in three places,
so each was normalised to what the driver would have produced:

* `numeric` → the driver returns a **string**; emitted as `col::text`.
  (`preservation_log.quantity_value`, `harvest_log.quantity`, `v_sow_candidates.quantity_on_hand`,
  `sow_depth_in`, `seed_spacing_in`, `row_spacing_in`, `seed_weight_g`.)
* `date` → the driver returns a JS `Date` at local midnight; Lambdas run `TZ=UTC`, so
  `JSON.stringify` yields `YYYY-MM-DDT00:00:00.000Z`. Emitted as
  `to_char(col,'YYYY-MM-DD')||'T00:00:00.000Z'`.
* `timestamptz` → `YYYY-MM-DDTHH:MM:SS.mmmZ` (ms precision — `.268251` in PG becomes `.268`,
  which is what a JS `Date` can hold).

Exception, deliberate: values nested **inside** a Postgres `json_build_object` (the entries query's
`photos` LATERAL) are rendered by Postgres itself on both paths, so those are left byte-identical to
psql output. All live `photos.taken_at` are NULL anyway.

Where a handler's own projector already normalises (`toYmd` in `watch.js:311`, the
`instanceof Date` ternaries in `projectEntry`), string-vs-Date input is provably equivalent and the
string form was used.

---

## 1. `GET /api/preservation/use-soon` → `usesoon.json`

**Envelope:** `{ "items": [ … ] }` — object, not a bare array. `resp(200, { items })`,
`lambda/preservation/index.js:680`. Consumer `src/components/PutUpUseSoonBand.jsx:21`
`normalize = d => Array.isArray(d?.items) ? d.items : []` — matches.

**SQL run** (verbatim from `index.js:653-667`, params substituted):

```sql
SELECT p.*, s.label AS storage_label, s.kind AS storage_kind, ct.display_name AS crop_display_name,
       gn.display_name AS planting_name, gn.sown_at AS planting_sown_at,
       gn.succession_order AS planting_succession_order, cv.display_name AS planting_variety_name
FROM preservation_log p
LEFT JOIN storage_location s ON s.id = p.storage_location_id
LEFT JOIN crop_types ct ON ct.slug = p.crop_type_slug
LEFT JOIN garden_node gn ON gn.id = p.plant_id AND gn.deleted_at IS NULL
LEFT JOIN cultivar cv ON cv.id = gn.cultivar_id AND cv.deleted_at IS NULL
WHERE p.user_id = ANY(ARRAY['harness_user','harness_member_2'])
  AND p.deleted_at IS NULL
  AND p.use_by_target IS NOT NULL
  AND (p.remaining_count IS NULL OR p.remaining_count > 0)
ORDER BY p.use_by_target ASC
```

**Rows: 4.**

**Post-processing reproduced exactly, not approximated.** `classifyUseBy` was **imported and
executed** from the real module (`lambda/preservation/useBy.js` — dependency-free, so it runs under
plain node), with `now` pinned to `2026-09-08T16:00:00.000Z` (= 12:00 EDT on 2026-09-08, so
`etDay(now)` = `2026-09-08`). `projectRow` (`index.js:437-484`) is module-private, so it was
transcribed field-for-field, preserving key order; `use_by_status` keeps its `projectRow` position
because the route's `{...projectRow(r), use_by_status: status}` spread overwrites in place.

**Result: ZERO items — a real finding, not a failure.** All 4 rows classify `ok`:

| id | crop | preserved_at | use_by_target | status |
|---|---|---|---|---|
| 2afee2e3-e6f1-4475-b39f-1dd1eb3a7c1f | squash | 2026-07-20 | 2027-07-20 | ok |
| 64b9cc17-b5a4-4c8d-a0c2-b74d07b8277d | plum | 2026-08-19 | 2027-08-19 | ok |
| b7111a27-d5e5-4947-aba1-a676f054028d | basil | 2026-08-19 | 2027-08-19 | ok |
| d6cb0640-44a1-492c-87d3-4e46ae3733a4 | basil | 2026-08-19 | 2027-08-19 | ok |

Each has a ~1-year span; the `use_soon` threshold is the final 17.5% of it (`USE_SOON_FRACTION`),
i.e. mid-May 2027 at the earliest. Nothing is close.

**Consequence for the harness:** `PutUpUseSoonBand` returns `null` at line 70 (`if (!items ||
items.length === 0) return null`) — the band renders **nothing** on Today today. That is the correct
current-state measurement. To exercise the populated band you need a fixture, not prod data.

Nothing the consumer needs is missing from this payload.

---

## 2. `GET /api/harvests/watch?limit=200` → `harvestwatch.json`

**Envelope:** object with exactly these keys in this order (`watch-route.js:667-691`):
`time_zone`, `et_today`, `season_start`, `model_version`, `nursery_offset`, `limit`,
`total_watching`, `candidates`, `excluded`, `snoozed`. Consumer
`src/components/HarvestWatchBand.jsx:91` `normalize = d => d && Array.isArray(d.candidates) ? d :
{candidates: [], snoozed: []}` — it consumes the **whole body**, so the envelope matters here.

**SQL run:** `queryWatchRows` (`watch-route.js:119-432`) verbatim — the ~310-line CTE chain
(`bounds`, `picks`, `fruit_set`, `fruiting`, `live`, `sibling`, `dismissed`, `last_dismissal`,
`derived`, `nursery`, `fruiting_gap`). Extracted programmatically from the source (not retyped) with
these substitutions:

* `${tz}` → `'America/New_York'`
* `${householdIds}` → the 2-element ARRAY above
* `${userId}` → `'harness_user'`

**Rows: 212.** Every date column in the result is already `to_char`'d by the handler or is a `date`
that `row_to_json` renders `YYYY-MM-DD`; `toYmd` treats both identically to the driver's `Date`.

**Post-processing reproduced exactly.** `buildWatchList`, `toYmd`, `WATCH_MODEL_VERSION` (from
`watch.js`) and `resolveNurseryOffset`, `resolveFruitingInterval`, `parseLimit`,
`resolveDerivedEnabled` (from `watch-route.js`) were **imported and executed** — both modules are
dependency-free. `handleWatchGet`'s body was replayed step for step.

**TWO WRITES WERE DELIBERATELY NOT RUN** (this task is read-only):
`recordWatchImpressions` (`watch-route.js:661`) and `recordWatchExclusions` (line 665). Both are
explicitly non-fatal, run *after* the body is assembled, and contribute **nothing** to the response
body — so their omission cannot change this payload. It does mean no `watch_impression` /
exclusion-census rows were logged for this simulated request, which is the correct outcome for a
read-only reproduction.

**Measured values on the wire:**

* `et_today` = `2026-09-08`, `season_start` = `2025-11-01`, `time_zone` = `America/New_York`
* `nursery_offset` = `{"days":35,"source":"household_median","sample_n":47}`
* fruiting interval = `{"days":19,"source":"household_median","sample_n":55}` (feeds the anchors,
  not itself on the wire)
* `derivedEnabled` resolved **true** (`DERIVED_ANCHOR_ENABLED`)
* `limit` = 200, `total_watching` = **28**, `candidates` = 28 (nothing truncated: 28 < 200)
* `excluded` = `{"already_harvested":100,"no_anchor":11,"not_yet_open":16,"habit_not_watched":57}`
  — 184 excluded + 28 candidates = 212 ✓
* `snoozed` = **[]**

**Why `snoozed` is empty, verified rather than assumed.** Dave has 11 live (`undone_at IS NULL`)
`harvest_watch_dismissal` rows this season. 9 of them attach to plantings in the 212-row live set,
and every one has `suppressed_until` in the past — the latest is `2026-09-04`, before
`et_today` 2026-09-08. So the `dismissed` CTE matches nothing, `dismissed_active` is `false` on all
212 rows, and no row takes the `dismissed` / `basis_unchanged` exclusion branch that feeds `snoozed`.
Empty is correct.

**Something the consumer needs that this payload does NOT contain:** `HarvestWatchBand` lazy-loads
the colour-window dataset via `import('../lib/harvestWindows.js')` (~396KB JSON, deliberately not in
the entry bundle — `scripts/verify-window-chunk.sh` guards this). That is a client-side module, not
API data, but the harness must let the dynamic import resolve or the band renders without windows.

---

## 3. `GET /api/harvests?…` → `harvests.json`

### Literal query string ComposeHarvestBand sends (asked for explicitly)

Built at `src/components/ComposeHarvestBand.jsx:92-99`:

```
/api/harvests?include=entries,aggregates&timeframe=season:2026&created_since=2026-09-07T16%3A00%3A00.000Z
```

Composition: `include=entries,aggregates` is a literal (the comma is **not** percent-encoded — it is
a template literal, not `encodeURIComponent`'d). `timeframe=season:${currentGrowYear(new Date())}`
→ `season:2026` (grow-year = Nov 1–Oct 31; 2026-09-08 falls in the season *ending* Oct 2026 —
`src/lib/growYear.js:16-28`). `created_since=${encodeURIComponent(new Date(Date.now() -
LOG_WINDOW_MS).toISOString())}` where `LOG_WINDOW_MS` = 24h (line 49) — hence the `%3A` on the
colons. The value shown is for a pinned `Date.now()` of **2026-09-08T16:00:00.000Z**; it slides with
the real clock.

### Envelope

`{ "time_zone", "timeframe", "entries", "cursor", "aggregates" }` — object, not a bare array
(`lambda/harvests/index.js:221, 310-312, 360, 525`). `timeframe` is the **parsed** object
`{"kind":"season","year":2026}`, not the raw string. `cursor` is `null` when there is no next page.
`entries`/`aggregates` are each present only because `include` asked for them.

### SQL run

Three statements, all extracted verbatim from `index.js` (entries 227-307, aggregates 317-359,
weights 398-449) plus the conditional hero query (496-518). Substitutions:

| template | value |
|---|---|
| `${HARVEST_TZ}` | `'America/New_York'` |
| `${tf.kind}` | `'season'` |
| `${seasonYear}` | `2026` |
| `${crop}` `${project}` `${plant}` | `NULL` |
| `${createdSince}` | `'2026-09-07T16:00:00.000Z'` |
| `${curDate}` `${curCreated}` `${curId}` | `NULL` |
| `${householdIds}` | the 2-element ARRAY above |
| `${PAGE_LIMIT + 1}` | `51` |
| `${heroPlantIds}` | the 30 ids `computeAggregates` produced |

Row counts: **entries 0**, aggregates **1301**, weights **275** (GROUPING SETS: grand total + per
crop + per variety + per planting), hero **30**.

### Post-processing reproduced exactly

`projectEntry`, `computeAggregates`, `applyWeights`, `applyCropHeroPhotos`, `encodeCursor`,
`parseTimeframe` were **imported and executed** from `lambda/harvests/aggregate.js` (dependency-free
by design). The `hasMore`/slice/cursor logic at `index.js:308-312` was replayed. `aggregate.js:162`
does `Number(r.quantity)`, so the numeric-as-string question cannot affect the aggregates block.

### `entries` IS EMPTY — and this is the load-bearing finding for this endpoint

The most recent harvest/first_harvest event in the household was **created at
`2026-09-07T15:00:03.268Z`** (11:00 ET on 2026-09-07). Measured, not inferred:

```sql
SELECT max(e.created_at) FROM event_log e JOIN plant_projects pj ON pj.id = e.project_id
WHERE e.event_type IN ('harvest','first_harvest') AND e.deleted_at IS NULL
  AND pj.created_by = ANY(ARRAY[…both ids…]);
→ 2026-09-07 15:00:03.268 +00
```

The 24h `created_since` window at the real clock time this ran (psql `now()` =
`2026-09-08 15:49:11 UTC`) starts at `2026-09-07T15:49:11Z` — **49 minutes after** the last logged
event. So zero entries, at the pinned anchor *and* at the true wall clock. The `aggregates` block is
unaffected (it is deliberately not narrowed by `created_since` — `index.js:169-179`) and is fully
populated: 30 crops, 123 first-picks, 13 weekly buckets, season weight
`{grams: 159161.37, measured_grams: 110283.25, estimated_grams: 48878.12, measured: 929,
estimated: 366, unweighed: 6}`, and a `hero_photo_id` resolved for all 30 crops.

### `ComposeHarvestBand` CANNOT RENDER TODAY EVEN WITH ENTRIES — read this before using the payload

Two independent gates, both clock-based:

1. `created_since` (24h) — excludes the 2026-09-07 batch from ~2026-09-08T15:00Z onward.
2. `MAX_BATCH_AGE_MS` = 18h (`ComposeHarvestBand.jsx:45`, enforced at line 286:
   `if (Date.now() - new Date(batch.endedAt).getTime() > MAX_BATCH_AGE_MS) return null`).
   `batch.endedAt` = `2026-09-07T15:00:03.268Z`, so the band returns `null` for any
   `Date.now()` past **2026-09-08T09:00:03Z** (05:00 ET).

So on 2026-09-08 at any realistic hour, `ComposeHarvestBand` renders nothing regardless of payload.
A harness that wants to measure this band must fake the clock to before 2026-09-08T09:00:03Z.

### Supplementary file: `harvests.batchwindow.json` (NOT the current-clock response)

Because an empty `entries` makes the band unmeasurable, one extra file was written — **real prod
rows, no fabrication**, same endpoint, same three queries, only `created_since` moved back to
`2026-09-07T14:00:00.000Z` (i.e. `Date.now()` = 2026-09-08T14:00:00Z). It contains the **20-entry
batch** Dave logged on 2026-09-07: all `event_type: 'harvest'`, all
`created_by: harness_user`, `created_at` spanning
`14:53:51.035Z → 15:00:03.268Z` (6 minutes, one batch under the 90-min gap rule), all with
`photos: []`. `cursor` is `null` (20 < 50). Its `aggregates` block is byte-identical to
`harvests.json`'s. **`harvests.json` remains the honest current-clock response; use the
batchwindow file only with a faked clock, and pair it with gate 2 above.**

### Other things the consumer needs that are not in this payload

* **Viewer identity.** `ComposeHarvestBand.jsx:82,113-116` scopes `detectLastBatch` to
  `useAuthOptional().profile?.id`. If the harness does not stub that to
  `harness_user`, `batch` is `null` and the band renders nothing even with
  entries present.
* **Photo URLs.** `hero_photo_id` (aggregates) and `entries[].photos[].id` are **IDs only** by
  design — the client resolves each against `GET /api/photos/view-url/:id`, a different endpoint not
  captured here. Every entry in the batchwindow file has `photos: []`, so only the crop heroes are
  affected.

---

## 4. `GET /api/inventory-items/sow-candidates` → `sowcandidates.json`

**Envelope:** `{ "items": [ … ] }` — `resp(200, { items: rows })`,
`lambda/inventory-items/index.js:379`. Consumer `src/components/today/CultivationLead.jsx:99`
`Array.isArray(d?.items) ? d.items : []` — matches.

**SQL run** (verbatim, `index.js:375-378` — the handler comment states "Raw `v_sow_candidates` rows
only, all date math happens client-side"):

```sql
SELECT * FROM v_sow_candidates
WHERE created_by = ANY(ARRAY['harness_user','harness_member_2'])
```

**Rows: 310.** No `ORDER BY` in the handler, so row order is whatever Postgres returned — the
captured order is one valid realisation, not a stable contract.

**Post-processing: none.** This route has zero JS post-processing; `SELECT *` goes straight to the
wire. The 40 columns were emitted with the numeric/date normalisation described above
(`quantity_on_hand`, `sow_depth_in`, `seed_spacing_in`, `row_spacing_in`, `seed_weight_g` as
strings; `purchase_date` as `…T00:00:00.000Z`; `sow_archived_at` as a ms-precision UTC instant;
`metadata` as a nested jsonb object).

**Nothing missing** — `CultivationLead` needs only this payload plus `bucketize` from
`src/lib/sowEngine.js`, which is client-side. Note it derives its day from
`todayLocalISO()` (device-local, not ET), so the harness clock decides which windows are "closing".

---

## Reproduction recipe (the scratchpad is not durable)

The generated `.sql` files lived in a session scratchpad and are gone. To regenerate, extract the
tagged-template bodies straight from the handlers rather than retyping them:

```python
src = open('lambda/harvests/index.js').read()
i  = src.index('const rows = await sql`')          # or aggRows / weightRows / heroRows
b1 = src.index('await sql`', i) + len('await sql`')
sql = src[b1:src.index('`;', b1)]
for a, b in SUBSTITUTIONS: sql = sql.replace(a, b)   # table in §3 above
assert '${' not in sql                                # catches a missed param
```

Then `psql-ro.sh -At -f q.sql` wrapping it as
`SELECT COALESCE(json_agg(row_to_json(t)),'[]'::json) FROM ( <sql> ) t;`, and feed the rows to the
real pure modules (`aggregate.js`, `watch.js`, `watch-route.js`, `useBy.js`) under plain node — all
four are dependency-free and importable outside the Lambda runtime.

## Honest limits of this run

* Handler code read from the worktree at `78911ebc…`; **no `git fetch`** was performed, so this is
  not anchored to a verified-current `origin/dev` SHA.
* `projectRow` (preservation) is module-private and was transcribed by hand from
  `index.js:437-484`; every other projector/classifier was executed, not transcribed.
* The two watch-route write calls were skipped (read-only mandate). They do not affect the body.
* `now` was pinned to `2026-09-08T16:00:00.000Z` for `classifyUseBy` and for the `created_since`
  derivation. The real psql clock during the run was `2026-09-08 15:49:11 UTC`; both anchors give
  the same zero-entry / zero-use-soon outcome.
