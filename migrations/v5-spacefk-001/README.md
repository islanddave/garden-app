# v5-spacefk-001: every container and planting names a real Space

Multi-space Phase 1, steps 1.9, 1.8 and 1.10 (lane M2). Build sheet
`project-state/_multispace-20261015/multispace-phase1-buildsheet-V203-20261016.0915.md` §2 and §3R
("M2 order and stamps", "1.9 census and behaviour"); Phase 0 facts from `phase0-reads-20261015.md` beside it.
Ledger: V5-SPACESENTINELDOC-001 (1.9), V5-SPACETENANCYKEY-001 (1.8, 1.10).

| file | step | stamp | what it does |
|---|---|---|---|
| `0a-fold.sql` | 1.9 | `5.1.5-spacefk-001-fold` | Moves the ten nil-workspace containers onto the one Space, by pinned id. BEFORE copy in `ctas_spacefold001_plant_projects`. No-op on staging. |
| `0b-fk-plants.sql` | 1.8 | `5.1.5-spacefk-001-fk-plants` | `plants.workspace_id → spaces(id) ON DELETE RESTRICT NOT VALID` |
| `0c-fk-plant-projects.sql` | 1.8 | `5.1.5-spacefk-001-fk-projects` | `plant_projects.workspace_id → spaces(id) ON DELETE RESTRICT NOT VALID` |
| `0d-validate.sql` | 1.10 | `5.1.5-spacefk-001-validate` | All-row sweep = 0, then `VALIDATE` both keys |
| `0r-rollback.sql` | | deletes all four | The whole directory in reverse: drop both keys, restore the ten from the copy, delete the stamps |
| `gates.yml` | | | 5 `pre` (apply-window receipts), 2 `sweep`, 8 standing `post`, each armed on one exact stamp |

Stamps are fixed here and read by lane M3: 1.11's photo tenancy gate arms on `5.1.5-spacefk-001-fold`.

## In plain words

Every container and planting has a `workspace_id`: the Space it belongs to. There is one Space today. Ten of
Dave's containers carry the all-zero id `00000000-0000-0000-0000-000000000000`, which is not a Space at all; every
other row in every `workspace_id` column carries the real one, `…0001`. The plantings inside those ten already
carry `…0001`. `0a` moves the ten onto the real Space. Nothing else about them changes: name, location, owner,
plantings, photos stay as they are. Then `0b`-`0d` make the database refuse any container or planting whose
`workspace_id` is not a Space, so the all-zero id cannot come back.

Nobody sees a difference, with two small exceptions below (a one-time 409, and the rain cap).

## The ten (prod; Phase 0 read 34, full ids re-read 2026-10-16)

| id | name | location (read 34) |
|---|---|---|
| `5ddfb9ab-0261-40f8-9528-e8c0cf5861f6` | Christmas Cactus | Stable |
| `a377adc6-6d83-4bf1-a19e-c533be0b938e` | Dracaena | Drive (outdoors) |
| `49be2767-0e6d-4bab-ba71-12ee293c5d0f` | Echeveria | Stable |
| `abc3a67a-7612-4224-96d6-2d0dfea20a7a` | Echeveria 'Perle von Nurnberg' | Stable |
| `a03bd522-3c81-4ecf-bfb8-f4832f7794e0` | Golden Sedum | Stable |
| `8c94878e-0689-4ea4-9c6e-ebb859e4ecc2` | Gymnocalycium mihanovichii | Stable |
| `6cc82240-35ca-495d-a050-0481a0e7b5c4` | Haworthia / Gasteria (assorted) | Stable |
| `5cd427cf-2e90-46f9-98bb-7dcebd4e64cc` | Jade Plant | House |
| `a08de1c6-da94-445b-85e7-f20c4a967ce2` | Japanese Maple | Drive (outdoors) |
| `10ff66bb-1343-4316-88fd-2b3dec325628` | Lithops (archived) | Stable |

No indoor precondition (sheet P1, D27-note): the fold re-stamps tenancy, not location.
Staging has none of them and no nil row anywhere (read 17; re-read 2026-10-16): there `0a` writes its stamp and
nothing else.

