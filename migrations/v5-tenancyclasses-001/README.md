# v5-tenancyclasses-001 — the relkind gate (the tenancy class file, live)

Multi-space plan V204 step **2.0b** (§2.1), ledger **V5-SPACETENANCYKEY-001**. Plan:
`project-state/_multispace-20261015/multispace-prep-plan-V204-20261019.0900.md`.

`lambda/tenancy-classes.json` maps every relation of relkind r, p, v, m or f in every non-system schema to its class
and tenancy column. This directory holds the live half: one standing gate that the catalog and the file name the same
relations. The repo half is `lambda/tenancy-classes.test.js` (every relation the 2.0a SQL census finds is classed; each
row against the prod catalog's `attnotnull`, read from the committed snapshot `tests/tenancy-catalog.prod.json`; the
VALUES lists here equal to the file, N16).

Stamp **`5.3.6-tenancyclasses-001`** (`<next version>-<dir>`, as `v5-plottier-001`; rename at push time if the release
number moves).

| file | what it does |
|---|---|
| `0a-stamp.sql` | Refuses, changing nothing, where the armed gate would red at once (the same predicate and VALUES rows); otherwise writes the stamp. No DDL. |
| `0r-rollback.sql` | Deletes the stamp. |
| `gates.yml` | 2 `pre` (not applied; the closed-world predicate unarmed); 1 `post`, `post_tenancy_classes_closed_world`, continuous, `env: both` (the default). |
| `rehearse_local.py` | The whole rehearsal on a local PostgreSQL 17 replica (below). |

Nothing here changes what any user sees.

## The gate

```sql
WITH tenancy_classes (nspname, relname, relkind, class, tenancy_column, pending_stamp) AS (VALUES …),  -- the file
live AS (relkind r/p/v/m/f, every schema but pg_catalog, information_schema, pg_toast*, pg_temp_*,
         minus relname !~ '^ctas_' / '^snap_' / '^harvest_log_weight_snapshot_' / '^plants_legacy_cols_backup_')
'unclassed <schema.rel> (relkind k)'  for each live relation not in the list
'stale <schema.rel> (relkind k)'      for each row whose relation is absent or has another relkind,
                                      unless its pending_stamp is set and not yet in schema_version
```

Both arms behind `EXISTS (… schema_version WHERE version = '5.3.6-tenancyclasses-001')`. No `::regclass`. The copy
patterns are anchored regexes on `relname` (a LIKE would read `_` as a wildcard), the same list as the class file's
`copyPatterns`; the test pins every gate's predicates to it. No other gate in the tree excludes copies by pattern
today (grep below), so this is the only consumer.

`public.plots` (step 3.1, `migrations/v5-plottier-001`, not yet applied) is a row with `pending_stamp =
'5.3.6-plottier-001'`: absent is green until that stamp exists, and required after it. Every later step that creates a
relation does the same in its own push: the class file row (pending on its stamp), `scripts/tenancy-catalog-snapshot.py`
after the apply, and the VALUES rows (`node tests/lib/tenancyClasses.mjs --values`).

## Arming: why a stamp-only 0a, for a gate with no DDL

gate-invariants runs every continuous post gate on every `migrations/**` push and on its Tuesday cron, so a standing
gate must not red before the step it guards is applied. The house rule for that is self-arming on the migration's own
`schema_version` row (review DSA I3), and the house answer for a **gates-only** directory is
`v5-tenantgates-001`'s: "a gates-only directory writes no stamp, so it gets a `0a` that writes only the stamp and a `0r`
that deletes it", with `0a` refusing first where the armed gate would red. This directory does the same.

Considered and not taken:
- **Unarmed** (`v5-plantprojectfkdrift-001/gates.yml:286` is a standing gate with no stamp, "true on prod today"). This
  gate is true on both envs today too (the pre read below), but an unarmed gate makes the first push the arming event,
  outside any sitting and with no refusal step; and the house rule names the stamp.
- **Arming on an existing stamp** (e.g. `5.1.5-tenantgates-001`): arms on push the same way, and ties this gate's
  rollback to another directory's.

So the gate is vacuous until a sitting applies `0a` (Dave's first-hand OK naming this migration and both envs, as for
any stamp write); until then the repo test is the live check.

## Apply (a sitting; Dave's first-hand OK naming this migration and both envs)

