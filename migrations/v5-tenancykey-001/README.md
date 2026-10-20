# v5-tenancykey-001: every Space-owned table names its Space

Multi-space Phase 2, step **2.1** (plan of record
`project-state/_multispace-20261015/multispace-prep-plan-V204-20261019.0900.md`, §2.1, §2.8, §3.0 and row 2.1).
Ledger: V5-SPACETENANCYKEY-001. Lane log: `project-state/_multispace-20261015/lanes-p2/2.1.log`.

The 22 tables the class file calls **S, needs key** gain `workspace_id uuid NOT NULL DEFAULT '…0001'` and a key
into `spaces` (ON DELETE RESTRICT, NOT VALID). The three that already carry the column (`treatment_association`,
`garden_shared_state`, `seen_event`) gain the key only. Step 2.3 validates the 25 keys after its all-row sweep.

## Files and stamps

One file per table, each one transaction, each writing one `schema_version` row. They are independent of one
another (each needs only `spaces` and `schema_version`) and run in this order. **Stamps are named for release
5.3.13; the session renames them if the release number differs** (`owner-classes.json` `stampPrefix`, then
`node generate.mjs --write`, then the VALUES blocks and `scripts/phase7-gate.json`).

| file | table | stamp |
|---|---|---|
| `01-locations.sql` | locations | `5.3.13-tenancykey-001-locations` |
| `02-photos.sql` | photos | `5.3.13-tenancykey-001-photos` |
| `03-inventory-items.sql` | inventory_items | `5.3.13-tenancykey-001-inventory-items` |
| `04-storage-location.sql` | storage_location | `5.3.13-tenancykey-001-storage-location` |
| `05-preservation-log.sql` | preservation_log | `5.3.13-tenancykey-001-preservation-log` |
| `06-kitchen-batch.sql` | kitchen_batch | `5.3.13-tenancykey-001-kitchen-batch` |
| `07-pantry-item.sql` | pantry_item | `5.3.13-tenancykey-001-pantry-item` |
| `08-recipe.sql` | recipe | `5.3.13-tenancykey-001-recipe` |
| `09-tag.sql` | tag | `5.3.13-tenancykey-001-tag` |
| `10-critter-state.sql` | critter_state | `5.3.13-tenancykey-001-critter-state` |
| `11-findings.sql` | findings | `5.3.13-tenancykey-001-findings` |
| `12-tasks.sql` | tasks | `5.3.13-tenancykey-001-tasks` |
| `13-event-batches.sql` | event_batches | `5.3.13-tenancykey-001-event-batches` |
| `14-daily-plan.sql` | daily_plan | `5.3.13-tenancykey-001-daily-plan` |
| `15-favorites.sql` | favorites | `5.3.13-tenancykey-001-favorites` |
| `16-voice-alias.sql` | voice_alias | `5.3.13-tenancykey-001-voice-alias` |
| `17-proj-rescope-events.sql` | proj_rescope_events | `5.3.13-tenancykey-001-proj-rescope-events` |
| `18-weather-cue-impression.sql` | weather_cue_impression | `5.3.13-tenancykey-001-weather-cue-impression` |
| `19-cultivar-weight-sample.sql` | cultivar_weight_sample | `5.3.13-tenancykey-001-cultivar-weight-sample` |
| `20-cultivar-weight-void.sql` | cultivar_weight_void | `5.3.13-tenancykey-001-cultivar-weight-void` |
| `21-source.sql` | source (+ its audit trigger, below) | `5.3.13-tenancykey-001-source` |
| `22-slug-redirects.sql` | slug_redirects | `5.3.13-tenancykey-001-slug-redirects` |
| `23-fk-treatment-association.sql` | treatment_association (key only) | `5.3.13-tenancykey-001-fk-treatment-association` |
| `24-fk-garden-shared-state.sql` | garden_shared_state (key only) | `5.3.13-tenancykey-001-fk-garden-shared-state` |
| `25-fk-seen-event.sql` | seen_event (key only) | `5.3.13-tenancykey-001-fk-seen-event` |
| `0r-rollback.sql` | all, in reverse | deletes the stamps it undoes |

