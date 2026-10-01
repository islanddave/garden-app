# v5-batchbuilder-001 — Put-Up B′ release 3 (the batch builder), the database half

Plan: `project-state/_crucible-pantry-20260928/04-design-final.md` (V4) §4.4, `05-release-train.md` §6 "3:" and
§6a "Archive vs soft deletes", as narrowed by `06-ferment-path.md` §1.3 / §1.6 (F took release 3's column).
Stamp `5.0.0-batchbuilder-001`; applies on top of `v5-fermentpath-001` (the guard refuses otherwise). In the train
it follows `v5-pantry-001` (release 2) and precedes `v5-recipes-001`; it needs nothing from release 2's DDL.

| file | what it does |
|---|---|
| `0a-additive-ddl.sql` | **No DDL.** The one-time dead-pick-link sweep (BUG-ARCHIVESOFTDELBATCH-001) and the stamp, one transaction. |
| `0r-rollback.sql` | Removes the stamp (disarms the standing gate). Does not restore swept links (below). |
| `gates.yml` | 3 `pre`; 1 apply receipt (`continuous: false`); 3 standing `post`, each armed on this stamp. |

## Why release 3 has no DDL

* V4 §4.4's only column, `preservation_log.remaining_amount`, shipped in F (`v5-fermentpath-001` 0a §4; 06 §1.3:
  "release 3's adds no remaining_amount").
* **05 §6 "3: re-create the preservation_log audit trigger with `remaining_amount` watched" — already done by F.**
  F's 0a drops and re-creates `trg_audit_preservation_log_upd` watching thirteen columns, `remaining_amount` among
  them, and F's `post_audit_watches_exactly_the_thirteen` pins the list. Re-creating it here would at best be a no-op
  and at worst drift from F's pinned thirteen, so this file does not touch it. `post_audit_watches_remaining_amount`
  below re-asserts the release-3 obligation on this stamp so it has a gate of its own.
* Everything else in release 3 is Lambda and client work over existing columns: How it was made →
  (`POST /api/kitchen-batches/from-jars`), the planting read (`GET /api/kitchen-batches?plant_id=`), the ranked name
  search, "Like <batch>, except…", a make with nothing kept (the close sheet's When), and pantry lines
  (`kitchen_batch_input.pantry_item_id`, which `v5-pantry-001` adds with its CHECK).

## BUG-ARCHIVESOFTDELBATCH-001 — the decision

**The bug.** `kitchen_batch_input.harvest_log_id` is `ON DELETE RESTRICT`, and a foreign key does not read
`deleted_at`. A pick line that is soft-deleted, or that belongs to a soft-deleted batch, passes both archive routines'
kitchen guards (Guard 4 in `archive_plant_events`, Guard 5 in `archive_container_events`, both filtering
`b.deleted_at IS NULL AND kbi.deleted_at IS NULL`) and then pins its `harvest_log` row, so the routine's harvest delete
aborts with a bare 23503 naming nothing. The 1b rehearsal's fixture table (`v5-putupmake-001/README.md`, "Archive
routines on the fixture") recorded it: *planting archive, the harvest line soft-deleted → bare 23503*; *planting
archive, the batch soft-deleted → bare 23503*.

**The three ways out** (1b README "What the archive filter cannot do", 06 §3.12, `kitchenRoutes.js` deleteBatch):

| option | what it would take | verdict |
|---|---|---|
| (a) FK → `ON DELETE SET NULL` | one FK change | **Does not work.** `chk_kbi_harvest_pairing` (`input_kind = 'harvest'` ⇔ `harvest_log_id IS NOT NULL`) turns the RI action into a 23514 inside the RI trigger — the archive still dies, now inside Postgres's own trigger — and a line that says "a pick went in" but cannot say which is exactly what Guard 4's comment refuses. |
| (b) teach both archive routines to delete dead lines before the harvest delete | a whole-body `CREATE OR REPLACE` of two shared routines | **Riskiest.** Both bodies are md5-fingerprinted by 1b's 0a guard and matched by text fragments in seven gate files (v4-archpreservguard-001, v4-archrestore-001, v4-softdelcascade-001, v5-inflightbatch-001, v5-putupmake-001 …). A routine rewrite re-opens the rehearsed DDL for a shape no writer can create any more. |
| (c) the app never leaves a dead pick link, plus a one-time sweep of the ones left from before, plus a standing gate | F already does most of the first half: take-out hard-deletes a pick line (06 §3.11) and "Remove this batch" hard-deletes its pick lines in the same statement (06 §3.12). **Found while building this:** F's "Undo that put-up" still SOFT-deleted every line of the sitting, a pick added at the end included — a third writer of the dead shape. Release 3's Lambda closes it (`gone_picks` in `undoPutUp`, the same hard delete). This file adds the sweep and the gate. | **Chosen.** |

**Why (c) is the safest.** No schema, routine or FK changes — so nothing another gate fingerprints moves, and the
deployed writer (F's Lambda) is unaffected by construction. The only rows it deletes are ones no route reads
(`readBatch`, `readLines` and `v_kitchen_batch_current` all filter soft-deleted lines and batches), and no FK points
at a pick line (pantry_use references draw lines only). It loses nothing that is evidence: the pick itself stays in
`harvest_log`, a removed batch has no restore, and the line was only a link — the same trade 06 §3.12 already made for
every batch removed since F. The one shape it cannot prevent by itself — a future writer that soft-deletes a pick
line — is caught by `post_no_dead_pick_link` (standing, one row per violator) and by the unit-lane static test
`lambda/preservation/batchbuilder-migration.static.test.js`, which pins that every Lambda soft delete of
`kitchen_batch_input` excludes pick lines.

**Where the residue comes from.** Batches removed through the shipped soft `DELETE /api/kitchen-batches/:id` before
F (live since V5-INFLIGHTBATCH-001; that route soft-deleted the batch and left its lines). 05 §6a measured 0 prod
batches on 2026-09-29; Dave started ferments on 2026-09-28/29, so the count at the sitting is whatever the sweep's
`NOTICE` says. Run `pre` and read the notice into the sitting log.

**Rollback.** `0r` removes the stamp only. The swept links are not restored (they were links under removed batches;
0a's NOTICE lists each id). Valid only while release 3's code is off dev; afterwards leave it applied (no schema, so
compatible with every earlier Lambda).

## Proof

* Unit lane: `lambda/preservation/batchbuilder-migration.static.test.js` (line-2 stamp = the INSERT; no DDL
  statement in 0a; the sweep block's predicate; every gate armed on the stamp, catalog joins only, no `::regclass`;
  every Lambda soft delete of `kitchen_batch_input` excludes pick lines).
* Integration lane: `tests/integration/batchbuilder-archive.int.test.js` seeds both dead shapes on the train fork,
  shows the bare 23503, runs the sweep block from this file (scoped to its own household so parallel files are
  untouched), and shows both archives succeed, the pick kept in `harvest_log_archive`, and `post_no_dead_pick_link`'s
  SQL returning 0 rows for those ids.
* Not run by this lane (no database): the local PG 17 rehearsal and the Neon-branch dry run. At the sitting: `pre`,
  0a (read the NOTICE), `post`, then 0r and 0a again (identical: 0a is a no-op the second time).