No object dependency. One row lock in `schema_version`; the house window anyway (never :55-:05, nor 07:00-08:00 UTC;
`lock_timeout` 5s). Before the sitting, regenerate and compare the snapshot on both envs:
`python3 scripts/tenancy-catalog-snapshot.py --check` (prod) and `--env staging --check` (0 differences each).

1. Staging: `gate_runner.py --migration migrations/v5-tenancyclasses-001 --env staging --phase pre` → `psql
   "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-tenancyclasses-001/0a-stamp.sql` → `--phase post` →
   `--all --phase post --continuous-only` compared with the run before (newly red must be empty).
2. Prod: the same.

## Rollback

`0r-rollback.sql` deletes the stamp; the gate goes vacuous. A re-run is a no-op; a re-apply of 0a re-checks first.

## Pre read on the live envs (read-only, 2026-10-19)

Catalog, read-only (psycopg `read_only`, `SET LOCAL search_path TO DEFAULT`): only `public` holds relations of these
kinds on either env (`gv` and `extensions` hold functions only). Prod 150 (121 r, 29 v), staging 147 (118 r, 29 v);
without copies 114 on each, the same names, relkinds and tenancy columns (`tenancy-catalog-snapshot.py --env staging
--check`: 0 differences from the prod snapshot). The copies differ by env only (prod 13 `ctas_*` + 2
`harvest_log_weight_snapshot_*` that staging lacks; staging 12 `snap_*` that prod lacks). `gate_runner.py --migration
migrations/v5-tenancyclasses-001 --phase pre` on prod and on staging: PASS 2/2 each; `--phase post`: PASS (vacuous).

## C-CONV pre-scan (V204 §2.8)

This step adds no relation, column, function, trigger or view; its only write is one `schema_version` row. So the
scan is for gates that read `schema_version` by pattern or by count:

```
rg -n "version\s+(NOT\s+)?(I?LIKE|~\*?|SIMILAR)\s" migrations/*/gates.yml   → only LIKE 'phase7-approved-%' (v5-tenantgates-001:45, :186)
rg -n -i "(count|max|min)\([^)]*\)[^\n]*FROM\s+public\.schema_version" migrations/*/gates.yml  → none
```

Every other `schema_version` read is an exact `version = '…'` / `version IN (…)` arm on another stamp. Neither can
change. Catalog-wide gates (`pg_class` / `information_schema` with no relname filter) are unaffected: no relation is
created. Expected newly red: **{}** — rehearsed (below), on both `--env prod` and `--env staging`.

## Rehearsal

Local PostgreSQL 17.10 only (`initdb … -A trust --no-locale -E UTF8`, 127.0.0.1:55482). Replica `base`: prod's
`pg_dump --schema-only --no-owner --no-privileges -n public -n gv -n extensions` (read-only, `garden_ro`), and as data
(`\copy` through `garden_ro`, loaded with `session_replication_role = replica`): prod's 187 `schema_version` rows,
`spaces` (1), `spacetheme` (1), `weather_daily` (162), `weather_cold_range` (6). Then:

```bash
python3 migrations/v5-tenancyclasses-001/rehearse_local.py --port 55482 --base-db base
```

**Result 2026-10-19: 47/47 PASS, exit 0.** Pre 2/2 on the base; C-CONV before: no ERROR on either env; 0a exit 0 and
the stamp written; post PASS; C-CONV newly red {} and newly green {} on prod and staging, this gate PASS inside the
`--all` run. Controls, each red then green on a clone of the applied database, the gate's rows naming the relation and
`gate_runner` reporting FAIL: a planted `public.zz_planted` (r); `zz.zz_part` (p) and `zz.zz_view` (v) in a new
schema; `public.zz_mv` (m); `public.zz_ft` (f, through a handler-less FDW); `maintenance_flags` renamed (stale +
unclassed); plottier's stamp without `plots` (stale), turned green by plottier's real `0a`; plottier's real `0a` on the
applied database green, and `plots` then dropped red (stale). One copy table per anchored pattern stays green;
`zz_ctas_x` (unanchored) reds. Self-arm: without the stamp a planted table leaves the post gate green and reds the pre
gate; `0a` refuses on it naming it, writing nothing. `0r` exit 0, stamp gone; `0r` again a no-op; `0a` again exit 0,
post PASS. Not run on staging or prod as an apply.