## Why fold first

A foreign key added `NOT VALID` still checks every later INSERT, and every UPDATE that changes the key. PostgreSQL
skips the check for an UPDATE that leaves the key alone, **except** when the row was already written earlier in the
same transaction. The rehearsal measured it on PostgreSQL 17: with a `NOT VALID` key and a nil container, one
UPDATE of another column succeeds, and a second UPDATE of the same row in the same transaction raises 23503. That is
exactly what `softDeletePhoto` does to a container (`featured_photo_id`, then `featured_image_id`, in one
transaction). So the fold runs before either key exists (review DSA I1), and `0b`/`0c` refuse until the fold stamp
is there and no nil row remains. With the fold first, the same double UPDATE on a folded container succeeds
(rehearsal D2). Read-only prod check, 2026-10-16: none of the ten has `featured_photo_id = featured_image_id`
(`featured_image_id` is NULL on all ten), so the window was empty on prod anyway.

## What the fold's UPDATE fires (prod `pg_trigger`, 2026-10-16; bodies in `phase0-function-bodies-20261015.sql`)

| trigger | when | effect on the fold |
|---|---|---|
| `container_bump` (`gv.bump_version`) | BEFORE UPDATE, row | `version := OLD.version + 1` on each of the ten |
| `set_updated_at` | BEFORE UPDATE, row | `updated_at := now()` on each of the ten |
| `prevent_ownership_transfer` | BEFORE UPDATE, row | **fires and passes**: `created_by` is not written |
| `container_reparent_after` (`gv.container_reparent`) | AFTER UPDATE, row | fires; acts only when `parent_project_id IS DISTINCT FROM` the old one, so does nothing |
| `container_closure_after_ins` | AFTER INSERT | not fired |
| `trg_guard_entity_tag_project` | BEFORE DELETE | not fired |

`plant_projects` has no audit trigger (read 26). The record of the fold is the BEFORE copy and the stamp; the actor
`migration:v5-spacefk-001` is set for any trigger that reads it (none on this table does).

### The one-time 409

`version` is the container's optimistic-lock counter. ProjectDetail sends `expected_version` on a move and on an
undo-move (`src/pages/ProjectDetail.jsx`), and `reparentCore` answers 409 "Version conflict — reload and retry"
when it differs. A page that loaded one of the ten **before** the fold gets that 409 once, on its next move or
undo of that container; reloading picks up the new version and the retry succeeds (rehearsal F2: 409, then 200).
Every run of a file that writes the ten bumps the version again: `0a`, and `0r` too. A rollback followed by a
re-apply is two more bumps, so a page left open across both gets the same single 409 on its next move; nothing
compounds. `updated_at` has no reader that matters (`last_activity_at` does not use it; gam-site exports
`id, name, slug, start_date, status`).

### The rain cap (a behaviour change, intended)

The daily-plan rain logger skips a Space for the day when someone hand-logged rain there
(`lambda/daily-plan/handler.js`, the once-a-day cap: `coalesce(n.workspace_id, c.workspace_id) = <Space>`). For a
rain event logged on a **container** (no planting), the Space is the container's. Today the ten carry the nil id,
so such a row on one of them never matches any Space and never caps the day. After the fold it does, exactly as
it already does for every other container: a hand-logged container-level rain on one of the ten suppresses the
gauge's automatic rain rows for that Space that day. Two of the ten (Dracaena, Japanese Maple) are outdoors.

Read-only prod evidence, 2026-10-16 (owner DSN inside `BEGIN TRANSACTION READ ONLY … ROLLBACK`):
`event_log` rain events with `plant_id IS NULL AND deleted_at IS NULL AND project_id IN (<the ten>)` = **0**
(0 hand-logged; 0 in any deleted state). Hand-logged container-level rain on **any** container = 0. So the change
alters no past day; it applies to the next such event. `lambda/daily-plan/rain-cap-fold.test.js` drives `run()`
through it.

