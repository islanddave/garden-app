# v5-fermentpath-001 — Put-Up release F (the ferment path), the database half

Plan: `project-state/_crucible-pantry-20260928/06-ferment-path.md` (V1) §2, §3 and §5, with review4
`boss-technical.md` F1-F3. The frozen column + route contract for 1b + F together is
`_putupbuild_20260929/contract-F.md` (Gardening docs); the Lambda and UI lanes build against it. F ships in promote
**F** together with release 1b (v5-putupmake-001), after promote A (1a) is live.

| file | what it does |
|---|---|
| `0a-additive-ddl.sql` | The schema, one transaction, stamp `5.0.0-fermentpath-001`. Applies on top of 1b only. |
| `0r-rollback.sql` | Guarded rollback to the exact post-1b schema. **Valid only while F's code is off dev.** |
| `gates.yml` | 6 `pre`; 5 `sweep` (the five tightenings); 18 standing `post` + 1 apply-window receipt. |
| `view-parity.sql` | Read-only: run before and after 0a, compare byte for byte (§5.1 b). |

Stamps are fixed at first apply anywhere and never edited: every standing gate self-arms on F's.

## What 0a adds

* **kitchen_batch**: vessel_label, vessel_size, vessel_unit, vessel_count, no_salt, shu_est_low/high/basis,
  recipe_ref.
