# v5-tenancyvalidate-001: the 25 Space keys are validated

Multi-space Phase 2, step **2.3** (plan of record
`project-state/_multispace-20261015/multispace-prep-plan-V204-20261019.0900.md`, §3.0 and row 2.3: "VALIDATE each 2.1
FK after the all-row sweep (no `deleted_at` filter) | post-deploy arm | sweep = 0; 23503 on an unknown uuid on the
rehearsal"). Ledger: V5-SPACETENANCYKEY-001. Lane log: `project-state/_multispace-20261015/lanes-p2/2.3.log`.

Step 2.1 (`v5-tenancykey-001`, applied on staging and prod) gave 25 tables a key `<table>_workspace_id_fkey` into
`spaces` (ON DELETE RESTRICT) **NOT VALID**: every new or updated row has been checked since, the rows already there
were not. This step sweeps every row of each table and then validates the key, so the catalog says what is true:
every row of the 25 names a Space.

## Files and stamps

One file per key, each one transaction, each writing one `schema_version` row. File NN validates the key that
`v5-tenancykey-001` file NN added. **Stamps are named for release 5.3.14; the session renames them if the release
number differs** (`STAMP_PREFIX` in `generate.mjs`, then `node generate.mjs --write`, the VALUES blocks from
`--values`, and `scripts/phase7-gate.json` G1 "2.3"; `validate.test.js` reds on any one left behind).

| file | key | 2.1 stamp it needs | stamp |
|---|---|---|---|
| `01-locations.sql` | locations_workspace_id_fkey | `5.3.13-tenancykey-001-locations` | `5.3.14-tenancyvalidate-001-locations` |
| `02-photos.sql` | photos_workspace_id_fkey | `5.3.13-tenancykey-001-photos` | `5.3.14-tenancyvalidate-001-photos` |
| `03-inventory-items.sql` | inventory_items_workspace_id_fkey | `5.3.13-tenancykey-001-inventory-items` | `5.3.14-tenancyvalidate-001-inventory-items` |
| `04-storage-location.sql` | storage_location_workspace_id_fkey | `5.3.13-tenancykey-001-storage-location` | `5.3.14-tenancyvalidate-001-storage-location` |
| `05-preservation-log.sql` | preservation_log_workspace_id_fkey | `5.3.13-tenancykey-001-preservation-log` | `5.3.14-tenancyvalidate-001-preservation-log` |
| `06-kitchen-batch.sql` | kitchen_batch_workspace_id_fkey | `5.3.13-tenancykey-001-kitchen-batch` | `5.3.14-tenancyvalidate-001-kitchen-batch` |
| `07-pantry-item.sql` | pantry_item_workspace_id_fkey | `5.3.13-tenancykey-001-pantry-item` | `5.3.14-tenancyvalidate-001-pantry-item` |
| `08-recipe.sql` | recipe_workspace_id_fkey | `5.3.13-tenancykey-001-recipe` | `5.3.14-tenancyvalidate-001-recipe` |
| `09-tag.sql` | tag_workspace_id_fkey | `5.3.13-tenancykey-001-tag` | `5.3.14-tenancyvalidate-001-tag` |
| `10-critter-state.sql` | critter_state_workspace_id_fkey | `5.3.13-tenancykey-001-critter-state` | `5.3.14-tenancyvalidate-001-critter-state` |
| `11-findings.sql` | findings_workspace_id_fkey | `5.3.13-tenancykey-001-findings` | `5.3.14-tenancyvalidate-001-findings` |
| `12-tasks.sql` | tasks_workspace_id_fkey | `5.3.13-tenancykey-001-tasks` | `5.3.14-tenancyvalidate-001-tasks` |
| `13-event-batches.sql` | event_batches_workspace_id_fkey | `5.3.13-tenancykey-001-event-batches` | `5.3.14-tenancyvalidate-001-event-batches` |
| `14-daily-plan.sql` | daily_plan_workspace_id_fkey | `5.3.13-tenancykey-001-daily-plan` | `5.3.14-tenancyvalidate-001-daily-plan` |
| `15-favorites.sql` | favorites_workspace_id_fkey | `5.3.13-tenancykey-001-favorites` | `5.3.14-tenancyvalidate-001-favorites` |
| `16-voice-alias.sql` | voice_alias_workspace_id_fkey | `5.3.13-tenancykey-001-voice-alias` | `5.3.14-tenancyvalidate-001-voice-alias` |
| `17-proj-rescope-events.sql` | proj_rescope_events_workspace_id_fkey | `5.3.13-tenancykey-001-proj-rescope-events` | `5.3.14-tenancyvalidate-001-proj-rescope-events` |
| `18-weather-cue-impression.sql` | weather_cue_impression_workspace_id_fkey | `5.3.13-tenancykey-001-weather-cue-impression` | `5.3.14-tenancyvalidate-001-weather-cue-impression` |
| `19-cultivar-weight-sample.sql` | cultivar_weight_sample_workspace_id_fkey | `5.3.13-tenancykey-001-cultivar-weight-sample` | `5.3.14-tenancyvalidate-001-cultivar-weight-sample` |
| `20-cultivar-weight-void.sql` | cultivar_weight_void_workspace_id_fkey | `5.3.13-tenancykey-001-cultivar-weight-void` | `5.3.14-tenancyvalidate-001-cultivar-weight-void` |
| `21-source.sql` | source_workspace_id_fkey | `5.3.13-tenancykey-001-source` | `5.3.14-tenancyvalidate-001-source` |
| `22-slug-redirects.sql` | slug_redirects_workspace_id_fkey | `5.3.13-tenancykey-001-slug-redirects` | `5.3.14-tenancyvalidate-001-slug-redirects` |
| `23-treatment-association.sql` | treatment_association_workspace_id_fkey | `5.3.13-tenancykey-001-fk-treatment-association` | `5.3.14-tenancyvalidate-001-treatment-association` |
| `24-garden-shared-state.sql` | garden_shared_state_workspace_id_fkey | `5.3.13-tenancykey-001-fk-garden-shared-state` | `5.3.14-tenancyvalidate-001-garden-shared-state` |
| `25-seen-event.sql` | seen_event_workspace_id_fkey | `5.3.13-tenancykey-001-fk-seen-event` | `5.3.14-tenancyvalidate-001-seen-event` |
| `0r-rollback.sql` | all, in reverse | | deletes the stamps it undoes |

Also here: `generate.mjs` (writes the 25 files; the table list, the order and the env fingerprints come from
`../v5-tenancykey-001/owner-classes.json`), `validate.test.js` (holds the files, the VALUES blocks, the rollback's
comment and `phase7-gate.json` G1 together), `gates.yml`, `rehearse_local.py` (local PostgreSQL 17 only). The runner
is `scripts/tenancykey-apply.py --dir v5-tenancyvalidate-001` (2.1's runner, extended; tested by
`scripts/test_tenancykey_apply.py`). **The SQL files are generated. Never edit one by hand.**

## In plain words

Step 2.1 told the database that every row of these 25 tables belongs to a Space, but asked it to check only new
rows. This step has the database check the old ones too, after first counting, row by row, any that name no
Space (soft-deleted rows included). There are none on prod or staging (read 2026-10-22). Nobody sees a difference:
the check on new rows was already on.

## What each file does (one transaction)

0. `LOCK <table> IN SHARE UPDATE EXCLUSIVE MODE` and `LOCK spaces IN ROW SHARE MODE`: the two locks VALIDATE itself
   takes, taken first so the sweep runs under them. Reads and writes of both tables go on throughout.
1. **The guard** (`$pregate$`, read-only; the runner's `--dry-run` runs it alone): the env and the database's
   fingerprint (2.1's mechanism: `psql -v env=prod|staging`, a prod-only and a staging-only `schema_version` stamp);
   2.1's stamp for this table present; the key present in 2.1's shape (workspace_id alone → `public.spaces(id)`,
   ON DELETE RESTRICT) and still NOT VALID; then **the all-row sweep**, no `deleted_at` filter (Migration Authoring
   Rule, L-058):
   * rows whose `workspace_id` names no row of `spaces` (these are what VALIDATE would refuse with 23503);
   * rows whose `workspace_id` IS NULL, **counted separately**: a MATCH SIMPLE key passes a NULL, so VALIDATE alone
     would not see one, and a validated key must mean every row names a Space. (Every one of the 25 columns is
     NOT NULL today, so this count is 0 by construction; it is counted, not assumed.)

   Either count above 0 refuses, naming both counts and up to five of the values; nothing changes.
2. `ALTER TABLE … VALIDATE CONSTRAINT …`, timed (a NOTICE gives the milliseconds), and `convalidated` read back.
3. The key's comment now says it is validated; the stamp.

A write that arrives between the sweep and VALIDATE is checked by the key itself (NOT VALID keys check new rows),
so it cannot add a row naming no Space. A re-run with the stamp present changes nothing; a validated key without
the stamp refuses (something else validated it).

## The arming check (§3.0, gardening-deploy.md "Falsifiable test")

*Would the currently deployed code produce a row that violates a validated key?* **No**, and the answer does not
depend on which code is deployed: VALIDATE adds no check a write meets. PostgreSQL checks a NOT VALID foreign key on
every INSERT and on every UPDATE of the key column, exactly as it checks a validated one; validation only proves the
rows that were there before the key. Evidence:

* Since the 2.1 sitting both envs have enforced all 25 keys on writes; the all-row sweep finds **0** rows naming no
  Space and **0** NULL on all 25 tables on both envs (read-only, owner role, READ ONLY transaction, every row,
  2026-10-22 ~02:20Z; per-table counts in the lane log). Any deployed writer that named a non-Space would have
  raised 23503 already, and left no row.
* 2.1's arming census (`../v5-tenancykey-001/README.md` "Arming census"): no deployed writer names `workspace_id`
  on the 22; the three `garden_shared_state` writers write the one Space. 2.2 (parent-derived stamps) writes the
  parent row's Space, which is a row of `spaces` because the parent's own key says so.
* Rehearsal F: a deployed-shape INSERT into each of the 25 succeeds before and after VALIDATE, and one naming an
  unknown uuid raises 23503 on the key before and after.

What does change: the planner may use a validated key for join selectivity (PostgreSQL ignores NOT VALID keys
there), so a plan joining one of the 25 to `spaces` on `workspace_id` can change. `spaces` has one row; no handler
joins it this way today.

## Sitting

Dave's first-hand OK names this directory and both envs. One sitting, staging then prod. It needs nothing from a
code deploy (no code reads `convalidated`), and step 2.1 is applied on both envs, so it can run any time after this
directory is in the checkout the sitting runs from. It is independent of 2.2's sitting in either order (2.2 changes
which Space a new row gets, never to a non-Space).

0. **Step 0 (read only):**
   * The C-CONV pre-scan below found **no existing gate that VALIDATE reds**, so no tolerant gate edit has to reach
     main first (rehearsed: newly red = ∅ on both shapes). Read: the latest gate-invariants run is green.
   * **The sweep, with the files' own SQL:** `python3 scripts/tenancykey-apply.py --dir v5-tenancyvalidate-001 --env
     staging --dry-run`, then `--env prod --dry-run`. Inside `BEGIN TRANSACTION READ ONLY` it runs each file's guard
     and prints PASS or REFUSED per file, each with its NOTICE `sweep, every row (deleted included): 0 row(s) name no
     Space, 0 row(s) NULL`. Every file PASS on both envs, or stop and triage (L-058).
   * `neon_safety_branch.py list` and both fleet caps (`harness.py fleet`) are read.
1. **Prod safety copy first:** `python3 scripts/neon_safety_branch.py --env-file .env.local create --slug ms2-23`.
2. **Timing:** outside :58-:02 of any hour and outside 07:00-08:00 UTC (the runner refuses inside them, before each
   file too). `lock_timeout = '5s'` in every file; a wait fails fast (55P03) having changed nothing, and a re-run
   resumes there. The runner stops at the first refusal; a re-run resumes at the first missing stamp.

```bash
# --- staging ------------------------------------------------------------------------------------------------
python3 scripts/gate_runner.py --all --env staging --phase post --continuous-only --json > before-staging.json
python3 scripts/gate_runner.py --migration migrations/v5-tenancyvalidate-001 --env staging --phase pre
python3 scripts/tenancykey-apply.py --dir v5-tenancyvalidate-001 --env staging
python3 scripts/gate_runner.py --migration migrations/v5-tenancyvalidate-001 --env staging --phase post
python3 scripts/gate_runner.py --all --env staging --phase post --continuous-only --json > after-staging.json
# newly red (red in after, not in before) must be the empty set

# --- prod (Dave's first-hand OK; after the safety copy) -------------------------------------------------------
python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only --json > before-prod.json
python3 scripts/gate_runner.py --migration migrations/v5-tenancyvalidate-001 --env prod --phase pre
python3 scripts/tenancykey-apply.py --dir v5-tenancyvalidate-001 --env prod --i-have-daves-ok
python3 scripts/gate_runner.py --migration migrations/v5-tenancyvalidate-001 --env prod --phase post
python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only --json > after-prod.json
```

Nothing follows the DDL: no push B, no gam-site edit (no column changes), no snapshot regeneration
(`tests/tenancy-catalog.prod.json` does not record validation). `check-staging-drift.py` compares constraint names
only, so the staging-first window shows nothing.

## What it locks (rehearsed, PostgreSQL 17)

| file | held to COMMIT |
|---|---|
| 01-25 | SHARE UPDATE EXCLUSIVE on the table (blocks VACUUM, ANALYZE, CREATE INDEX CONCURRENTLY and other ALTER TABLE on it; reads and writes go on) and ROW SHARE on `spaces` (blocks only EXCLUSIVE / ACCESS EXCLUSIVE); the RI scan adds ACCESS SHARE on both. Read from `pg_locks` inside the transaction: `photos` AccessShareLock + ShareUpdateExclusiveLock, `spaces` AccessShareLock + RowShareLock. Two scans of the table: the sweep and VALIDATE's own anti-join against `spaces` |
| 0r | ACCESS EXCLUSIVE (plus SHARE ROW EXCLUSIVE from the re-add) on each table it puts back and on `spaces` (dropping a key drops its RI triggers there; adding it back makes them again) |

Time: prod's largest table is `critter_state` (2,288 rows, 896 KiB heap; then photos 2,099, cultivar_weight_sample
1,695, inventory_items 567; five tables are empty). On the rehearsal every file's VALIDATE took 0.2-0.6 ms (seed rows
on the prod shape, staging's own rows on the staging shape); a synthetic table of 2,288 rows (832 KiB) validated in
1.3 ms and one of 228,800 rows (81 MiB) in 33.5 ms (rehearsal H, run 2026-10-22). Estimate for prod: a few
milliseconds of database time per file, tens of milliseconds at worst if Neon has to fetch the pages cold; the
sitting's wall clock is the 25 psql connections (seconds per env), not VALIDATE.

## C-CONV pre-scan (§2.8, widened; R16)

VALIDATE changes exactly two things a gate can read, and only for the 25 named keys: `pg_constraint.convalidated`
(false → true) and the text of `pg_get_constraintdef` (its trailing ` NOT VALID` goes). It adds and drops no
constraint, trigger, index or column. Scanned every `migrations/*/gates.yml` (158 files, 2051 gates at this commit)
for any gate whose SQL reads `convalidated`, `pg_get_constraintdef` or `NOT VALID`, or counts / shapes foreign keys
on the 25 tables or on `spaces`; each candidate was read in full.

**Found: no gate that VALIDATE turns red, and none that it turns green.** Nothing is edited. In detail:

* Gates reading `convalidated` or the definition of a foreign key name their own keys by `conname` or read a table
  outside the 25: `v5-fermentpath-001:300`, `v5-pantry-001:162`, `v5-putupmake-001:470`, `v5-recipes-001:193`,
  `v5-seedlotaddition-001:145`, `v5-seedmultiparent-001:195`, `:383`, `v5-sourcekind-001:182`,
  `v5-wxcoldband-001:288`, `v5-wxplotid-001` `post_plot_keys_exact`, `v5-plottier-001:167`, `v5-spacefk-001:231`
  (plants and plant_projects only). Each expects the same value before and after.
* Gates matching `NOT VALID` in a definition read CHECKs on `source` by name: `v5-sourcecontact-001:123`,
  `v5-sourceentity-001:450`. Unchanged.
* Foreign-key shape gates on these tables or on `spaces`, none of which reads validation state:
  `v5-spaceguard-001:387` (single column on `spaces.id`), `v5-tenancykey-001` `post_tenancykey_key_shape` (its
  header: "validated or not is step 2.3's to assert"), `ops-cueinstrument-001` `post_no_foreign_keys` (2.1's tolerant
  form: name, columns, target, action), `v5-spacefk-001:182`, `:206`. `spaces_delete_guard` reads the same catalog
  shape, not validation.
* Outside the gates: `scripts/check-staging-drift.py` compares constraint names; `scripts/tenancy-catalog-snapshot.py`
  and `scripts/dev-main-schema-audit.py` read no validation state.

**Rehearsed (D):** `gate_runner.py --all --phase post --json` before and after the 25 files on the prod and the
staging shape: newly red = ∅, newly green = ∅, and this directory's own post gate PASS before (vacuous) and after.

**New continuous gate:** `post_tenancyvalidate_keys_validated` (below). It is new, not an edit, and self-armed per
key on that key's own stamp, so it is green before the sitting on every database and needs no main-first promote.

## Gates

* `pre` (receipts, continuous: false; each row read only while its own stamp is absent, so vacuous after the run):
  `pre_tenancyvalidate_keys_are_2_1s_and_not_valid` (each key is there, its 2.1 stamp is there, it is NOT VALID);
  `pre_tenancyvalidate_all_row_sweep_is_zero` (the files' sweep as a gate: every row, no `deleted_at` filter,
  NULLs separately).
* `post` (continuous): `post_tenancyvalidate_keys_validated`. Each of the 25 rows is armed on its own exact stamp;
  armed, the key must exist and be `convalidated = true` ("key missing" / "NOT VALID" name what is wrong). Before a
  stamp a NOT VALID key passes (the tolerant half); after it, a key re-added NOT VALID or dropped reds (the tightened
  half). Rehearsal E shows each arm red then green.

## Rollback

`0r-rollback.sql`, one transaction, the directory in reverse, as far as the stamps say it went. **A validated key
cannot be un-validated in place** (PostgreSQL has no `ALTER … NOT VALID` for an existing constraint), so for each
stamped key that is validated it drops the key and adds it again exactly as 2.1 made it (`FOREIGN KEY (workspace_id)
REFERENCES public.spaces (id) ON DELETE RESTRICT NOT VALID`) with 2.1's comment, then deletes the stamp. Adding a key
NOT VALID scans no row, so the rollback cannot fail on data. It refuses, changing nothing, if a stamped key is gone
while 2.1's stamp is present, or is not in 2.1's shape. A NOT VALID key with a stamp, or a key gone together with
2.1's stamp (2.1's own rollback ran first), just loses the stamp. It is never needed for writes (both states check
new rows the same way); run it before `v5-tenancykey-001/0r-rollback.sql` so these stamps do not outlive their keys.
A second run is a no-op. Rehearsal G: definitions and comments equal to the pre-step database after it.

## For the steps after this one

* **2.4a** adds its own keys NOT VALID and validates them in its own post-deploy file; it does not touch these 25.
* A later step that re-keys one of these tables (drops and re-adds `<table>_workspace_id_fkey`) adds it back
  validated or edits `post_tenancyvalidate_keys_validated` in its own push; its C-CONV pre-scan finds this gate by
  the key's name.

## Rehearsal (local PostgreSQL 17 only)

A throwaway cluster (scratch directory, `initdb -U postgres -A trust --no-locale -E UTF8`, a free port, 127.0.0.1
only), every Neon read made read-only (`PGOPTIONS=-c default_transaction_read_only=on`, URL by key name):

* `base_prod`: `CREATE SCHEMA extensions; CREATE EXTENSION "uuid-ossp" SCHEMA public;` (on Neon the extension lives
  in `public` and `extensions` holds SQL wrappers the dump defines), then prod's `pg_dump --schema-only --no-owner
  --no-privileges -n public -n gv -n extensions` (its `CREATE SCHEMA extensions/public` lines removed; it carries
  2.1's 25 NOT VALID keys), then prod's `spaces`, `schema_version`, `spacetheme` and `plots` rows (`--data-only`,
  loaded with `session_replication_role=replica`), then `../v5-tenancykey-001/rehearse_seed.sql` (same role).
* `base_staging`: the same first line, then a full `pg_dump --no-owner --no-privileges -n public -n gv -n extensions`
  of staging (replica role).

`python3 migrations/v5-tenancyvalidate-001/rehearse_local.py --port <port> --base-prod base_prod --base-staging
base_staging` runs sections A-H (its docstring) on clones and prints PASS/FAIL per check. Run 2026-10-22: see the
lane log for the full output.
