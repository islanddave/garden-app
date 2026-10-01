# v5-pantry-001 — Put-Up release 2 (the Pantry), the database half, as B′ carries it

Plan: `project-state/_crucible-pantry-20260928/04-design-final.md` (V4) §2.5, §4.3, §5.1 rows "2", §5.2–§5.6,
amended by `05-release-train.md` §6/§6a and shrunk by `06-ferment-path.md` (F) §1.3. The routes are in
`lambda/preservation/pantryRoutes.js` (+ `pantryItems.js`, the widened `pantryUses.js`, the pantry line in
`lineRoutes.js`). Ships in promote **B′** after F, applied in B′'s sitting in train order 2 → 3 → 4.

| file | what it does |
|---|---|
| `0a-additive-ddl.sql` | The schema, one transaction, stamp `5.0.0-pantry-001` (line 2). Applies on top of F only. |
| `0r-rollback.sql` | Guarded rollback to the exact post-F schema. **Valid only while B′'s code is off dev.** |
| `gates.yml` | 5 `pre`; no `sweep` (nothing can meet existing data); 12 `post` (11 standing + 1 apply-window receipt). |

## What 0a adds

* **pantry_item** (new): id, user_id, name (nonblank, ≤ 120), storage_location_id NOT NULL, acquired_at date,
  acquired_precision (the §3.6 vocabulary; a known day carries a precision other than `unknown`, no day has
  none or `unknown` — `chk_pantry_item_acquired_pairing`), use_by_target date (typed only — no route derives
  one), plant_id, crop_type_slug, used_up_at, notes, idempotency_key (global unique partial
  `uq_pantry_item_idempotency_key` — a 23505 on it is a replay), created_at, updated_at, deleted_at.
  Triggers: `set_updated_at`; `prevent_pantry_item_ownership_transfer` → the **user_id variant**
  `prevent_kitchen_batch_ownership_transfer()`, reused unchanged (the function 1b attached to preservation_log).
  Not `prevent_ownership_transfer()`, which reads `created_by` and would 42703 every UPDATE here. **Unaudited**
  (V4 §5.5).
* **kitchen_batch_input.pantry_item_id** uuid, FK NO ACTION, `chk_kbi_pantry_item_kind`
  (`pantry_item_id IS NULL OR input_kind = 'pantry'`). A legacy `pantry` line with no item stays legal.
* **Nothing for pantry_use.** F's `chk_pantry_use_fate` already admits `discarded` and `given_away`;
  `pre_pantry_use_fate_admits_went_bad_and_gave_away` proves it before the apply and
  `post_pantry_use_fate_admits_went_bad_and_gave_away` holds it after. No pantry_use, delta_at or
  remaining_amount is created here (F §1.3).

Every FK states its ON DELETE: storage_location NO ACTION, plants **SET NULL** (a bought or picked thing outlives
its planting record — the preservation_log precedent; merge.js repoints it), crop_types NO ACTION,
kitchen_batch_input → pantry_item NO ACTION. Nothing CASCADEs.

## Registry (V4 §5.6) — where each item landed

* merge.js SURFACES + snapshot/restore: `pantry_item.plant_id` → repoint, no deleted_at filter (the kbi
  reasoning); snapshot read + literal UPDATE in `lambda/plants/merge.js`; contract in
  `lambda/plants/merge-surfaces-columns.test.js`. **`scripts/merge-surface-inventory.py` is NOT wired into
  gate-invariants** by this release: it can only be judged against a live database (it reads pg_constraint and
  information_schema, uses `::regclass`), and against prod/staging today it would report `pantry_item.plant_id`
  as a stale entry until this DDL is applied. Wiring it (and making its lookups pooled-connection-safe, 05 §6a)
  stays open.
* Archive routines: untouched. pantry_item names no harvest_log and its plant FK is SET NULL, so neither
  `archive_plant_events()` nor `archive_container_events()` can meet a pantry_item row.
* PHOTO_POINTERS: none — pantry_item has no photo column.
* api.js prefix: `'/api/pantry'` already routes to the preservation Lambda (F); no change.
* Router delegation: one hunk in `lambda/preservation/index.js` (`handlePantryRoute`), and the jar DELETE
  body now calls `removeJar` (Remove refused on a used or drawn jar, V4 §2.5).