* **kitchen_batch_input**: brand, form, shu_rating_low/high, salt_method, base_from, edited_at;
  `chk_kbi_salt_base` widened in place to admit `produce`; five CHECKs that **tighten 1b's salt columns**
  (`chk_kbi_salt_facts_on_salt_line`, `_pairing`, `_grams`, `chk_kbi_salt_pct_range`, `chk_kbi_base_g_positive`);
  `uq_kbi_id_preservation_log_id` (target of pantry_use's same-jar FK).
* **kitchen_stage_log**: acts, mash_in_g, edited_at.
* **preservation_log**: shu_est_low/high/basis, cooked, delta_at, remaining_amount; `trg_audit_preservation_log_upd`
  re-created watching 1b's nine plus remaining_amount, shu_est_low, shu_est_high, cooked.
* **pantry_use** (new): the use ledger, insert-only, with two same-jar composite FKs and the created_by ownership
  trigger.
* **Functions and triggers**: `audit_stmt_update_no_soft_delete()` (kitchen_stage_log has no deleted_at, so the
  shared writer would swallow a 42703 and audit nothing — reproduced in the rehearsal); `prevent_ksl_identity_change()`
  and `prevent_kbi_identity_change()` with one trigger each; audit triggers on kitchen_stage_log and
  kitchen_batch_input.
* **v_kitchen_batch_current**: 1b's 31 columns kept, F's nine appended at 32-40 (md5
  `b70ac2f238dfc9d09e8db2017c0e7474`; the guard also accepts 1b's `c180cfc6868704fdfdf5cc4de1013d6c`).

Every column is nullable with no default (pantry_use is a new table). Every CHECK is VALIDATED and NULL-safe:
`role IS NOT DISTINCT FROM 'salt'`, never `role = 'salt'` — the `=` spelling passes on a NULL role, which the
rehearsal's planted violations caught in the first draft.

## Apply order (F's sitting = 05-release-train §3 with "1b→F")

1. 1b's own sequence first (its README), through its post gates.
2. **Pre-checks, immediately before every apply of F's 0a** (Neon branch of prod, staging, prod):
   ```bash
   python3 scripts/gate_runner.py --migration migrations/v5-fermentpath-001 --env <env> --phase pre
   python3 scripts/gate_runner.py --migration migrations/v5-fermentpath-001 --env <env> --phase sweep
   psql "$URL" -X -At -v ON_ERROR_STOP=1 -f migrations/v5-fermentpath-001/view-parity.sql > before.txt
   ```
   The five `sweep_*` rows are the only F CHECKs that can meet existing data (every other F CHECK is over a new
   column). Each must return 0 rows.
3. **0a** — `psql -X -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql`. Never inside BEGIN/ROLLBACK on a shared database.
4. **Right after**: `view-parity.sql > after.txt; cmp before.txt after.txt`; `--migration … --phase post` (all of
   it, incl. `post_no_f_shaped_row_yet`); 1b's `--phase post`; then the three corpora `--all --phase post
   --continuous-only`.

**Partial-apply policy:** if F's apply fails, stop; 1b stays applied (it is 1a-compatible) and F is fixed forward.
0r is for "applied, F's code not yet on dev" only.

### Sitting-day steps this lane could NOT run (brief: no database but local PG 17 and CI forks)
06 §5.1's "same-day Neon fork of prod" items, to be run at the sitting on the prod branch (step 3 of the train):
(a) `--phase sweep` above (every F CHECK predicate that can meet data) → 0 rows; (b) `view-parity.sql` before/after →
identical; (c) re-measure `SELECT count(*)` of kitchen_batch, kitchen_batch_input, kitchen_stage_log and correct
1b 0a:247's "0 rows on prod" in 1b's README (possibly stale: Dave started two ferments 2026-09-28/29; whether
they are logged in the app was not measured by this lane); (d) snapshot
the live batches' shapes read-only (kind, brine_note non-null, legacy pick lines) as the L3 render fixture and the
N-1 matrix input.

## Why the deployed writer (1a) is compatible

When F's DDL lands on prod the live Lambda is release 1a's (promote A). Every change is one of: a new column 1a never
names; a relaxation under its own name (`chk_kbi_salt_base` + produce); a tightening of a 1b salt column 1a never
writes; triggers 1a cannot trip; nine NULL keys appended to the view 1a reads with `SELECT *`.
**Measured, not argued:** `git grep` over `lambda/` (tests excluded) at prod main
`22e7db7cbc787129706126dbe5bfdb93ab8d63e7` and at the 1a tip `a0462b8f79200e0e832762b4b3c3ad83a3f8bad0`: 0 references
to salt_pct, salt_base, base_g, salt_method or base_from, and 0 `UPDATE kitchen_batch_input` / `UPDATE
kitchen_stage_log` statements (1a only INSERTs and hard-DELETEs lines and INSERTs stage rows), so neither the
tightenings nor the identity triggers can meet a 1a write.

## Corrections to 1b, recorded here (1b's 0a, 0r and stamp are untouched)

* **1b 0a:249 "'harvest' stays in the kind list for stale bundles; new UI never writes it"** no longer holds: F writes
  `input_kind = 'harvest'` for the optional pick link (06 §2.2, DS-I5). Consequence: `kitchen_batch_input.harvest_log_id`
  is RESTRICT, so F keeps harvest lines a hard delete, and batch removal hard-deletes its harvest lines in the same
  statement (06 §3.12) so a later planting or container archive cannot meet a bare 23503.
* **1b's gates.yml** (the one edit F makes to 1b's directory, 06 §3.9): every leg of
  `post_audit_watches_exactly_the_nine` gains `AND NOT EXISTS (… version = '5.0.0-fermentpath-001')`; this directory's
  `post_audit_watches_exactly_the_thirteen` takes over. Proven necessary: 1b's unedited gates.yml (putup-train
  `17c5996`) on a 1b+F replica → `post_audit_watches_exactly_the_nine` FAIL, 4 rows (the four new columns); edited → 26/26
  PASS, before F, after F and after F's 0r.

## Names the Lambda lanes bind to (contract-F.md §2)

23514 on `chk_preservation_log_remaining_count` → 409 `only_n_left`; on `chk_preservation_log_remaining_amount` → 409
`only_g_left`. 23505 on `uq_kbi_idempotency_key` / `uq_pantry_use_idempotency_key` → replay; on `uq_kbi_batch_harvest` →
409 `already_in`; on `uq_pantry_use_reverses_use_id` → the reversal already happened. P0001 `<table>.<col> cannot
change` from the identity triggers means a route let a frozen column through — a bug, not a user error. New CHECK
names: `chk_kitchen_batch_{vessel_label_nonblank,vessel_pairing,vessel_unit,vessel_count,no_salt_true,shu_est_range,
shu_est_basis,shu_est_pairing,recipe_ref_nonblank}`, `chk_kbi_{salt_facts_on_salt_line,salt_facts_pairing,
salt_facts_grams,salt_pct_range,base_g_positive,brand_nonblank,form,form_not_on_role,shu_rating_range,
shu_rating_not_on_role,salt_method,salt_method_on_salt_line,base_from,base_from_needs_base}`,
`chk_ksl_{acts,acts_on_tended,mash_in_g}`, `chk_preservation_log_{shu_est_range,shu_est_basis,shu_est_pairing,
remaining_amount}`, `chk_pantry_use_{count_nonzero,negative_is_reversal,fate,batch_line}`.
Known cause, not a bug (boss-technical minor): a planting whose variety was changed through VarietyPicker points at a
new plant_varieties row with no scoville values (v5-rekeystrand-001), so SHU says "no listed heat" for it; the line's
typed rating is one tap away.

## Rehearsal

Local PostgreSQL 17.10 only, 127.0.0.1:55447. Replica: 1b's prod `pg_dump --schema-only` + 153 prod stamps + the V4
fixture (1b README), then **STATS's two 0a files** (`v5-sourcecontact-001`, `v5-seasonstats-001`, read from
`stats-integ-20260929` @ 9d32464) because STATS applied them to prod and staging before F (boss-technical: F rehearses
on a post-STATS schema) — 155 stamps — then 1b's 0a, then F.

**Results, 2026-09-29** (lane `lane-F-migration-20260929`):

| step | result |
|---|---|
| 1b `pre` → 1b 0a → 1b `post` | 9/9 PASS → exit 0 → 26/26 PASS |
| F `pre` / `sweep` | 6/6 / 5/5 PASS |
| F `post --continuous-only` before F | 18 PASS + 1 window-only, 0 ERROR (vacuous) |
| F 0a | exit 0; 0 audit WARNINGs |
| F `post` / 1b `post` after F | 19/19 / 26/26 PASS |
| F planted cases | **76/76** as expected: every F CHECK (incl. the five tightenings and NULL-role/NULL-unit arms), every pantry_use CHECK, FK, UNIQUE and the ownership trigger, 11 identity-frozen columns (P0001), and the accepted arms (plant_id and deleted_at mutable, stage note editable). Positive controls: Petri Dish (vessel, typed SHU, recipe_ref), started "About 448 g", tended with acts + top-up, put_up with Made 256 g + mash_in_g 180, a weighed 100 g bag at 92 g, a counted jar with a computed SHU and cooked, garden / typed dried chili with brand and rating 0 / three salt lines (brine produce, rinsed water-base 2,000 g scale, grams-only) / water in ml / counted and weighed draws / a pick line / a sitting line; a forward use, its reversal by Jen, and a keyed use-route tap |
| audit | a stage edit → 1 `kitchen_stage_log` UPDATE row with the actor; a line edit → 1 row; an unwatched edit → 0; a line soft delete → SOFT_DELETE; a grams move → 1; a hard-deleted harvest line → 0 rows (the accepted gap, 06 §3.7); a planting hard delete SET NULLs the line's plant_id through the identity trigger |
| DS-B2 reproduced | `audit_stmt_update` attached to kitchen_stage_log → `WARNING … 42703 (column o.deleted_at does not exist)`, 0 audit rows; F's function → 1 row |
| 1b's 48 planted cases + positive controls under F's schema | 0 wrong outcomes; no fixture needed rewriting (1b's salt line, 2.5% peppers of 650 g in g, satisfies all five tightenings) |
| 1b 0a re-applied after F | **refused** by 1b's guard: `v_kitchen_batch_current is md5 b70ac2f2…` (negative test) |
| F 0r | exit 0; fingerprint (1b's family fingerprint + every public relation, function, trigger, constraint, all stamps, kitchen and jar data) **identical to post-1b**; 1b `post` 26/26 (the nine re-armed); F `post` vacuous again |
| F 0a × 2 after 0r, then a third over an applied F | identical to the first apply; exit 0 each |
| 0r guard | refused, naming the reason and changing nothing, for: a pantry_use row, a batch vessel, a line brand, a produce salt line, check-in acts, a jar delta_at, a jar remaining_amount; refused without F applied. F 0a refused without 1b |
| view-parity.sql | before/after F on a replica with three batches (stages with pH and a move, lines): identical |

Gate mutation arms (each on a copy of the F-applied replica; the named gate FAILs): a planted `shu` column and a
`scoville_measured` column → `post_no_measured_shu_column`; audit_stmt_update on kitchen_stage_log →
`post_audit_stmt_update_tables_have_deleted_at` (+ the trigger and watch-list gates); `acts` dropped from the ksl list;
the preservation trigger back to nine → `post_audit_watches_exactly_the_thirteen`; plant_id frozen / output_id unfrozen
→ `post_identity_fn_kbi_names_its_columns`; voids_id unfrozen → `…_ksl_…`; a CHECK gating no_salt on `kind` →
`post_no_f_check_names_kind`; a tightening dropped; salt_base re-narrowed; a same-jar FK dropped; the replay index
dropped; an F column given a default; view columns 32/33 swapped → `post_view_f_columns_in_order`.

Both corpora `--all --phase post --continuous-only` (FAIL counts pre-1b / after 1b / after F):

* **this branch: 29 / 29 / 29**, the same 29 reference-data gates 1b's rehearsal named (a synthetic replica cannot
  satisfy them). F turns nothing red.
* **MAIN (`22e7db7cbc787129706126dbe5bfdb93ab8d63e7`): 29 / 33 / 33.** The four added at 1b are the four release 1a
  restates (1b README); F adds none.

**Re-measured for the sitting, 2026-09-29 (review-F-prepromote-early I6).** The MAIN line above is `22e7db7c`; the
main that exists at the sitting is `421a1f943f61fd762f7ac1087f65cb602458e45b` or later (V5-LOSSTOKEN-001, STATS's two
directories, release 1a's restated gates). The replica was re-seeded from scratch (the same prod dump, 153 stamps and V4
fixture, plus STATS's two 0a files, byte-identical in `421a1f94`, the train and `stats-integ` @ 9d32464 = 155 stamps),
then 1b's 0a, then this 0a. `--all --phase post --continuous-only`, every gate keyed by migration directory + name
(`--json`); FAIL counts before 1b / after 1b / after F:

| corpus | gates | FAIL | gates whose status changed, before 1b → after F |
|---|---|---|---|
| main-to-be `421a1f94` | 1009 | 29 / 29 / 29 | 0 |
| putup-train `a4491acc` (1b's and F's own gates included) | 1054 | 29 / 29 / 29 | 0 |
| old main `22e7db7c` (continuity with the line above) | 973 | 29 / 33 / 33 | 4: 1a's four restated gates, PASS → FAIL at 1b |

**0 new FAIL** in both current corpora. Their 29 are the same set, identical before and after: the replica-only
reference-data gates of 1b's README (none names a kitchen, preservation, STATS or LOSSTOKEN relation). In the train
corpus after F, 1b's directory reads 25 PASS + 1 window-only and this one 18 PASS + 1 window-only. Repeated with
LOSSTOKEN's `0a-data.sql` also applied first (its stamp present, as it will be if its backfill runs before the
sitting): the same counts, the same 29, 0 status changes.

**Integration (real Postgres, CI):** `integration-test.yml` on `lane-F-migration-20260929` — run 36624301265 @
`3ebbd5d`: the train step applied `v5-putupmake-001` then `v5-fermentpath-001` to a fork of (post-STATS) staging, and
60 integration files / 919 tests passed against 1b+F.
