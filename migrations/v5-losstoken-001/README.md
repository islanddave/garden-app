# v5-losstoken-001 — move the stored loss and give-away tokens out of the status vocabulary

**Status: WRITTEN, GATED, REHEARSED ON A LOCAL POSTGRES 17, UNAPPLIED.** Nothing in this directory has run against
staging or prod. The prod apply is a prod write: Dave's call, and only after the app release it depends on is live.

Ledger row: `V5-LOSSTOKEN-001` (parent `BUG-LOSSEVENTLABEL-001`). Plan and the four review seats:
gardening-docs `project-state/_lossrename-20260929/plan-v2.md` and its `seat-*.md` files. The new names are final
(Dave, 2026-09-29): **`reduction_lost`** and **`reduction_given_away`**.

| file | what it does |
|---|---|
| `0a-data.sql` | One transaction. Snapshots every stored row carrying `failed` / `given_away` (event_log, soft-deleted included, and both copies in event_log_archive) under row locks, renames them by snapshot id, checks the result all or nothing, stamps `5.0.0-losstoken-001`. No DDL on an app table. |
| `0r-rollback.sql` | Puts the old token back on exactly the snapshot ids, never by token, all or nothing; removes the stamp and the snapshot. |
| `gates.yml` | 12 `pre` (2 MANUAL, 1 prod-only), 8 `sweep` (record only), 11 `post`: 4 standing invariants (self-armed, env both) and 7 apply-window receipts (1 prod-only). |
| `rehearse_local.py` | The shipped 0a / 0r / gates.yml on a throwaway local Postgres 17: the whole lifecycle plus a planted violation for every gate. `python3 migrations/v5-losstoken-001/rehearse_local.py`, about 90 s. |

## Why

Dave, 2026-09-29: *"I worry that the namespace 'failed' will confuse future session given that there is also a status
called 'failed' I would prefer to migrate this to a safer reserved namespace."*

`failed` means three things in this app today: a planting status (`PLANT_STATUSES`, `src/lib/constants.js:145`, which
`END_STATUS_OFFER` offers after a planting reaches zero, `lambda/events/validators.js:390`), a kitchen stage kind
(`KITCHEN_STAGE_KINDS`, `lambda/preservation/kitchenBatch.js:44`), and the event type a plant loss is stored under.
`given_away` is both a kitchen batch outcome (`kitchenBatch.js:39`) and the give-away event type. The chosen names sit
where nothing else lives: `reduction_` has one unrelated hit in the code (the `'reduction_invalid'` reason code) and
names the concept the code already uses (`PLANT_REDUCTION_EVENT_TYPES`).

The app release built alongside this makes the new tokens canonical and keeps the old ones as a permanent alias. This
migration rewrites what is already stored, so the database speaks one vocabulary.

### The rows it touches

Whatever carries a legacy token when 0a runs: the target set is fixed at apply time, by the snapshot, under row locks.
**No count and no id is hard-coded in 0a**, because the number grows every time Dave logs a loss. Read on prod
2026-09-29 (read-only, owner DSN): 7 live `failed` rows, 0 soft-deleted, 0 `given_away`, 0 in event_log_archive (494
rows), 0 in event_batches, 0 achievements keyed on either token.

| event_log id | logged | qty_reduced | loss_reason |
|---|---|---|---|
| `71d90490-aa6d-41d3-aa04-45b2eb424c34` | 2026-08-21 | 3 | culled |
| `d0a9b0b4-b49a-4f53-9d28-fd13d214a718` | 2026-08-21 | 2 | disease |
| `30517b7d-8675-4b98-a7c0-90c9f7281f0e` | 2026-08-21 | 2 | disease |
| `3fa4869f-d910-48b9-84ba-396753ffe785` | 2026-08-21 | 8 | disease |
| `b21d6c72-f3e9-44d1-94bc-3c20894f18e3` | 2026-09-01 | 11 | pest |
| `2e3a7526-ce8e-44ca-b983-ba307964f336` | 2026-09-01 | 4 | disease |
| `6dffa249-a23a-4e19-8f7a-5ce159bd9def` | 2026-09-29 | 2 | weather |

