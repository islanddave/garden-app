# v5-putupmake-001 — Put-Up release 1b ("Put it up"), the database half

Plan: `project-state/_crucible-pantry-20260928/04-design-final.md` (V4), the data-model section for release
1b, as amended by `05-release-train.md` (§6 "1b" and "All B releases"). 1b ships in promote **B** together
with releases 2, 3 and 4, **after promote A (release 1a) is live**.

| file | what it does |
|---|---|
| `0a-additive-ddl.sql` | The schema, one transaction, stamp `5.0.0-putupmake-001`. **No backfill.** |
| `0p-post-deploy-backfill.sql` | `use_by_basis` for every existing jar, against frozen matrices. Stamp `5.0.0-putupmake-001-backfill`. **Post-deploy only.** |
| `0r-rollback.sql` | Guarded rollback to the exact pre-1b schema. **Valid only while B's code is off dev.** |
| `gates.yml` | 9 `pre`; 5 `sweep` + 3 for the 0p checkpoint (`mid_backfill_*`, one MANUAL); 25 standing `post` + 1 apply-window receipt. |

Stamps are fixed at first apply anywhere and never edited (05 §2.8): every standing gate self-arms on them.

## Apply order (B's sitting, 05-release-train §3)

1. **Pre-checks, immediately before every apply** (staging in step 4, prod in step 9 — and the Neon branch of
   prod in step 3). Both are also `sweep` gates:

   ```sql
   -- 1. must return 0 rows: 0a arms remaining_count <= package_count, VALIDATED
   SELECT id FROM public.preservation_log WHERE remaining_count > package_count;
   -- 2. must return 0 rows: 0a builds UNIQUE (user_id, kind, lower(label)) WHERE deleted_at IS NULL
   SELECT user_id, kind, lower(label) FROM public.storage_location
    WHERE deleted_at IS NULL GROUP BY 1, 2, 3 HAVING count(*) > 1;
   ```

   ```bash
   python3 scripts/gate_runner.py --migration migrations/v5-putupmake-001 --env <env> --phase pre
   python3 scripts/gate_runner.py --migration migrations/v5-putupmake-001 --env <env> --phase sweep
   ```
   Read `pre_*` and `sweep_*` only. `mid_backfill_0a_applied` is FAIL here **by design** — it belongs to the
   0p checkpoint. A `pre_*_captured_*` md5 mismatch means someone changed an archive routine or the view since
   2026-09-29: 0a would refuse anyway (its fingerprint guard); fold their change into 0a, re-pin, re-rehearse.
2. **0a** — `psql -X -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql`. Never wrap it in BEGIN/ROLLBACK to "try" it on
   a shared database: its own COMMIT escapes your wrapper.
