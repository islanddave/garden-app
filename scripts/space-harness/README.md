# C-HARNESS — `scripts/space-harness/`

Build sheet step 1.12 (V5-SPACEISOLATION-001). The harness measures one change on two throwaway copies of
prod forked at the same point, and gives one of three verdicts:

| Verdict | Exit | Meaning |
|---|---|---|
| PASS | 0 | A and B matched before the change, the instrument saw a stray write, the named positive control was seen where it should be (and not where it should not), and every difference is one the use allows. |
| DIFF | 1 | The change did something the use does not allow: a business row, an alert or an outbound call differs. Do not apply. |
| FAULT | 3 | The instrument cannot vouch for itself: A ≠ B before the change, the stray write was invisible, the positive control is missing (or the use names none), the sentinel could not be read, or anything crashed. **Never a pass.** Record it and make a new pair. |
| (usage) | 2 | Bad arguments. |
| REFUSED | 4 | A precondition said do not start: the fleet is full, the minute is too close to :00, a pair name is taken, or an offline URL is not loopback. |

## Files

| File | What it does |
|---|---|
| `harness.py` | The CLI: `fleet`, `pair`, `selftest0`, `stray`, `run`. |
| `neon_pair.py` | Fleet check through `neon_safety_branch.py list`; A through `neon_safety_branch.py create`; B through the Neon API at A's fork point; one endpoint per branch; each branch's URL. |
| `checksum.py` | Business-column checksums, the row-level diff, the stray-write self-test, the sentinel read. |
| `arm.mjs`, `arm-lib.mjs` | One arm: a non-dry daily-plan `run()` from one tree's own `lambda/daily-plan/handler.js`, against one branch, with recording stubs. |
| `fixtures/fetchers.default.json` | The default weather fixture both arms read (2-decimal coordinates at most, no station id). |
| `fixtures/use.example-d1.json` | A use in the V102 Step 11 (D1) shape. |
| `test_space_harness.py`, `arm.test.mjs` | Unit tests: no network, no database. |
| `test_space_harness_pg.py` | The self-tests on two real local Postgres clusters (skipped unless given). |

## What is compared

- **Tables.** Every base table in `public` (a use can add schemas), except the volatile tables `app_events`,
  `ux_events` and `rate_limit_buckets`.
- **Columns.** Business columns only. A column is left out when it is named `created_at`, `updated_at` or
  `generated_at`, when its DEFAULT draws a fresh value (`gen_random_uuid()`, `uuid_generate_v4()`, `now()`,
  `nextval()`, ...), or when the use names it in `volatile_columns`. jsonb keys named in `jsonb_volatile_keys`
  are stripped (`daily_plan.plan → prior_runs` by default). Every exclusion is written to the verdict file.
- **Order.** Each row's business columns form one text value; a table's checksum is the md5 of its row md5s
  ordered by that value (`COLLATE "C"`). The business key is the whole business row, so two tables match only
  when they hold the same multiset of business rows, whatever their uuids and timestamps.
- **Calls.** Each arm records every outbound effect by destination: `publishAlert` (`sns:<topic>`), AWN
  (`fetchStation` and any fetch to `api.ambientweather.net`, recorded as `awn:<sha256 tag>`, never the device
  id), Graph (any fetch to `graph.facebook.com`, `graph:<node>/<edge>`, never the token), the weather fetchers
  (`grid:<lat>,<lng>` at 1 decimal) and any other host (`fetch:<host>`). Global `fetch` is replaced for the
  run: nothing reaches the network. Alert lists and call lists are compared as multisets.

## The use file

```json
{
 "name": "what this run proves",
 "binds": { "indoor": "SELECT id::text FROM public.spaces WHERE ..." },
 "positive_control": { "name": "...", "kind": "log | row | destination", "...": "..." },
 "allowed_diffs": [ { "table": "public.spaces", "where": "id = %(indoor)s::uuid", "side": "b" } ],
 "allowed_call_diffs": [ { "stub": "publishAlert", "destination": "sns:ops" } ],
 "volatile_columns": { "public.t": ["seen_at"] },
 "jsonb_volatile_keys": { "public.t.col": ["key"] },
 "stray_target": "public.plants.name"
}
```