Each is on its own planting, carries `plant_id`, an integer `qty_reduced` and its `loss_reason` and nothing else, and has
`updated_at = created_at`. On all 7 plantings `plants.qty_lost` equals the live loss ledger. `gates.yml` names these ids
twice: a pre gate that they still carry `failed`, and a prod-only receipt that the snapshot holds all 7.

### What it leaves alone, deliberately

- **History.** `audit_events` keeps `failed` in its before-images, and `app_events` keeps `event_type=failed` on 7
  `log_entry_created` telemetry rows (measured). Both record what happened at the time; neither is a stored event.
- **Everything but the token.** `set_updated_at` moves `updated_at` on each renamed event_log row (expected; every
  comparison excludes it). No other column changes, which the check block and `post_nothing_but_the_token_moved` prove.
  `plants` counters are not touched: no trigger on event_log writes them.
- **The statuses.** `plants.status 'failed'`, `END_STATUS_OFFER`, the kitchen `failed` / `given_away` and the response
  key `composition.given_away` are different vocabularies and stay as they are (plan-v2 "Do-not-rename").
- **`event_log_public`** is a view over event_log and follows the rename by itself.

## What changes for Dave

**Nothing he can see, when the order below is kept.** The alias release already reads both tokens, so the 7 losses keep
reading "N plants lost", delete still gives the plants back, and the counts do not move. The public site keeps counting
them once gam-site reads both tokens. The change is underneath: the stored rows stop sharing a word with a planting
status, which is what Dave asked for.

## ORDER — the part that matters

1. **gam-site first.** `design-prototype/refresh_live.py` `Q_LOSSES` reads both tokens; `public-export.yaml`
   `allowed_types` gains `reduction_lost` (and `failed` stays, for good); `reduction_given_away` is classified. Published,
   because `refresh.sh` is the deploy. On gam-site origin/main `436570f2` (2026-09-29) none of this is done yet:
   `Q_LOSSES` hard-codes `'failed'` three times, and neither `given_away` nor either new token is classified.
2. **The app release, live in prod on BOTH the events Lambda and the SPA.** Plan stages R1a (reads both, still writes the
   old token) then R1b (writes the new token, reads both). This migration needs **R1b**: with only R1a live, the first
   loss logged after the apply is stored as `failed` again and the standing gate goes red.