3. **Gates, right after the apply**: `--migration migrations/v5-putupmake-001 --phase post` (all of it,
   including the receipt `post_no_b_shaped_row_yet`), then the three corpora `--all --phase post
   --continuous-only` (the rebased train's, dev HEAD's, main's — 05 §3 steps 4 and 9).
4. … releases 2 → 4 (`v5-pantry-001`, `v5-batchbuilder-001`, `v5-recipes-001`), the push, the promote …
5. **0p, after verify-deploy shows B's Lambda live** (05 §3 step 11): check `mid_backfill_*`, then apply
   `0p-post-deploy-backfill.sql`, then `--migration … --phase post --continuous-only`.

**Staging gets 0p too**, right after deploy-staging puts B's code there (05 §3 step 5) and before the staging
walks: `post_backfill_ran_once_b_writes_a_basis` reds on any database where B has written a basis and the
backfill never ran — which is exactly what a forgotten staging backfill looks like.

**Partial-apply policy** (05 §3 step 9): if any apply in the chain fails, STOP. Leave the releases already
applied in place — 1b's schema is 1a-compatible (below), and every later release is additive over it — and
fix forward. Do not reach for 0r under time pressure; it is for "prod applied, train not yet on dev" only.

**Post-deploy order** (05 §3 step 12), after verify-deploy: **this backfill (0p)** → pesto re-file (the two
basil "passata" jars, through B's PATCH — it must follow the backfill, because the correction rule re-derives
from a table basis) → zucchini fix (through B's PATCH, which carries the quantity pair; omit
`remaining_count`) → recipe seed (only after Dave has seen the list) → `scripts/staged-promote.py clear`.

## Why release 1a's writer (the one deployed when 0a lands on prod) is compatible

The house rule: every CHECK a release arms is tested against the writer that is live when it lands, and NOT
VALID is never the pre-deploy remedy. Each change in 0a is one of:

* **a relaxation kept under its own name** — `chk_preservation_log_attribution` (+ label),
  `chk_preservation_log_method_other` (+ label), `chk_kitchen_batch_start_precision` (+ season, year),
  `chk_kitchen_batch_kind_other` (Other may be unnamed), `chk_ksl_stage_kind` (+ six kinds), `chk_kbi_kind`
  (+ garden, put_up), `chk_kbi_qty_unit` (14 → 25). Each admits a strict superset of what it admitted before.
* **a constraint over a column 1a never writes** — every new column. Notably `use_by_basis` stays NULL on
  every row 1a writes, so the basis/date CHECK is vacuous for it; that is why the backfill is post-deploy.
* **an arming 1a already satisfies**:
  * `remaining_count <= package_count` — 1a's legacy PUT moves `remaining_count` with a changed
    `package_count` and refuses below 0, and ignores the body's `remaining_count` (1a server lane,
    `1b3ae36`). This is the reason promote A must be live before 0a reaches prod.
  * the unit union — the deployed picker's 14 spellings (`g kg lbs oz count cups pints quarts bushels
    half-bushels pecks flats jars bags`) and the harvest prefill's outputs are all inside the 35.
  * `kitchen_stage_log.amount_unit` — 1a validates it against 14 values, all inside KITCHEN_UNITS (25).
  * the quantity pairing — 1a always writes both halves, value > 0.
  * the storage-location UNIQUE — 1a answers its 23505: POST finds and returns the caller's place, PUT
    (rename / re-kind) says 409 `place_exists` (1a server lane, `3d9e83d`).
* **nothing 1a can reach at all** — the view keeps its 30 columns in order (1a reads `SELECT *`, so it gains
  one NULL key, `idempotency_key`); `kitchen_stage_log.entered_at` loses its default, but every shipped
  stage INSERT names it; the archive routines are operator-invoked, never called by deployed code.

**Measured, not argued** — see "Deployed-writer proof" below: the exact SQL of 1a's legacy PUT and of the
storage-location POST/PUT, executed against the rehearsed 1b schema.

## What 0a deliberately does not do, and one premise it corrects

* `chk_preservation_log_quantity_value` and `chk_kitchen_batch_start_pairing` are **untouched**: the first is
  already NULL-safe, the second holds unchanged for the two new precision words.
* **`chk_preservation_log_quantity_unit` did not exist.** V4 and review 3 assumed v5-preservunit-001 phase A
  had put it on the column; neither prod nor staging carries the `5.0.0-preservunit-20260904` stamp or any
  CHECK naming `quantity_unit` (read-only, 2026-09-29). 0a creates it (DROP IF EXISTS + ADD — it widens
  phase A's 22 values in place if phase A ever lands first); 0r restores whichever state it found, keyed on
  that stamp. Phase B (`0b-normalise-and-narrow.sql`) is superseded by this migration and carries a
  do-not-apply header: the union never narrows.
* "A void row carries nothing else" and "void only for a tended, moved or noted row" are **writer rules**
  (the stages and undo routes), not CHECKs; the plan states them as prose, not DDL.
* **What the archive filter cannot do.** Both routines now skip soft-deleted lines, and the container routine
  finally names kitchen batches (Guard 5) instead of dying on a bare 23503. But
  `kitchen_batch_input.harvest_log_id` is `ON DELETE RESTRICT` and a foreign key does not read `deleted_at`: a
  harvest line under a **soft-deleted batch** (reachable today through `DELETE /api/kitchen-batches/:id`)
  passes the guard and still blocks the harvest_log delete with a bare 23503. That predates 1b (Guard 4 has
  filtered `b.deleted_at` since v5-inflightbatch-001); it refuses rather than loses anything, and changing it
  is a decision for the plan, not this file.

## Names the Lambda lanes bind to

A 23505 on these names is a **replay** (V4 "Idempotency"): `uq_preservation_log_idempotency_key`,
`uq_kitchen_batch_idempotency_key`, `uq_ksl_idempotency_key`, `uq_kbi_idempotency_key`; on `uq_ksl_voids_id`
a second Undo of the same row. `uq_storage_location_user_kind_label` is the place key (1a maps it by
SQLSTATE). New CHECK names: `chk_preservation_log_{label_nonblank,label_len,use_by_basis,use_by_basis_date,
texture,texture_method,ph_pairing,ph_scale,put_up_stage_batch,preserved_at_precision,quantity_pairing,
quantity_unit,remaining_within_package}`, `chk_ksl_{entered_precision,entered_pairing,void_pairing,
amount_unit}`, `chk_kbi_{put_up_pairing,role,salt_base,output_needs_put_up}`.

## Rehearsal

Local PostgreSQL 17 only (never Neon): `pg_dump --schema-only --no-owner --no-privileges -n public -n gv`
of prod through `GARDEN_RO_DATABASE_URL` (read-only; the direct endpoint, so pg_dump's session
`search_path=''` never lands on a pooled connection), the 153 prod `schema_version` rows, the V4 fixture, then
the sequence and results below.

Sequence: `pre` → `post --continuous-only` before the apply (must be vacuous: PASS or window-only, never
ERROR) → `sweep` → 0a → full `post` → one planted violation per new CHECK and UNIQUE (each must be refused)
→ 0r → 0a twice → 0p → the NULL-basis gate green; then BOTH corpora (this branch's, and MAIN's via
`git archive <origin/main> scripts/gate_runner.py migrations`) `--all --phase post --continuous-only`
against the replica before and after, every FAIL named.

**Results, 2026-09-29** (PostgreSQL 17.10 local; prod 17.11). Replica: 153 stamps; the V4 fixture — the 5
live put-ups verbatim (zucchini 2.5 qt × 3, the farm-stand plums with no planting, the 4-qt `other` with no
date, the two basil "passata" pestos, plural units), a NULL-remaining jar (Jen's), a pre-1b "No expiry" row, a
fallthrough-dated pesto on a pantry shelf (10 months), three deep-freezer places + that one shelf and no
fridge, and a pre-1b Snapped ferment (kind NULL, precision week) with a harvest line and a purchased line
in lb.

| step | result |
|---|---|
| `pre` | 9/9 PASS |
| `post --continuous-only` before 0a | 25 PASS + 1 window-only, 0 ERROR (vacuous) |
| `sweep` | 5/5 `sweep_*` PASS (`mid_backfill_0a_applied` FAIL by design) |
| 0a | applied, exit 0 |
| `post` | 26/26 PASS |
| planted violations | 48/48 refused with the expected SQLSTATE and constraint — every new CHECK, UNIQUE and FK, the kept-name relaxed CHECKs, ownership transfer (P0001), batch hard deletes (23503); positive controls accepted: a keyed season-precision batch, an undated `put_up` row (`unknown`), `noted`, a void, a jar put up from it (label, basis table, `after`, pH pair, `fl oz`), a label-only no-size jar, an unnamed Other batch, garden / salt / water / put_up / sitting lines, same-name places in another kind, for Jen, and soft-deleted |
| 0r | applied, exit 0; fingerprint (constraints, indexes, triggers, columns, view md5 + ACL, routine md5 + comments, stamps, data) identical to before 0a |
| 0a × 2 after 0r | identical to the first apply |
| 0p | table 6, none 1, typed 1; the NULL-basis gate PASS |

Both corpora `--all --phase post --continuous-only` (FAIL counts before 0a / after 0a / after 0p):

* **this branch: 29 / 29 / 29, the same 29 names each time** — all seeded-reference-data gates that a
  synthetic replica cannot satisfy (achievements, crop-type aliases and rows, habits of the fixture's crop
  rows, the fixture planting's missing care cache, sow-first-year slugs, the sentinel space, xp levels, the
  source catalogue). 1b turns nothing red.
* **MAIN (`22e7db7cbc787129706126dbe5bfdb93ab8d63e7`): 29 / 33 / 33.** The four added are exactly the gates
  release 1a's gates-only commit restates: `v4-putupprov-001::post_column_count_is_25`,
  `v4-putupsession-001::post_column_count_is_25`, `v5-preservunit-001::post_column_is_still_not_null`,
  `v5-putupmultisource-001::post_parent_column_count_unchanged`. (`v5-phrecord-001::post_view_gained_exactly_two`
  stays green: appending kitchen_batch's one new column keeps "view = batch + 8" true.) So the Tuesday cron
  would red on the first database 1b reaches until that commit is on main — 05 §1, A(iii).

Archive routines on the fixture (+ a container C1 whose harvest feeds the batch):

| case | prod bodies (pre-1b) | 1b |
|---|---|---|
| planting archive, live harvest line | Guard 4, named | Guard 4, named |
| planting archive, the harvest line soft-deleted | n/a (no column) | **bare 23503** — the FK still holds (see above) |
| planting archive, the batch soft-deleted | bare 23503 | bare 23503 (unchanged) |
| planting archive, the harvest line removed (hard) | archived | archived |
| container archive, live harvest line | **bare 23503** | Guard 5, named |
| container archive, the line removed | archived | archived |

## Deployed-writer proof

`PREPARE` / `EXECUTE`, against the rehearsed 1b schema, of the exact SQL of release 1a's legacy
`PUT /api/preservation/:id` (RowEditor clearing a date, changing a date, lowering the count below what is
left, Mark used) and of the shipped storage-location POST and PUT with a duplicate label (must be 23505,
which 1a maps). Nothing may violate a 1b CHECK except that intended 23505.

**Results, 2026-09-29**, against `lane-putup1a-server-20260929` HEAD
`3d9e83d8b41182855907182adbb972140c46ca15` (the PUT count delta is `1b3ae36`, the place answers `3d9e83d`).
Each statement PREPAREd with its placeholders numbered in order (one number per reused value) and **no declared
types**, so the server infers them from context as it does for the neon driver's untyped params; EXECUTEd in
autocommit on the rehearsed 1b schema with every basis NULL (the A-to-B window). Arguments mirror the client's
`buildFullPayload` + RowEditor overrides and the handler's own derivations (`package_count ?? 1`,
`consumed_at` stamped at 0 left).

| case (1a legacy PUT) | outcome |
|---|---|
| RowEditor clears the date (zucchini: 3 packages, 3 left) | written, date NULL, basis NULL |
| RowEditor changes the date | written |
| Mark used 3 → 2, then 2 → 1 | written |
| RowEditor lowers the count 3 → 1 with 1 left (1 + (1 − 3) = −1) | **refused inside 1a's UPDATE** (no row; the handler answers 409) — never a 23514 |
| RowEditor lowers the count 3 → 2 with 1 left | written: 2 packages, 0 left, consumed_at stamped |
| raise 1 → 3, then lower 3 → 2 with 3 left (the basil passata) | written: 3/3, then 2/2 |
| Mark used on the NULL-remaining jar (Jen's, 2 packages) | written: 1 left |
| Used up on the no-date Other; Mark used on the farm-stand plums | written; method_other_text and the source pair kept |
| a stale unit `lbs` → `g` on the "No expiry" row | written (both inside the union) |
| 1a POST, 1a createBatch + its started row, a tended row with a unit and pH, unlink of a plain jar | written |

| case (storage location, 1a) | outcome |
|---|---|
| POST a duplicate (`chest freezer 1`, deep freezer) | **23505 `uq_storage_location_user_kind_label`**; 1a's lookup returns Chest Freezer 1 (200, `existing: true`) |
| POST a new name / the same name in another kind / Jen's same name | created |
| PUT rename Chest Freezer 1 → `CHEST FREEZER 2` | **23505**; 1a's clash lookup returns Chest Freezer 2's id (409 `place_exists`) |
| PUT re-kind the pantry "Chest Freezer 1" → deep freezer | **23505**; the clash lookup returns the freezer's id |
| PUT rename to a free name | written |

Three errors in the whole run, all the intended 23505. Every row it left satisfies every 1b CHECK.

**Why 0p waits for B's Lambda, measured:** on the same schema AFTER 0p, 1a's PUT clearing a backfilled date
raises 23514 `chk_preservation_log_use_by_basis_date` — and, the quieter half, 1a's PUT *changing* the date
succeeds and leaves `use_by_basis = 'table'` beside a hand-typed date (a "general figure" label on a date no
table produced). B's legacy PUT refuses a differing date (409 `client_stale`), so neither can happen once B is
live.
