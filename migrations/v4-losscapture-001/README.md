# v4-losscapture-001 — loss cause, loss quantity, harvest disposition

**Status:** authored, gate-schema-validated, **nothing applied to any environment.**
**Ledger items:** `V4-LOSSEVENT-001`, `BUG-LOSSCAUSE-001`, `V4-HARVDISPOSITION-001`.
**schema_version rows:** `4.25.0-losscapture-001` (0a) · `4.25.1-losscapture-001-checks` (0b) ·
`4.25.2-losscapture-001-validate` (0c).

> **`losscapture-001` is a directory slug, not a ticket.** An earlier draft of this bundle cited
> `V4-LOSSCAPTURE-001` throughout. **No such id exists in `project-state/ledger.yaml` and none ever
> did.** The three ids above are the real rows. The slug survives only as the directory name and the
> `schema_version` prefix, both of which are keys other files already reference.

## What it adds

| phase | file | change | reversible by |
|---|---|---|---|
| 1 | `0a-additive-ddl.sql` | `plants.loss_cause`, `plants.qty_lost` formalized in-repo (no-op on prod/staging, which already carry both hand-applied); `harvest_log.disposition` **new**, nullable, no default | `0r` |
| 2 | `0b-arm-checks.sql` | `chk_plants_loss_cause`, `chk_plants_qty_lost_nonneg`, `chk_harvest_log_disposition` — all `NOT VALID` | `0r` (constraint drops only) |
| 3 | `0c-validate.sql` | `VALIDATE` all three against the full heap | irreversible in practice; drop + re-add `NOT VALID` |

`plants.loss_cause` / `plants.qty_lost` **are never dropped** by `0r` — they pre-date this bundle on
both live environments and carry real mortality data this migration did not create.

## Apply order — this bundle is DEPLOY-ORDERED, and that is the whole reason it has three phases

```
1.  DEPLOY  plants Lambda carrying validateQtyLost   ← promote #1, must settle first
2.  0a      ADD COLUMN (columns only)                ← safe against any deployed artifact
3.  (no backfill — this bundle writes no rows)
4.  0b      ADD CONSTRAINT ... NOT VALID             ← requires step 1 to be LIVE
5.  0c      VALIDATE CONSTRAINT                      ← requires step 4
```

**Adding a column is backward-compatible. Arming a CHECK over it is not.** `NOT VALID` is routinely
read as "safe, changes nothing" — it exempts *existing* rows and constrains **every subsequent
write**. So step 4 narrows the contract the **already-deployed** writer must satisfy, and a writer
deployed before the narrowing has no idea it happened.

Concretely: until the guard ships, the plants Lambda writes `body.qty_lost` through a plain
`COALESCE` (PUT) and `?? 0` (POST) with no floor. Arm `chk_plants_qty_lost_nonneg` against that
artifact and a client-supplied negative becomes a **23514 → 500 on a live route**, and any prod row
already holding a negative `qty_lost` becomes **un-editable through the app** (the PUT rewrites the
whole row; the CHECK rejects it). `pre_qty_lost_guard_is_deployed` (manual) refuses the apply until
step 1 is verified.

Only `chk_plants_qty_lost_nonneg` is genuinely blocked. `chk_plants_loss_cause` mirrors an allowlist
the deployed Lambda has enforced since V1.2a-4 S1, and `chk_harvest_log_disposition` guards a column
with no writer at all. All three are armed together anyway — one boundary is easier to operate than
three staggered ones, and `0b`'s header records which is which.

### This cannot be done inside a single promote

`deploy-lambda.yml` ships **all 26 Lambdas in ONE `fail-fast: false` matrix**, triggered by
`push: main`. It is a **separate workflow** from `promote-gate.yml`, whose coupled deploy job is the
**SPA only**. There is no ordering knob inside the matrix and no way to hold one function back, so:

- **"Promote succeeded" does NOT mean the guard is live.** Wait for the `deploy-lambda` run to
  settle, then verify with `aws lambda get-function-configuration --function-name <plants>` and read
  `LastModified` — that timestamp, not the promote's, is the fact `pre_qty_lost_guard_is_deployed`
  asks about.
- **Steps 1 and 4 therefore require SEPARATE PROMOTES.** Promote #1 ships the guard; only once its
  `deploy-lambda` run has settled and `LastModified` confirms it may `0b` run. Attempting to
  sequence code-then-constraint inside one promote is not possible with this topology.
- Steps 2 and 4 may run in the same operator session *after* step 1 has settled — the split exists
  to put a verifiable boundary between the code deploy and the constraint, not to add a wait.

