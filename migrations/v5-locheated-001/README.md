# v5-locheated-001 — `locations.heated` (V5-COLDCARDREACHABLE-001, heated half)

A cold card should only fire for a plant Dave can act on. Of the 61 `protect` cold cards the nightly plan
emitted 2026-09-01..09-17, **29 named plants already in the heated House** (evidence:
`_bdreview_20260917/coldthreshold-recommendation.md` §6.8). The obvious fix, "skip covered locations", is
wrong. `covered` means *rain does not reach it*, and the covered **Stable is unheated**. It also holds more
live plantings (23) than the House (11). Dave, 2026-09-17: *"House is heated, Stable is unheated, shelves are
all in the stable."* The schema had no column meaning "warm". This migration adds it.

| file | what it does |
|---|---|
| `0a-additive-ddl.sql` | One transaction: `ADD COLUMN heated boolean NOT NULL DEFAULT false`, a first-apply-only `heated = true` on the House **by id** (`7ee03125-2470-4400-a870-d931da1ffb92`), and the `5.0.0-locheated-001` stamp. |
| `0r-rollback.sql` | Drops the column and the stamp. **Staging rehearsal only.** On prod, revert the reader first (see below). |
| `gates.yml` | 4 `pre` (incl. the House identity receipt, env prod); 3 standing `post` (self-armed, or naturally vacuous before the apply); 3 apply-window receipts. |

The reader ships in the same branch: `lambda/daily-plan/handler.js` selects `l.heated is true as
heated_resolved`, and `engine.coldFor` returns no card when it is `true`.

## Landing order — NOT OPTIONAL

The handler selects `l.heated` **unconditionally**. There is no flag. On a database without the column, the
nightly plantings query throws. Today then has no plan for either user, and it keeps serving yesterday's stored
plan until someone notices. **Nothing in CI catches this.** The integration job forks from staging but runs no
test that executes the daily-plan plantings query. `select-columns.test.js` (the L-081 SELECT audit) covers
only `weather_daily`. The daily-plan Lambda is prod-only (not in `deploy-staging.yml`'s matrix), so the first
place a missing column would show is the 02:00 production run.

1. **Staging:** `gate_runner.py --migration migrations/v5-locheated-001 --env staging --phase pre` → apply
   `0a` → `--phase post` → rehearse `0r` → re-apply `0a` → `--phase post`.
2. **Prod:** `--env prod --phase pre` (must PASS `pre_house_row_is_the_house`; see its note if
   `pre_house_has_no_child_locations` reports a row) → apply `0a` → `--env prod --phase post`.
3. **Both envs, whole corpus** (per memory `garden-migration-gates-both-envs`):
   `gate_runner.py --all --env prod --phase post --continuous-only`, then the same with `--env staging`.
4. **Only then** push the branch (this directory + the handler/engine commits) to `dev` → CI →
   promote → `deploy-lambda` (daily-plan).

Old code + new schema is **inert**. The deployed Lambdas never name the column. The locations writer's INSERT
lists its columns, so it takes the default. Its `RETURNING *` gains one key that the UI ignores. So steps 1–3
can land any time before step 4, and the gap between them can be as long as needed.

**Rollback:** code back before schema back. First revert the reader (promote a `main` that predates the
`heated_resolved` projection and redeploy daily-plan). Then run `0r`. The reverse order is an outage.

## Design decisions

- **Heated alone suppresses; covered is untouched.** Keying the cold card on `covered` would silence the
  Stable. `heated` is a separate fact, and nothing else reads it.
- **`NOT NULL DEFAULT false`, unlike covered's three-state.** For this column the dangerous error is a false
  TRUE. A wrongly heated location drops the cold card for everything in it. Those plantings are also covered,
  so the frost alert (`frostClass.isCoveredDefault`) already excludes them and nothing would speak for them.
  So "not stated" must read *unheated*.
- **No ancestor inheritance, and that follows from NOT NULL.** Covered's walk (behind
  `CARE_COVER_INHERIT_ENABLED`) fills a NULL from the nearest stated parent. `heated` has no NULL, so the walk
  would stop at depth 0 on every row. The House has **no child locations** (prod, 2026-09-18). A child created
  later reads unheated, so its plantings keep their card. That is noise, which is the safe direction. If a
  warm child should inherit, the column has to become three-state first. That is a separate decision.