Also here: `owner-classes.json` (the one source), `generate.mjs` (writes the 25 files from it),
`tenancykey.test.js` (holds them, the VALUES blocks and the class file together), `gates.yml`,
`rehearse_local.py` + `rehearse_seed.sql` (local PostgreSQL 17 only). The runner is
`scripts/tenancykey-apply.py` (tested by `scripts/test_tenancykey_apply.py`).

**The SQL files are generated. Never edit one by hand:** edit `owner-classes.json` (or `generate.mjs`), run
`node migrations/v5-tenancykey-001/generate.mjs --write`, and `npx vitest run migrations/v5-tenancykey-001` must be
green. `node generate.mjs --values` prints the rows for the marked VALUES blocks in `gates.yml` and `0r-rollback.sql`.

## In plain words

Every planting and container already says which Space (household) it belongs to. Photos, locations, seed lots,
jars, recipes, tags, favourites, the daily plan and the rest do not yet. This step gives each of those rows a Space
column. There is one Space today, so every existing row gets it, and every row written afterwards gets it too
until the code learns to name it (steps 2.2 and 4.3). Nobody sees a difference. Nothing is copied or rewritten:
PostgreSQL records the value once in the catalog and every existing row reads it from there.

Before it adds the column, each file checks who owns the table's rows. Every owner must be someone or something
we already know (Dave, Jen, the system accounts, the data-import pipelines). If an owner we have never classified
turns up, the file stops and names it, and nothing changes. That is the point of the step: once rows carry a
Space, an unknown owner would silently be filed into Dave's Space.

## Owner classes (`owner-classes.json`)

Read-only census of prod and staging, 2026-10-20 ~14:00Z (all rows, soft-deleted included; lane log has the
counts). Each class has a reason in the file; `envs` says which section it is in.