3. **This directory on `main`**, so the Tuesday `gate-invariants.yml` cron (which runs main's corpus) watches the
   standing gates from the first week. A push to dev is safe at any time: the four standing gates arm themselves on the
   stamp and are vacuous before it (measured on prod 2026-09-29: 4 PASS, 7 window-only).
4. **Staging**, then **prod**: pre, sweep, 0a, post, sweep. Then the whole corpus on both.

Why code first: code that knows only `failed` (everything live on 2026-09-29: prod `sw.js` reads `v4.158.1-22e7db7`)
reads the STORED token in two places that change counts. After a rename it cannot see, its DELETE of a renamed loss
reverses nothing (`readReductionPlan` on the
stored row, `lambda/events/index.js:2640`), and its PUT lets a renamed loss be edited (the `REDUCTION_EVENT_IMMUTABLE`
guard, `:1662`). Its feed and labels would print the raw token again (`BUG-LOSSEVENTLABEL-001` back).

## One-way for revert

**Once 0a has run on prod, the app release is one-way for revert.** Code below the alias release (R1a) cannot read
`reduction_lost`: a delete would restore nothing, a loss could be edited, and the label regresses. Reverting R1b to R1a
keeps the reads working but writes `failed` again, so `post_no_legacy_reduction_token_is_stored` reds on the next loss;
after the apply the effective floor is R1b. Per the landing-checklist line in `claude-ops/project-rules/gardening-deploy.md`
(§Undoing a bad release), the release lane records this in `scripts/revert-floors.json` (the plan puts the entry in R1b,
at R1a); this lane does not touch that file.

`0r` is the data-side undo, and it is safe under R1a or R1b (both read the old token). It does not make a revert below
R1a safe: rows the new app writes natively after the apply stay new, by design.

## Apply

The apply is a prod write: not part of any ship, and only with Dave's approval. URLs come from `garden-app/.env.local` by
key name, never by pattern, and never typed on a command line. Run one line at a time and read each result. The blocks
carry no comments on purpose (Dave's zsh has no `interactivecomments`).

**0. A checkout that contains this directory.** Go on only if it prints `migration-present`. Afterwards: `cd ~`, then
`git -C /Users/davenichols/AI/Claude/Projects/Gardening/garden-app worktree remove /tmp/apply-losstoken-001`.

```zsh
git -C /Users/davenichols/AI/Claude/Projects/Gardening/garden-app fetch -q origin main dev
git -C /Users/davenichols/AI/Claude/Projects/Gardening/garden-app worktree add --detach /tmp/apply-losstoken-001 origin/main
cd /tmp/apply-losstoken-001
test -f migrations/v5-losstoken-001/0a-data.sql && echo migration-present || echo MIGRATION-MISSING
```

**1. The two URLs by key name, both hosts checked.** Go on only on `prod-host-ok` and `staging-host-ok`.

```zsh
ENVF=/Users/davenichols/AI/Claude/Projects/Gardening/garden-app/.env.local
export NEON_DATABASE_URL="$(/usr/bin/grep -m1 '^NEON_DATABASE_URL=' "$ENVF" | cut -d= -f2-)"
export NEON_STAGING_URL="$(/usr/bin/grep -m1 '^NEON_STAGING_URL=' "$ENVF" | cut -d= -f2-)"
case "$NEON_DATABASE_URL" in *ep-lucky-bird-amju6iqt*) echo prod-host-ok ;; *) echo WRONG-PROD-HOST ;; esac
case "$NEON_STAGING_URL" in *ep-mute-firefly-amq424mj*) echo staging-host-ok ;; *) echo WRONG-STAGING-HOST ;; esac
```

**2. The two MANUAL gates.** `R1B` is the full 40-hex dev SHA of the commit that makes the new tokens canonical: the
v4.160.0 release commit (`feat(events): store plant losses as reduction_lost …`). It is found by the version it set
rather than written in here, so a rebase before the push cannot leave a stale SHA behind; an empty `R1B` makes the
ancestry checks print the failure line, which is the safe direction. Go on only on `garden-events Successful code-matches-marker`,
`events-has-release`, `spa-has-release`, and both gam-site greps printing a match.

```zsh
git -C /Users/davenichols/AI/Claude/Projects/Gardening/garden-app fetch -q origin dev
R1B="$(git log -1 --format=%H -S'"version": "4.160.0"' origin/dev -- package.json)"; echo "R1B=$R1B"
aws lambda get-function-configuration --region us-east-1 --function-name garden-events --query '[CodeSha256,LastUpdateStatus,Description]' --output text | awk '{ split($0, a, " code="); split(a[2], b, " "); print "garden-events", $2, ($1 == b[1] ? "code-matches-marker" : "CODE-MISMATCH") }'
EV_SRC="$(aws lambda get-function-configuration --region us-east-1 --function-name garden-events --query Description --output text | sed -E 's/.* src=([0-9a-f]{40}) .*/\1/')"
git merge-base --is-ancestor "$R1B" "$EV_SRC" && echo events-has-release || echo EVENTS-LACKS-RELEASE
SPA_SHORT="$(curl -fsS https://garden.futureishere.net/sw.js | sed -nE "s/^const CACHE_VERSION = 'v[0-9.]+-([0-9a-f]+)'.*/\1/p")"
git merge-base --is-ancestor "$R1B" "$(git rev-parse --verify "$SPA_SHORT^{commit}")" && echo spa-has-release || echo SPA-LACKS-RELEASE
git -C /Users/davenichols/AI/Claude/Projects/Gardening/gam-site fetch -q origin main
git -C /Users/davenichols/AI/Claude/Projects/Gardening/gam-site show origin/main:design-prototype/refresh_live.py | grep -n reduction_lost
git -C /Users/davenichols/AI/Claude/Projects/Gardening/gam-site show origin/main:public-export.yaml | grep -nE 'reduction_lost|reduction_given_away'
```

The SPA line reads prod's `sw.js`, which read `v4.158.1-22e7db7` on 2026-09-29 (so today it prints the failure line).
The gam-site greps prove the edits are on origin/main, not that a publish has run since: confirm that from gam-site's
own publish record.

**3. Staging first.** Expect `pre`: 9 PASS + 2 MANUAL, with the one prod-only gate n/a (read-only on 2026-09-29 it
printed exactly that). Staging was cut from prod on 2026-08-11, before the first loss on 08-21, and read-only on
2026-09-29 its `sweep` was 0 on every line: no reduction row of either spelling. The first `sweep` run says what it
holds at apply time. With nothing there, expect 0a to print `INSERT 0 0` for the snapshot, `UPDATE 0` twice, the NOTICE
with three zeros, an empty report, `INSERT 0 1` and `COMMIT`: only the stamp and an empty snapshot land, and that is the
correct result, not a wrong host. Expect `post`: 10 PASS, the prod non-vacuity gate n/a.

```zsh
python3 scripts/gate_runner.py --migration migrations/v5-losstoken-001 --env staging --phase pre
python3 scripts/gate_runner.py --migration migrations/v5-losstoken-001 --env staging --phase sweep --json
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-losstoken-001/0a-data.sql
python3 scripts/gate_runner.py --migration migrations/v5-losstoken-001 --env staging --phase post
python3 scripts/gate_runner.py --migration migrations/v5-losstoken-001 --env staging --phase sweep --json
```

**4. Prod.** Expect `pre`: 10 PASS + 2 MANUAL. Expect 0a: `INSERT 0 N` with N >= 7 (an `INSERT 0 0` here means the
wrong host: stop), `UPDATE N` on event_log, `UPDATE 0` on the archive unless something was archived since, the NOTICE
naming the live, soft-deleted and archive counts (they must add up to N and match the first sweep), the N-row report,
`INSERT 0 1`, `COMMIT`. Expect `post`: 11/11 PASS. The second `sweep` must show every legacy count at 0, `sweep_record_new_token_rows`
up by exactly N, and the other two counts unchanged. **A 0a ERROR means a guard fired and nothing changed:** read the
message and re-run `pre`.

```zsh
python3 scripts/gate_runner.py --migration migrations/v5-losstoken-001 --env prod --phase pre
python3 scripts/gate_runner.py --migration migrations/v5-losstoken-001 --env prod --phase sweep --json
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-losstoken-001/0a-data.sql
python3 scripts/gate_runner.py --migration migrations/v5-losstoken-001 --env prod --phase post
python3 scripts/gate_runner.py --migration migrations/v5-losstoken-001 --env prod --phase sweep --json
```

**5. The whole corpus, both environments.** Expect no new FAIL or ERROR.

```zsh
python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only
python3 scripts/gate_runner.py --all --env staging --phase post --continuous-only
```

**If a `pre` gate fails, do not apply.** Each names its reason in `gates.yml`: a malformed reduction row (the rename
would carry it into a standing gate), a reduction key on some other event, an archive row whose two copies disagree, a
near-miss spelling the exact match would skip, a legacy token in event_batches or an achievement, a legacy row newer
than the first new-token row (legacy writes still happening), or one of the 7 authoring rows gone.

## Rollback

```zsh
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-losstoken-001/0r-rollback.sql
python3 scripts/gate_runner.py --migration migrations/v5-losstoken-001 --env prod --phase pre
```

Expect the empty "cannot be restored" table, `UPDATE N`, `UPDATE M`, the NOTICE `restored N event_log row(s) and M
event_log_archive row(s)`, `DELETE 1`, `DROP TABLE`, `COMMIT`; then `pre` passes again. 0r restores by the snapshot's ids
only, so a row the new app wrote as `reduction_lost` is never reverted. It follows a renamed row that has since been
archived or unarchived. It refuses, restoring nothing and keeping the stamp and the snapshot, if any snapshot row is gone,
sits in both tables, or no longer carries the token 0a gave it. Only the token goes back: a renamed loss deleted since
stays deleted. The standing gates disarm with the stamp.

## The gates

**Standing (continuous, self-armed on the stamp, env both).** `post_no_legacy_reduction_token_is_stored`: no stored
`failed` / `given_away` in event_log (soft-deleted included), either archive copy, or event_batches.
`post_reduction_keys_only_on_the_new_tokens`: no non-null `qty_reduced`, `loss_reason` or `giveaway_reason` on any other
event type. `post_loss_reason_only_on_reduction_lost`, `post_giveaway_reason_only_on_reduction_given_away`: each reason
key only on its own token. **The three key gates were measured before arming them:** the PUT route never runs
`validateReduction`, so the question was whether prod already breaks the rule. It does not: 0 violations over all 22,358
event_log rows (947 soft-deleted) and all 494 archive rows, 2026-09-29. The pre gates re-measure it on each environment
before its apply. With the arming clause removed, three of the four read 7 on prod today (the 7 legacy rows) and the
fourth reads 0, so the arming is what keeps them quiet before the apply, not a blind predicate.

**Apply-window receipts (continuous: false).** The stamp; prod non-vacuity (the snapshot holds the 7 authoring rows);
every snapshot row carries its mapped token, judged against the two pairs written out in the gate, never against the
snapshot's own `new_event_type`; nothing but the token (and `updated_at`) moved; per-plant counts and `qty_reduced`
sums per family; no event_log row outside the snapshot carries the apply's timestamp; one audit receipt per renamed row.
They read the snapshot, so they ERROR on an unapplied database and CI never runs them.

**Pre.** Stamp and snapshot absent; the two MANUAL gates; every reduction row well formed (both spellings, archive
included); reduction keys only on reduction rows; the archive's two copies agree; no near-miss spelling; no legacy token
in event_batches; no achievement keyed on one; no legacy row newer than the first new-token row; the 7 authoring rows
still carry `failed` (prod only).

**Sweep (record only).** `failed` / `given_away` counts live and soft-deleted, legacy rows in the archive, new-token
rows, a per-plant family table, and plantings whose `qty_lost` differs from the loss ledger.

## Verification at authoring (2026-09-29)

**Nothing was applied to staging or prod.** Every read was read-only (owner URLs by key name, hosts checked; `BEGIN
TRANSACTION READ ONLY` + `SET LOCAL search_path TO DEFAULT` for prod queries, gate_runner — read-only by construction —
for every gate run, staging's included).

- **Prod, this migration's gates:** `pre` 10 PASS + 2 MANUAL; `sweep` failed live 7, everything else 0, 7 per-plant
  groups, 0 `qty_lost` mismatches; `post --continuous-only` 4 PASS + 7 window-only. With the arming clause removed:
  three standing gates FAIL at 7, the fourth PASS at 0.
- **Staging, this migration's gates (read-only):** `pre` 9 PASS + 2 MANUAL + 1 n/a; `sweep` 0 on all eight lines.
- **The whole corpus with this directory in it, `--all --phase post --continuous-only`, read-only:** prod 793 PASS,
  174 window-only, 13 MANUAL, 4 RETIRED, 0 FAIL, 0 ERROR; staging 769 PASS, 24 n/a, 174 window-only, 13 MANUAL, 4
  RETIRED, 0 FAIL, 0 ERROR. The four standing gates PASS on both (vacuous: unapplied).
- **Prod, the facts behind the design:** PostgreSQL 17.11; event_log triggers `prevent_ownership_transfer`,
  `set_updated_at`, `trg_audit_event_log_upd` (watches `event_type` and `metadata`), `trg_audit_event_log_del`; none on
  event_log_archive or event_batches; no constraint on event_log names either token; the archive's `event_type` column
  equals `row_data->>'event_type'` on all 494 rows; 39 achievements, none keyed on a token; `snap_losstoken001_%` free.
  The live `audit_stmt_update` body and event_log trigger arguments match `v4-harvestaudit-001`, which the rehearsal
  loads.
- **Local Postgres 17.10, `rehearse_local.py`: 72 checks, all as expected, exit 0 (91 s).**
  - Lifecycle: pre 10 PASS + 2 MANUAL; continuous gates vacuous before the apply and all four red with the arming
    removed; 0a renames 8 live + 2 soft-deleted event_log rows and 2 archive rows (both copies); post 11/11; sweep moves
    10 legacy to 0 and new-token rows up by 10 with family totals unchanged; native `reduction_*` rows and unrelated
    rows untouched, `updated_at` included; `updated_at` moved on all 10 renamed rows; 10 audit rows with the migration
    actor; a second 0a refused with nothing changed; 0r restores 10 + 2 and every row equals its pre-apply image
    (`updated_at` aside); the rollback's 10 audit rows carry `migration:v5-losstoken-001:rollback`; a second 0r refused;
    pre passes again; re-apply passes post 11/11; pre on an applied database fails exactly the three unapplied-state
    gates.
  - An empty database (staging's likely shape): 0a applies with an empty snapshot; `post --env staging` all PASS, the
    prod gate n/a; judged as prod, only the non-vacuity gate reds.
  - **Every gate seen failing.** 19 planted pre violations and 15 post violations, each on a fresh copy, each redding
    exactly the gates named (plus two controls, a soft-deleted and an archived authoring row, redding none). Mutants of
    0a: a swapped CASE, a CASE that drops `given_away`, archive `row_data` left behind, an extra column written, and a
    legacy row landing after the snapshot are all refused by 0a itself, database unchanged; with 0a's pair check
    disabled, the swapped CASE is caught by five gates; a full-table `CASE ... ELSE event_type` (which the check block
    cannot see) reds `post_apply_touched_no_event_row_outside_the_snapshot`; a missing audit actor or a disabled audit
    trigger reds the receipt. The shipped 0a refuses an archive row whose copies disagree, a legacy token in
    event_batches, and a leftover snapshot. 0r follows an archived row, refuses a retyped or deleted one, leaves a row
    written after the apply, and a token-keyed 0r mutant reverts the new app's own rows, which is why 0r keys on the
    snapshot.
  - The harness can fail: two weakened copies of gates.yml (the standing gate blind to event_log `failed`; the
    well-formed gate without its quantity test) each red exactly the case they should and exit 1.
- `python3 -m pytest scripts/`: 1048 passed. `gate_runner.py --all --validate-only`: 125 files, 1571 gates.

## Not in scope, noticed

- **gam-site classifies neither give-away token.** `given_away` is in neither `allowed_types` nor `denied_types` on
  origin/main `436570f2`, so the first give-away logged (under either spelling) will stop the publisher at Gate 1. The
  gam-site stage should classify `reduction_given_away` (and `given_away`).
- **The PUT route can write reduction keys onto other events.** `validateEventMetadata` checks only the water-depth
  keys and PUT never runs `validateReduction`. Prod has no such row, and `post_reduction_keys_only_on_the_new_tokens`
  will report one if it happens, but the writer is unguarded.
- **Telemetry keeps the old token.** 7 `app_events` rows say `event_type=failed`. A future reader counting losses from
  telemetry by the new token would miss them.
