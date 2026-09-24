# v5-invrefstrand-001 — BUG-INVREFSTRAND-001 (option C)

**Something grown from an inventory item, or applied from it, left pointing at the item after it was
soft-deleted.** Guard-only: no DDL, no data written. `0a-arm-guard.sql` inserts one `schema_version`
receipt (`5.0.0-invrefstrand-20260924`), which arms the standing gates.

Option C is Dave's call of 2026-09-24 ("Block only if sown"). It replaces the 2026-09-08 bundle, which
counted all four foreign keys, was never applied on either environment, and was refused on
2026-09-23 because on today's data it would have made every saved-seed lot undeletable and failed
Snap's inventory Undo every time (`project-state/invrefstrand-reverify-20260923.md` in gardening-docs).

## The defect

Four foreign keys point at `inventory_items`, and two of them are `ON DELETE RESTRICT`:

| referencing table | column | `ON DELETE` | what it is |
|---|---|---|---|
| `plants` | `source_inventory_item_id` | **RESTRICT** | the packet a planting was sown from |
| `event_log` | `treatment_product_id` | NO ACTION | the product a treatment was logged with |
| `photos` | `inventory_item_id` | **RESTRICT** | the item's own photos |
| `seed_lot_stage_log` | `inventory_item_id` | NO ACTION | the lot's own processing history |

**None of them can ever fire.** `lambda/inventory-items/index.js` implements `DELETE` as
`UPDATE inventory_items SET deleted_at = NOW()`, and a foreign key guards `DELETE`s, not `UPDATE`s.
The parent survives, the pointer stays technically valid, and every read path filters
`deleted_at IS NULL` — so the reference stops resolving with no error and a 200. A planting sown from
a deleted packet keeps a `source_inventory_item_id` that resolves to nothing, and seed → plant
provenance breaks with nothing to see.

## What counts

A reference that lives **outside** the item — something grown from it, or applied from it:

- **a planting that is not soft-deleted, archived ones included** (`plants.source_inventory_item_id`).
  Archiving is a statement about the garden; the planting is still history (the Archive-Hiding Rule).
  A soft-deleted planting is retracted and does not count — blocking on it would make the item
  undeletable to protect a row nobody can see.
- **a treatment event that is not soft-deleted** (`event_log.treatment_product_id`). 0 rows on prod
  today; it is here because it is the same kind of reference.

The app refuses a delete over exactly these two (`lambda/inventory-items/delete-guard.js`,
`BLOCKING_RELATIONS`): **409**, with a sentence for Dave that says what is in the way, how many,
whether archived plantings are among them, and to set the item's Status to "depleted" instead.
This gate detects exactly these two, with the same live/archived scope — nothing else. A detector
wider than its preventer reds on deletes the app makes on purpose.

## What does not count, and why

What belongs to the item itself. It keeps its pointer and follows the item into soft-deletion, intact;
clearing the item's `deleted_at` brings every one of them back (inventory has no restore route in the
app today, so that is a data fix):

- **its own photos** (`photos.inventory_item_id`) — a packet photo is part of the packet record;
- **its own seed-processing history** (`seed_lot_stage_log`) — every saved-seed lot is born with a stage
  row, the column is `NOT NULL`, and nothing in the app can remove one;
- **the `seed_saved` event's `metadata->>'seed_lot_id'`** — not a foreign key at all, and it describes
  the lot.

Measured on prod 2026-09-24 (owner DSN, read-only): of 525 live items, counting all four relations
would refuse 330 (63%) — 291 of them held only by their own photos and/or stage rows. Counting the two
that count refuses **39**: every one of them a seed packet with exactly one planting sown from it, 10
of those plantings archived.

`garden_node` is a **view** over `plants`, not a fifth referrer — it carries the same
`source_inventory_item_id` and cannot carry a foreign key. Counting it would double-count every
planting.

## Why the predicate is parent-side and not an anti-join

`gate_runner` connects with `NEON_DATABASE_URL` / `NEON_STAGING_URL` — the **owner**, which is
RLS-exempt. For that connection a soft-deleted parent **is** visible, the foreign key guarantees it
exists, and `LEFT JOIN inventory_items i ... WHERE i.id IS NULL` returns **zero rows forever**. (Run
against live prod on 2026-09-08 over the two strands then live, the anti-join spelling read green.)
So the gate asserts `i.deleted_at IS NOT NULL` on an inner join, and
`lambda/inventory-items/delete-gate-coverage.test.js` reds if anyone "simplifies" it back.

## Proving the gate moves

All read-only, through `gate_runner` against the owner DSNs, 2026-09-24. Prod's strands are 0 since
that day's data repairs, so an unarmed-but-green result proves nothing by itself; variants 3–7 are
scratch copies of this file (never committed) that prove the predicate executes, can see rows, and
that the census reds.