| class | match | prod | staging | where it owns rows today |
|---|---|---|---|---|
| Dave | his Clerk sub (= `spaces.created_by`) | yes | yes | every table with rows |
| Jen | her Clerk sub (prod `user_notification_prefs` = {Dave, Jen}) | yes | yes | prod critter_state 5, daily_plan 124, event_batches 6, favorites 34 |
| `system` | exact (also the first managed principal) | yes | yes | tag (owner_id all, created_by 164), source 54 |
| `SYSTEM_CLERK_SUB` | exact (`daily-plan/handler.js` default) | yes | yes | none today |
| Dave's dev-Clerk sub | exact | yes | yes | prod 2 soft-deleted locations; staging cws 2, favorites 10, inventory 2, locations 2, photos 8, source 1 |
| managed principals | `rescue-intake-%`, `data-audit-%`, `data-correction-%` (`varieties/authz.js` MANAGED_PRINCIPAL_PATTERNS) | yes | yes | prod tag.created_by `rescue-intake-longriver-20260712` 8 |
| pipeline labels | `cal1-seed`, `migration:v4-harvweightest-001`, `res008-backfill`, `agent:mainsync13-20260928` (recon B §3 #5) | yes | yes | prod cultivar_weight_sample 9 + 4, cultivar_weight_void 4 + 3 + 1 |
| integration fixtures | `%int-test-%` (`_harness.js` testRunId) | **no** | yes | none today |
| NULL | owner IS NULL | **no** | **locations only** | staging locations 11 |

Owner columns: `created_by` (locations, photos, critter_state, tasks, event_batches, cultivar_weight_sample,
cultivar_weight_void, source); `user_id` (storage_location, preservation_log, kitchen_batch, pantry_item, recipe,
daily_plan, favorites, voice_alias, weather_cue_impression); **two** for `inventory_items` (user_id, created_by) and
`tag` (owner_id, created_by); `actor` for proj_rescope_events. **Parent joins:** `findings` through
`garden_node_id` → `plants.created_by`; `slug_redirects` through its target (`project` → plant_projects, `variety`
→ plant_varieties, `planting` → plants; an `archived` or missing target has no owner and refuses). LIKE patterns
escape `_` as `\_` (none of today's patterns contains one; the test reds an unescaped `_`).

## How a file learns its env

`psql -v env=prod|staging` (the runner passes it). The file's first statement is
`SELECT set_config('tenancykey.env', :'env', true)`: with no `-v env`, psql cannot parse it and nothing runs. The
guard then refuses any value but `prod` or `staging`, and refuses a database that does not carry that env's
**fingerprint**: a `schema_version` stamp only that env has, and the absence of one only the other has
(`4.0.0-pot-001` prod-only, `4.23.9-cascadesweep-001-rollback` staging-only; read 2026-10-20). So a wrong or missing
env aborts; nothing defaults. A rehearsal copy of prod carries prod's stamps and so reads as prod.

## Sitting

Dave's first-hand OK names this directory and both envs. One sitting, staging then prod, same day.

0. **Read 45, the owner census re-run (read only):** `python3 scripts/tenancykey-apply.py --env staging --dry-run`
   and `--env prod --dry-run`. Inside `BEGIN TRANSACTION READ ONLY` it runs each pending file's own guard (env,
   fingerprint, owner pre-gate) and prints PASS or REFUSED per file. Every file PASS on both, or stop: a REFUSED
   names the owner value to classify (owner-classes.json, with its reason, regenerate, review, ship) before the
   sitting. Also confirm: main carries this directory's tolerant gate edits and the latest gate-invariants run is
   green (§3.0); `neon_safety_branch.py list` and both fleet caps (`harness.py fleet`) are read.
1. **Prod safety copy first:** `python3 scripts/neon_safety_branch.py --env-file .env.local create --slug ms2`.
2. **Timing:** outside :58-:02 of any hour and outside 07:00-08:00 UTC (the runner refuses inside them, before each
   file too). Every file sets `lock_timeout = '5s'`; a lock wait fails fast (55P03) having changed nothing, and a
   re-run resumes there. 2.0c has landed (`eec5b723`), so the trigger re-create in file 21 needs no restore-verify
   timing; it keeps the trigger's name, type and function, so the dump-time trigger list still matches.

```bash
# --- staging ------------------------------------------------------------------------------------------------
python3 scripts/gate_runner.py --all --env staging --phase post --continuous-only --json > before-staging.json
python3 scripts/gate_runner.py --migration migrations/v5-tenancykey-001 --env staging --phase pre
python3 scripts/tenancykey-apply.py --env staging            # stops at the first refusal; re-run resumes there
python3 scripts/gate_runner.py --migration migrations/v5-tenancykey-001 --env staging --phase post
python3 scripts/gate_runner.py --all --env staging --phase post --continuous-only --json > after-staging.json
# newly red (red in after, not in before) must be the empty set

# --- prod (Dave's first-hand OK; after the safety copy) -------------------------------------------------------
python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only --json > before-prod.json
python3 scripts/gate_runner.py --migration migrations/v5-tenancykey-001 --env prod --phase pre
python3 scripts/tenancykey-apply.py --env prod --i-have-daves-ok
python3 scripts/gate_runner.py --migration migrations/v5-tenancykey-001 --env prod --phase post
python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only --json > after-prod.json
```

3. **gam-site, right after the prod DDL** (separate repo, its own push): in `public-export.yaml` add
   `workspace_id` under `excluded:` for the four export sources that gain it, `locations` (`:531`), `photos`
   (`:897`), `inventory_items` (`:971`) and `source` (`:1082`), reason "tenancy key; internal". Then
   `tools/gates.py` gate1 must print ok for each. Order matters: classifying the column before it exists is a
   phantom FAIL that stops the publish; between the DDL and the edit gate1 reports it PENDING (its name matches
   no row-filter stem), which does not stop a publish. (`plant_varieties` `:691`/`:820` gain theirs at 2.4a.)
4. **Push B, after the prod DDL** (prepared on branch `ms2/21-post`): the class file's 22 rows move to
   `S has key` on `workspace_id`, the catalog snapshot is regenerated from prod, and the six VALUES blocks with it.
   Its README section "After the sitting" has the exact commands. Until push B lands, CI stays green: nothing in
   CI reads the live catalog against the class file, and the snapshot it reads is the committed one.
5. **integration-test.yml on a dev SHA after the staging DDL** must be green with FIXTURE LEAK 0 (its throwaway
   branch is cut from staging, so it is the first CI run that sees the columns; `_cleanup.js` below).

`scripts/check-staging-drift.py` reports the 25 keys as staging-only constraints between the staging and the prod
apply (advisory; it exits 0). The sitting closes that window the same day.

## What it locks (rehearsed, PostgreSQL 17)

| file | held to COMMIT |
|---|---|
| 01-22 | ACCESS EXCLUSIVE on the table (taken first, so the owner census and the DDL see the same rows; one scan of at most ~2.3k rows on prod), SHARE ROW EXCLUSIVE on `spaces` (the key). Catalog changes only: no rewrite, no validation scan |
| 21 | as above, plus DROP/CREATE of `trg_audit_source_upd` on `source` (already locked) |
| 23-25 | SHARE ROW EXCLUSIVE on the table (writers wait, readers do not) and on `spaces` |
| 0r | ACCESS EXCLUSIVE on each table touched and on `spaces` (dropping a key removes its RI triggers there) |

## No row rewrite

A constant DEFAULT is stored once (`pg_attribute.atthasmissing`, `attmissingval`) and every existing row reads it.
Rehearsed: `pg_relation_filenode` of all 22 unchanged across the files and `atthasmissing = true` for every new
`workspace_id`; the control `ADD COLUMN zz uuid DEFAULT gen_random_uuid()` on `tag` changed its filenode
(17790 → 25514) with `atthasmissing = false`.

## The source audit trigger (file 21)

`v5-sourceentity-001/gates.yml:380` (`post_audit_update_watches_every_mutable_column`) requires every `source`
column except `id`, `match_key` and `updated_at` in `trg_audit_source_upd`'s watched list. **Chosen: the watched
list gains `workspace_id`** (not a gate exclusion). Why: the column is mutable (a later Space move writes it), and a
Space move of a source row with no audit row is exactly the invisible failure that gate exists to prevent;
`v5-sourcecontact-001` set the precedent for this trigger. The list is the trigger's arguments, so file 21 drops
and re-creates it in the same transaction as the column, same shape, the eleven names in order plus
`workspace_id`, behind a **definition pre-gate**: the md5 of the trigger's catalog fingerprint (type, enabled,
function, transition tables, arguments; search_path-independent) must be `6680e278331fbcc28bbb5242b10a2f35`, read
identical on prod and staging 2026-10-20, else the file refuses. After the re-create it must be
`109d579db13a5f4b329bf2b60dd3c1d4`. The gate stays as written and stays green; the rehearsal shows it red with the
re-create left out of file 21. `preservation_log`'s audit trigger is not touched (its watched list is pinned exact
by `v5-fermentpath-001:410`; it is not a "watch every column" gate). A later step that writes `workspace_id` on
existing rows (a Space move) adds it to that list in its own push.

