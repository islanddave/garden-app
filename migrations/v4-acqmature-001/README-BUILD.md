# V4-ACQMATURE-001 · Acquired-mature flag on plantings — BUILD SPEC

**Status 2026-08-17: AUTHORED. NOT applied to staging, NOT applied to prod, NOT deployed.**
Lane base: `origin/dev` = `9c335bfbaf4362fdc4e84d99f936dd77ee0a14e1` (v4.31.0).

Gives the "this plant ARRIVED already grown" class an explicit column, so the from-transplant site
calibration can exclude it by predicate instead of by the hand-maintained `STRUCTURAL_OUTLIERS` name
list in `src/lib/maturityCalibration.js`. That list is retired by this change.

## Why a new column and not a predicate over what exists

Nine candidate predicates were measured read-only against the live 41-row calibration cohort
(`_lane_reports/acqmature-recon-20260816b.md` §5). Maximum recall across all nine is **0.50**, and
the miss is always the same row. The decisive evidence is a pair no query can separate:

| | source_type | source_ref | sown_at | container | notes | ratio |
|---|---|---|---|---|---|---|
| King Richard (leek) | `nursery_transplant` | Shawski Farm**s** | NULL | `in_ground` | none | **0.707** |
| Shallots | `nursery_transplant` | Shawski Farm | NULL | `in_ground` | none | **0.122** |

`source_type` is not a weak signal, it is **anti-correlated**: `nursery_transplant` averages ratio
0.763 against a cohort mean of 0.717, i.e. nursery stock is *better* behaved than average. Do not
infer this flag from `source_type`, from a missing `sown_at`, or from the sow-to-transplant gap —
all three were measured against the real cohort and all three fail.

## Files

| file | role |
|---|---|
| `0a-additive-ddl.sql` | 3 nullable columns, no default; provenance CHECK `NOT VALID`; **garden_node view widen 50 → 53**; schema_version. |
| `0b-backfill.sql` | 2 rows by id (Ghost, Shallots). A separate decision — read its header. |
| `0c-validate.sql` | `VALIDATE CONSTRAINT chk_plants_acquired_mature_source`. |
| `0r-rollback.sql` | restore the 50-column view, drop constraint + columns. **Code-revert-first once deployed.** |
| `gates.yml` | 3 pre / 2 sweep / 11 post. Two post gates are `env: prod` — see below. |

Repo-side companions, outside this directory:

    lambda/plants/index.js              INSERT + VALUES + both RETURNINGs, PUT SET-list + RETURNING,
                                        all 4 GET SELECT blocks, POST + PUT validation
    lambda/plants/validate.js           validateAcquiredMature(); tier-3 note on the clear channel
    lambda/plants/acquired-mature.test.js   round-trip + migration-shape guards (15 tests)
    lambda/plants/select-columns.test.js    3 new columns added to the read-symmetry census
    src/lib/maturityCalibration.js      STRUCTURAL_OUTLIERS retired -> isAcquiredMature() +
                                        CALIBRATION_COHORT_EXCLUSION_SQL
    src/__tests__/maturityCalibration.test.js  asserts the PREDICATE, not the two names

## The view widen is the half that silently does nothing

`public.garden_node` is a VIEW over base `public.plants` with an **explicit** 50-column projection
(verified via `pg_get_viewdef` on prod **and** staging 2026-08-17 — byte-identical). The plants
Lambda binds the VIEW for every read *and* for the create `INSERT`. `CREATE OR REPLACE VIEW` can
only append, so a column added to `plants` does not appear in `garden_node` and is invisible to
essentially the whole app. Skipping step 3 of `0a` produces a migration that applies cleanly,
passes every gate that only asks about `plants`, and changes nothing.

`lambda/daily-plan/handler.js` reads base `plants` directly (`from plants p`) and needs no view
change; both consumer shapes coexist.

`lambda/plants/acquired-mature.test.js` diffs `0a`'s view column list against `0r`'s and asserts
`after.slice(0,50) === before` — the byte-for-byte property, executable rather than promised.

## Nullable, no default — the one decision not to reverse

A `DEFAULT false` would write an assertion about all 261 live plantings that nobody made. Ghost and
Shallots would be stamped "did not arrive mature" the instant the migration applied, the calibration
predicate would read that as truth, and the exact two rows the flag exists to exclude would be
silently re-admitted — contamination laundered through a column that looks authoritative.

    NULL   never asked          <- the default, and a distinct claim
    false  asked, started here
    true   arrived already grown

Same shape as `rain_exposed` (`migrations/drg-wxwater-001`): nullable boolean + `_source` provenance
+ `_set_at` stamp. The provenance tag is what lets a future re-fit tell a Dave-asserted value from
this migration's backfilled one — precisely the distinction the retired name list could not make.