### A THIRD ordering constraint, in the opposite direction — the writer

The two above are *code before schema*. The disposition writer is *schema before code*, and missing
that inverts the hazard rather than avoiding it:

```
2.  0a      ADD COLUMN harvest_log.disposition
5.  DEPLOY  any Lambda that SELECTs or writes harvest_log.disposition   ← never before step 2
```

A column reference is resolved at **parse time**, so a deployed writer naming `disposition` against
a database where `0a` has not run raises **42703 on every request that touches it** — not on the
ones that supply a value. This is the same parse-time fact that forced
`sweep_no_out_of_vocab_disposition` out of the `pre` phase, and it is why the "no writer yet" gap
below is *safe* today: nothing in the repo names the column, so the bundle can be applied in any
order relative to a promote. That stops being true the moment a writer is written.

`plants.loss_cause` has no equivalent constraint — the column already exists on both live
environments and the deployed Lambda already reads and validates it.

### Runbook

```bash
export NEON_DATABASE_URL=...      # never on the command line (L-067)
export NEON_STAGING_URL=...
# 0. promote #1 (guard) merged, deploy-lambda settled, plants LastModified verified

# --- STAGING first, whole sequence ---
python3 scripts/gate_runner.py --migration migrations/v4-losscapture-001 --env staging --phase pre
psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -f migrations/v4-losscapture-001/0a-additive-ddl.sql
psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -f migrations/v4-losscapture-001/0b-arm-checks.sql
python3 scripts/gate_runner.py --migration migrations/v4-losscapture-001 --env staging --phase sweep
psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -f migrations/v4-losscapture-001/0c-validate.sql
python3 scripts/gate_runner.py --migration migrations/v4-losscapture-001 --env staging --phase post

# --- PROD, same sequence, same session. Confirm the host the runner prints before applying. ---
```

**Staging is not optional.** `gate-invariants.yml` runs the continuous post gates against prod
**and** staging on the same cron. A prod-only apply leaves the self-arming gates armed on one
environment and quiet on the other, which is how a gate corpus decays into noise.

## Gates — rewritten 2026-08-18 for the continuous-invariant trap

`continuous:` **defaults to TRUE**, `gate-invariants.yml` runs every continuous **post** gate
against live prod and staging, and it has been **blocking since 2026-08-10**. There is no
skip-if-unapplied logic in `gate_runner.py`. A post gate asserting this migration's own effect
therefore goes red the moment the directory lands on `dev` — before the apply, which here is
deliberately blocked behind a deploy, so the window is open-ended. The first draft shipped **six**
such gates.

Every asserting post gate is now **self-arming** on the `schema_version` row of the phase that
*establishes* the fact it asserts (`0a`'s for the column, `0b`'s for the constraints, `0c`'s for
convalidation) — vacuously true before that phase, a permanent invariant after, no follow-up edit.
Reference shape: `migrations/v4-cachemissingrow-001/gates.yml`.

**One inversion, because copying that reference naively gets it backwards.** Its self-armed gates
are *violation*-shaped (`rowcount_eq 0`, enumerating defects), so a bare `AND EXISTS (schema_version
…)` conjunct suffices. Four gates here are *presence* assertions ("the constraint exists"). On those
a bare EXISTS conjunct returns 0 rows against an expectation of 3 — it fails exactly when it should
be quiet. Each is re-expressed as `SELECT 1 WHERE <armed> AND NOT <the fact>`, expecting 0.

| gate | was | now |
|---|---|---|
| `post_harvest_log_disposition_present_nullable_defaultless` | continuous, unarmed | self-arming on `0a` |
| `post_all_three_checks_present` | continuous, unarmed | self-arming on `0b` |
| `post_loss_cause_vocab_exact` | continuous, unarmed | self-arming on `0b` |
| `post_disposition_vocab_exact` | continuous, unarmed | self-arming on `0b` |
| `post_validate_all_three_checks_convalidated` | continuous, unarmed | self-arming on `0c` |
| `post_schema_version_recorded` | continuous, unarmed | `post_schema_version_0c_recorded`, `continuous: false` (apply-time receipt) |
| `post_no_out_of_vocab_loss_cause` | post | **→ `pre`** — predicts `0c`, not a post-condition of `0a`/`0b` |
| `post_no_negative_qty_lost` | post | **→ `pre`** — same |
| `post_no_out_of_vocab_disposition` | post | **→ `sweep`** — same class, but cannot run in `pre`: the column does not exist yet and a column reference resolves at *parse* time, so no EXISTS guard makes it safe (it would raise 42703, not fail cleanly) |
| `post_checks_not_yet_validated` | post, `continuous: false` | **→ `sweep_checks_armed_not_valid`** |

