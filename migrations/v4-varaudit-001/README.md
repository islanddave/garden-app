# OPS-VARAUDIT-001 — hardening the live audit trigger on `plant_varieties`

`trg_audit_plant_varieties` has been the only writer to `public.audit_events` since 2026-05-11 and
has written all 1,872 rows in it. It is `FOR EACH ROW` and its function has **no exception handler**,
so a failed audit INSERT aborts the user's `plant_varieties` write. This bundle replaces it with
three statement-level triggers that cannot do that.

**What it records does not change.** Same five actions, same `before_jsonb`/`after_jsonb`, same
INSERT arm, same actor semantics. Only the mechanism changes. See §Decisions.

---

## Deploy order

```
1.  0a-additive-ddl.sql    STAGING, then PROD   inert; creates three functions, attaches nothing
2.  0b-swap-triggers.sql   STAGING, then PROD   the swap — behaviour changes here
3.  0c-verify-triggers.sql STAGING, then PROD   mechanism proof, rolls back, leaves nothing
```

`0r-rollback.sql` reverses 0b and 0a at any point. It cannot fail on data — it removes writers and
re-attaches one, and touches no row and no constraint.

**No Lambda deploy is needed on either side.** The output shape is unchanged and nothing reads
`audit_events` — no Lambda, no SPA surface. The actor GUC the triggers read is already set by the
deployed code (`lambda/varieties/index.js` issues `set_config('app.actor_clerk_sub', …, true)` on all
four of its write paths; `lambda/projects`, `lambda/plants`, `lambda/photos` and `lambda/events` do
the same). Where it is unset the actor degrades to `'system'`, exactly as the live trigger has
behaved since 2026-05-11.

### The swap is atomic; no write is ever unaudited

Measured on a real PostgreSQL 17.10 rather than recalled: `DROP TRIGGER` takes `AccessExclusiveLock`
on `plant_varieties`, `CREATE TRIGGER` takes `ShareRowExclusiveLock`. Locks are held to COMMIT, so
0b holds ACCESS EXCLUSIVE from its DROP until it commits. That conflicts with ROW EXCLUSIVE (every
write) and ACCESS SHARE (every read), so:

- a write already holding its lock completes **under the old trigger** and is audited by it;
- a write arriving after the DROP **blocks**, then proceeds under the three new triggers;
- there is no third case, and a ROLLBACK leaves the original trigger attached and unchanged.

The real risk is the lock **queue**, not coverage: ACCESS EXCLUSIVE waits behind any open transaction
on the table, and everything else queues behind it. `SET LOCAL lock_timeout = '5s'` turns that into a
fast retryable failure instead of a stalled varieties surface.

---

## Decisions

### 1. Statement-level, and therefore three triggers instead of one

Postgres refuses transition tables on a multi-event trigger — verified, verbatim:
`ERROR: transition tables cannot be specified for triggers with more than one event`. Covering
INSERT/UPDATE/DELETE at statement level therefore requires three triggers, and the name
`trg_audit_plant_varieties` ceases to exist.

Why move at all: prod has taken single UPDATE statements of **338 and 326 rows** (the
`4.1.1-planttype-seed-001` and `4.18.0-cal1-refweight-001` backfills, matched to `schema_version`
`applied_at` to the microsecond). Row-level is tolerable *today* only because there is no handler —
adding an exception block to a row-level trigger opens **one subtransaction per row**, and past 64
per transaction the subxid cache spills and every concurrent snapshot check hits `pg_subtrans`. The
handler is what makes row-level expensive; statement level is what makes the handler free.

### 2. The recorded trail is NOT column-scoped — measured, not inherited

The sibling lane OPS-HARVESTAUDIT-001 scopes its UPDATE arm to a watched column list because 96% of
`event_log` updates were one backfill of `source`, a column that is part of no total. **That finding
does not transfer.** Diffing `before_jsonb` against `after_jsonb` across all 1,427 UPDATE audit rows
on prod:

```
 real column change              1386   97.1%
 ONLY updated_at                   40    2.8%
 NO COLUMN CHANGED (no-op)          1    0.1%
```

The bulk bursts on *this* table wrote `unit_weights` / `weight_source` / `weight_confidence` (the
CAL-1 reference weights harvest totals are computed from) and `crop_type_slug` / `lifecycle` /
`growth_habit` / `species` (the variety taxonomy). Scoping would suppress 41 rows out of 1,872 — 2.9%
— in exchange for a permanent discontinuity in a trail running since 2026-05-11, plus an allowlist
whose vacuity mode needs its own completeness gate. The burden of proof for changing an in-use trail
is not met.