- `positive_control` is **required and named**. Kinds:
  - `log`: a console JSON line whose keys include `match` (e.g. `{"msg": "space-wx", "space": "$indoor"}`);
  - `destination`: a recorded call of `stub` whose fields include `match` (e.g. `{"destination": "sns:ops"}`);
  - `row`: `SELECT count(*) FROM <table> WHERE <where>` on each branch.
  It must be seen on `present_on` (default `b`) and not on `absent_on` (default `a`; `null` = no check).
- `binds` are read on B after the change, each one value. `sentinel` is always bound, from
  `gv.sentinel_workspace()` on both branches (they must agree). No Space id is ever written in this
  directory: refer to `$sentinel` / `$name` in `match`, and `%(name)s` in SQL (`%%` for a literal `%`).
- `allowed_diffs` rows (matched on the named side) do not count as differences. Allowed is not required:
  the positive control is what must be seen.

## Offline self-test (how this was built and proved)

No Neon branch or endpoint is created and no Neon write is called offline. Two local PG17 clusters stand in
for A and B:

```sh
BIN=/opt/homebrew/opt/postgresql@17/bin; S=<scratch dir>
for p in a b; do $BIN/initdb -D $S/$p -U postgres -A trust --no-locale -E UTF8; done
LC_ALL=C $BIN/pg_ctl -D $S/a -o "-p 55445 -c unix_socket_directories= -c listen_addresses=127.0.0.1" -w start
LC_ALL=C $BIN/pg_ctl -D $S/b -o "-p 55455 -c unix_socket_directories= -c listen_addresses=127.0.0.1" -w start
SPACE_HARNESS_PG_A=postgresql://postgres@127.0.0.1:55445/postgres \
SPACE_HARNESS_PG_B=postgresql://postgres@127.0.0.1:55455/postgres \
SPACE_HARNESS_DRIVER=<an installed @neondatabase/serverless dir> SPACE_HARNESS_WS=<repo>/node_modules/ws \
  python3 -m pytest -q scripts/space-harness/
```

For a run of the real `handler.js`, load prod's schema read-only (`pg_dump "$GARDEN_RO_DATABASE_URL"
--schema-only --no-owner --no-privileges -n public -n gv`, after `CREATE SCHEMA extensions` with `uuid-ossp`
and `pgcrypto` in it), seed one Space with `id = gv.sentinel_workspace()` and a few plantings on A, restore A's
dump into B (a fork), then:

```sh
export HA=postgresql://postgres@127.0.0.1:55445/harness HB=postgresql://postgres@127.0.0.1:55455/harness
python3 scripts/space-harness/harness.py run --a-dsn-env HA --b-dsn-env HB --local-pg \
  --use <use.json> --b-sql <change.sql> --today 2026-10-16 --driver <driver dir> --ws node_modules/ws
