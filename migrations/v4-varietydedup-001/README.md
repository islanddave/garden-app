# v4-varietydedup-001 — plant_varieties consolidation

Closes **`V4-VARIETYDUP-001`** (Alaska Mix duplicate) and **`V4-CWARCHIVE-001`** (California Wonder
family). Data-only — no DDL, no schema change. Soft-delete only, per this project's
Soft-Delete-Only Rule: nothing is `DELETE FROM plant_varieties`, everything is `deleted_at = now()`
and reversible via `0r-rollback.sql`.

## Status

**PREPARED — NOT APPLIED.** No writes have been made to prod or staging. `0a-data-fix.sql` has not
been run anywhere. This is ready for Dave's review before anyone applies it.

**Prod-only by construction.** The SQL is keyed to specific live prod row UUIDs found by querying
prod directly. Staging's isolated Neon branch doesn't carry these rows, so unlike a schema
migration there is no "apply to staging first" step — apply to prod only, when Dave says so.

## What ships here

| File | Purpose |
|---|---|
| `0a-data-fix.sql` | The fix: 1 repoint + 2 soft-deletes for Alaska Mix, 3 soft-deletes for the CA Wonder family. Every statement is `WHERE id = ... AND <guard>`, so a second run changes 0 rows. |
| `0r-rollback.sql` | Reverses exactly the rows `0a` touched, by explicit id. |
| `gates.yml` | 6 pre / 6 post data-state gates (`scripts/gate_runner.py`). Not schema-shape checks — this migration adds no schema — row-state checks instead. |

## V4-VARIETYDUP-001 — Alaska Mix: true duplicate, merged

Two rows, both `crop_type_slug='nasturtium'`, `name='Alaska Mix'` exactly:

| | `a11dd600…` (survivor) | `f2c6edd8…` (archived) |
|---|---|---|
| created_by | `data-audit-20260706` | `user_3D2gM0hIl03gjW3JM2DjtPzm0jI` |
| created_at | 2026-07-06 | 2026-07-07 (one day later) |
| species / genus | `majus` / `Tropaeolum` (correct ID) | NULL / NULL |
| other fields | all NULL | all NULL |
| live planting | 1 (`8f84f21c`, vegetative, active) + 1 already-deleted | 1, already-deleted (`7ea304c4`) |
| inventory_items | 1 | 0 |

**Called a clean true-duplicate, not a near-duplicate needing Dave's input**, because neither row
carries any distinguishing catalog data — no `source_url`, no vendor, no conflicting
characteristics on either side. The second row is a bare stub with zero information the first
doesn't already have; the uniqueness index (`uq_plant_varieties_name_species`, keyed on
`lower(name), COALESCE(species,'')`) simply didn't catch it at insert time because one row has
`species='majus'` and the other has it NULL, so the two rows hashed to different keys. This is the
opposite of the "different vendors / different characteristics" ambiguity case the task was
watching for.

`a11dd600` is kept as survivor (richer data, more active references). Its `created_by` matches
`MANAGED_PRINCIPAL_PATTERNS` (`data-audit-%`) in `lambda/varieties/authz.js`, so it stays editable
by Dave through the app's normal household-scoped write path — not stuck unowned. Repointed:
`plants.id = 7ea304c4…` (the loser's one referencing planting, already deleted, repointed anyway
for FK correctness). Checked and confirmed 0 rows to repoint in `inventory_items`,
`cultivar_weight_sample`, `preservation_log`, `proj_rescope_events`. `entity` needs no manual
touch — `plant_varieties_entity_softdel` mirrors `deleted_at` automatically.

## V4-CWARCHIVE-001 — California Wonder family: 4th row changes the plan

The ledger text says 3 rows, rename the keeper to 'Emerald Green'. Live data has **4**:

| id | name | created_by | created_at | planting state |
|---|---|---|---|---|
| `960c10f5…` | Golden California Wonder | system | 2026-05-11 | only non-deleted planting already **archived** |
| `750c8334…` | Orange Sun | system | 2026-05-11 | only non-deleted planting already **archived** |
| `1eff5046…` | California Wonder | user | 2026-05-21 | only planting already **archived** (status=failed) |
| `7a6ab71f…` | **Emerald Green** | user | 2026-06-07 | **active** planting (status=failed, not archived) — not in the ledger text |

A literal rename of `1eff5046` → `'Emerald Green'` is not just undesired, it's **blocked**:
`uq_plant_varieties_name_species` is `UNIQUE(lower(name), COALESCE(species,''))
WHERE deleted_at IS NULL`, and `7a6ab71f` already holds that exact key
(`'emerald green'`, species `annuum`).

**Resolution:** `7a6ab71f` is the true keeper — already correctly named, holds Dave's only
currently-active planting in this family, and carries cultivar-specific detail (DTM 72-80, no
generic source) vs `1eff5046`'s generic gardeningchannel.com growing-guide content (DTM 60-90,
`source_proj_rescope_project_id` populated — it was created via a project-rescope event, not
hand-authored). Reading: Dave already created the real "Emerald Green" entry by hand on 2026-06-07
rather than literally renaming the old row, and this ledger item was never closed out to reflect
that. So `0a` archives all **three** off-target rows (Golden CW, Orange Sun, and the old
"California Wonder") and **does not** touch `7a6ab71f` — no `UPDATE ... SET name` anywhere in this
migration.

**This is a deviation from the ledger's literal "archive 2, rename 1" and is the one thing in this
migration most worth Dave's eyes before applying**, even though soft-delete makes it cheaply
reversible either way.

**Archive-impact check** (the task's explicit ask: does archiving blank an active view?).
`lambda/plants/index.js:455` LEFT JOINs `plant_varieties` with `AND pv.deleted_at IS NULL`, so a
planting whose variety gets archived loses its `variety_ref` (name/DTM/care notes/etc. all go
`null`) on any screen that renders it — confirmed by reading the query, not assumed. Checked every
planting referencing the 3 archive targets: **all of them are already `archived_at`-set or
`deleted_at`-set** (960c10f5: one archived + one deleted; 750c8334: one archived + one deleted;
1eff5046: one archived). None is currently visible in any view today — the app also has no
route to archived plantings at all yet (`gardening.md` Archive-Hiding Rule: "no route to archived
records… exactly one deliberate route… does not exist anywhere"). So this migration changes zero
currently-rendered screens. `pre_no_active_planting_on_archive_targets` /
`post_no_orphaned_active_planting` in `gates.yml` assert this as a hard invariant, not a one-time
observation.

## Runbook (when Dave approves applying)

```bash
export NEON_DATABASE_URL=$(grep -m1 '^NEON_DATABASE_URL=' .env.local | sed 's/^NEON_DATABASE_URL=//' | tr -d '"')
python3 scripts/gate_runner.py --migration migrations/v4-varietydedup-001 --env prod --phase pre
# all pre gates must be green before applying
psql "$NEON_DATABASE_URL" -f migrations/v4-varietydedup-001/0a-data-fix.sql
python3 scripts/gate_runner.py --migration migrations/v4-varietydedup-001 --env prod --phase post
# flip continuous: false -> true on every post_* gate once this is green
```

Rollback: `psql "$NEON_DATABASE_URL" -f migrations/v4-varietydedup-001/0r-rollback.sql`, safe at any
time — every statement is guarded and only touches the exact rows `0a` touched.
