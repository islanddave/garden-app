# v4-harvestaudit-001 — OPS-HARVESTAUDIT-001

Wire `audit_events` onto `harvest_log` and `event_log`, so a row that leaves either table leaves a
trace.

**Not applied to any environment.** Author-only; Dave gates the apply.

---

## Why

`public.audit_events` has been live since 2026-05-11 and holds 1,872 rows. Every one of them is
`plant_varieties`, written by `trg_audit_plant_varieties`. Measured on prod 2026-08-18:

| table | rows | soft-deleted | triggers before this migration |
|---|---:|---:|---|
| `event_log` | 15,019 | 583 | `prevent_ownership_transfer`, `set_updated_at` — no audit |
| `harvest_log` | 735 | 28 | **none at all** |
| `plant_varieties` | 425 | 18 | `trg_audit_plant_varieties` ← the precedent |

So when a crop total on screen disagreed with the database, there was nothing to reconstruct it
from. Hard deletes are real: three live PL/pgSQL functions — `archive_plant_events`,
`archive_container_events`, `unarchive_events_apply` — copy rows to `*_archive` and then
`DELETE FROM public.event_log e WHERE e.id = ANY(v_ids)`. Anything that deletes by another route
(psql, a script, a future migration) leaves no record at all.

## Files

| file | phase | effect |
|---|---|---|
| `0a-additive-ddl.sql` | additive, **inert** | creates `audit_watched_slice`, `audit_stmt_delete`, `audit_stmt_update`. Attaches nothing. |
| `0b-arm-triggers.sql` | **arming** | attaches 4 triggers (DELETE + UPDATE on each table). |
| `0c-verify-triggers.sql` | verification | fixture → exercise → assert → `ROLLBACK`. Safe on prod. |
| `0r-rollback.sql` | rollback | drops triggers, then functions. Keeps the collected audit rows. |
| `gates.yml` | gates | 5 pre, 2 sweep (`continuous: false`), 13 post (all self-armed). |
| `audit-triggers.test.js` | artifact guards | 36 vitest assertions, incl. 0b ↔ gates.yml classification parity. |

## Deploy order

**There is no code deploy on either side of this migration, and that is a measured claim, not an
assumption.** Adding a trigger normally forces ordering, because a trigger that writes a shape the
deployed writer does not expect breaks it the moment it lands. Three facts say this one does not:

1. It writes **only** to `audit_events`, which no Lambda and no SPA surface reads.
2. It **cannot raise.** Every audit INSERT is inside an exception handler that degrades to a
   `WARNING`. Proved on a real Postgres: with the audit writer deliberately broken, the user's
   `DELETE` still committed and the counter `UPDATE` still committed.
3. The actor GUC it reads is **already set by the deployed code**. `lambda/events/index.js` issues
   `set_config('app.actor_clerk_sub', userId, true)` in the same transaction as its soft-delete
   `UPDATE`; `lambda/plants`, `lambda/varieties` and `lambda/photos` do the same. Where it is not
   set, the actor degrades to `'system'` — the behaviour `trg_audit_plant_varieties` has had since
   2026-05-11.

```
1.  0a   STAGING, then PROD      inert; creates functions only
2.  0b   STAGING, then PROD      arms the triggers — this is where behaviour changes
3.  0c   STAGING, then PROD      mechanism proof, rolls back, leaves nothing
```

Migration gates run on **both** environments; run the whole corpus, not just this bundle's gates.

Rollback is `0r`. It **cannot fail on data** — it removes writers, not constraints, so no stored row
can refuse it.

## The three design decisions

### 1. Statement-level, not row-level

`event_log` is batch-shaped. Grouping real prod rows into one-second buckets:

```
max rows in one second : 157        <- one runBulk fan-out = one human action
mean per bucket        : 5.13
buckets >= 50 rows     : 87
```

A `FOR EACH ROW` trigger would run 157 times per burst and open 157 subtransactions for its
exception block. `FOR EACH STATEMENT` with transition tables does it in one `INSERT ... SELECT`. The
hard-delete path is statement-shaped too (`DELETE ... WHERE id = ANY(v_ids)`), so a 11,201-row
delete is **one** trigger call.

### 2. UPDATE is column-scoped — and this is the whole write-amplification story

12,275 of 15,019 `event_log` rows show `updated_at > created_at`. But **11,775 of those (96%) landed
in bulk bursts, and 11,201 landed in a single second**: `2026-08-04 18:53:13`, which is exactly the
`applied_at` of `4.21.3-eventsource-001-backfill` — a migration whose only write is
`UPDATE public.event_log SET source = ...`.

