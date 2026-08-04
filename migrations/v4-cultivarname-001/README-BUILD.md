# V4-CULTIVARNAME-001 · Cultivar rename + entity-mirror name sync — BUILD SPEC

**Status 2026-08-04: AUTHORED. Applied + round-tripped on STAGING. NOT applied to prod, NOT
deployed, NOT shipped.** Dev anchor at authoring: `cc70cdb` (= origin/dev = origin/main, v3.97.0).

Closes two tickets that are one job:

| ticket | change |
|---|---|
| `BUG-FLORADADESYNC-001` | `Floridade` → `Floradade` — propagate a cultivar rename that never left `plant_varieties` |
| `BUG-CZECHBUSHID-001` | `Czech Bush Slicer` → `Czech's Bush` |

## Why they are one job

They are the same defect seen from two angles. `entity` is a trigger-maintained mirror of the
identity of every cultivar and planting, and it covered two of the three lifecycle events:

| event | trigger | status |
|---|---|---|
| INSERT | `gv.entity_cultivar_ins` / `gv.entity_planting_ins` | covered |
| soft-DELETE | `gv.entity_cultivar_softdel` / `gv.entity_planting_softdel` | covered |
| name UPDATE | — | **the hole** |

`display_name` was written once at INSERT and never again. On 2026-08-04 someone renamed the
Floradade cultivar and the mirror stayed at `Floridade`; that is `BUG-FLORADADESYNC-001`. Doing the
Czech rename without fixing the hole would have produced a second instance of the same defect
before the first was closed.

**This is not a manual-SQL accident.** The app reproduces it on every rename. `lambda/varieties/
index.js:232` issues `UPDATE public.cultivar SET display_name=…` and `lambda/plants/index.js` issues
`UPDATE public.garden_node SET display_name=…`. Both are auto-updatable views with no `INSTEAD OF`
trigger and no rule, so they resolve straight to `plant_varieties.name` / `plants.name` — and
nothing has ever propagated onward. Prod on 2026-08-04 carried **28 already-drifted mirror rows**
(7 cultivar, 21 planting), every one of them still showing `updated_at = created_at`.

## Why the order is the design

Two independent surfaces resolve this cultivar **by literal name**, in opposite directions:

    DB -> JSON   engine.js resolveCadence(): byV[p.variety] || byV[p.name], no normalization
    JSON -> DB   gen-refweight-seed.mjs -> 0b-seed.sql: WHERE crop_type_slug=… AND name=…

Neither can be made atomic with a database rename, and **both fail silently**. A cadence miss falls
through to the genus default — wrong watering interval, no error, no log line. A seed miss updates
zero rows and reports success.

There is therefore no order in which a straight key-rename is safe. Renaming the JSON key and the DB
row in one change leaves a window where *neither* spelling resolves. The only safe shape is:

**WIDEN → RENAME → NARROW**

1. **Widen (deploy).** Add `"Czech's Bush"` to `by_variety` and **keep** `"Czech Bush Slicer"`. The
   Lambda now accepts both names. No behaviour changes; nothing depends on the new key yet.
2. **Rename (migrate).** `0b-rename.sql`. Every lookup lands on the new key, which is already live.
3. **Narrow (a later, separate deploy).** Drop the legacy key — only after the rename is confirmed
   in prod, and not while `0r-rollback.sql` is still the live rollback path.

### NARROW CHECKLIST — all four in ONE commit, or not at all

The narrow step retires the rollback path. Doing it piecemeal leaves an armed trap: a
`0r-rollback.sql` whose header still promises it is safe without a deploy rollback, when it no
longer is. Running it post-narrow would set the DB back to `Czech Bush Slicer` with no deployed key
to match — the exact silent genus-fallback this whole design exists to prevent.

1. Remove `"Czech Bush Slicer"` from `by_variety` in `lambda/daily-plan/cadence-data-v2.json`, and
   the `alias_keys_note` entry naming it.
2. **Delete `migrations/v4-cultivarname-001/0r-rollback.sql`.** Not edit — delete. A rollback that
   cannot be run safely should not be sitting there looking runnable.
3. Delete the `"by_variety STILL carries the pre-rename key"` and alias-equality tests in
   `lambda/daily-plan/cadence-rename-alias.test.js`.
4. Flip check 5 in `scripts/verify-cultivar-rename.mjs` — it currently asserts `0r-rollback.sql`
   *contains* the old spellings, so post-narrow it would keep passing and keep vouching for a file
   that should no longer exist. It must assert the file is gone.

Steps 3 and 4 are what make the checklist self-enforcing: leave the key in and test 2 passes;
take it out without doing 2 and 4, and nothing complains. Do all four.

