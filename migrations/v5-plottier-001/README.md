# v5-plottier-001: the plot tier's table and Plot 1

Ledger **V5-SPACEPLOTTIER-001**, multi-space plan V204 step **3.1** (§2.2, §2.8, §3.0; plan of record
`project-state/_multispace-20261015/multispace-prep-plan-V204-20261019.0900.md`). Stamp **`5.3.6-plottier-001`**,
written by `0a-plots.sql` in the same transaction as its DDL.

| File | What |
|---|---|
| `0a-plots.sql` | `public.plots`, its one-default index, C-AUDIT, C-GUARD, C-BLOCK, Plot 1 for every Space, the stamp |
| `0r-rollback.sql` | refuses while plots holds data spaces does not, or anything references plots; else drops it all |
| `gates.yml` | 5 pre gates; 16 post gates, each self-armed on the stamp, one apply-window receipt |
| `rehearse_local.py` | the local PostgreSQL 17 rehearsal (below) |

Not applied to staging or prod. Nothing in the deployed code reads or writes `plots` (no reader until 3.3b).

## What it adds

- **`public.plots`** with V204 §2.2's columns as the session amended them on 2026-10-19: `id uuid` PK (default
  `gen_random_uuid()`), `workspace_id uuid NOT NULL` → `spaces(id)` ON DELETE RESTRICT, `name text NOT NULL`,
  `postal_code text`, `lat numeric`, `lng numeric`, `timezone text NOT NULL` (no default), `is_default boolean NOT
  NULL DEFAULT false`, `created_by text NOT NULL`, `created_at` and `updated_at timestamptz NOT NULL DEFAULT now()`,
  `deleted_at timestamptz`. `plots_lat_lng_both_or_neither CHECK ((lat IS NULL) = (lng IS NULL))`: a plot with no
  coordinates means "no weather", exactly as a coordinate-less `spaces` row does today (`daily-plan/handler.js:35`);
  half a place is refused. `UNIQUE (id, workspace_id)` (the target of 3.2a's, 3.5's and 3.6's composite keys) and
  `plots_one_default_per_space`, unique on `(workspace_id) WHERE is_default AND deleted_at IS NULL`.
- **C-AUDIT:** `trg_audit_plots_ins` (`audit_stmt_insert`), `trg_audit_plots_upd` (`audit_stmt_update` watching
  `workspace_id, name, postal_code, lat, lng, timezone, is_default, created_by`), `trg_audit_plots_del`
  (`audit_stmt_delete`), all statement-level with transition tables. `audit_stmt_update`, not the `_no_soft_delete`
  variant, because plots has `deleted_at` (a soft delete audits as `SOFT_DELETE`, a restore as `RESTORE`). Ignored:
  `id` (it is `audit_events.row_id`), `created_at`, `updated_at`, `deleted_at` (recorded by the function itself).
- **C-GUARD:** `plots_repoint_guard`, `BEFORE UPDATE OF lat, lng, postal_code, timezone` → `guard_plots_repoint()`.
- **C-BLOCK:** the key into spaces is single-column on `spaces.id`, so `spaces_delete_guard` refuses to delete a Space
  that has a plot (live or soft-deleted); `plots_delete_guard` (`BEFORE DELETE` → `guard_plots_delete()`) and
  `plots_truncate_guard` (`BEFORE TRUNCATE` → v5-spaceguard-001's `guard_space_truncate()`, unchanged).
- **Plot 1** for every Space by `INSERT … SELECT` from `spaces`, `is_default = true`, under the actor
  `migration:v5-plottier-001` (so each has its INSERT audit row), on the first apply only. No literal coordinates and no
  literal Space (N12); none in any trigger body either.

### What the plots guard refuses today (C-GUARD rule)

`plots_repoint_guard` raises P0001 when `(lat, lng, postal_code, timezone)` changes (IS DISTINCT FROM, so a NULL on
either side counts) on a plot that **is or becomes its Space's default plot**, while **any `weather_daily` or
`weather_cold_range` row names that Space** (`space_id = workspace_id`, old or new). Everything else passes: a
non-default plot moves freely, a default plot of a Space with no weather moves, a same-value SET passes, and columns
outside the OF list never fire it.

Why that rule, read against Phase 1's `spaces_repoint_guard` (refuses the Space's triple while weather names the
Space): until 3.2a no weather row carries `plot_id`, so there is no "weather recorded for this plot" to read. A Space's
weather is recorded at its default plot's place **by construction**: Plot 1 is a copy of the Space's triple, which
`spaces_repoint_guard` already freezes while weather exists, and 3.2a backfills that weather onto the default plot. So
the default plot is frozen exactly when, and for the same rows as, the Space. A non-default plot has no weather until
3.2b's writers stamp it. **3.2a** (which adds `plot_id`) replaces the body to read `plot_id`, behind a definition
pre-gate on this body's md5 (`0845482dfbb48a94ec3cd81bddd6d62f`, `gates.yml` `post_plots_guard_functions_pinned`).

`is_default` is not in the OF list (V204 names the four columns). Moving the default flag to a plot elsewhere is caught
by the continuous gate `post_default_plot_place_equals_space_place`, not refused.

A coordinate-less default plot is frozen the same way: giving it its first place while its Space has weather is a
change (NULL → value), as it is for `spaces_repoint_guard`. Staging's Space holds one `weather_cold_range` row, so its
Plot 1 gets a place only by the escape template (rehearsed: P0001).

The escape template (owner-approved move of a default plot) is in `COMMENT ON FUNCTION public.guard_plots_repoint()`:
disable this one trigger, update, re-enable, check `tgenabled = 'O'`, stamp. Until 3.7 the Space's triple must move in
the same transaction (`spaces_repoint_guard`'s template), or `post_default_plot_place_equals_space_place` reds.

### C-BLOCK detail

`guard_plots_delete()` walks every foreign key whose referenced table is `public.plots`, read from the catalog at each
delete, and pairs each key's columns with the plot's (`(plot_id, space_id) = (OLD.id, OLD.workspace_id)` for the
composite keys from 3.2a on). Any referencing row, soft-deleted or not, refuses the delete, which makes the effective
behaviour RESTRICT even for a key declared CASCADE. A row whose key holds a NULL names no plot (MATCH SIMPLE) and does
not block. Today nothing references plots, so a hard delete (test cleanup, 0r) passes.

## Where each value of Plot 1 comes from (read live, read-only, 2026-10-19)

| Column | Source | Note |
|---|---|---|
| `workspace_id` | `spaces.id` | |
| `name` | `spaces.name` | NOT NULL on spaces. Prod: "Gardens at Mathews Ridge". |
| `postal_code` | `spaces.postal_code` | nullable on both |
| `lat`, `lng` | `spaces.weather_lat`, `weather_lng` | numeric on both, so Plot 1 equals its Space exactly; NULL together when the Space has no coordinates |
| `created_by` | `spaces.created_by` | the Space's owner (nullable on spaces; set on both envs) |
| `timezone` | **the literal `'America/New_York'`, in `0a-plots.sql`'s `INSERT … SELECT` only** | `spaces` has no zone column and `app_config` no zone key; the deployed code compiles it in (`lambda/inventory-items/seed-stage-date.js` `ET_TZ`, `lambda/daily-plan/rainForecast.js`). Not a column DEFAULT. **Accepted by the session, 2026-10-19.** |
| `is_default` | `true` | |

Step 0 of 0a refuses, naming each Space, when on the first apply a Space has no `created_by` (NOT NULL here) or
exactly one of `weather_lat` / `weather_lng` (`plots_lat_lng_both_or_neither`). A Space with neither is admitted.

## Staging: the Space has no place (decided)

Read 2026-10-19 (`NEON_STAGING_URL`, inside `BEGIN TRANSACTION READ ONLY … ROLLBACK`): staging's one Space has
`postal_code`, `weather_lat` and `weather_lng` **all NULL**; prod's has all three. **Session decision, 2026-10-19
(recorded in V204):** amend rather than escape. A Space with no coordinates is a supported state today (staging's
Space, the harness D1 shape, any future owner before they set a place), and "every live Space has exactly one default
plot" must hold for it. So `plots.lat` and `lng` are NULLable with `CHECK ((lat IS NULL) = (lng IS NULL))`;
`postal_code` stays NULLable; `name`, `timezone`, `created_by` stay NOT NULL. DSA-35's positive control becomes: a plot
with one of `lat` / `lng` NULL raises 23514 (rehearsed both ways, insert and update).

On staging, Plot 1 is written with `lat`, `lng` and `postal_code` NULL. Confirmed read-only against staging's live
database on 2026-10-19: 0a's own step-0 block, run inside `BEGIN TRANSACTION READ ONLY … ROLLBACK`, passes (no
refusal), and all five pre gates return 0 rows (1 Space: no place, no half place, an owner, a name). The same read
through `garden_ro` on prod: step 0 passes, all five pre gates 0 rows.

## C-CONV pre-scan (V204 §2.8, widened)

Searched every `migrations/*/gates.yml` (153 files) for: the target relation (`plots`: 0 hits); gates naming `spaces`
(8 files); every post gate reading `pg_attribute`, `information_schema.columns`/`tables`, `pg_class`, `pg_trigger`,
`pg_constraint` or `pg_index` without a single-object filter, or with a closed-world `NOT IN` list (54 gates: those
whose scope can reach a new table are in the table below; the rest close over named tables other than plots, or
over shapes plots does not have, such as a SET NULL key inside an anchor CHECK); the audit writers by name (`audit_stmt_*`); foreign keys into spaces; RLS and grant gates; `prosrc` pins
(this file replaces no function, view or trigger body, so no definition pre-gate applies). Then the whole corpus ran
before and after 0a on the rehearsal, `--env prod` and `--env staging`.

**No existing gate changes its expected value, so no existing gate is edited and none must reach main by promote
before the sitting.** The gates the new table enters, each green before and after on the rehearsal:

| Gate | Why it is in scope | Expected value after 3.1 |
|---|---|---|
| `v5-spaceguard-001/gates.yml:387` `post_foreign_keys_into_spaces_are_single_column_on_id` (and pre `:114`) | every FK into spaces | 0 rows: `plots_workspace_id_fkey` is single-column on `spaces.id` |
| `v5-spaceguard-001/gates.yml:188` `post_spaces_has_no_other_trigger` | the new FK adds RI triggers on spaces | 0 rows: they are `tgisinternal`, filtered |
| `v5-spaceguard-001/gates.yml:157` `post_spaces_guard_and_audit_triggers_exact_and_enabled` | spaces triggers | 0 rows, unchanged |
| `v5-spaceguard-001/gates.yml:262` `post_audit_stmt_insert_only_on_after_insert_statement` | catalog-wide over `audit_stmt_insert` | 0 rows: `trg_audit_plots_ins` is tgtype 4 with `NEW TABLE AS new_rows` |
| `v5-platformoperators-001/gates.yml:316` `post_audited_tables_have_a_uuid_id` | catalog-wide over audited tables | 0 rows: `plots.id` is uuid NOT NULL |
| `v5-spacefk-001/gates.yml:261` `post_workspace_census_every_row_names_a_space` | catalog-wide over `workspace_id` columns | 0 rows: plots enters it; its FK guarantees it |
| `v4-cascadesweep-001/gates.yml:159` `post_no_cascade_onto_a_soft_deletable_table` | catalog-wide over CASCADE keys whose child has `deleted_at`; plots has it | 0 rows: plots' key into spaces is RESTRICT (a CASCADE there would red it) |
| `v5-wxcoldband-001/gates.yml:320-349` `post_no_trigger_and_no_row_security` | triggers on the weather tables | 0 rows: 3.1 adds none there (V204 §2.2 table) |
| `v5-wxcoldband-001/gates.yml:242` `post_exactly_one_fk_cascade_validated_to_spaces` | FKs of `weather_cold_range` | unchanged until 3.2a |
| `v4-weatherdaily-001/gates.yml:99` `post_no_extra_columns`, `v5-wxcoldband-001/gates.yml:179`, `:229`, `:282` | weather table shapes | unchanged until 3.2a (V204 §2.2 table) |

**Rehearsal set difference: newly red = {} and newly green = {}, on `--env prod` and on `--env staging`, on prod's
shape and again on staging's shape (the Space with no coordinates); 0 ERROR in any before-run (no FAULT).** The
non-gate consumer the pre-scan found, `src/__tests__/integrationCleanupTriggers.static.test.js`
(integration code may not lift a guard), now lists `plots` and its two guard functions.

**Later consumers of this file** (each step's own C-CONV will meet them):
- **3.2a:** replaces `guard_plots_repoint()` behind a definition pre-gate on its md5; its keys into plots are composite
  and RESTRICT; its 0r runs before this 0r (this 0r refuses while a key into plots exists).
- **3.7:** drops `spaces.weather_lat`, `weather_lng`, `postal_code`: it retires `post_default_plot_place_equals_space_place`
  and `pre_every_space_has_an_owner_and_both_coordinates_or_neither` in the same push (both name those columns).
- **Whoever adds `spaces.deleted_at`:** `post_every_live_space_has_exactly_one_live_default_plot` gains
  `AND s.deleted_at IS NULL`.
- **4.1 `createSpace`, 6.7's route:** make the default plot in the same transaction (the continuous gate reds
  otherwise). A Space made without a place gets a default plot with `lat` and `lng` NULL.
- **Harness uses (`scripts/space-harness/fixtures/*.json` and any `--b-sql`) that create a Space once 3.1 is on prod**
  must create its default plot in the same statement or transaction, as `scripts/test_space_harness_pg.py`'s `INDOOR`
  now does. The D1 use (`use.example-d1.json`, "one null-coordinate Space committed on B") does not yet: re-run after
  3.1, its B-side Space would have no plot and `post_every_live_space_has_exactly_one_live_default_plot` would red on
  the fork, and its `allowed_diffs` would need the plots row.
- **`tests/integration/_cleanup.js` (MF3):** not changed here. No `tests/integration` helper makes a plot: every
  integration Space is made without one, and `spaces_delete_guard` only refuses a Space that a plot names. The
  harness self-tests that now pair a Space with its plot run on databases they drop whole. The plots step (ahead of
  spaces) lands with the first integration helper that gives a test Space a plot (4.1 at the latest).

## Rehearsal

Local PostgreSQL 17.10 only (`initdb … -A trust --no-locale -E UTF8`, 127.0.0.1:55471). Replica: prod's
`pg_dump --schema-only --no-owner --no-privileges -n public -n gv -n extensions` (read-only, `garden_ro`), and as data
(`\copy` through `garden_ro`, loaded with `session_replication_role = replica`): prod's 187 `schema_version` rows,
`spaces` (1), `spacetheme` (1), `weather_daily` (162), `weather_cold_range` (6), and the `audit_events` rows of `spaces`
(1). Then:

```bash
python3 migrations/v5-plottier-001/rehearse_local.py --port 55471 --base-db base
```

**Result 2026-10-19, after the session's amendment: 138/138 PASS, exit 0** (113/113 on the first, NOT NULL shape).
Pre 5/5 on the base; C-CONV before: no ERROR on either env; 0a exit 0;
post 16/16 with the receipt; C-CONV newly red {} / newly green {} on prod and staging; C-AUDIT: INSERT with the actor,
watched UPDATE, unwatched `updated_at` silent, SOFT_DELETE, RESTORE, hard DELETE, multi-row INSERT (3 rows); the insert
audit gate red on a plot inserted with the audit off. C-GUARD on the real Space's Plot 1: lat, lng, postal_code → NULL,
postal_code, timezone and ON CONFLICT DO UPDATE each P0001; same-value SET and `name` pass; a non-default plot moves; a
plot becoming default while moving and a multi-row UPDATE naming Plot 1 refused; a Space with no weather moves, with
only `weather_daily` or only `weather_cold_range` refused; `DROP COLUMN lat` 2BP01; mutants `<>`, dropped cold-range
EXISTS, dropped default arm and dropped trigger each killed, each body mutant also red on the md5 gate. C-BLOCK: the
real Space refuses delete; a Space whose only child is a soft-deleted plot refuses naming plots, and deletes once the
plot goes first; a childless plot deletes; a 3.2a-shaped composite CASCADE key and a single-column CASCADE key each
refuse with the child kept; a NULL key does not block; TRUNCATE plots and TRUNCATE spaces CASCADE refused; the delete
and truncate guards dropped → CASCADE / TRUNCATE go through (killed). Shape: the CHECK mutants, a plot with `lat` NULL
and `lng` set, with `lng` NULL and `lat` set, and an UPDATE leaving only `lat`, each 23514; a plot losing both admitted;
NULL name, timezone, created_by each 23502; unknown Space 23503; a second live default 23505, a replacement beside a
soft-deleted default admitted. **A coordinate-less Space:** its default plot is admitted with `lat`, `lng`,
`postal_code` NULL, and the one-default, place, insert-audit, place-audit and zone gates are all green (NULL = NULL);
its plot given a place alone reds the place gate, the Space given the same place greens it; a coordinate-less default
plot given its first place while its Space has weather is P0001. **Positive controls, red then green:** a planted Space with no plot reds the one-default gate naming it,
a non-default plot does not satisfy it, its default plot greens it; Plot 1 soft-deleted reds it, a replacement greens
it; Plot 1 moved alone by the escape template reds the place gate while the audit gate stays green, the Space moved
with it greens it; the default flag moved to a plot elsewhere reds it; a move with every trigger off reds the audit
gate; an unknown zone reds the zone gate; any added plot makes the receipt false. Self-arm: with the stamp absent the
planted Space does not red, and `post_schema_version_recorded` reds. A gate-level red for each of 15 structural mutants
(an extra column, on two gates; a `timezone` default, `lat` NOT NULL, a dropped key, the CHECK dropped, the CHECK
weakened to one direction, the FK as CASCADE, the index without its `deleted_at` arm, the UPDATE audit on
`_no_soft_delete`, a disabled guard, an extra trigger, a DELETE audit without its transition table, a typo'd watched
column, RLS on with no policy). **Staging shape** (a clone with the Space's three columns set NULL, as on staging): every
pre gate PASS; the whole corpus before and after 0a on both envs, newly red {} and newly green {}, no ERROR; 0a exit 0;
Plot 1 has `lat`, `lng`, `postal_code` NULL, is the default, and carries the Space's name and owner; post gates 16/16
with the receipt; giving Plot 1 its first place under weather P0001. 0a refuses a name collision, and refuses naming
both Spaces when one has half a place and another no owner (the pre gate red alone), catalog unchanged each time. 0r refuses an added plot, a renamed Plot 1, a soft-deleted Plot 1 and a key into plots, nothing dropped
each time. 0r exit 0 with the catalog equal to the base and the audit rows kept; post gates vacuous again with no
42P01; 0r again a no-op. 0a after 0r, then twice more: exit 0, catalog and plot ids unchanged, catalog equal to the
first apply; post gates green with the receipt.

## The DDL sitting (V204 §2.8, §3)

- **Envs:** staging, then prod, one sitting with Dave's first-hand OK naming this migration and both envs. Staging's
  coordinate-less Space gets a coordinate-less Plot 1 ("Staging" above); 0a's step 0 and the pre gates pass on both
  envs' live data (read-only, 2026-10-19).
- **Before:** one prod safety copy for the day (`python3 scripts/neon_safety_branch.py --env-file .env.local create
  --slug ms2`) and `list` plus both fleet caps (`harness.py fleet`); today's restore-verify run finished (trigger DDL,
  until 2.0c lands); outside :55-:05 and 07:00-08:00 UTC.
- **Apply:** `gate_runner.py --migration migrations/v5-plottier-001 --env <env> --phase pre`, then
  `psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-plottier-001/0a-plots.sql`, then `--phase post` (the receipt
  included). Stamp `5.3.6-plottier-001`.
- **Step 0:** no existing gate is edited (above), so there is no tolerant gate that must be on main first; the latest
  gate-invariants run must be green. This directory's gates are vacuous before the apply and may be pushed before or
  after it; the house order pushes `migrations/**` after both envs carry the stamp.
- **Rollback:** `0r-rollback.sql` (after any later step's rollback that references plots, and before
  v5-spaceguard-001's 0r).

## Decisions

Taken by the session, 2026-10-19 (recorded in V204):
- `plots.lat` / `lng` NULLable with `plots_lat_lng_both_or_neither CHECK ((lat IS NULL) = (lng IS NULL))`;
  `postal_code` NULLable; `name`, `timezone`, `created_by` NOT NULL.
- `timezone`: the literal `'America/New_York'` for Plot 1 in 0a's `INSERT … SELECT` only, no column default: accepted.
- The stamp stays `5.3.6-plottier-001`.

Taken by this lane (engineering choices the plan does not state):
- `created_at`, `updated_at`: `NOT NULL DEFAULT now()` (the house shape of `spaces` and `platform_operators`; V204
  marks neither).
- `lat`, `lng`: `numeric`, the type of `spaces.weather_lat` / `weather_lng`, so the copy and the equality gate are exact.
- Plot 1's `name` is the Space's name and its `created_by` the Space's owner (both have a source; no literal).
- The guard also refuses a plot that *becomes* the default while moving, and reads the Space's weather under the old
  and the new `workspace_id`.