Measured on a real Postgres 17.10, replaying that statement at full scale:

| | audit rows | bytes |
|---|---:|---:|
| unfiltered UPDATE arm | 11,201 | **23 MB in one statement** |
| **this design** | **0** | **0** |

`audit_events` is 5.5 MB in total on prod today. An unfiltered arm would have quadrupled the entire
audit table with one schema backfill that changed nothing forensically relevant, burying the ~500
real user edits in it.

So each UPDATE trigger carries an explicit **watched column list**. Watched = can change a total,
change which planting a row counts toward, change visibility, or change attribution.

The allowlist has a real failure mode — a quantity-bearing column added later would be silently
unaudited. `post_column_classification_is_complete` closes it: it fails when any column of either
table is neither watched (read live from the trigger arguments) nor in the ignored list, so schema
growth forces a decision instead of opening a quiet gap.

Two ignored columns carry the design:

- **`updated_at`** — `set_updated_at` moves it on *every* update. Watching it collapses this back
  into the unfiltered design.
- **`source`** — the 11,201-row backfill target above.

### 3. The audit can never abort the write it audits

`audit_events.actor_clerk_sub` is `NOT NULL` with no default, so a trigger that cannot produce an
actor raises 23502 and kills the user's write. That matters more now: V4-LOSSEVENT-001 adds the
schema's first accumulating writer (plant-reduction events whose `metadata` drives counters on
`plants`, reversed on delete). An audit row is not worth failing a counter transaction for.

Every INSERT is therefore wrapped in an exception block that degrades to `RAISE WARNING`.
**Cancellation is deliberately not swallowed** (`WHEN query_canceled OR admin_shutdown THEN RAISE`) —
converting those to a warning would make the trigger un-cancellable.

Because the handler makes failures invisible, both functions are `SECURITY DEFINER` with a pinned
`search_path` — a missing grant would otherwise degrade into a silently swallowed audit gap. This
deviates from `trg_audit_plant_varieties`, deliberately; that function has no handler, so its
failures are loud.

## What was deliberately not built

**No INSERT arm.** For "which rows existed, with which values, at time T", an INSERT audit row is
redundant twice: a row that still exists carries its own `created_at`, and a hard-deleted row has its
complete pre-image in the DELETE audit's `before_jsonb` (`created_at` included — and `created_at` is
itself watched, so a later edit to it is captured). INSERT is also where 100% of the batch
amplification lives: it *is* the 157-row bursts. Auditing it would roughly double the write volume of
the hottest table in the schema to record facts already on the row. `post_no_insert_arm_was_added`
pins the decision; re-adding it is one `CREATE TRIGGER` plus a re-measurement.

**No TRUNCATE coverage.** `TRUNCATE` bypasses DELETE triggers entirely, so it is a real remaining
hole. It is not closed here because `audit_events_action_check` does not admit a `TRUNCATE` action,
so recording one needs a CHECK widening with its own ordering. Nothing in the app or the archive
functions truncates these tables. The cheap, no-DDL mitigation, if Dave wants it, is to refuse the
operation outright:

```sql
CREATE OR REPLACE FUNCTION public.refuse_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is audited; TRUNCATE bypasses the audit trail. Use DELETE.', TG_TABLE_NAME; END; $$;
CREATE TRIGGER trg_no_truncate_event_log   BEFORE TRUNCATE ON public.event_log   FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_truncate();
CREATE TRIGGER trg_no_truncate_harvest_log BEFORE TRUNCATE ON public.harvest_log FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_truncate();
```

**No retention policy.** Under this design `audit_events` grows only on deletes and material edits,
so growth is slow. It is worth revisiting if a bulk delete ever becomes routine: a DELETE audit row
measured 1,151 bytes and an UPDATE audit row 2,169 bytes (row + three indexes).

**`trg_audit_plant_varieties` was not touched.** It is row-level, has no exception handler, and can
therefore abort a variety write. That is a pre-existing risk in a different table and out of this
bundle's scope — flagged, not fixed.

## Verification

- `0c-verify-triggers.sql` — 14 assertions (A1–A5, B1, C1–C2, D1–D2, E1–E4), green on a real
  Postgres 17.10 whose `event_log`/`harvest_log`/`audit_events` definitions are `pg_dump` output from
  live prod.
- `audit-triggers.test.js` — 36 assertions, 18/18 mutations killed.
- `gates.yml` — 13 post gates, 12/12 gate mutations killed against a live database.
