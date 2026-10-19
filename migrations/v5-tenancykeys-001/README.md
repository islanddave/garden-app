# v5-tenancykeys-001 — the index gate (unique keys carry the tenancy key)

Multi-space plan V204 step **2.0e** (§2.4 "Unique keys and upserts"), ledger **V5-SPACETENANCYKEY-001**. Plan:
`project-state/_multispace-20261015/multispace-prep-plan-V204-20261019.0900.md`.

Once a second Space exists, a unique key that does not carry the Space makes two Spaces collide: B's insert of a key A
already holds gets A's 23505 (or, in an upsert, updates A's row). This directory holds the live half of the keys
instruments: one standing gate that every unique index on an S, D or base-capable C table carries the tenancy key or is
a named exemption. The repo half is `lambda/tenancy-keys.static.test.js` (every ON CONFLICT arbiter the 2.0a SQL census
finds; the exemption file's closed world against the committed snapshot `tests/tenancy-unique-indexes.prod.json`; the
VALUES lists here equal to the files, N16), with its rule in `tests/lib/tenancyKeys.mjs`.

Stamp **`5.3.12-tenancykeys-001`** (`<next version>-<dir>`; rename at push time if the release number moves).

| file | what it does |
|---|---|
| `0a-stamp.sql` | Refuses, changing nothing, where the armed gate would red at once (the same predicate and VALUES rows); otherwise writes the stamp. No DDL. |
| `0r-rollback.sql` | Deletes the stamp. |
| `gates.yml` | 2 `pre` (not applied; the predicate unarmed); 1 `post`, `post_s_unique_indexes_carry_workspace`, continuous, `env: both` (the default). |
| `rehearse_local.py` | The whole rehearsal on a local PostgreSQL 17 replica (below). |

Nothing here changes what any user sees.

## The rule

A unique index (`pg_index.indisunique`, primary keys included) on a table of `lambda/tenancy-classes.json` whose class
is `S …`, `D …` or `C base + private` passes when it is the single-column primary key on `id` (exemption class 1, by
rule), or, unless it is `NULLS NOT DISTINCT`, when

| arm | passes when |
|---|---|
| S (`S has key`, `S needs key`, `S keyed by space_id`, `S new`) | a key column is `workspace_id` or the table's tenancy column (`spacetheme`: `space_id`) |
| D (`D`, `D event-time copy`, `D via plot`) | a key column is `workspace_id` or the tenancy column; on `D via plot` (the weather tables) `space_id` or `plot_id` (§2.2); or the leading key column alone carries a single-column FK into an S or D table |
| C (`C base + private`) | a key column is `workspace_id`, or the predicate holds a bare top-level `is_base` conjunct with no `OR` (the §2.5 base key `WHERE is_base AND deleted_at IS NULL`) |

Anything else must be an entry of `scripts/tenancy-index-exemptions.json`, with its class (2-6, §2.4) and a one-line
reason; class 5 names its route, class 6 its 5.3 row. Key columns only: `INCLUDE` columns do not count. A column
anywhere in the key counts: a key that holds a Space-determining column cannot collide across Spaces whatever its
position. The leading-FK rule is single-column only, so composite-FK keys (`uq_ksl_voids_id`,
`uq_pantry_use_reverses_use_id`) are class-3 entries named one by one.

## The gate

```sql
WITH key_classes (nspname, relname, class, tenancy_column) AS (VALUES …),   -- the class file's in-scope tables
     exemptions (nspname, relname, indexname, class) AS (VALUES …),          -- the exemption file
uniq      -- each unique index of a key_classes table (pg_namespace / pg_class / pg_index, no ::regclass)
keycols   -- its key columns, unnest(indkey) WITH ORDINALITY up to indnkeyatts; attname NULL for an expression
verdict   -- pk_on_id, has_key, has_plot_key, leads_with_fk (pg_constraint contype f, conkey = ARRAY[lead]),
          -- base_pred (pg_get_expr(indpred) ~ '(^|\(|AND )is_base( AND |\)|$)' and no OR)
'<schema>.<table>.<index> (<class>; <key columns>)'   for each index that passes no arm and is not exempt
```

Armed by `EXISTS (… schema_version WHERE version = '5.3.12-tenancykeys-001')`. A table not in `key_classes` is not
checked: the 2.0b relkind gate (`post_tenancy_classes_closed_world`) reds on an unclassed relation, and the test holds
`key_classes` equal to the class file. An exemption naming an index that does not exist is harmless to the gate; the
test fails it against the snapshot unless it is `pending` on a stamp.