## C-CONV pre-scan (§2.8, widened)

Scanned every `migrations/*/gates.yml` (157 files, 2048 gates at this commit): each of the 25 table names,
`workspace_id`, catalog-wide shapes (`pg_attribute` / `information_schema.columns` / `pg_constraint` /
`pg_trigger` / `pg_attrdef` with no relname filter), FK count or shape gates on these tables or on `spaces`,
`prosrc` / `pg_get_*def` / `md5` pins, trigger gates on these tables, row-image shapes (`to_jsonb(t)`,
`row_to_json`, `EXCEPT`, `SELECT *`). Each closed-world or exact-list gate found was read in full.

**Edited in this push, tolerant (green before and after; tighter on the step's stamp):**

| gate (base line) | before | after the stamp | tightened arm |
|---|---|---|---|
| `ops-cueinstrument-001/gates.yml:92` `post_no_extra_columns` (continuous) | 0 | 0 | `workspace_id` allowed only with stamp `…-weather-cue-impression`, and required with it ("missing" arm); any other column still reds |
| `ops-cueinstrument-001/gates.yml:192` `post_no_foreign_keys` (continuous; now catalog joins, no `::regclass`) | 0 | 0 | only `weather_cue_impression_workspace_id_fkey` in exactly the C-BLOCK shape, only with the stamp, and required with it |
| `v5-kbownertrigger-001/gates.yml:300` `post_no_frozen_gate_moved` (continuous: false) | 0 | 0 | with stamp `…-kitchen-batch`, `workspace_id` is left out of both counts (the view names its columns, so it does not carry the new one; a later view rewrite that appends it stays green) and must exist on `kitchen_batch` |

The row's premise for `:300` is right that the gate reds, for a slightly different reason: the view's count does
not rise (it lists its columns); the table's does (33 → 34 against the view's 41).