**No CHECK is armed over `acquired_mature` itself.** Adding a nullable column is backward-compatible
with the currently-deployed writer; constraining its values would not be. The only CHECK is on
`acquired_mature_source`, a column no deployed writer emits at all, so it is born valid over an
empty column rather than armed over live traffic (cf. the 2026-08-03 harvest `23514`).

## Backfill: exactly two rows, and nothing else

| id | name | evidence | ratio |
|---|---|---|---|
| `1bbfe326-5a99-4124-8bbe-b25de49e4dde` | Ghost | own notes: Greenfield Co-op rescue **acquired 2026-07-12**, set out 07-23, fruiting 08-02. A 100-day pepper does not go set-out → harvest in 10 days. | 0.100 |
| `9cd590d4-05d9-4f68-9b71-b881130653d7` | Shallots | shallots are planted as **sets** — already part-grown bulbs. A fact about the propagule, which is why no per-planting column could infer it. | 0.122 |

Both were re-checked against the n=41 cohort on 2026-08-16 (`_lane_reports/calibrefit-20260816.md`
§6). The next-lowest ratio in the whole cohort is 0.430, so these are a different population, not a
tail.

**Every other row is left NULL**, and that is the most important line in `0b`. 32 live plantings are
`source_type='rescued'` and 18 carry `plant_anchor_derivation.plausibility='rescue_suspect'`; none
is touched. `post_backfill_did_not_bulk_infer` guards it continuously.

`0b` also bumps `updated_at` and `version` on those two rows, via the existing `set_updated_at` and
`garden_node_bump` BEFORE UPDATE triggers. Unavoidable without disabling a trigger, which is not
done. `prevent_ownership_transfer` fires and does **not** raise — it compares `OLD.created_by` to
`NEW.created_by`, and this UPDATE does not name `created_by`.

## Sequencing — the migration goes first, both environments

    staging 0a -> staging 0c -> staging 0b (no-op there)
      -> prod 0a -> prod 0c -> [Dave] prod 0b
      -> dev push of the plants Lambda -> deploy-lambda -> SPA

The plants Lambda names `acquired_mature` **unconditionally** in its `INSERT`, its PUT SET-list and
all four GET SELECT blocks. Landing that code against a database without the column is the L-081
incident verbatim: every plants endpoint 500s. `schema-audit.yml` fires on a dev push touching
`lambda/**/index.js` and will say so.

**A schema-audit waiver is not available here.** `scripts/schema-audit-allowlist.json` is explicit
that a waiver is only legitimate for a ref unreachable in prod because it sits behind an OFF feature
flag. This one is on the hot path.

CI's integration job branches off **staging without applying migrations**, so a skipped staging
apply surfaces as an infra flake and gets retried instead of fixed.

`gate-invariants.yml` is blocking and runs post-gates on `migrations/**` pushes to dev, so pushing
this directory before applying it reds that job too — which is the mechanism working, not a
problem to route around.

`0b` is deliberately environment-agnostic: **staging holds 12 plantings and neither target id**
(verified read-only 2026-08-17), so it is a legitimate no-op there. Its in-file guard asserts "no
target id present here is left NULL" rather than "exactly 2", and the absolute count lives in
`gates.yml` under `env: prod` where it can be stated honestly.

## Verification performed at authoring (2026-08-17)

* All 4 SQL files parse against the real Postgres grammar (`pglast` v8.4 / PG17): 4 + 4 + 1 + 6
  statements, zero errors. **Nothing was executed against any database.**
* `gates.yml` loads clean through `scripts/gate_runner.py::load_gate_file` — 16 gates, schema-valid,
  `env`/`continuous` as intended.
* Prod and staging `pg_get_viewdef('public.garden_node')` diffed: **identical**, 50 columns each.
* Exclusion-mechanism equivalence measured read-only on live prod, same cohort query, only the
  exclusion changed: by name n=35 / 0.7504 / sd 0.1453; by the 2 backfill ids n=35 / 0.7504 /
  sd 0.1453; with no structural exclusion n=37 / 0.7158.
* Vitest: full suite green (counts in `_lane_reports/acqmature-build-20260817.md`).

## What this does NOT do, deliberately

* **No UI affordance.** The wording is Dave's call and the proposal is in the build report. Until a
  form renders it, the flag is settable only through the API or by SQL.
* **No change to what `computeMaturity` shows.** A flagged planting is excluded from the *fit*; its
  own Est.-harvest window still reads off its arrival date and is still wrong. That is a separate,
  user-visible decision — see the build report's design fork.
* **No re-fit of `SITE_FACTOR`.** It stays 0.75 on n=35. The swap is measured as a no-op on the
  number; the value of this change is preventing drift as the garden grows, not correcting today.
* **No bulk inference, no new exclusions.** Yellow Onions (ratio 0.430, the largest surviving
  residual) is explicitly NOT this class — a bulb crop pulled young, sown on site. Flagging it would
  be fitting the exclusion to the answer.
