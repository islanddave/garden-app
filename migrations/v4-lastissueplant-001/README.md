# V4-LASTISSUEPLANT-001 — backfill `entity_memory.last_issue_at` on the plant-keyed arm

**Ticket:** `BUG-LASTISSUEPLANT-001`
**Kind:** data-only repair (no DDL on any app table)
**Ships with:** the `lambda/events/index.js` change that adds `last_issue_at` to the plant-keyed
forward upsert **and to all six maintenance arms**.
**Ordering:** order-independent with the code. See "Ordering" below.

---

## What was wrong

`entity_memory.last_issue_at` is `MAX(event_date)` over events with `flagged_as_issue = true`. The
**project-keyed** forward upsert has written it since it shipped. The **plant-keyed** sibling never
did.

The reason is mechanical, not an oversight of judgement: care-rekey Step B introduced the plant-keyed
upsert as an additive dual-write and copied its column list from `care-rekey-001/0b-backfill.sql`.
That backfill is keyed on `event_type`. `last_issue_at` is keyed on a **boolean flag**, so it had no
row in an `event_type` mapping table and simply fell out of the list. Every plant-keyed maintenance
arm then inherited the same gap.

Measured on live prod immediately before authoring:

| measurement | value |
|---|---|
| plant-keyed `entity_memory` rows | 262 |
| …with a non-NULL `last_issue_at` | **0** |
| …BEHIND the event log | **72** |
| …AHEAD of the event log | 0 |
| live flagged events (`flagged_as_issue = true`, not deleted) | 72 |
| distinct plantings carrying one | 72 |
| project-keyed rows with `last_issue_at` | 7, all clean (0 ahead, 0 behind) |

Exactly one flagged event per affected planting, so the repair is unambiguous.

**Why it was invisible:** reads are still project-keyed until care-rekey **Step D** cuts over. The
column is nullable with no CHECK. Nothing 500s, nothing logs, and no user-facing surface reads the
plant arm yet. Step D would have turned it into a silent Findings regression — the failure mode this
codebase keeps meeting, where the tests are green because the writer and the reader are both
consistent with each other and both wrong.

## Direction — forwards only, and why that differs from its sibling

`v4-carecacheundo-001` walks the cache **backwards** only. This file walks it **forwards** only.
They are exact mirrors and the asymmetry is deliberate:

| | cause | direction | repair |
|---|---|---|---|
| `v4-carecacheundo-001` | undo left a value **ahead** of the log | lower to truth | recompute arms |
| **this file** | the writer **never fired**, so the value is missing | raise to truth | one-time backfill |

There is no value to lower here — only a value that was never recorded. Gate **P3** asserts 0 rows
are ahead before writing. If it is ever non-zero those rows are **not this ticket**: an AHEAD
`last_issue_at` means an undone or re-anchored flagged event left a stale value, which is the
CARECACHEUNDO class, and its repair is the six recompute arms in `lambda/events/index.js` that now
carry `last_issue_at`.

## The accompanying code change (7 sites)

`last_issue_at` was absent from every one of these. All seven are in `lambda/events/index.js`:

1. plant-keyed **forward upsert** (the ticket itself)
2. batch undo — project-keyed recompute
3. batch undo — plant-keyed recompute
4. single undo — project-keyed recompute
5. single undo — plant-keyed recompute
6. re-anchor — vacated + destination, project arm
7. re-anchor — vacated + destination, plant arm

Sites 2–7 are **not scope creep**. `last_issue_at` on the project arm was written forward through
`GREATEST()` and recomputed by nothing, i.e. it was already one-way — inside the very fix whose
header says it "recompute[s] EVERY recency column, not just watering." Adding the plant-keyed forward
write without them would have minted a second one-way column rather than fixing one.

Guarded by `lambda/events/undo-recompute.test.js`, which now asserts 7 `MAX()`es per arm and,
separately, that `last_issue_at` is recomputed **from the flag** rather than from an `event_type` —
so a future edit cannot satisfy the count while recomputing the wrong set of rows.

## KNOWN REMAINING GAP — read before assuming the column is now maintained

Adding `last_issue_at` to the six recompute arms makes those arms correct. It does **not** make the
column fully maintained, because of a gap those arms do not sit behind.

