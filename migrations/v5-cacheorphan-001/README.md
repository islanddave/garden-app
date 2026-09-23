# v5-cacheorphan-001 — remove the care-cache rows of 7 deleted plantings

**Status: NOT APPLIED on staging or prod.** Written, gated and rehearsed on an ephemeral fork of prod on 2026-09-21;
this README added 2026-09-23. **Apply 0a only after the fixed `garden-daily-plan` Lambda is live in prod, and only
with Dave's approval: it is a prod write.** Applied earlier, the next rain night writes all 7 rows back under new ids
(the negative control under Verification).

Ledger row: `BUG-CACHEORPHANREGRESS-001`. The 2026-09-21 integrity recon (gardening-docs
`_mainsync5ship3_20260921/recon-integrity-20260921.md` §1.6) recommends this cleanup after the code fix. Dave's
approval of the apply is not recorded yet.

| file | what it does |
|---|---|
| `0a-cleanup.sql` | One transaction. Deletes the 7 plant-keyed `entity_memory` rows listed below, each by its id AND its planting id AND that planting still being soft-deleted. The DELETE's own `RETURNING` fills the BEFORE copy `public.snap_cacheorphan001_entity_memory` in the same statement. All or nothing: 7 on prod, 0 on a branch that never had them, anything else aborts. Stamps `5.0.0-cacheorphan-001`. No DDL on an app table. |
| `0r-rollback.sql` | Puts the 7 rows back from the copy (every column, original ids), all or nothing; refuses if any of them cannot go back; then removes the stamp and the copy. |
| `gates.yml` | 8 `pre` (not applied; copy table absent; a MANUAL deployed-first gate; 5 prod-only: the 7 by id, planting and creation time, every planting still soft-deleted, no listed row on a live planting, the cache rows on soft-deleted plantings are exactly the 7, the 4 baseline project rows present), 1 standing `post` invariant (self-armed, prod-only), 5 apply-window receipts (4 prod-only). |

## Why

The Monday integrity check (`scripts/integrity-weekly-check.sh`, run by `integrity-weekly.yml`) has alerted every week
since 2026-08-31: `entity_memory_orphans` reads 11 against a baseline of 4 (`scripts/integrity-baselines.json`). The
+7 are plant-keyed care-cache rows on soft-deleted plantings.

- `migrations/v4-rainbackfill-001/0c-cachearms.sql` (applied 2026-08-28, commit `3cc0237`) upserted a plant-keyed row
  for every planting with a live watering or rain event and never checked that the planting was live. A soft-deleted
  planting keeps its events (the Deleted-Planting History Rule), so each of the 7 soft-deleted plantings that had ever
  been watered got a row, all in one transaction (2026-08-28T13:17:38.504170Z). Curly Parsley's row had been cleaned
  on 2026-08-14 and came back.
- The nightly rain-night cache upsert in `lambda/daily-plan/handler.js` (`logRainEvents`, from the same commit) had the
  same gap. It rewrote all 7 on every rain night since, and it re-creates any of them that is deleted: that is why 0a
  must wait for the code (next section).
- A soft-deleted planting's cache row is meant to go with the soft-delete: the plants DELETE and the merge remove it in
  the same statement or transaction (BUG-CACHEORPHANLEAK-001). No read path uses these 7 rows: the rollups and the
  by-id read both drop a soft-deleted planting.

### The rows it touches (prod; nothing else is written)

Read on prod on 2026-09-21. Every planting is soft-deleted and none is archived. Re-read 2026-09-23: these 7 are still
the only cache rows on soft-deleted plantings, each last written 2026-09-21 05:00:25Z (the last rain night).

| entity_memory id | planting | plants.id | planting soft-deleted |
|---|---|---|---|
| `45bbd419-d153-4c56-aa94-a16c11f6002b` | Plum | `6e0e8cc0-0282-4fe0-9938-3fe21551bede` | 2026-05-28 |
| `40c4fec4-db50-43ae-bf5f-e0b4fdf5f2d1` | Red Leaf (Regrown) | `53c74573-be0a-432d-8c19-f0f10af525ba` | 2026-06-23 |
| `9d1f2750-1af9-43ba-8143-0c0aeb41a384` | Jalapeño Orange | `da969f5d-e18b-4f4e-b23a-e227269c7c74` | 2026-06-24 |
| `b1ba32dc-3997-4eb7-9a95-616b6f4d9031` | Crown of Thorns | `f7cc1e5c-6a71-4a57-8969-5148da48adb1` | 2026-06-30 |
| `05a13854-80fa-4d71-80c8-df67b568aad7` | Vietnamese Coriander | `6def5dc1-e0df-446c-8cb7-d45f8a14ec53` | 2026-06-30 |
| `ca39cf2a-bd0b-49d0-bfc9-61b40bcf19f1` | Dracaena | `b0a61907-5e6d-4135-ad4a-e204f8c780d1` | 2026-07-09 |
| `0478b377-b3ff-448a-a2d5-b2bf0243a24b` | Curly Parsley | `845b0dcf-e480-4da5-bb13-e0ac7550f029` | 2026-08-07 |

