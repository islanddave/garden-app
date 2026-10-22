# v5-tenancystamp-001: weight voids and re-filed samples take their parent's Space

V5-SPACETENANCYKEY-001, multi-space Phase 2 step 2.2 ("parent-derived stamps only", R1). Plan of record:
`project-state/_multispace-20261015/multispace-prep-plan-V204-20261019.0900.md` §2.1 "DB functions that stamp the
key", §2.4 "Writers", §3.0 and §3 row 2.2.

2.1 gave 22 tables a `workspace_id` whose DEFAULT is the original Space. A writer that does not name the column files
its row there whoever owns the parent. Step 2.2 makes every writer that already reads the parent row copy the
parent's `workspace_id` instead. This directory is the database half: two function bodies. The Lambda half (four copy
writers) and the two tests that hold every writer to the rule are in the same push:

* `lambda/tenancy-insert.static.test.js` (writer test) over the 2.0a SQL census, allowlist
  `tests/tenancy-insert-allowlist.json` (29 scope-derived INSERTs, each with the 4.3 lane that clears it);
* `lambda/tenancy-prosrc.static.test.js` over the prosrc census `tests/tenancy-prosrc.prod.json`
  (`scripts/tenancy-prosrc-census.py`, read-only) and its decisions `tests/tenancy-prosrc-decisions.json`.

## Files and stamps

| File | Stamp | Function | Body md5 before → after |
|---|---|---|---|
| `01-void-event-weight-samples.sql` | `5.3.14-tenancystamp-001-void-event-weight-samples` | `public.void_event_weight_samples(uuid, text, text)` | `cc33df74a8d622bebe772002210f836e` → `886bb851e921341bc2d3af0f89f9c718` |
| `02-reattribute-plant-weight-samples.sql` | `5.3.14-tenancystamp-001-reattribute-plant-weight-samples` | `public.reattribute_plant_weight_samples(uuid, text)` | `d9bd4ee654ae3d2f8f9e3cae0b495640` → `2b881bb13ecf5e9f0b6d0701f3f850e1` |
| `0r-rollback.sql` | deletes both | both, back to the originals byte for byte | after → before |

Stamps are named for release 5.3.14; if the release number differs, rename them in the two files, `0r-rollback.sql`,
`gates.yml`, `tests/tenancy-prosrc-decisions.json` and `scripts/phase7-gate.json` (G1 "2.2").

Each file is one transaction: step 0 (2.1's column present on both weight tables; the definition pre-gate on today's
md5, or this file's own on a re-apply), `CREATE OR REPLACE FUNCTION` (same signature, language, volatility; owner,
grants and comment kept), a post-check that the body written hashes to the md5 `gates.yml` pins, the stamp. No Space
literal and no `sentinel_workspace()` call in either body (N12).

## What changes, in plain words

* **01** `void_event_weight_samples`: each void row takes the `workspace_id` of the sample it voids (`s.workspace_id`).
* **02** `reattribute_plant_weight_samples`: the void of a misattributed sample takes that sample's (`m.workspace_id`);
  the re-filed sample takes its planting's (`v_workspace`, read by the SELECT that already reads the planting for its
  cultivar: same join, same predicate, so this function and `record_harvest_weight_sample` still agree on a
  planting's cultivar).

## What is not here, and why

The census (`tests/tenancy-prosrc.prod.json`, read 2026-10-22, prod and staging identical: 55 functions, 19 with an
INSERT) lists six function writers of an S table or of `entity`:

| Function | Target | Today | Decision |
|---|---|---|---|
| `void_event_weight_samples` | `cultivar_weight_void` | DEFAULT | rewritten here (01) |
| `reattribute_plant_weight_samples` | `cultivar_weight_void`, `cultivar_weight_sample` | DEFAULT | rewritten here (02) |
| `record_harvest_weight_sample` | `cultivar_weight_sample` | DEFAULT | **2.6** (the autocapture INSERT, `v4-cal1-slicec-001/0f-autocapture.sql:94-98`; row 2.6 stamps it from the planting with the per-Space weight views) |
| `gv.entity_cultivar_ins` | `entity` | `gv.sentinel_workspace()` | **2.4a** (MF1: copies `NEW.workspace_id` / `NEW.is_base` from the variety, in the file of entity's CHECK) |
| `gv.entity_planting_ins` | `entity` | `NEW.workspace_id` | already parent-derived (§2.1); 2.4a adds `is_base = false` (F2) |

Every other function INSERT targets a D or P table (`container_closure`, the three archives, `audit_events`,
`event_log`/`harvest_log` in `unarchive_events_apply`). No crop or critter entity writer exists in `pg_proc` (MF1,
DSA-21). The DEFAULT-reliant count (5.7's G2 precondition) is 4 today, 1 after this sitting (2.6's), 0 after 2.6.

## Why the deployed code is unaffected (the arming test, V204 §3.0, DSA-25)

Read-only on 2026-10-22 (`BEGIN TRANSACTION READ ONLY … ROLLBACK`), children against their parents:

| Child vs parent | prod rows / differing | staging rows / differing |
|---|---|---|
| `cultivar_weight_void` vs its sample | 66 / 0 | 0 / 0 |
| `cultivar_weight_sample` vs its planting (source event) | 1686 / 0 | 2 / 0 |
| `seen_event` vs planting (Lambda half) | 0 / 0 | 2 / 0 |
| `proj_rescope_events` vs project (Lambda half) | 27 / 0 | 0 / 0 |
| `recipe` vs its linked batch (Lambda half) | 7 / 0 | 0 / 0 |
| `preservation_log` vs its batch (Lambda half) | 8 / 0 | 0 / 0 |
| `merge_event` vs winner planting (already stamped) | 14 / 0 | 0 / 0 |
| `entity` (planting) vs planting | 327 / 0 | 12 / 0 |

Every child value is `00000000-…-0001` and each env has one Space. So each rewritten writer writes the value the
DEFAULT wrote; the callers (`record_harvest_weight_sample`, the events and plants Lambdas) pass the same arguments and
read the same integer. `gates.yml` `pre_child_rows_already_carry_their_parents_space` re-reads it at the sitting.

## C-CONV pre-scan (V204 §2.8, widened)

Every gate that reads `pg_proc`/`prosrc`/`pg_get_functiondef` was read for a filter that matches either function, a
body pattern either body changes, or a scan over all functions (`rg -l "pg_proc|prosrc|functiondef"
migrations/*/gates.yml`: 38 files). No existing gate pins either body. Expected values, before = after:

* `v4-cal1-slicec-001` `post_autocapture_functions_present` (both names present) = 2 / 2.
* `v4-harvweightest-001` `mid_reattribute_function_present_with_the_expected_signature` (sweep phase; signature and
  result type) = 1 / 1. `pre_reattribute_function_absent` is a pre-phase receipt of that migration, already red since
  it applied; not run in post, unchanged.
* `v5-tenantgates-001` `post_sentinel_callers` (bodies holding the original Space literal or calling
  `sentinel_workspace(`): neither new body does; unchanged.
* `v4-archrestore-001` `post_all_preexisting_guards_survive`, `v4-plantmerge-001` `post_routine_guards_present`
  (name `cultivar_weight_sample` in other functions' bodies), `v4-parentprojfk-001`
  `post_no_indb_routine_hard_deletes_containers`, `v4-plantrehomefk-001`
  `post_no_indb_routine_hard_deletes_plantings_or_containers`, `v4-archpreservguard-001` (pre): neither body deletes
  or archives anything; unchanged.
* Gates over the two weight tables' columns and rows (`v4-cal1-*`, `v4-harvweightest-001`, `v5-tenancykey-001`,
  `v5-tenancyclasses-001`, `v5-tenancykeys-001`): no column added or dropped, no row moved; unchanged.

So no existing gate file is edited (nothing to ship tolerant first), and the rehearsal's newly-red set is `{}`.
None of the files touched here is in the gardening-deploy.md (c) list.

## Sitting

Dave's first-hand OK names this directory and both envs. Staging, then prod, the same day. No ordering constraint
with a code deploy: the Lambda half of the push names `workspace_id` on tables that already have it (2.1, both envs),
and these bodies change no value while there is one Space.

0. main carries this directory (`migrations/**`, so gate-invariants reads its gates) and the latest gate-invariants
   run is green.

```bash
# --- staging ------------------------------------------------------------------------------------------------
python3 scripts/gate_runner.py --all --env staging --phase post --continuous-only --json > before-staging.json
python3 scripts/gate_runner.py --migration migrations/v5-tenancystamp-001 --env staging --phase pre
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-tenancystamp-001/01-void-event-weight-samples.sql
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-tenancystamp-001/02-reattribute-plant-weight-samples.sql
python3 scripts/gate_runner.py --migration migrations/v5-tenancystamp-001 --env staging --phase post
python3 scripts/gate_runner.py --all --env staging --phase post --continuous-only --json > after-staging.json
# newly red (red in after, not in before) must be the empty set

# --- prod (Dave's first-hand OK; after the safety copy) -------------------------------------------------------
python3 scripts/neon_safety_branch.py --env-file .env.local create --slug ms2
python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only --json > before-prod.json
python3 scripts/gate_runner.py --migration migrations/v5-tenancystamp-001 --env prod --phase pre
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-tenancystamp-001/01-void-event-weight-samples.sql
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-tenancystamp-001/02-reattribute-plant-weight-samples.sql
python3 scripts/gate_runner.py --migration migrations/v5-tenancystamp-001 --env prod --phase post
python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only --json > after-prod.json

# --- after prod: the prosrc census re-run, read-only (URL by key name from .env.local, never printed) ---------
NEON_DATABASE_URL="$(grep -m1 '^NEON_DATABASE_URL=' .env.local | cut -d= -f2-)" python3 scripts/tenancy-prosrc-census.py
NEON_STAGING_URL="$(grep -m1 '^NEON_STAGING_URL=' .env.local | cut -d= -f2-)" python3 scripts/tenancy-prosrc-census.py --env staging --check
npx vitest run lambda/tenancy-prosrc.static.test.js     # the two rewritten writers now read md5 to_md5, stamped
```

Commit the re-run census (its two bodies move to `886bb851…` and `2b881bb1…`; the DEFAULT-reliant count drops to 1).
The decisions file needs no edit: a `rewritten` decision accepts either md5 and checks the stamped one.

## Rollback

`0r-rollback.sql`: both bodies back to the originals byte for byte (its post-check reads the md5s), both stamps
deleted (the post gates disarm). Refuses, changing nothing, over a body that is neither the original nor this
directory's. Rows the stamped bodies wrote keep their parent's Space, which the DEFAULT would also have given while
there is one Space. A second run is a no-op. Re-run the prosrc census after it.

## Gates

* pre (receipts, `continuous: false`): 2.1's columns present; each body is the one its file was written from (or its
  own); the arming check.
