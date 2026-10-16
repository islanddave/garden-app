# C-HARNESS — `scripts/space-harness/`

Build sheet step 1.12 (V5-SPACEISOLATION-001). The harness measures one change on two throwaway copies of
prod forked at the same point, and gives one of three verdicts:

| Verdict | Exit | Meaning |
|---|---|---|
| PASS | 0 | A and B matched before the change, the instrument saw a stray write in every table the use measures, both arms ran `run()` to success, the named positive control was seen on its side and not on the other, something told B from A, and every difference is one the use allows. |
| DIFF | 1 | The change did something the use does not allow: a business row, an alert (topic, subject or body) or an outbound call differs, or a `needles_absent` needle was found. Do not apply. |
| FAULT | 3 | The instrument cannot vouch for itself: A and B are one database, A ≠ B before the change, a stray write was invisible (or a measured table has no row to write to), an arm exited with anything but success, the positive control is missing or seen on both sides, **B = A** (no change given, one SHA twice, or nothing tells B from A), the sentinel could not be read, or anything crashed. **Never a pass.** Record it and make a new pair. |
| (usage) | 2 | Bad arguments (including `--base-sha` = `--candidate-sha`, and `--pair` with `--local-pg`). |
| REFUSED | 4 | A precondition said do not start: the fleet budget, the minute is too close to :00, a pair name is taken, the pair record does not match what Neon says, the two URLs are one database, or an offline URL is not loopback. |
| DATA-ONLY | 5 | `--no-arms`: the data comparison passed but `run()` was not measured. Not a pass. |

## Files

| File | What it does |
|---|---|
| `harness.py` | The CLI: `fleet`, `pair`, `selftest0`, `stray`, `run`. |
| `neon_pair.py` | Fleet check through `neon_safety_branch.py list`; A through `neon_safety_branch.py create`; B through the Neon API at A's fork point; one endpoint per branch; each branch's URL. |
| `checksum.py` | Business-column checksums, the row-level diff, the stray-write self-test, the sentinel read. |
| `arm.mjs`, `arm-lib.mjs` | One arm: a non-dry daily-plan `run()` from one tree's own `lambda/daily-plan/handler.js`, against one branch, with recording stubs. |
| `fixtures/fetchers.default.json` | The default weather fixture both arms read (2-decimal coordinates at most, no station id). |
| `fixtures/use.example-d1.json` | A use in the V102 Step 11 (D1) shape. |
| `../test_space_harness.py`, `arm.test.mjs` | Unit tests: no network, no database. |
| `../test_space_harness_pg.py` | The self-tests on two real local Postgres clusters (skipped unless given). |

## What is compared

- **Tables.** Every base table in `public` (a use can add schemas), except the volatile tables `app_events`,
  `ux_events` and `rate_limit_buckets`.
- **Columns.** Every column except `created_at` and `updated_at`, and the ones the use names in
  `volatile_columns` (an explicit list per use, printed with the verdict, table by table). A DEFAULT of `now()`
  or `gen_random_uuid()` is never a reason to leave a column out: the code writes such columns too
  (`event_log.event_date`), and a fork carries equal values in them. Rows both arms insert get different ids
  and timestamps: name those columns (`daily_plan.id`, `daily_plan.generated_at`, ... — the example use shows
  the ones the offline rehearsal needed). jsonb keys named in `jsonb_volatile_keys` are stripped
  (`daily_plan.plan → prior_runs` by default).
- **Order.** Each row's business columns form one text value; a table's checksum is the md5 of its row md5s
  ordered by that value (`COLLATE "C"`). The business key is the whole business row, so two tables match only
  when they hold the same multiset of business rows, whatever their uuids and timestamps.
- **Calls.** Each arm records every outbound effect by destination: `publishAlert` (`sns:<topic>`), AWN
  (`fetchStation` and any fetch to `api.ambientweather.net`, recorded as `awn:<sha256 tag>`, never the device
  id), Graph (any fetch to `graph.facebook.com`, `graph:<node>/<edge>`, never the token), the weather fetchers
  (`grid:<lat>,<lng>` at 2 decimals) and any other host (`fetch:<host>`). Global `fetch` is replaced for the
  run, and every TCP connect (`node:net`, `tls`, `http`, `https`, an SDK, a WebSocket, a second pg client) passes
  a guard that allows only the arm's own database (and, offline, its in-process proxy); anything else is
  recorded as a `net` call and refused. Calls are compared as multisets of (stub, destination, subject, a
  hash of the message body).
- **Allowed differences.** Each `allowed_diffs` entry reports how many rows its predicate matched on each side
  and how many differing rows it removed, so a broad predicate cannot blind a table without showing it.
- **The stray write.** Before the change, one value is changed (inside a transaction that is rolled back) in
  every table the use measures — its row control's table, `allowed_diffs` tables, `volatile_columns` and
  `jsonb_volatile_keys` tables, `needles_absent` row tables, `stray_target`, and `daily_plan` when arms run —
  and each must show as a diff. A measured table with no row is a FAULT: seed it (offline) or drop it.

## The arms' environment