Plus the `schema_version` row `5.0.0-cacheorphan-001` and the BEFORE copy table (the house `snap_` pattern for a cache
repair; 11 `snap_` tables were already on prod on 2026-09-21, none with RLS). No event, planting or photo is touched:
the 56 live events on these 7 plantings stay exactly as they are.

### Why a hard delete is allowed

`entity_memory` is a cache derived from `event_log`, which is the Soft-Delete-Only Rule's derived-data carve-out. The
Deleted-Planting History Rule says the same ("the care cache IS taken by the planting's soft-delete"), and the plants
DELETE already removes the row in the same statement as the soft-delete. The prod write still needs Dave's approval.

### What it leaves alone

The 4 project-keyed rows on containers soft-deleted in May (Chilis, Build Out, Basil, Smoke Child 2) are the alert's
accepted baseline of 4. They are there because the container DELETE (`lambda/projects/index.js`) does not remove a
container's cache row. Cleaning them (baseline 4 → 0) and changing that DELETE are separate decisions for Dave; the
gates pin all 4 as untouched.

## What changes for Dave

- **The orphan count in the Monday integrity email goes back to 4**, its baseline (from 11).
- **The email does not stop.** `s3_not_in_db` reads 7 against a baseline of 6: one photo upload interrupted on
  2026-09-04 left its original in S3 with no row. The Monday alert keeps firing until `OPS-S3UNREGISTEREDUPLOAD-001` is
  decided (keep the photo by registering it through the app, or accept it as abandoned and move that baseline to 7).
- **Nothing in the app changes.** No screen reads these 7 rows, and no event, planting or photo is touched.

**Release note:** none. Nothing anyone sees changes; the Monday integrity email's orphan count returns to its baseline.

## Which build: the fixed daily-plan Lambda must be live first