Three gates pin the decision so re-scoping is deliberate: `post_update_audit_is_not_column_scoped`
(no `TG_ARGV`, no watched-slice helper), `post_update_trigger_takes_no_watched_column_arguments`
(`tgnargs = 0`), and `post_audit_triggers_have_no_when_clause` (a `WHEN` clause is scoping by another
name).

### 3. The INSERT arm stays

426 existing audit rows depend on it. On a 425-row catalog table the INSERT row *is* the provenance
record of a cultivar definition, and unlike `event_log` there is no batch amplification to trade
against — INSERT bursts here are the seed migrations, which are exactly the events worth recording.
`post_all_three_events_are_covered` pins it.

### 4. `SECURITY DEFINER` with a pinned `search_path`

A strict upgrade on the live function, which is `SECURITY INVOKER` with no `proconfig`. Because the
INSERT is now inside an exception handler, a missing grant would degrade from a loud failure into a
swallowed WARNING — an invisible audit gap. Running as owner removes that failure mode; the pinned
`search_path` is what makes `SECURITY DEFINER` safe.

### 5. Distinct function names from the sibling lane

Both bundles use `CREATE OR REPLACE`. Reusing `audit_stmt_update` / `audit_stmt_delete` would mean
whichever applied second silently rewrote the other lane's trigger bodies — and theirs is
column-scoped, the behaviour this lane measured its way out of. The `audit_pv_*` prefix keeps the two
independent and applyable in either order. `V16` pins it.

---

## A subtlety worth knowing: `WHEN OTHERS` does not catch `query_canceled`

Probed directly on 17.10: PL/pgSQL excludes `query_canceled` from `WHEN OTHERS`, so it propagates
past a bare catch-all on its own. `admin_shutdown` is **not** excluded and *is* swallowed by
`WHEN OTHERS`.

So in `WHEN query_canceled OR admin_shutdown THEN RAISE`, the `query_canceled` half is belt-and-
braces and the **`admin_shutdown` half is the one doing the work**. It is kept explicit because it
documents intent and does not depend on that subtlety staying true. `post_audit_functions_reraise_
cancellation` checks for **both** names — a gate that checked only `query_canceled` would be
asserting the half Postgres already guarantees.

---

## Files

| file | what |
|---|---|
| `0a-additive-ddl.sql` | `audit_pv_stmt_insert/update/delete`. Inert — attaches nothing. |
| `0b-swap-triggers.sql` | drops the old trigger, creates the three, in one transaction with `lock_timeout`. |
| `0c-verify-triggers.sql` | fixture → 11 assertions → `ROLLBACK`. Safe on prod. |
| `0r-rollback.sql` | the three out, the original back in. Keeps collected audit rows. |
| `gates.yml` | 6 pre, 2 sweep (`continuous: false`), 17 post (all self-armed, all violation-shaped). |
| `varaudit-triggers.test.js` | 34 artifact guards over comment-stripped SQL. |

`0c` costs a brief `SHARE ROW EXCLUSIVE` on `audit_events` while it runs (it attaches a temporary
failure-injection trigger there), so concurrent `plant_varieties` writes block for the few
milliseconds it takes. Run it when the varieties surface is quiet.

---

## What was deliberately not built

- **TRUNCATE is uncovered**, as it was before. `TRUNCATE` bypasses DELETE triggers entirely, and
  recording it would need `audit_events_action_check` widened to admit a `TRUNCATE` action — its own
  ordered change. Nothing in the app truncates `plant_varieties`.
- **No retention policy on `audit_events`.** 5.5 MB today, growing ~22 MB/year at current rates.
  Fine, but nobody has decided what happens at year five.
- **The stale comments naming `trg_audit_plant_varieties`** in `lambda/varieties/index.js`,
  `lambda/photos/photoDelete.js`, `lambda/photos/photoDelete.test.js` and
  `migrations/v4-cultivarname-001/0c-verify-triggers.sql` are **not** updated here — all four are
  prose, no gate or code depends on the name, and they belong to files other lanes are editing today.
- **Attribution, not correctness:** any write path that does not set `app.actor_clerk_sub` records
  `'system'`, exactly as today.