```

Offline, `--local-pg` accepts loopback URLs only, and the arm reaches local Postgres with the Lambda's own
driver through an in-process WebSocket proxy that forwards to that one address.

## The live pair (the session, later)

The live pair creates two Neon branches and two endpoints. It is a session step, not a lane step, and it
runs only when the fleet allows (build sheet P20: `list` shows 6 or fewer temporary branches). The pair
counts against the same budget as the day's `--slug ms1` safety copy. Neither branch is ever deleted by the
harness; both expire one day after creation.

1. **Fleet.** `python3 scripts/neon_safety_branch.py --env-file ../garden-app/.env.local list`. Six or
   fewer temporary branches, or wait. (`harness.py fleet` refuses at 9.)
2. **Minute.** Between :10 and :50 UTC (the hourly writers run at :00). `pair` refuses outside it.
3. **Pair.**
   `python3 scripts/space-harness/harness.py pair --step 1.12 --env-file ../garden-app/.env.local --out $S/pair.json`
   A = `sitting-harness-1-12-<HHMM>-a-prod-preapply-<date>` (made by `neon_safety_branch.py create --days 1`);
   B = `sitting-harness-1-12-<HHMM>-b-prod-preapply-<date>`, from prod at A's `parent_lsn` (or
   `parent_timestamp` when A reports no LSN). `pair.json` holds ids and hosts, no password.
4. **Driver.** Each arm loads `@neondatabase/serverless` and `ws` from its tree's `lambda/daily-plan/node_modules`:
   `npm install --prefix <tree>/lambda/daily-plan --no-save --legacy-peer-deps`, or pass `--driver` and `--ws`.
5. **Environment.** Both arms inherit one environment. Export the prod engine flags and
   `GARDEN_HOUSEHOLD_IDS`/`SYSTEM_CLERK_SUB` exactly as the live Lambda has them (the `f2-raindepth-soak.mjs`
   note applies: without the flags the arms are not the shipped behaviour). Pass a recorded fetcher fixture
   with `--fixture` if the default dry day is not the point.
6. **Run.** Data change:
   `harness.py run --pair $S/pair.json --env-file ../garden-app/.env.local --use <use.json> --b-sql <change.sql> --today <YYYY-MM-DD> --out $S/verdict.json`.
   Code change: replace `--b-sql` with `--base-sha <base> --candidate-sha <candidate>` (two clean detached
   worktrees are added under `--trees-dir` and removed afterwards unless `--keep-trees`).
   Each URL is asked of the Neon API for the pair's own endpoint (`branch_id`, `endpoint_id`, `neondb`,
   `neondb_owner`, `pooled=false`) and refused unless its host is that endpoint and not one of
   `PROTECTED_ENDPOINTS` in `tests/integration/_cleanup.js`.
7. **Read the verdict.** `run` does, in order: self-test 0 (A = B), the stray-write self-test (one UPDATE on
   B inside a transaction, read, rolled back, then B = A again), the sentinel read, the change on B, arm A,
   arm B, the binds, checksums, call lists, the positive control. PASS / DIFF / FAULT as above.
8. **One pair, one run.** The arms are non-dry, so after a run both branches carry their writes and the
   next run's self-test 0 would fault. A FAULT or a second measurement needs a new pair (a new minute).

## Neon API fields relied on

From Neon's public v2 OpenAPI spec (`https://neon.com/api_spec/release/v2.json`, read 2026-10-16):
`POST /projects/{project_id}/branches` takes `branch.parent_id`, `branch.name`, `branch.expires_at`,
`branch.parent_lsn` ("A Log Sequence Number (LSN) on the parent branch. The branch will be created with data
from this LSN.") and `branch.parent_timestamp` (RFC 3339); the Branch object reports `parent_lsn` and
`parent_timestamp`. `POST /projects/{project_id}/endpoints` takes `endpoint.branch_id` and `endpoint.type`
(both required). `GET /projects/{project_id}/operations/{operation_id}` reports `operation.status`
(`finished` is done). `GET /projects/{project_id}/connection_uri` takes `branch_id`, `endpoint_id`,
`database_name`, `role_name` and `pooled`. The harness sends exactly one of `parent_lsn` / `parent_timestamp`.

## Tests

```sh
python3 -m pytest -q scripts/space-harness/test_space_harness.py   # no network, no database
npx vitest run scripts/space-harness/arm.test.mjs                  # no network, no database
python3 -m pytest -q scripts/space-harness/test_space_harness_pg.py  # needs the two local clusters (above)
```

`arm.test.mjs` runs in CI's unit run (the vitest node project takes `scripts/**`). The pytest files are
outside ci.yml's `scripts/test_*.py` glob.