**Required:** commit `f1633e507517741c8487e8caa6527c09e6acf0fb` ("fix(daily-plan): rain night cache upserts skip
soft-deleted plantings and containers (BUG-CACHEORPHANREGRESS-001)") running on the prod `garden-daily-plan` Lambda.
Both of `logRainEvents`' cache upserts then join their parent and skip a soft-deleted one; archived parents are still
written. It is not in v4.142.0; it reaches prod in a later release, under a new SHA once integrated.

**Why the order matters.** On the fork, after 0a had run, the unfixed plant upsert (as the current Lambda runs it) wrote
279 rows: 272 updates and 7 new rows, one for each of these plantings, under new ids. The orphan count went 4 → 11,
`post_no_cache_row_on_soft_deleted_planting` failed on 7 rows, and 0r refused to restore anything (each planting had a
row again). With the fix, a rain night left all 7 plantings without a row. Rain is logged most weeks (six rain nights
between 08-28 and 09-21), so an early apply undoes itself within days.

**A second writer of the same kind** is in the events edit route: the plant-keyed cache upsert of the `PUT
/api/events/:id` re-anchor block (`lambda/events/index.js`, `if (newPlantId)`) has no liveness check. All 56 live
events on these 7 plantings sit in live containers, so the route reaches every one of them, and an edit that changes
an event's date, type or issue flag writes its planting's row (after the cleanup, re-creates it). It is fixed by
commit `4ed11b798f2c9dffc06af5e4c68c97bb27057280` under the same ledger row: the upsert now reads the planting in the
same statement and selects nothing for a soft-deleted one, and `lambda/events/reanchor-cache-liveness.test.js` guards
the statement the handler sends. If that fix ships after the daily-plan fix, an apply in between can be undone by one
such edit, and the standing gate reports it.

**How to check the MANUAL gate** (`pre_live_parent_cache_upserts_are_deployed`; gate_runner prints it and does not
count it as a pass). Its note says `deploy-lambda.yml` is a separate `push: main` workflow. That has not been true
since OPS-PROMOTERACE-001 (2026-08-14). `promote-gate.yml` now runs `deploy-lambda.yml` itself, as its
`deploy-lambdas` job, before the SPA deploy. It skips that job only when `scripts/check-lambda-current.py` proves every
running function is already current. A release carrying the fix changes `lambda/`, so its promote deploys all 26
functions. The check:

1. The promote-gate run of the release that carries the fix shows `deploy-lambdas` succeeded, not skipped.
2. `LastModified` from the `aws lambda get-function` line under Apply is later than that job. For proof beyond the
   timestamp, the function's `Description` holds the deploy marker the last step of every deploy leg writes
   (`garden-app lambda-deploy v1 src=<commit built> … code=<CodeSha256> …`; `scripts/check-lambda-current.py`
   documents it). Its `src=` must be a commit that contains the fix, and its `code=` must equal the `CodeSha256`.
3. Optional, once a rain night has been logged after that deploy: the database proof under Apply.

## Apply

The apply is a prod write: not part of any ship, and only with Dave's approval. URLs come from `garden-app/.env.local`
by key name, never by pattern, and are never typed on a command line. Run from a garden-app checkout that contains
this directory, one line at a time, reading each result before the next. The blocks carry no comments on purpose:
Dave's interactive zsh does not have `interactivecomments` set, so a pasted `#` line runs as a command, and an
apostrophe in one opens a quote that swallows the lines after it.

**1. Load the two URLs by key name and check both hosts.** Go on only if the two `case` lines print `prod-host-ok` and
`staging-host-ok`.

```zsh
ENVF=/Users/davenichols/AI/Claude/Projects/Gardening/garden-app/.env.local
export NEON_DATABASE_URL="$(/usr/bin/grep -m1 '^NEON_DATABASE_URL=' "$ENVF" | cut -d= -f2-)"
export NEON_STAGING_URL="$(/usr/bin/grep -m1 '^NEON_STAGING_URL=' "$ENVF" | cut -d= -f2-)"
case "$NEON_DATABASE_URL" in *ep-lucky-bird-amju6iqt*) echo prod-host-ok ;; *) echo WRONG-PROD-HOST ;; esac
case "$NEON_STAGING_URL" in *ep-mute-firefly-amq424mj*) echo staging-host-ok ;; *) echo WRONG-STAGING-HOST ;; esac
```

**2. The deployed-first check (the MANUAL gate).** The live Lambda's code must carry the join; read the output as
described under "How to check the MANUAL gate" above.

```zsh
aws lambda get-function --function-name garden-daily-plan --query 'Configuration.[LastModified,CodeSha256]' --output text
```

Optional database proof, read-only (added 2026-09-23 and run on prod then). Before the fix, the second time is within
a second of the first: on 2026-09-23 it read 2026-09-21 05:00:24.976064Z and 05:00:25.202589Z. Once the fix is live and
a rain night has been logged after the deploy, the first moves to that night and the second stays where it was.

```zsh
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'BEGIN' -c 'SET TRANSACTION READ ONLY' -c "SELECT (SELECT max(e.created_at) FROM public.event_log e WHERE e.event_type = 'rain' AND e.deleted_at IS NULL) AS last_rain_row_created_at, (SELECT max(em.updated_at) FROM public.entity_memory em JOIN public.plants p ON p.id = em.plant_id WHERE p.deleted_at IS NOT NULL) AS last_write_to_a_deleted_plantings_row" -c 'COMMIT'
```

**3. An off-database BEFORE copy of the 7 rows**, as on 2026-08-14 (read-only; writes a CSV into gardening-docs'
`project-state/`).

```zsh
psql "$NEON_DATABASE_URL" -X -c "\copy (SELECT * FROM public.entity_memory WHERE id IN ('45bbd419-d153-4c56-aa94-a16c11f6002b','40c4fec4-db50-43ae-bf5f-e0b4fdf5f2d1','9d1f2750-1af9-43ba-8143-0c0aeb41a384','b1ba32dc-3997-4eb7-9a95-616b6f4d9031','05a13854-80fa-4d71-80c8-df67b568aad7','ca39cf2a-bd0b-49d0-bfc9-61b40bcf19f1','0478b377-b3ff-448a-a2d5-b2bf0243a24b')) TO '/Users/davenichols/AI/Claude/Projects/Gardening/project-state/entity-memory-orphan-BEFORE-20260921.csv' CSV HEADER"
```

**4. Staging first.** Expect `pre`: 2 PASS, the MANUAL gate, 5 n/a. Expect 0a to print `INSERT 0 7` (the target
list), `INSERT 0 0` (the copy), `NOTICE ... deleted 0`, `INSERT 0 1` (the stamp) and `COMMIT`. Expect `post`: the
stamp PASS, the rest n/a. This was **not rehearsed on staging** (the lane was cleared to read prod only); see the
staging note below.

```zsh
python3 scripts/gate_runner.py --migration migrations/v5-cacheorphan-001 --env staging --phase pre
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-cacheorphan-001/0a-cleanup.sql
python3 scripts/gate_runner.py --migration migrations/v5-cacheorphan-001 --env staging --phase post
```

**5. Prod.** Expect `pre` PASS 7 plus the MANUAL gate. Expect 0a to print `INSERT 0 7` (the target list), `INSERT 0 7`
(the copy), `NOTICE ... deleted 7`, the 7-row report, `INSERT 0 1` (the stamp) and `COMMIT`. Expect `post` PASS 6/6.
That is exactly what the fork printed. **A 0a ERROR means a guard fired and nothing was deleted:** re-run `pre` and
read the message.

```zsh
python3 scripts/gate_runner.py --migration migrations/v5-cacheorphan-001 --env prod --phase pre
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-cacheorphan-001/0a-cleanup.sql
python3 scripts/gate_runner.py --migration migrations/v5-cacheorphan-001 --env prod --phase post
```

**6. The whole corpus, both environments.** Expect 0 FAIL and 0 ERROR.

```zsh
python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only
python3 scripts/gate_runner.py --all --env staging --phase post --continuous-only
```

**Staging is designed blind.** The 7 ids were created on prod after the staging branch was cut (2026-08-11), so 0a
there should delete nothing and land only the stamp. If staging does hold them with soft-deleted plantings it deletes
all 7; any other mix aborts with nothing changed. Apart from `pre_not_already_applied`,
`pre_before_copy_table_absent`, `post_schema_version_recorded` and the MANUAL gate, every gate is `env: prod`, the
standing invariant included, and reports n/a there. Staging probably carries its own copies of this leak under other ids: `3cc0237` says 0c was applied
to staging too. Nothing here reads or removes them.

**If a `pre` gate fails on prod, do not apply.** The identity gate means one of the 7 rows is no longer the row that
was read (gone, re-keyed or re-created). The "still soft-deleted" and "no listed row on a live planting" gates mean a planting was restored:
it owns its row again. The "exactly the seven" gate means an eighth row has appeared (a planting deleted with watering
history, then a rain night under the old code, or an edit through the events route); the standing gate would fail
right after the apply. The baseline gate means one of the 4 project rows changed. Each needs a fresh read, not a
retry.

**Push and apply order.** Pushing this directory before the apply is safe. The one continuous `post` gate arms itself
on this migration's stamp, and every other `post` gate is window-only, so the nightly continuous corpus is unchanged
(measured on the fork: 959 results, no change). The apply itself must come after the code, as above.

## Rollback

```zsh
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-cacheorphan-001/0r-rollback.sql
python3 scripts/gate_runner.py --migration migrations/v5-cacheorphan-001 --env prod --phase pre
```

Expect "restored 7", then `pre` PASS 7 plus the MANUAL gate. Rolling back brings the 7 orphans back, and the Monday
count reads 11 again: this exists to unwind a bad apply, not for tidiness. The code fix does not need rolling back with
it; with the fix live, the restored rows are simply never written again. 0r restores all or nothing: if any row's id is
in use, its planting has a cache row again, or the planting row is gone, it lists them, restores nothing and keeps the
copy and the stamp.

## Verification at authoring (2026-09-21)

**At authoring, nothing had been applied to staging or prod.** Every prod read was read-only (owner URL by key name,
host checked).

- **The premise, on prod.** The integrity script's own predicate returned 11 rows: the 4 project-keyed baseline rows
  and these 7 plant-keyed ones, each created 2026-08-28T13:17:38.504170Z and last written 2026-09-21 05:00:25Z. Exactly
  7 soft-deleted plantings carry live watering or rain events, and they are these 7.
- **The code half, on the SQL the handlers actually send.** Each version of the handler was driven through one rain
  night with a recording database stub, and the two cache upserts it emitted were wrapped as read-only SELECTs on prod.
  Plant arm: old 279 rows, new 272. The 7 dropped are exactly these plantings; nothing new, no value differs, and no
  live or archived planting with watering history is missing (new = 244 live + 28 archived). Container arm: 74 = 74,
  identical.
- **Gates on unapplied prod.** `--validate-only` clean (14 gates). `--phase pre` PASS 7 plus the MANUAL gate. `--phase
  post --continuous-only` PASS 1 (the standing gate, vacuous until the stamp) with 5 window-only receipts skipped. The
  full `--phase post` fails the stamp, "seven gone" (7) and "orphans left" (7) receipts, ERRORs on the copy receipt
  (42P01: the copy table does not exist yet, by design), and passes "four untouched" and the standing gate. The standing
  gate with its arming clause removed returns exactly the 7 rows, so it detects the defect.
- **Rehearsed on an ephemeral Neon fork of prod** (branch `br-billowing-violet-am0k8fbx`, parent production, deleted
  afterwards: `DELETE` 200, then `GET` 404, and the project's branch list back to the same 8). The fork matched prod
  (identical fingerprints of `entity_memory`, 363 rows, plus plants, containers, event_log and schema_version). Steps,
  each through the commands above:
  - The fixed rain-night upserts, before any cleanup: 272 plant and 74 container rows written, no row created, the 7
    untouched. The fix stops the rewriting and deletes nothing.
  - `0a`: `INSERT 0 7` into the copy, "deleted 7", the report, the stamp, `COMMIT`. Read back in a new session: 363 →
    356 rows, exactly these 7 gone, every other row byte-identical, the orphan count 11 → 4, and each copied row's md5
    equal to its pre-apply md5. `post` PASS 6/6. A second `0a` was refused ("already applied") and changed nothing.
  - The whole gate corpus after the apply: the continuous form (what CI runs) had 959 results and zero changes. In the
    full form, this migration's own 4 FAIL/ERROR turned PASS. Three `continuous: false` receipts elsewhere changed
    detail only (FAIL stayed FAIL), each count down by exactly 7: `v4-cachefwdgap-001` and `v4-carecacheundo-001`
    `post_every_repaired_row_is_snapshotted` (339 → 332, 352 → 345) and `v4-cachemissingrow-001`
    `post_no_preexisting_cache_row_was_touched` (271 → 264).
  - The fixed rain night again, after the cleanup: no row created, orphans stayed 4, `post` 6/6.
  - **The negative control:** the unfixed plant upsert after the cleanup re-created all 7 (above), and 0r then refused
    all 7 as "planting has a row again". The re-created rows were removed on the fork only.
  - `0r`: "restored 7". Each row's md5 (all columns, `created_at` and `updated_at` included) matched its pre-apply self,
    and `pre` passed again. `0a` was then re-applied cleanly.
  - Red proofs, each restored afterwards; every executable gate failed at least once. A copy row removed failed the
    copy receipt. A baseline project row touched failed "four untouched" and "four present". The Plum planting restored
    failed three pre gates, and 0a then aborted ("1 listed row(s) survived") with nothing deleted. An eighth cache row
    on a soft-deleted planting failed "exactly the seven". A listed row re-keyed failed the identity gate, and 0a
    aborted. `0r` with nothing applied refused.
- **Tests.** For `f1633e5`: `lambda/daily-plan/weatherdaily.test.js` 52/52; `lambda/daily-plan` 92 files / 2170 tests
  green under `TZ=UTC` and `TZ=America/New_York`; 25 mutations of the fix and of the test's model, 22 red as intended
  and 3 correct-spelling controls green. For this directory: `gate_runner --all --validate-only` 121 files / 1514
  gates OK; `pytest scripts/test_gate_runner.py` 52 passed. The unit tests stub the database: they prove the statements' shape,
  and the fork proves what they match.

## Not in scope, noticed

- **The note on `pre_live_parent_cache_upserts_are_deployed` in `gates.yml` is out of date** (see Which build). The
  check it points to is the one in this README.
- The container DELETE leaves the container's cache row, which is how the 4 baseline rows arose. Mirroring the plants
  DELETE there needs a decision on restore (`post_every_non_deleted_project_with_events_has_a_cache_row` in
  `v4-cachemissingrow-001` would stay red after a restore until the next write).
- `migrations/v4-rainbackfill-001/0c-cachearms.sql` is applied and is not edited; its plant arm has no liveness filter
  and must not be copied or re-run (a note in that directory's README says so).
- Two container-keyed upserts in `lambda/events/index.js` (the single-event POST and the edit's new-container arm) take
  the container from the planting and never check that it is live. A live planting in a soft-deleted container would
  get its container a cache row there; on prod on 2026-09-23 there were none, so nothing reaches them today. The
  standing gate here is plant-keyed and would not see it; the weekly integrity check would.
- `lambda/daily-plan/rain-live-filter.test.js` asks that a third user of its SQL parser hoist it into a shared module;
  the fix's test wrote a narrower model instead. Hoisting the two existing copies is a separate refactor.
- `s3_not_in_db` (`OPS-S3UNREGISTEREDUPLOAD-001`) keeps the Monday alert firing after this apply.