Each arm gets only `PATH`, `HOME`, `TMPDIR`, `TZ`, `LANG`, `LC_ALL`, its own URL (`HARNESS_DSN`),
`AWS_EC2_METADATA_DISABLED=true`, and the Lambda's flags: the values in `scripts/lambda-config-expected.json`
(`garden-daily-plan.env`, the checked-in copy of the live function's configuration that
`check-lambda-config.py` enforces). A string is set as it is, `null` is unset, and `true` (present, value varies:
`SYSTEM_CLERK_SUB`, `OWNER_FALLBACK_SUB`, `GARDEN_HOUSEHOLD_IDS`, `AWN_STATIONS_JSON`) is taken from the
operator's environment only when exported there. A use's `flags` override the manifest, and `requires_flags`
FAULTs a run whose arms would have a needed flag off. Never `NEON_*`, `*DATABASE_URL*`, `AWS_*` or anything
secret-shaped; an arm that reports such a key it was not given is a FAULT. The effective flag map (no
passed-through value) is printed and written to the verdict.

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

- Unknown keys are refused (a typo such as `stray_targett` would otherwise fall back silently).
- `positive_control` is **required and named**. Kinds:
  - `log`: a console JSON line whose keys include `match` (e.g. `{"msg": "space-wx", "space": "$indoor"}`);
  - `destination`: a recorded call of `stub` whose fields include `match` (e.g. `{"destination": "sns:ops"}`);
  - `row`: `SELECT count(*) FROM <table> WHERE <where>` on each branch.
  It must be seen on `present_on` (default `b`) and NOT on the other side. `absent_on` can only name that other
  side: B = A must fault, and no use can switch that off. With arms, a row control must not already be true
  before the arms run (it would show the data change, not `run()`).
- `needles_absent`: `[{"needle": "$indoor", "sides": ["a"], "surfaces": ["console", "calls",
  "rows:public.daily_plan"], "destination": "sns:<topic>"}]` — a needle found on a listed side and surface is a
  DIFF (`destination` limits `calls` to one destination, e.g. "B's Space never in Dave's alert").
- `flags` / `requires_flags`: see "The arms' environment".
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
  python3 -m pytest -q scripts/test_space_harness.py scripts/test_space_harness_pg.py
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

1. **Fleet.** `python3 scripts/space-harness/harness.py fleet --env-file ../garden-app/.env.local`. It counts
   self-cleaning branches the way integrity-weekly does (`neon_branch_select.self_cleaning`) and refuses when
   they + 2 for the pair + 1 held for the day's `--slug ms1` sitting copy (until it exists) exceed
   `NEON_MAX_EXPIRING` (default 6): 3 or fewer before the sitting copy, 4 or fewer after it. (Row 1.12's
   "refuse at 9" and P20's "6 or fewer" both miss that integrity-weekly caps expiring branches at 6.)
2. **Minute.** Between :10 and :50 UTC (the hourly writers run at :00). `pair` refuses outside it.
3. **Pair.**
   `python3 scripts/space-harness/harness.py pair --step 1.12 --env-file ../garden-app/.env.local --out $S/pair.json`
   A = `sitting-harness-1-12-<HHMM>-a-prod-preapply-<date>` (made by `neon_safety_branch.py create --days 1`);
   B = `sitting-harness-1-12-<HHMM>-b-prod-preapply-<date>`, from prod at A's `parent_lsn` (or
   `parent_timestamp` when A reports no LSN). `pair.json` holds ids and hosts, no password.
4. **Driver.** Each arm loads `@neondatabase/serverless` and `ws` from its tree's `lambda/daily-plan/node_modules`:
   `npm install --prefix <tree>/lambda/daily-plan --no-save --legacy-peer-deps`, or pass `--driver` and `--ws`.
5. **Environment.** The flags come from the manifest (see "The arms' environment"). Export
   `GARDEN_HOUSEHOLD_IDS`, `SYSTEM_CLERK_SUB`, `OWNER_FALLBACK_SUB` and `AWN_STATIONS_JSON` as the live Lambda has
   them if the use needs them (name them in `requires_flags`). Pass a recorded fetcher fixture with `--fixture`
   if the default dry day is not the point; keep it free of station ids and of coordinates past 2 decimals.
6. **Run.** Data change:
   `harness.py run --pair $S/pair.json --env-file ../garden-app/.env.local --use <use.json> --b-sql <change.sql> --today <YYYY-MM-DD> --out $S/verdict.json`.
   Code change: replace `--b-sql` with `--base-sha <base> --candidate-sha <candidate>` (two clean detached
   worktrees are added under `--trees-dir` and removed afterwards unless `--keep-trees`).
   Before any URL is asked for, each side is read back from the Neon API (`GET branches/{id}`,
   `GET endpoints/{id}`): the branch must be named `sitting-harness-…-<side>-prod-preapply-<date>`, be a child
   of prod that expires within 48 hours, and not be default or protected; the endpoint must belong to it, be at
   the recorded host and not be one of `PROTECTED_ENDPOINTS` (`tests/integration/_cleanup.js`); A and B must
   differ in branch, endpoint and host. Then each URL is asked for that endpoint (`branch_id`, `endpoint_id`,
   `neondb`, `neondb_owner`, `pooled=false`) and refused unless its host is that endpoint. Once connected, an
   advisory-lock probe proves the two URLs are two databases.
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
python3 -m pytest -q scripts/test_space_harness.py      # no network, no database
npx vitest run scripts/space-harness/arm.test.mjs      # no network, no database
python3 -m pytest -q scripts/test_space_harness_pg.py   # needs the two local clusters (above)
```

The pytest files sit in `scripts/` so ci.yml's `python3 -m pytest -q scripts/test_*.py` collects them; the PG
file skips itself there (no psycopg, no clusters). `arm.test.mjs` runs in CI's unit run (the vitest node project
takes `scripts/**`).