## Day one: the exemption file

44 entries (read live on prod and staging 2026-10-19, read-only; the two are identical outside copy tables):

| class | n | entries |
|---|---|---|
| 2 | 2 | `plants_id_project_uq`, `uq_kbi_id_preservation_log_id` |
| 3 | 8 | `uq_findings_live_natural`, `idx_locations_child_slug`, `care_profile_scope_uniq`, `entity_planting_uniq`, `plant_varieties_source_proj_rescope_uniq` (2.4-post drops it), `uq_vbc_blend_component_live`, `uq_ksl_voids_id`, `uq_pantry_use_reverses_use_id` |
| 4 | 4 | `care_profile_system_uniq`, `entity_crop_uniq`, `entity_critter_uniq`, `entity_cultivar_uniq` |
| 5 | 13 | the six S idempotency keys (`event_batches`, `inventory_items`, `kitchen_batch`, `pantry_item`, `preservation_log`, `recipe`); the D idempotency keys (`uq_kbi_idempotency_key`, `uq_ksl_idempotency_key`, `uq_pantry_use_idempotency_key`); `idx_critter_state_source_event_id`, `uq_evidence_source_record_live` (5.3 decides both); `merge_event_op_uniq`, `uq_sla_addition_key` |
| 6 | 17 | the §2.4 re-key table (`daily_plan`, `favorites`, `idx_locations_root_slug`, `idx_photos_content_hash_uniq`, `plant_projects_slug_key`, the two `plant_varieties` keys, the two `recipe_type` keys, `uq_slug_namespace`, `uq_source_match_key_live`, `storage_location`, `uq_tag_facet_slug_owner`, `uq_voice_alias_user_phrase`, `uq_weather_cue_impression_day`); the dormant `locations_qr_code_slug_key`; `reparent_op_uniq` |