**Kept green by the file, not edited:** `v5-sourceentity-001/gates.yml:380` (above), expected 0.

**Read in full, unchanged (expected value as today):**
- `v5-spaceguard-001/gates.yml:387` FKs into spaces single-column on id: 0 (the 25 keys are).
- `v5-spacefk-001/gates.yml:261` every `workspace_id` row names a Space (catalog walk): 0; it now reads the 22 too,
  all `…0001`. `:283` covers the seven: 0. `:182`, `:206` (plants, plant_projects only): 0.
- `v4-cascadesweep-001/gates.yml:159` no CASCADE onto a soft-deletable table: 0 (RESTRICT, and spaces has no
  `deleted_at`). `v4-evtanchordel-001/gates.yml:102`, `v4-parentprojfk-001/gates.yml:194` (SET NULL): 0.
- `v5-fermentpath-001/gates.yml:410`, `v5-putupmake-001/gates.yml:611` (preservation_log's exact watched list): 0,
  that trigger is not touched. `v5-sourcecontact-001/gates.yml:143`, `:160` (per-name watched), `:182` and
  `v5-sourceentity-001/gates.yml:355` (trigger shape regex): 0 after file 21.
- `v5-tenantgates-001/gates.yml:207` `post_sentinel_callers` (`prosrc` callers): unchanged; the DEFAULT is a
  literal, no new caller.
- `v5-tenancyclasses-001/gates.yml:192` relkind closed world: 0 (no relation added). `v5-tenancykeys-001/gates.yml:226`
  unique indexes carry workspace: 0 (no index added).
- `v5-invrefstrand-001/gates.yml:105`, `:136`, `v5-seedmultiparent-001/gates.yml:415`,
  `v5-seedlotaddition-001/gates.yml:145`: FKs INTO inventory_items / the link table; this step's key goes out.
- `v4-weatherdaily-001/gates.yml:216`, `v5-wxcoldband-001/gates.yml:288`: the weather tables' own keys.
- Positive lists (`v5-pantry-001:111`, `v5-recipes-001:92`, `:133`, `v5-voicealias-001:83`,
  `v5-sourceentity-001:208`, `:466`, `v5-sourcecontact-001:107`, `ops-cueinstrument-001:82`): unchanged.
- Trigger gates on these tables or on `spaces`: the keys add internal RI triggers to the 25 tables and to
  `spaces`; every trigger gate there filters `NOT tgisinternal` or names its trigger.
- Row images: `v5-sourcekind-001:90` and `v5-sourceentity-001:171` read keys out of `row_to_json(t)`; a new key
  changes nothing they read.

**Pre-phase receipts that would red if re-run (not in any `--phase post` run; left as they are):**
`v5-kbownertrigger-001:140` `pre_no_frozen_gate_moves` (the `:300` pair's apply-window half),
`v5-phrecord-001:87` and `v4-putupsession-001:87` (both already red today: 41 ≠ 33 + 6, 43 ≠ 23).

**Positive control (rehearsal E):** before/after the 25 files, `gate_runner.py --all --phase post --json`:
newly red = ∅ and newly green = ∅ with this tree's gates (prod and staging shapes); with the three edits reverted,
newly red = exactly {cue `post_no_extra_columns`, cue `post_no_foreign_keys`, kb `post_no_frozen_gate_moved`};
file 21 without the trigger re-create reds `v5-sourceentity-001:380`. Before-run ERRORs: none on the prod shape;
on the staging shape one pre-existing FAULT, `v4-harvbasis-sample-001` `post_no_measured_weight_was_ever_overwritten`
(42P01: its dated snapshot table exists on prod only; continuous: false; ERROR before and after).

## Arming census (§3.0, DSA-25): every deployed writer still succeeds

*Would the currently deployed code write a row these keys reject, or does the new column break a statement?* No.

- **Lambda** (2.0a census, 801 statements): 31 INSERTs, 91 UPDATEs, 3 DELETEs into the 25 tables. Every INSERT
  names its columns; none names `workspace_id` on the 22, so each takes the DEFAULT (a Space). The three
  `garden_shared_state` writers (`events/critterAward.js:33`, `shared-state/index.js:123`, `:166`) write the literal
  one Space, a row of `spaces` on both envs and on CI's branches. No UPDATE writes `workspace_id`; every existing
  row carries `…0001`, so an UPDATE that re-checks the key (the same-transaction case) passes.

  | table | INSERT (lambda/) | UPDATEs | DELETEs |
  |---|---|---|---|
  | critter_state | events/critterAward.js:192 | 4 | 0 |
  | daily_plan | daily-plan/handler.js:2264 | 1 | 0 |
  | event_batches | events/index.js:596 | 1 | 0 |
  | favorites | favorites/index.js:83 | 1 | 2 |
  | findings | findings/materialize.js:38 | 2 | 1 |
  | garden_shared_state | events/critterAward.js:33, shared-state/index.js:123, :166 (literal one Space) | 0 | 0 |
  | inventory_items | inventory-items/index.js:2464 | 16 | 0 |
  | kitchen_batch | preservation/batchBuilderRoutes.js:105, preservation/kitchenRoutes.js:535 | 11 | 0 |
  | locations | locations/index.js:472 | 7 | 0 |
  | pantry_item | preservation/pantryRoutes.js:209 | 3 | 0 |
  | photos | photos/index.js:221, :260 | 8 | 0 |
  | preservation_log | preservation/index.js:764, preservation/kitchenRoutes.js:1463 | 22 | 0 |
  | proj_rescope_events | projects/index.js:646 | 0 | 0 |
  | recipe | preservation/recipeRoutes.js:220, :374 | 2 | 0 |
  | seen_event | plants/index.js:614 | 1 | 0 |
  | source | varieties/index.js:431 | 2 | 0 |
  | storage_location | preservation/jarRoutes.js:463, kitchenRoutes.js:1463, pantryRoutes.js:209, storage-location/index.js:325 | 2 | 0 |
  | tag | tags/crop-derive.js:247, tags/index.js:213, varieties/crop-derive.js:247 | 6 | 0 |
  | treatment_association | none | 1 | 0 |
  | voice_alias | varieties/index.js:838 | 1 | 0 |
  | weather_cue_impression | daily-plan-read/cue-impression.js:113 | 0 | 0 |

  (Line numbers are each statement's first line at this commit.)
- **DB functions** (`prosrc`, public and gv, read on prod 2026-10-20): `record_harvest_weight_sample` (INSERT
  cultivar_weight_sample, column list), `reattribute_plant_weight_samples` (INSERT cultivar_weight_sample and
  cultivar_weight_void, column lists), `void_event_weight_samples` (INSERT cultivar_weight_void, column list),
  `archive_container_events`,
  `archive_plant_events`, `unarchive_events_apply` (UPDATE photos, named columns; the photo archive keeps a
  four-key jsonb pre-image). No function returns or declares a row type of these tables. No event trigger exists.
- **Scripts:** `scripts/_tagsub_cow_runner.mjs:66`, `_tagsub_cow_runner2.mjs:23` (INSERT tag, column list).
- **Positional copies: none.** No `INSERT INTO <one of the 25> SELECT|TABLE|VALUES` without a column list, no
  `COPY` of them without one, in `migrations/**/*.sql`, `scripts/**`, `lambda/**`, `tests/smoke`, or the
  workflows (scan of 837 files); no `SELECT *` / `t.*` feeding an INSERT into them; no row-constructor comparison
  over them (the one `old.* IS DISTINCT FROM new.*` trigger is on `garden_shared_state`, whose columns do not
  change). Views name their columns (PostgreSQL expands `*` at CREATE), so no view grows; the one gate that counts
  a view against its table is `v5-kbownertrigger-001:300`, edited above. The `jsonb_populate_record(...).*`
  restores in `unarchive_events_apply` target event_log / harvest_log, not these tables.
- **Rehearsal G:** a deployed-shape INSERT (named columns, no `workspace_id`) into each of the 25 succeeds with the
  key enforced and lands on the one Space; an INSERT naming a non-Space raises 23503; two UPDATEs of one photo in
  one transaction succeed; every one of the 801 census statements PREPAREs after the files exactly as before
  (798 prepare in both; the 3 that do not are census splice placeholders and a try/caught column, the same before).

## tests/integration/_cleanup.js (§3.0 MF3)

No integration fixture writes `workspace_id` into any of the 25 tables (the column does not exist before this
step, and no deployed writer names it after), so no fixture row names a test Space and today's teardown deletes
the same rows. But two swept tables, `storage_location` and `event_batches`, sat **after** the `spaces` step, and
with these keys they are tables with a foreign key to `spaces`, which MF3 puts ahead of it. Both moved ahead of the
weather/theme/spaces block (a reorder only; their children `pantry_item`, `preservation_log`, `kitchen_stage_log` are
swept earlier). Rehearsal J: with a fixture Space named by one row in each, the base order leaves the Space behind
(`spaces_delete_guard` refuses it) and the new order sweeps it. Tables of the 25 the sweep does not touch (tag,
voice_alias, daily_plan, weather_cue_impression, source, slug_redirects, garden_shared_state,
treatment_association) keep the DEFAULT Space and never name a test Space. The suite cannot run locally (its
driver is Neon's HTTP `neon()`); CI must show `integration-test.yml` green with FIXTURE LEAK 0 on a dev SHA after
the staging DDL.

## Rollback

`0r-rollback.sql`, one transaction, the directory in reverse, as far as the stamps say it went: drop each key; put
`trg_audit_source_upd` back to its eleven names (only over file 21's definition); drop each of the 22 columns;
delete the stamps. **Destructive** (DROP COLUMN): it is for the window before any code names these columns. It
refuses, changing nothing, if any row names a Space other than the one (a later writer stamped it), if a column or
key exists without its stamp, or if the source trigger is neither file 21's definition nor the one it replaced. No
CASCADE: an object that depends on a column makes it fail whole. Run 2.3's rollback first if 2.3 has run. A second
run is a no-op.

## Gates

* `pre` (receipts, continuous: false): the one Space exists; no workspace_id column on the 22 yet; no key yet; the
  three key-only tables' rows all name a Space.
* `post`, each row armed on its own table's exact stamp: `post_tenancykey_column_shape` (uuid, NOT NULL, DEFAULT
  `'…0001'::uuid`); `post_tenancykey_key_shape` (exactly one key on workspace_id: `<table>_workspace_id_fkey`,
  single column to `spaces(id)`, RESTRICT; validated or not is 2.3's to assert); armed on the object:
  `post_tenancykey_objects_have_their_stamps`.

## For the steps after this one

* **2.3** validates the 25 keys after an all-row sweep (no `deleted_at` filter) and arms its own `convalidated`
  gate on its stamp; nothing here asserts NOT VALID, so 2.3 edits no gate here.
* **2.2 / 4.3** writers that name `workspace_id`: the arming census above is the list to move; `_cleanup.js` already
  sweeps the two keyed tables before spaces.
* **Phase 5's "no Dave defaults"** drops these 22 DEFAULTs once every writer names the column; it edits
  `post_tenancykey_column_shape` in that push.
* A **Space move** writer adds `workspace_id` to `preservation_log`'s audit list (and edits the two exact-list
  gates there).

## Rehearsal (local PostgreSQL 17 only)

Build two databases in a throwaway cluster (scratch directory, `initdb -U postgres -A trust`, a free port, listen on
127.0.0.1 only), every Neon read made read-only (`PGOPTIONS=-c default_transaction_read_only=on`, URL by key name):

* `base_prod`: `CREATE SCHEMA extensions; CREATE EXTENSION "uuid-ossp" SCHEMA extensions; CREATE EXTENSION
  pgcrypto SCHEMA extensions;`, then prod's `pg_dump --schema-only --no-owner --no-privileges -n public -n gv -n
  extensions` (its `CREATE SCHEMA extensions/public` lines removed), then prod's `spaces`, `schema_version`,
  `spacetheme` and `plots` rows (`pg_dump --data-only -t ...`, loaded with `session_replication_role=replica`), then
  `rehearse_seed.sql` (same role).
* `base_staging`: the extensions as above, then a full `pg_dump --no-owner --no-privileges -n public -n gv -n
  extensions` of staging (replica role).

`python3 migrations/v5-tenancykey-001/rehearse_local.py --port <port> --base-prod base_prod --base-staging
base_staging` runs sections A-J (its docstring) on clones and prints PASS/FAIL per check. Run on 2026-10-20: see
the lane log for the full output.