* `*-columns.test.js`: `lambda/preservation/pantry-columns.test.js` (pantry_item + kbi.pantry_item_id), pinned
  both directions to this 0a. The Phase 4 join ratchet stays at 47 (measured DB-free with the auditor's own
  main()).
* Household loaders (V4 §5.3): `loadPantryItems` (pantryItems.js) for a line's pantry_item_id; `loadPlace`
  (pantryRoutes.js) for storage_location_id; `loadPlantings` (lineRoutes.js) for plant_id. Not in the shared
  `household.js` — that file is byte-identical across 19 Lambda directories, and F put its loaders beside
  their routes for the same reason.
* AUDITED_DML: unchanged (pantry_item is unaudited). The undo and Remove write preservation_log inside the actor
  transaction.
* `tests/integration/_cleanup.js`: a `pantry_item` step after the lines and before places/plantings/crops.

## Apply order (B′'s sitting = 05-release-train §3 with "1b→4" read as "2→4" after F)

1. **Pre-checks, immediately before every apply** (Neon branch of prod, staging, prod):
   ```bash
   python3 scripts/gate_runner.py --migration migrations/v5-pantry-001 --env <env> --phase pre
   ```
2. **0a** — `psql -X -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql`. Never inside BEGIN/ROLLBACK on a shared database.
3. **Right after**: `--migration migrations/v5-pantry-001 --phase post` (all of it, incl. `post_no_pantry_line_yet`),
   then the three corpora `--all --phase post --continuous-only`.

**Partial-apply policy:** if this apply fails, stop; F stays applied and release 2 is fixed forward. 0r is for
"applied, B′'s code not yet on dev" only; in the 4r → 3r → 2r chain it runs after 3r.

## Why the deployed writer (F) is compatible

A new table no deployed code names; one nullable column on kitchen_batch_input with no default whose only CHECK
passes on NULL; nothing relaxed, nothing tightened, no view or audit trigger touched. F's line INSERTs name
their columns explicitly, so the new column stays NULL for every F write.

## Rehearsal (this lane)

Local PostgreSQL 16.13 on a throwaway socket, **against a stub schema** (schema_version with F's stamps,
storage_location with 1b's UNIQUE, plants/garden_node, plant_varieties/cultivar, crop_types, preservation_log,
preservation_source, kitchen_batch/v_kitchen_batch_current, kitchen_batch_input, pantry_use with F's CHECKs and
unique indexes, set_updated_at, the two ownership functions) — not a prod dump (the lane has no database
access). Results:

| step | result |
|---|---|
| `pre` on the pre-state | 5/5 PASS |
| 0a, twice | applies; second run is a no-op |
| `post` after 0a | 12/12 PASS |
| `post --continuous-only` on the pre-state, and on a bare database with only schema_version | vacuous PASS, no ERROR |
| mutation: the trigger re-pointed at `prevent_ownership_transfer()` | `post_pantry_item_triggers_present_and_enabled` and `post_pantry_item_ownership_trigger_names_real_columns` FAIL |
| `v4-cascadesweep-001` / `v4-evtanchordel-001` census gates on the applied stub | `post_no_cascade_onto_a_soft_deletable_table`, `post_no_setnull_fk_inside_an_anchor_check`, `post_no_new_triggers_on_touched_tables` PASS |
| behaviour | owner change → `user_id cannot be changed after creation`; blank name, date + `unknown`, an item on a non-pantry line → 23514 by name |
| 0r with an item present | refused, naming "1 pantry_item rows" |
| 0r clean → 0a twice | stamp, table and column gone; re-applies; `post` 12/12 |
| every new route's SQL, executed through a neon-shaped driver on the stub | create/replay/foreign-key replay, place find-or-create, PATCH, used-up toggle, soft delete, GET list both groupings, Went bad / Gave it away, undo / replay / already_undone / batch-line refusal, weighed-bag grams restored, Remove refusals, the pantry line — all as the unit tests assert |

**Still owed at the sitting** (not runnable here): the same `pre`/`post` against a Neon branch of prod after F,
MAIN's and the train's corpora `--all --phase post --continuous-only`, and the integration files
`tests/integration/pantry-items.int.test.js` / `pantry-uses.int.test.js` on the train fork.