## Who reads a container's workspace_id (the consumer census)

`lambda/container-workspace-census.test.js` walks every non-test Lambda file, resolves every `workspace_id` in its
SQL to the relation it reads, and pins the result. At 51a97146 the readers of a **container's** `workspace_id` are
exactly:

* `lambda/projects/index.js` `reparentCore`: the `tgt` CTE selects it from `plant_projects` (was `:96`) and the
  `ev` CTE copies `t.workspace_id` into `reparent_event` (was `:112`; `:111` is `reparent_event`'s column list).
* `lambda/daily-plan/handler.js` the rain cap's `c.workspace_id` (was `:1149`).

No Lambda writes `plants.workspace_id` or `plant_projects.workspace_id` (inserts take the DEFAULT `…0001`), and none
reads a container row whole (`*`, `c.*`, `to_jsonb(c)`). A new reader, a new writer, or a reader that moves out of
its pinned statement reds the test.

The reparent path is also proved on a real database: `tests/integration/reparent-workspace.int.test.js` moves a
container and reads `reparent_event.workspace_id` back as the container's Space. `reparent_event` has no foreign
key at all on prod or staging (2026-10-16: PK and `UNIQUE (op_id)` only), so its teardown in `_cleanup.js` is for
residue, not for FK order.

## Prerequisites and order

1. **M1 first.** `0b` and `0c` refuse unless `public.spaces` carries `spaces_truncate_guard` (BEFORE TRUNCATE,
   enabled `O`). With these keys, `TRUNCATE spaces CASCADE` reaches `plants`, `plant_projects` and everything that
   references them (rehearsal E9: the cascade set includes `plants`, `plant_projects`, `event_log`, `photos`); the
   guard is then the only stop (review DSA I6).
2. **0a → 0b → 0c → 0d**, each its own transaction. `0b`/`0c` refuse without the fold stamp; `0d` refuses without
   both key stamps or with any row the keys would reject.
3. **Rollback order across Phase 1: M3 → M2 → M1.** M1's `0r` refuses while either key from this directory
   exists. This directory's `0r` has no object dependency on M3, but run M3's first all the same: M3's 1.11 gate is
   armed on this directory's `-fold` stamp.

## Applying

Never at :55-:05 (the hourly daily-plan run). Every file sets `lock_timeout = '5s'`; a lock wait fails fast (psql
exit 3, 55P03) having changed nothing. Run it again.

**No restore-verify red from this directory.** `scripts/restore-verify.py` drops triggers on tables the dump does not
list from its missing set (`:609-610`) and treats a table added after the dump as info (`:513`, `:521`), so neither
the keys' internal RI triggers nor `ctas_spacefold001_plant_projects` reds the daily or snap leg. If one appears, the
dump's `tables.json` is missing: investigate it, do not wave it off.

**Before 0a, on BOTH envs (read-only):** run the SQL of `post_workspace_census_every_row_names_a_space` with its
schema_version stamp test removed, inside `BEGIN TRANSACTION READ ONLY; … ROLLBACK;`. It must return 0 on every one of
the seven non-keyed `workspace_id` tables; `0d` arms that gate, and nothing in `pre`/`sweep` or `0d`'s refusal checks
those seven, so a non-zero here would arm a gate that is red at once. Record the result in the sitting record.

**Newly red = ∅.** Take the BEFORE set first on each env, and compare the AFTER set with it; a pre-existing red cannot
be told apart from a new one otherwise.

```bash
# --- staging ---------------------------------------------------------------------------------------
python3 scripts/gate_runner.py --all --env staging --phase post --continuous-only --json > before-staging.json
python3 scripts/gate_runner.py --migration migrations/v5-spacefk-001 --env staging --phase pre
python3 scripts/gate_runner.py --migration migrations/v5-spacefk-001 --env staging --phase sweep
for f in 0a-fold 0b-fk-plants 0c-fk-plant-projects 0d-validate; do
  psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-spacefk-001/$f.sql || break
done
python3 scripts/gate_runner.py --migration migrations/v5-spacefk-001 --env staging --phase post
# staging only: rehearse the rollback, then put it back
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-spacefk-001/0r-rollback.sql
python3 scripts/gate_runner.py --migration migrations/v5-spacefk-001 --env staging --phase pre
for f in 0a-fold 0b-fk-plants 0c-fk-plant-projects 0d-validate; do
  psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-spacefk-001/$f.sql || break
done
python3 scripts/gate_runner.py --all --env staging --phase post --continuous-only --json > after-staging.json
# newly red (in after, not red in before) must be the empty set

# --- prod (Dave's first-hand OK; after the pre-apply copy) -------------------------------------------
python3 scripts/neon_safety_branch.py --env-file .env.local list
python3 scripts/neon_safety_branch.py --env-file .env.local create --slug ms1 --days 7
python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only --json > before-prod.json
python3 scripts/gate_runner.py --migration migrations/v5-spacefk-001 --env prod --phase pre
python3 scripts/gate_runner.py --migration migrations/v5-spacefk-001 --env prod --phase sweep
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-spacefk-001/0a-fold.sql   # expect: folded 10
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-spacefk-001/0b-fk-plants.sql
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-spacefk-001/0c-fk-plant-projects.sql
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-spacefk-001/0d-validate.sql
python3 scripts/gate_runner.py --migration migrations/v5-spacefk-001 --env prod --phase post
python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only --json > after-prod.json
# newly red (in after, not red in before) must be the empty set
```

On prod `0a` must print `folded 10 container(s) … (10 of 10 pinned present on this database)`. `folded 0` with
`0 of 10` means the wrong host. `pre_pinned_ten_still_nil` (prod) says the same before anything runs.

After the apply, `pre` reads red by design (`pre_no_workspace_key_yet`, `pre_pinned_ten_still_nil` are
`continuous: false` receipts that the apply makes false), and `sweep` stays green.

## What it locks (measured on the rehearsal, PostgreSQL 17)

| file | locks held to COMMIT |
|---|---|
| `0a` | row locks on the ten (`FOR UPDATE`, then the UPDATE); nothing table-wide beyond ROW EXCLUSIVE |
| `0b` | `ShareRowExclusiveLock` on `plants` and `spaces` (no row scan) |
| `0c` | `ShareRowExclusiveLock` on `plant_projects` and `spaces` (no row scan) |
| `0d` | `ShareUpdateExclusiveLock` on `plants` and `plant_projects`, `RowShareLock` on `spaces`, for the scan (327 + 86 rows on prod) |
| `0r` | `AccessExclusiveLock` on `plants`, `plant_projects` **and** `spaces` (dropping a key removes its RI triggers from `spaces`) |

Behind an open writer transaction on `spaces`, `0b` failed after 5 s with 55P03, exit 3, no key and no stamp
(rehearsal C4). Readers do not wait behind `0b`/`0c`/`0d`; writers of the locked tables wait for milliseconds.

## Would the currently deployed code break on this?

No. The falsifiable test (gardening-deploy.md, Migration ordering): would deployed code write a row these keys
reject? No code writes either column (census test), inserts take the DEFAULT `…0001`, which is the one Space, and
after the fold no existing row is rejected, so no UPDATE can meet an unchanged invalid key. No deployed code deletes
a Space. RESTRICT (not CASCADE) keeps `v4-cascadesweep-001 post_no_cascade_onto_a_soft_deletable_table` green, and
not SET NULL/DEFAULT keeps `v4-evtanchordel-001 post_no_setnull_fk_inside_an_anchor_check` green. The RI triggers the
keys add (on `plants`, `plant_projects` and `spaces`) are internal; the trigger-inventory gates on those tables either
filter `NOT tgisinternal` or name their triggers (recon §2), and `restore-verify` compares non-internal triggers only. Rehearsal G: the whole corpus `--all --phase post`, before any file versus after
`0d`, newly red = {} and newly green = {}.

## Rollback

`0r-rollback.sql`, one file, the whole directory in reverse: drop `plant_projects_workspace_id_fkey` and
`plants_workspace_id_fkey` first (once a key exists, putting the nil id back would be checked and raise 23503;
review DSA I2), then restore `workspace_id` on the ten from the BEFORE copy, only where the row still carries
`…0001`, all or nothing (a copied row that moved or vanished is named and nothing is restored; rehearsal H0), then
drop the copy and delete the four stamps. Only `workspace_id` goes back; `version` and `updated_at` move forward
again (see the 409 note). A second run is a no-op. On staging (no copy) it drops the keys and the stamps only.

## Gates

* `pre` (receipts, `continuous: false`): the target Space exists; `spaces_truncate_guard` is enabled; no
  `workspace_id` key yet; no nil row except the ten, over every `workspace_id` table (catalog walk); prod only: the
  ten are still nil.
* `sweep`: every `plants` row names a Space; every `plant_projects` row outside the ten does.
* `post`, each armed on one exact stamp:
  * `-fold`: `post_fold_no_nil_workspace_rows` (both envs) and `post_fold_pinned_ten_present_on_the_space`
    (prod only; staging has none of the ten by design). A later Space move of one of the ten (Phase 4+) retires the
    second in the same change.
  * `-fk-plants` / `-fk-projects`: exactly one key on the column, single-column, to `spaces(id)`, RESTRICT.
  * `-validate`: both keys `convalidated`; the all-row census: every row of every OTHER base table with a
    `workspace_id` column names a Space (`entity`, `care_profile`, `garden_shared_state`, `merge_event`,
    `reparent_event`, `seen_event`, `treatment_association` today, found in the catalog, read through
    `query_to_xml`; `ctas_`/`snap_` copies excluded by prefix); and a companion that the walk still finds those seven.
  * armed on the objects: a key without its stamp, or a later stamp without `-fold`, is red.

## What was rehearsed, and where

Local PostgreSQL 17 throwaway cluster, 2026-10-16: prod's schema (`pg_dump --schema-only` of `public` and `gv`,
read-only, 148 relations, restored with no error), prod's 180 `schema_version` rows and its `spaces` row as data,
synthetic prod-shaped rows (the ten at the nil id with prod's ids, 12 `…0001` plantings inside them, 10 live and 2
soft-deleted, plus two `…0001` containers), and a stub `spaces_truncate_guard` (M1 builds the real one). The real
`reparentCore` from `lambda/projects/index.js` was driven through a node-postgres adapter. Every positive control was
seen red and then green:

| control | red | green |
|---|---|---|
| reparent of a ten-shaped container | before `0a`: `reparent_event.workspace_id = …0000` | after: `…0001` |
| unknown-Space insert | before `0b`: accepted | after `0b`: 23503 `plants_workspace_id_fkey`; after `0c`: same on `plant_projects` |
| two UPDATEs of one container in one transaction | `NOT VALID` key + nil row: 23503 on the second | after the fold, with both keys: both succeed |
| `0b` guard | no guard, guard disabled, no fold stamp: each refused, nothing changed | stub enabled: applied |
| `0a` guard | unpinned nil container; nil `reparent_event` row: each refused | removed: applied |
| `0d` sweep | a soft-deleted orphan planting: refused, nothing validated | removed: validated |
| census gate | a `reparent_event` and a `seen_event` row naming no Space | removed; a stray `snap_` table is not counted |
| other post gates | CASCADE key, a second key, `NOT VALID` key, a missing stamp, the `-fold` stamp over nil rows | each restored |
| `0r` | a copied row moved to another Space: refused, nothing restored | round trip: keys, copy and stamps gone, ten back at nil; second run a no-op |
| re-apply | | `0a`-`0d` again: exit 0, folded 10; a third time: exit 0, folded 0, versions unchanged |
| staging shape | | `0a` a clean no-op (no copy, stamp only); `0b`-`0d`, `0r`, re-apply all clean |
| TRUNCATE CASCADE after M2 | | `TRUNCATE spaces CASCADE` and `TRUNCATE photos CASCADE` refused by the guard |

Not applied to staging or prod.