- **Selected by id, name checked once as a receipt.** Name-matching is the free-text-identity defect that
  `v4-loccovered-001` retired. The House row was read on prod through `garden_ro`. It is the only row named
  House among all 31 location rows, soft-deleted rows included.
- **No CHECK** (`post_no_check_constraint_over_heated`), for the reason `v4-loccovered-001` gives.
- **`heated` implies `covered`** is a standing gate, not a constraint. It guards hand-written SQL, because
  nothing in the app can set `heated`.

## Known gaps, deliberately not closed here

- **No way to set `heated` from the app.** The locations API and UI do not expose it. Marking a second warm
  location (a heated greenhouse) is SQL-only until a field is added. The follow-up is ledger
  V5-LOCHEATEDUI-001 (Dave-approved 2026-09-18): a Heated checkbox coupled to Rain shelter on the location
  edit form, built on branch `lane-heatedui-20260918`, not yet on dev.
- **Staging's House.** Resolved at apply time: staging's House shares prod's id (`7ee03125-…`, covered, root),
  so the staging backfill marked it heated too.
- **The frost alert used to exclude every covered planting, the unheated Stable included.** Fixed in v4.137.1
  (BUG-FROSTALERTSTABLE-001): `frostClass.summarize` now excludes only heated plantings.

## Applied 2026-09-18
- **Staging:** pre gates PASS (2, plus 2 prod-only); `0a` applied; post gates PASS 5 (+1 prod-only); `0r`
  rehearsed (column and stamp removed); `0a` re-applied; post gates PASS 5 again.
- **Prod** (Dave approved applying before the dev push): pre gates PASS 4/4, including
  `pre_house_row_is_the_house`; `0a` applied at 12:46:39Z; post gates PASS 6/6, including `post_house_is_heated`.
  Only the House is heated.
- **Whole corpus**, `--all --phase post --continuous-only`: prod PASS 765 and staging PASS 746, with no FAIL or
  ERROR on either.
- The reader reached dev in v4.137.0. The "NOT APPLIED" wording in `0a`'s header comment describes authoring
  time; it was left as written.

## Verification performed at authoring (2026-09-18)

**Nothing was applied to staging or prod.** The rehearsal ran against a throwaway local PostgreSQL 17. It was
seeded with the 31 prod `locations` rows (read-only, via `garden_ro`) and with stand-ins for `schema_version`,
`set_updated_at` and `prevent_ownership_transfer`. The shipped `gates.yml` was driven through the shipped
`gate_runner.py`:

- **Unapplied**, `--phase post --continuous-only` (what `gate-invariants.yml` runs): all 3 standing gates PASS
  and the 3 receipts report APPLY_WINDOW_ONLY. Pushing this directory before the apply cannot red CI.
- **Apply `0a`**: exactly one heated row, the House. Its `updated_at` was bumped and the ownership trigger
  passed. All 6 post gates PASS. The pre gates then fail as designed (`pre_heated_column_absent`,
  `pre_not_already_applied`).
- **Rehearse `0r`**: the column and the stamp are gone, and the continuous gates are vacuous and green.
  **Re-apply `0a`**: the House is backfilled again and all 6 PASS.
- **First-apply-only**: set the House to `false`, then re-run `0a`. The House stays `false`, so a re-run
  cannot revert a later edit.
- **Red proofs**, each restored afterwards:

  | mutation | gate that goes red |
  |---|---|
  | open-sky Bag Area marked heated | `post_heated_location_is_covered` |
  | NOT NULL dropped | `post_heated_is_not_null_boolean_default_false` |
  | default set to true | `post_heated_is_not_null_boolean_default_false` |
  | a CHECK armed | `post_no_check_constraint_over_heated` |
  | Stable marked heated | `post_only_the_house_is_heated` |

- **Self-arm and parse-time proofs**, run on a temp copy of this file against the unapplied DB. Removing the
  `schema_version` EXISTS makes the shape gate FAIL before the apply, so the arm is what keeps it vacuous.
  Reading `l.heated` as a column instead of through `to_jsonb` ERRORs with `42703`.
- Reader semantics (`l.heated is true` over the handler's join): House gives `t`. Stable, Shelf 4 and an
  un-located planting all give `f`.
- `gate_runner.py --all --validate-only`: 115 files and 1421 gates are schema-valid. `python3 -m pytest
  scripts/`: 663 passed. PyYAML and `yamllint -d relaxed` are clean apart from line-length warnings, as in the
  rest of the corpus.