`lambda/events/index.js:1445` gates the entire recompute on `if (projectChanged || plantChanged)`.
**Unflagging an event changes neither anchor**, so no recompute runs and `last_issue_at` keeps
pointing at an event that is no longer flagged. v4.2.0 shipped the unflag affordance, so this is
reachable from the UI today.

This is the fourth instance of one shared root cause. The other three were found in the same session
by the integration-coverage pass:

| gap | trigger | symptom |
|---|---|---|
| GAP 1 | `event_date` edited **backwards** | `last_watered_at` / `next_water_at` stay forward |
| GAP 2 | `event_type` retyped in place | old type's column stays set, new type's stays NULL |
| GAP 3 | re-anchor **and** retype in one save | `next_water_at` gated on the POST-edit type |
| **GAP 4** | **event unflagged** | **`last_issue_at` stays pointing at it** |

All four are one fix — widen the gate at `:1445` — but widening it correctly is a real design change
(when nothing moved, "old" and "new" are the same key), so it is deliberately **not** in this
migration. Executable `describe.skip` bodies for all four sit in
`tests/integration/reanchor-carecache.int.test.js`; un-skip each in the commit that fixes it.

## Ordering

Order-independent with the Lambda deploy; apply in either order.

Nothing reads `last_issue_at` on the plant arm today, the column is nullable, and it carries no
CHECK — so there is no writer/schema coupling in either direction and neither order can 500 or lose
data. This is **not** the `arming-a-CHECK` hazard: no constraint is added or validated.

- migration first → the 72 rows are correct immediately; new flagged events keep missing the plant
  arm until the code lands.
- code first → new flagged events populate the plant arm; the 72 historical rows stay NULL until
  this runs.

## Apply

```bash
export PGURL="$(grep -E '^NEON_DATABASE_URL=' garden-app/.env.local | cut -d= -f2-)"
psql "$PGURL" -f migrations/v4-lastissueplant-001/0b-data.sql
```

Staging first, then prod, per the usual gate.

## Gates

Run **before** and **after**. All four are plain SELECTs and safe to run read-only.

```sql
-- P1 plant-keyed rows total                          pre 262   post 262   (unchanged)
SELECT count(*) FROM entity_memory WHERE plant_id IS NOT NULL;

-- P2 plant-keyed rows BEHIND on last_issue_at        pre  72   post   0   <-- the repair
SELECT count(*) FROM entity_memory em
 WHERE em.plant_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM event_log e
                WHERE e.plant_id = em.plant_id AND e.flagged_as_issue = true AND e.deleted_at IS NULL
                  AND (em.last_issue_at IS NULL OR em.last_issue_at < e.event_date));

-- P3 plant-keyed rows AHEAD on last_issue_at         pre   0   post   0   <-- must be 0 BOTH times
--    non-zero pre  => those rows are CARECACHEUNDO, not this ticket. STOP.
--    non-zero post => this file moved a cell the wrong way. Roll back.
SELECT count(*) FROM entity_memory em
 WHERE em.plant_id IS NOT NULL AND em.last_issue_at IS NOT NULL
   AND em.last_issue_at > COALESCE((SELECT MAX(e.event_date) FROM event_log e
        WHERE e.plant_id = em.plant_id AND e.flagged_as_issue = true AND e.deleted_at IS NULL),
        '-infinity'::timestamptz);

-- P4 project-keyed rows disturbed                    pre   7   post   7   (this file must not touch them)
SELECT count(*) FROM entity_memory WHERE project_id IS NOT NULL AND last_issue_at IS NOT NULL;
```

Expected write volume: **`UPDATE 72`**. A re-run must report **`UPDATE 0`** — that idempotency check
is the cheapest proof the predicate is direction-correct.

## Rollback

```bash
psql "$PGURL" -f migrations/v4-lastissueplant-001/0r-rollback.sql
```

Restores every snapshotted row to its captured pre-repair value (all NULL on prod) and removes the
`schema_version` row. The snapshot table is left in place; drop it manually once soaked:

```sql
DROP TABLE public.snap_lastissueplant001_entity_memory;
```