All 24 of recon B §4's keys that lack `workspace_id` are in it (its 25th, `idx_garden_shared_state_natural`, carries
the key). The rest are the D and base-capable C keys, which recon B §4 did not cover. `reparent_op_uniq` is class 6
by §2.4's own class-5 rule: `projects/index.js` `reparentCore` returns the prior move by `op_id` with no scope (step 1,
and again in its 23505 catch), so the conflict path reveals the existing row; the 5.3 lane re-keys it. No weather key
needs an entry: today's primary keys carry `space_id`, 3.2a's `(plot_id, "date")` and `(plot_id, night_date,
init_time)` carry `plot_id` (both by the D-via-plot arm; the rehearsal shows 3.2a's shape green).

## Arming: a stamp-only 0a, as v5-tenancyclasses-001

gate-invariants runs every continuous post gate on every `migrations/**` push and on its Tuesday cron, so a standing
gate must not red before the step it guards is applied. The house answer for a gates-only directory is
`v5-tenantgates-001`'s, which `v5-tenancyclasses-001` (2.0b) also took: a `0a` that writes only the stamp, refusing first
where the armed gate would red, and a `0r` that deletes it. The gate is vacuous until a sitting applies `0a` (Dave's
first-hand OK naming this migration and both envs, as for any stamp write); until then the repo test is the check.

## Apply (a sitting; Dave's first-hand OK naming this migration and both envs)

No object dependency. One row lock in `schema_version`; the house window anyway (never :55-:05, nor 07:00-08:00 UTC;
`lock_timeout` 5s). Before the sitting, regenerate and compare the snapshot on both envs:
`python3 scripts/tenancy-index-snapshot.py --env staging --check` and the prod write (0 differences, or commit the new
snapshot with the exemption edits it needs).

1. Staging: `gate_runner.py --migration migrations/v5-tenancykeys-001 --env staging --phase pre` → `psql
   "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-tenancykeys-001/0a-stamp.sql` → `--phase post` →
   `--all --phase post --continuous-only` compared with the run before (newly red must be empty).
2. Prod: the same.

## Rollback

`0r-rollback.sql` deletes the stamp; the gate goes vacuous. A re-run is a no-op; a re-apply of 0a re-checks first.

## Pre read on the live envs (read-only, 2026-10-19)

`gate_runner.py --migration migrations/v5-tenancykeys-001` on prod and on staging: PASS 3/3 each (the pre predicate
returns 0 rows on both; post vacuous). With one class-6 row (`idx_locations_root_slug`) deleted from a scratch copy of
`gates.yml`, the same run on prod: `FAIL pre/pre_s_unique_indexes_carry_workspace: got rowcount=1`, the row
`public.locations.idx_locations_root_slug (S needs key; slug)`. With `idx_photos_content_hash_uniq`'s row deleted too,
the predicate lists exactly those two on prod and on staging.

## C-CONV pre-scan (V204 §2.8)

This step adds no relation, column, index, function, trigger or view; its only write is one `schema_version` row. So
the scan is for gates that read `schema_version` by pattern or by count:

```
rg -n "version\s+(NOT\s+)?(I?LIKE|~\*?|SIMILAR)\s" migrations/*/gates.yml   → only LIKE 'phase7-approved-%' (v5-tenantgates-001:45, :186)
rg -n -i "(count|max|min)\([^)]*\)[^\n]*FROM\s+public\.schema_version" migrations/*/gates.yml
   → exact-version counts only, plus v4-wintergreenstypes-001:125 (WHERE version = '4.32.1-…' on the next line) and
     v4-archrestore-001:102 (count(*) > 0): one more row changes neither
```

Expected newly red: **{}** — rehearsed (below), on both `--env prod` and `--env staging`.

## What later steps change here

- **2.1** (22 tables gain `workspace_id`): no exemption changes (an index does not gain the column by ADD COLUMN). The
  class file rows move from `S needs key` to `S has key` with column `workspace_id`; regenerate the `key_classes` rows
  (`node tests/lib/tenancyKeys.mjs --values`) in the same push. The unchanged S arm still accepts `workspace_id` for
  either class. Regenerate the snapshot only if an index changes.
- **2.4-pre**: `variety_rescope_origin`'s partial unique `(project_id)` is a class-3 entry (N14) with `pending` on its
  stamp, in its push, with its class file row.
- **2.4a**: the new base keys (`WHERE is_base AND deleted_at IS NULL`) and private keys (`(workspace_id, …)`) pass by
  rule; the old keys stay class 6 until 5.3.
- **3.2a**: its plot keys pass by rule (no entry). If 3.2a changes the weather rows' class or column in the class file,
  regenerate `key_classes`.
- **5.3**: each re-key's old-index drop removes its class-6 entry, regenerates the snapshot and the VALUES in the same
  push; each class-5 entry is confirmed or turned into a re-key at its route.

## Rehearsal

Local PostgreSQL 17.10 only (`initdb … -A trust --no-locale -E UTF8`, 127.0.0.1:55493). Replica `base`: prod's
`pg_dump --schema-only --no-owner --no-privileges -n public -n gv -n extensions` (read-only, `garden_ro`; the
`uuid-ossp` extension created in `public` first, since the dump's `extensions.*` functions are SQL wrappers over it),
and as data (read-only `COPY`, loaded with `session_replication_role = replica`): prod's 189 `schema_version` rows,
`spaces` (1), `spacetheme` (1), `plots` (1), `weather_daily` (162), `weather_cold_range` (6). Then:

```bash
python3 migrations/v5-tenancykeys-001/rehearse_local.py --port 55493 --base-db base
```

**Result 2026-10-19: 43/43 PASS, exit 0.** Pre 2/2 on the base; C-CONV before: no ERROR on either env; 0a exit 0 and
the stamp written; post PASS; C-CONV newly red {} and newly green {} on prod and staging, this gate PASS inside the
`--all` run. Controls, each red then green on a clone of the applied database, the gate's rows naming the index and
`gate_runner` reporting FAIL: an unlisted global unique index on `favorites (entity_type, entity_id)`; a D index
`kitchen_stage_log (stage_kind, id)`; a weather key on `("date")` alone; a base-capable C key `WHERE NOT is_base`;
`NULLS NOT DISTINCT` on `garden_shared_state (workspace_id, kind)`; one class-6 row (`idx_locations_root_slug`)
deleted from the gate's exemptions (armed). Green by rule: `favorites (workspace_id, user_id, entity_type,
entity_id)`; 3.2a's `(plot_id, "date")` and `(plot_id, night_date, init_time)`; `plant_varieties (lower(name)) WHERE
is_base AND deleted_at IS NULL`; `harvest_log (event_id, id)` (leading FK into `event_log`, D). Self-arm: without the
stamp the planted favorites index leaves the post gate green and reds the pre gate; `0a` refuses on it naming it,
writing nothing. `0r` exit 0, stamp gone; `0r` again a no-op; `0a` again exit 0, post PASS. Not run on staging or prod
as an apply.