This is the 2026-08-03 lesson generalized. That day a VALIDATED CHECK was widened ahead of a writer
that did not yet emit the new value and `23514`'d every prod harvest save. Adding a column is
backward-compatible; validating a constraint over it is a **deploy**, not a migration, because it
breaks the still-deployed old writer. Same shape here: widen what the *reader* accepts before you
change what the *writer* emits, and narrow only afterwards.

**Belt and braces, not braces alone.** The Czech planting actually resolves its cadence from the DB
`care_profile` tier — `engine.js:32` returns early on `db_cadence._seeded`, and `care_profile` is
keyed by cultivar **uuid**, so `by_variety` is never consulted for it today. That makes the cadence
hazard latent rather than live for this particular planting. It is deliberately **not** relied on:
`care_profile` seeding is data, one `DELETE` from being untrue, and the sequencing has to be correct
for the next rename regardless. `0c-verify.sql` check 4c raises a WARNING if that seeding ever
disappears.

## Why `Czech's Bush`

The row's own `origin_region` already said it: *"Czechoslovakia; sent to Ben Quisenberry (USA) by
Milan Sodomka in 1976"* — verbatim the documented provenance of the heirloom catalogued as
**Czech's Bush** ([Tatiana's TOMATOBase](https://tatianastomatobase.com/wiki/Czech's_Bush),
[Plants with Stories](http://plantswithstories.com/tomatoes/czechs-bush)). Determinate, ~70 days,
4–6 oz red — matching this row's `days_to_maturity` 70–75 and `expected_yield_notes` *"4 oz round
red fruits"*. **"Czech Bush Slicer" is attested by no seed house, catalogue or reference.**

The 10× fruit-size disagreement that stopped this rename on 2026-08-03 cuts **across** both
spellings, so it is not evidence of two cultivars — it is a size dispute inside one. Identity
settled: one cultivar, one row, `b2be3698-b782-4a6b-8879-435effc9fcce`, renamed not replaced.

`Floradade` is the UF 1976 release (Flora + Dade County). The row's own `care_notes` and its
victoryseeds `flora-dade` `source_url` both already said so, and the nursery sign OCR reads
*"Tomato - Floradade"*. Peer-reviewed literature uses `Floradade` exclusively.

## Files

| file | role |
|---|---|
| `0a-name-sync-triggers.sql` | additive DDL — 2 functions + 2 `AFTER UPDATE OF name` triggers. No constraint. |
| `0b-rename.sql` | the 4-statement data rename. Idempotent, first-write-wins, id-scoped. |
| `0c-verify.sql` | post-apply proof for the two specific cultivars. Prod-scoped (guarded). |
| `0c-verify-triggers.sql` | environment-agnostic mechanism proof. Self-rolling-back fixture. |
| `0r-rollback.sql` | reverse the rename. Safe **without** a Lambda rollback. |
| `0r-rollback-triggers.sql` | remove the triggers. Read its header — this re-arms the drift. |

Repo-side companions, outside this directory:

    lambda/daily-plan/cadence-data-v2.json          widened by_variety (+ alias_keys_note)
    lambda/daily-plan/cadence-rename-alias.test.js  CI guard for the alias contract
    src/data/harvest-weights-v3-reference.json      authoring source, both names corrected
    migrations/v4-cal1-refweight-001/0b-seed.sql    REGENERATED from the above
    migrations/v4-cal1-refweight-001/README-BUILD.md re-run ordering rule
    migrations/v4-croptype-002/gates.yml            gate note annotated (id is the identity)
    src/__tests__/ripenessCues.test.js              both spellings retained, comments corrected
    scripts/verify-cultivar-rename.mjs              18-check repo-surface proof

## What this does NOT fix, deliberately

* **The other 27 drifted mirror rows.** Prod carries 28 (7 cultivar + 21 planting). Exactly ONE is
  in scope here — entity `52ea7182`, the Floradade cultivar; the other three in-scope rows currently
  agree with their still-stale sources and only drift once this migration moves those sources.
  The triggers stop *new* drift but cannot retro-heal a row nobody edits. `0c-verify.sql` prints the
  full list every run so it stays visible. Healing them is a data decision with its own blast radius
  (several look like deliberate repurposings — `plants.name` "Beefsteak Rescue 1" against a mirror
  reading "Lemon Thyme"), and it belongs in its own ticket.
* **`audit_events`** (15 rows). Immutable history. An audit log recording what a value *was* is the
  audit log working.
* **`daily_plan.items`** (21 rows `Floridade`, 29 `Czech Bush Slicer`, of 95 — measured on prod
  2026-08-04; re-measure before applying, the history grows nightly). Per-day generated snapshots.
  Past days are history; the current day is refreshed by re-invoking the Lambda, which regenerates
  from live names. Hand-editing a generated artifact makes it disagree with its generator.
* **`ctas_*` snapshot tables.** They exist to hold the old values. Rewriting a backup defeats it.
* **Two other name-carrying surfaces, clean today.** Both hold zero rows for these cultivars
  (verified prod 2026-08-04), so neither needs a write — recorded so the next rename checks them
  rather than rediscovering them:
  * `plant_projects.variety` — free-text cultivar name, written by `lambda/projects/index.js:576`,
    read by `lambda/dashboard/handlers.js:194,504`. Only 3 non-NULL rows exist; none is ours. Same
    hazard class as `by_variety`, and the sync triggers do **not** cover it.
  * `slug_alias.alias_string` — entity-name alias table, currently 0 rows.
* **The name-keyed lookup pattern itself.** `by_variety` has 171 literal cultivar keys and a
  documented live collision (`by_variety['Peach']` is a *pepper* profile that collides with the
  Peach tree planting; `frostClass.js:231` exists to contain it). Replacing name keys with cultivar
  uuids would retire this entire hazard class. Out of scope here; worth its own item.

## Rollback

    psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v4-cultivarname-001/0r-rollback.sql

Reverses the rename. **No Lambda rollback required** — the legacy `by_variety` key was retained
precisely so this works against the new deploy. Does *not* drop the triggers (see
`0r-rollback-triggers.sql`, and read its header first). Does *not* revert
`plant_varieties.name` for Floradade, because that rename was correct; the commented statement to do
so is left in the file so the choice is explicit rather than forgotten.

## Verification performed at authoring (2026-08-04, staging)

* `0a` applied; re-runnable (`DROP TRIGGER IF EXISTS` + `CREATE OR REPLACE`).
* `0c-verify-triggers` — **8/8 pass**, including the app's real view-based rename path and the
  blank-name case that proves the trigger cannot reject a previously-succeeding write.
* **Negative control** — dropping both triggers inside a transaction and re-running the identical
  rename reproduces the desync on demand (mirror stayed at the old name). The test tests the fix.
* `0b`, `0r-rollback`, `0r-rollback-triggers` all parse, commit and round-trip; `0a` re-applies
  cleanly afterwards.
* `0c-verify` correctly **refuses** to run on staging rather than passing vacuously.
* Fixture residue: zero rows left behind in `plant_varieties`, `plants`, `entity`.
* Repo: `scripts/verify-cultivar-rename.mjs` 18/18; `vitest` 555/555 daily-plan, 46/46 ripeness +
  cal1 refweights, 7/7 new alias guard; `npm run parity:golden` all 13 fixtures unchanged.

Staging holds **neither** cultivar (full-column `ILIKE` scan of all 922 columns across all 68
staging tables: zero occurrences of any spelling), so the rename itself is first exercised on the
prod apply. Re-run the post gates there; a green staging run is not coverage.

**Staging is left with `0a` + `0b` applied**, so it carries both `schema_version` rows
(`4.21.3-cultivarname-001-namesync`, `-rename`) and both triggers, ahead of prod. The `-rename` row
there records a migration that updated zero rows. That is expected, not drift.

### Adversarial review, and what it changed

An independent skeptic re-derived the surface inventory from scratch (its own `rg -uuu` sweep and
its own full-column scan of all 76 prod / 70 staging tables) and attacked each claim. It confirmed
the inventory, the ordering, the trigger safety analysis, the FK audit and the quoting — and found
four things worth fixing, all now folded in:

1. **"No unique constraint exists on any name column" was FALSE.** `uq_plant_varieties_name_species`
   is a bare `UNIQUE INDEX` on `(lower(name), COALESCE(species,''))` with **no `pg_constraint` row**,
   so the FK audit that produced the claim was structurally incapable of seeing it — the same shape
   as the "querying `pg_constraint` against a VIEW returns clean and means nothing" trap, one level
   over. It is the one mechanism by which the rename can raise. Now: its own pre-gate reading
   `pg_indexes`, plus a pre-flight guard inside `0b-rename.sql`. Verified clear (0 colliding rows).
2. **The `daily_plan` baseline counts were wrong and swapped** (documented 29/24, actual 21/29), and
   `daily_plan` carries *two* rows per date, not one — so the post-gate's "drop by at most one" told
   the operator to diff against a fiction.
3. **The NARROW step left an armed trap.** Nothing tied dropping the legacy cadence key to retiring
   `0r-rollback.sql`, whose header still promised it was safe without a deploy rollback. Now a
   four-step checklist, with `verify-cultivar-rename.mjs` check 5 *coupled* to the key's presence so
   it flips from "the rollback must exist" to "the rollback must be deleted" automatically.
4. **`0c-verify-triggers` checks 5 and 6 used `WHEN OTHERS`**, so a 23505 or any future CHECK would
   have been reported as the sync trigger rejecting the write. Narrowed to `check_violation`.

Two documented facts were also corrected: the residual drift count (27, not 26 — only one of the
four in-scope mirror rows is drifted *today*) and the mechanism by which the Floradade planting
misses the DB cadence tier (`_seeded` absent from a non-NULL merged profile, not a missing row).