`post_checks_not_yet_validated` was **mutually exclusive** with
`post_validate_all_three_checks_convalidated` in the same phase — no environment state satisfies
both, so the post phase could not be green at *either* runbook checkpoint, and `continuous: false`
did not save it (that key is honoured only under `--continuous-only`, which the runbook does not
pass). Its real content — *`0b` armed them `NOT VALID`, so no full-table lock was taken* — is a
statement about `0b` checked before `0c`, which is what the `sweep` phase is for.

Nothing in `pre` or `sweep` runs continuously (`gate-invariants.yml` passes `--phase post`), so the
trap is post-only; the audit above covers every gate in the file.

### The two vocabulary gates were self-arming but vacuous — fixed 2026-08-18

`post_loss_cause_vocab_exact` and `post_disposition_vocab_exact` were written as a conjunction of
`pg_get_constraintdef(oid) LIKE '%value%'` tests. That form is satisfied by any **superset** and by
any value that merely *contains* the expected token, so the gate whose own comment says it exists to
catch "a CHECK dropped and re-added with a **widened** ARRAY" could not catch one. Measured on a
scratch PG 17.10 with `0a`+`0b` applied — rows returned, `0` = pass:

| constraint state | old `LIKE` form | set-equality form |
|---|---|---|
| exact vocabulary | 0 — pass | 0 — pass |
| widened with a sixth value `'sabotage'` | **0 — passes** | 1 — fails |
| narrowed by dropping `'unknown'` | 1 — fails | 1 — fails |
| renamed `pest`→`pest_damage`, `unknown`→`unknown_x` | **0 — passes** | 1 — fails |

Both gates now extract the `ARRAY` literals from `pg_get_constraintdef` and assert **set equality**
(`@>` **and** `<@`) — order- and collation-independent, so it does not depend on how the server
renders or sorts. The regex requires the `::text` suffix, so it matches only the vocabulary literals.

`lambda/plants/loss-cause-vocab.test.js` then pins the gate's hard-coded expectation to `0b`'s ARRAY,
alongside the two `ALLOWED_LOSS` copies in `lambda/plants/index.js`. A set-equality gate is only
worth having if the set it compares against is the migration's; without that test an edit to `0b`
that `gates.yml` did not follow would leave the gate confidently asserting a vocabulary the database
no longer has.

`0b`'s header also claimed byte-comparability with `lambda/events/validators.js`'s
`ALLOWED_LOSS_CAUSES`. **No such constant exists or ever has** — the string occurred in exactly one
place in the repo, and it was that comment. The header is corrected; the real twins are the two
`ALLOWED_LOSS` literals in `lambda/plants/index.js`.

## Known gaps, recorded rather than hidden

- **There is still no writer.** This bundle is DDL only. The `POST /api/events` loss path and the
  disposition capture UI that `0a`'s original header described do not exist on this branch
  (`grep -rn 'qty_lost\|disposition' lambda/events/ src/` finds nothing). Until they ship, `0c`
  validates a `disposition` column that is 100% NULL — a real but vacuous assertion, and exactly the
  V4-EVENTSOURCE-001 shape (DDL applied, backfill never ran) that `gate-invariants.yml` exists to
  catch. The three ledger items are not closed by applying this bundle. The writer's own deploy
  ordering is §"A THIRD ordering constraint" above; `loss-cause-vocab.test.js` reds the moment one
  defines an allowlist, so the parity set gets extended rather than a fourth copy started.
- **V4-LOSSEVENT-001 is not addressed by this bundle at all, and no file here can address it.**
  Dave's 2026-07-28 decision was to add a **loss event type**. `EVENT_TYPES` carries 49 members
  (verified against `lambda/events/eventTypes.generated.js` on this branch) and not one of them is a
  loss, mortality, discard or spoilage type — `deadheaded` is the only near-miss and it is a pruning
  action. The vocabulary's source of truth is `src/lib/eventTypes.js`, not the database, so closing
  that item is a code change with a CI drift check (`npm run check:event-types`), not DDL. What this
  bundle contributes to that item is `plants.qty_lost`'s guard and floor; the event type itself is
  untouched work.
- **`plants.loss_cause` and `plants.qty_lost` exist on prod and staging with no migration in the
  repo that created them.** Hand-applied, like `divergence_type` before V4-DIVERGENCEVOCAB-001.
  `0a` formalizes them; the provenance gap itself is not repaired by anything here.