| # | variant | expected | measured prod | measured staging |
|---|---|---|---|---|
| 1 | as shipped, unarmed | GREEN (the `migrations/**` push must not red CI) | PASS=3, window-only 1 | PASS=3, window-only 1 |
| 2 | `--phase pre` | 0 rows — nothing to resolve before arming | `rowcount=0` PASS | `rowcount=0` PASS |
| 3 | receipt clause stripped (= armed) | GREEN **executed** — 0 strands today | guard `rowcount=0` PASS | guard `rowcount=0` PASS |
| 4 | armed, predicate inverted to `i.deleted_at IS NULL` (references to LIVE items) | RED with rows — the joins execute | `rowcount=39` FAIL (the 39 plantings on live packets) | `rowcount=0` (staging has no planting pointing at any item) |
| 5 | armed, photos FK dropped from the census allowlist (what a fifth FK looks like) | RED | `rowcount=1` FAIL | `rowcount=1` FAIL |
| 6 | armed, plants FK `confdeltype` r → c in the allowlist | RED | `rowcount=1` FAIL | `rowcount=1` FAIL |
| 7 | armed, feed gate sees 3 of the 4 names | RED (feed gate) | `rowcount=1` FAIL | `rowcount=1` FAIL |

## Prevention is in the handler

`lambda/inventory-items/delete-guard.js` runs one preflight statement before the soft-delete: ownership
first (404 for an item the caller cannot see, before any count is read), then the two counts, then 409
if either is non-zero. There is no override flag. Every writer of the two blocking columns already
refuses to point at a deleted item (`loadOwnedInventoryItem` filters `deleted_at IS NULL`, in both the
plants and events Lambdas), so in the app a strand is made by deleting after pointing — the one place
the check sits.

This migration is the **detector**, and it is not redundant: it covers a reference created between the
check and the UPDATE, a planting or event restored after its item was deleted, and hand-written SQL.

## If the census gate reds

`post_inventory_fk_census_is_unchanged` compares `pg_constraint` against a hand-written list of four
`(conname, confdeltype)` pairs — every one of them classified in `delete-guard.js` as blocking
(`BLOCKING_RELATIONS`) or following (`FOLLOWING_RELATIONS`). It reds for two different reasons and they
want opposite responses:

- **A fifth foreign key now points at `inventory_items`.** Decide which kind it is — a reference from
  outside (something grown or applied from the item: it blocks, and it becomes an arm of the guard and
  of the preflight) or part of the item (it follows). Then add it to the census allowlist, the feed
  gate, and exactly one of the two lists. `delete-gate-coverage.test.js` fails until all of them agree.
- **A `confdeltype` changed.** Weakening a RESTRICT to CASCADE or SET NULL is a real decision about
  data loss. Update the pair only alongside that decision.

**Editing the list to make the red go away without classifying the relation is the failure mode.** The
second census gate (`post_inventory_fk_census_still_finds_all_four`) exists because the first is a
`NOT IN` violation count and therefore also reports zero when `pg_constraint` returns nothing.

## Applying

**Not applied anywhere by the lane that wrote it. Applying is a prod write and needs Dave's approval.**
Pushing this directory before applying is safe: every standing gate self-arms on the receipt, so it is
vacuously green until `0a` runs.

```
python3 scripts/gate_runner.py --migration migrations/v5-invrefstrand-001 --env staging --phase pre
psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -f 0a-arm-guard.sql
python3 scripts/gate_runner.py --migration migrations/v5-invrefstrand-001 --env staging --phase post
# then the same three against prod ($NEON_DATABASE_URL, --env prod)
```

The pre gate must read 0 rows first — it did on both environments on 2026-09-24. Anything it finds is
a strand arming would make visible, and `gate-invariants.yml` goes red on its next run until it is
resolved: **restore** the parent (clear its `deleted_at`) when the reference is real history, or
re-point it at the right live item. **Never** resolve one by clearing a planting's seed source — that
destroys the provenance the guard exists to protect. Those are Dave's calls, not this migration's.

Rollback is `0r-rollback.sql`: one `DELETE` of the receipt, which returns every standing gate to
vacuously green without weakening an assertion. It does not disarm the handler-side check, which is
application code.

## Not closed here

- **How PhotoLibrary shows a live photo whose item is soft-deleted** — the open question option C
  carried. Such photos are now expected (the item's own photos follow it); nothing in this bundle
  changes how they render.
- **An inventory restore route.** Restoring a deleted item is a data fix today.
- **Duplicate seed rows** (OPS-SEEDDUPEROWS-001) remain unmerged and out of scope.