* post (self-armed on each file's stamp): each body pinned by md5; `post_tenancystamp_bodies_have_their_stamps`
  (armed on the bodies: a stamped body without its stamp); `post_every_weight_void_carries_its_samples_space`
  (continuous data invariant, both envs).

## For the steps after this one

* **2.6** shares this surface (V204 §3.0): it rewrites `record_harvest_weight_sample` (not these two) and rebases on
  these bodies if it touches them; a rewrite of either edits its pin here, tolerant first, and its decision.
* **2.4a** rewrites `gv.entity_cultivar_ins` and may rewrite `gv.entity_planting_ins`: re-run the census after its
  sitting; both entity decisions move.
* **4.3** lanes clear `tests/tenancy-insert-allowlist.json` one Lambda at a time; G5 needs it empty.
* **5.7** (G2): the prosrc census shows no DEFAULT-reliant function writer.

## Rehearsal (local PostgreSQL 17 only)

Throwaway cluster in a scratch directory (`initdb -U postgres -A trust --no-locale -E UTF8`, port 54422, listening on
127.0.0.1 only). Every Neon read read-only (`PGOPTIONS=-c default_transaction_read_only=on`, URL by key name, into
libpq variables, never on a command line):

* `base_prod`: `CREATE SCHEMA extensions; CREATE EXTENSION "uuid-ossp" SCHEMA public; CREATE EXTENSION pgcrypto SCHEMA
  public;` (prod keeps both in public, with SQL wrappers in extensions), then prod's `pg_dump --schema-only --no-owner
  --no-privileges -n public -n gv -n extensions` (its `CREATE SCHEMA extensions/public` lines removed; it carries
  2.1's 25 keys), then prod's `spaces`, `schema_version`, `spacetheme` and `plots` rows (`--data-only`, loaded with
  `session_replication_role=replica`).
* `base_staging`: the extensions as above, then a full `pg_dump --no-owner --no-privileges -n public -n gv -n
  extensions` of staging (replica role).

`python3 migrations/v5-tenancystamp-001/rehearse_local.py --port 54422 --base-prod base_prod --base-staging
base_staging` runs sections A-G on clones (its docstring) and prints PASS/FAIL per check; the lane log has the run.
