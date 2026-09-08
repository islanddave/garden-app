# v5-invrefstrand-001 — BUG-INVREFSTRAND-001

**Rows left pointing at a soft-deleted `inventory_items` row.** Guard-only: no DDL, no data written.
`0a-arm-guard.sql` inserts one `schema_version` receipt, which arms three standing gates.

## The defect

Four foreign keys point at `inventory_items`, and two of them are `ON DELETE RESTRICT`:

| referencing table | column | `ON DELETE` |
|---|---|---|
| `plants` | `source_inventory_item_id` | **RESTRICT** |
| `photos` | `inventory_item_id` | **RESTRICT** |
| `seed_lot_stage_log` | `inventory_item_id` | NO ACTION |
| `event_log` | `treatment_product_id` | NO ACTION |

**None of them can ever fire.** `lambda/inventory-items/index.js` implements `DELETE` as
`UPDATE inventory_items SET deleted_at = NOW()`, and a foreign key guards `DELETE`s, not `UPDATE`s.
The parent survives, the children keep technically-valid pointers, and every read path filters
`deleted_at IS NULL` — so the reference stops resolving with no error and a 200.

Reading `ON DELETE RESTRICT` and concluding the database is protecting you is the whole trap. It is
protecting a delete that never happens.

What it costs, in this repo's own code:

- **`seed_lot_stage_log` history goes blank, not error.** The `/seed-stage` GET joins
  `public.inventory_items i ... AND i.deleted_at IS NULL` and then `resp(200, rows)`. Soft-delete the
  lot and its stage history returns **HTTP 200 with `[]`** — indistinguishable from "this lot has no
  history".
- **`plants.source_inventory_item_id` becomes a dangling pointer.** `lambda/plants/index.js` returns
  it raw with no join, so the planting keeps an id that resolves to nothing and seed → plant
  provenance breaks with nothing to see.

`garden_node` is a **view** over `plants` (`relkind = 'v'`), not a fifth referrer — it carries the
same `source_inventory_item_id` and cannot carry a foreign key. It is deliberately not a separate arm
of the guard; counting it would double-count every planting.

## What is live on prod right now

Measured 2026-09-08 through `gate_runner` against the owner DSN (`conn.read_only = True`), and
independently via `psql-ro.sh`. **Two rows**, not zero:

| referrer | id | detail | dangling target |
|---|---|---|---|
| `plants` | `7ca159f5-3dc5-4d3e-9f5b-c6676ecd454c` | "Hungarian" (Black Hungarian), `status=failed`, archived 2026-07-20 | `5ea890a3-b0f0-44ae-ae36-cd1cbfb15ded` |
| `seed_lot_stage_log` | `4bb986e7-c977-4b85-9884-3a92724ca820` | stage `fermenting`, entered **2026-09-07 12:23** | `4074e59e-c9be-4762-af59-c28ebd9c73d6` |

The second is the documented cost happening in production: that lot's stage history is already
answering 200 with an empty array. `photos` (6 references) and `event_log` (0 references) are clean.

There is **no audit trail on `inventory_items`** (`audit_events WHERE table_name='inventory_items'`
→ 0 rows), so nothing can say when either parent was deleted or by which route.

## Why the predicate is parent-side and not an anti-join

This is the correctness argument of the whole file, and getting it backwards ships a gate that reads
GREEN over the damage it exists to catch.

Reading as `garden_ro`, the natural spelling is
`LEFT JOIN inventory_items i ... WHERE i.id IS NULL`: RLS on `inventory_items` carries
`deleted_at IS NULL`, so a soft-deleted parent simply is not there and the anti-join finds it.

`gate_runner` connects with `NEON_DATABASE_URL` / `NEON_STAGING_URL` — the **owner**, which is
RLS-exempt. For that connection the parent row **is** visible, the foreign key guarantees it exists,
and the anti-join returns **zero rows forever**. Confirmed by running exactly that spelling against
live prod over the two findings above: `rowcount=0`.

So the gate asserts `i.deleted_at IS NOT NULL` on an inner join.
`lambda/inventory-items/delete-gate-coverage.test.js` pins that shape and reds if anyone
"simplifies" it back.

## Proving the gate moves

All read-only, through `gate_runner`. The migration is **not applied**, so "armed" was simulated by
replacing the receipt clause with a tautology — which is exactly what an applied receipt makes it.

| # | variant | expected | measured |
|---|---|---|---|
| 1 | as shipped, unarmed | GREEN (so the `migrations/**` push does not red CI) | `rowcount=0` PASS |
| 2 | armed | RED, finding the live strands | `rowcount=2` FAIL |
| 3 | armed, rewritten as the anti-join | GREEN over the same damage — the trap | `rowcount=0` PASS |
| 4 | armed, one FK dropped from the census allowlist | RED | `rowcount=1` FAIL |
| 5 | armed, a RESTRICT flipped to CASCADE in the allowlist | RED | `rowcount=1` FAIL |
| 6 | armed, one constraint renamed so the census sees 3 of 4 | RED (feed gate) | `rowcount=1` FAIL |
| 7 | armed, against **staging** | runs, no ERROR | all three PASS, `rowcount=0` |

Row 3 is the one that earns the file: the obvious spelling is silently vacuous.

Line 7 is why no `env:` is declared on the standing gates — staging was reached and carries every
substrate they touch. Only the `pre` gate is `env: prod`, because staging has zero strands and a
`rowcount_gte 1` there would fail while describing nothing wrong.

## Prevention is elsewhere, and it already landed

`lambda/inventory-items/delete-guard.js` adds a pre-delete reference count to the DELETE arm: the
route now answers **409** naming what is in the way, instead of stranding it on a 200.
`?force=true` overrides and writes a `console.warn` naming the item and the counts.

That closes the app-side path completely, because every *writer* of these four columns already
refuses to point at a deleted item (`loadOwnedInventoryItem` filters `deleted_at IS NULL`, and so
does the `/seed-stage` CTE). A strand can only be created by deleting **after** pointing.

This migration is the **detector**, and it is not redundant: it covers hand-written SQL, the two
findings that predate the handler change, and any future write path that forgets.

## If the census gate reds

`post_inventory_fk_census_is_unchanged` compares `pg_constraint` against a hand-written list of four
`(conname, confdeltype)` pairs. It reds for two different reasons and they want opposite responses:

- **A fifth foreign key now points at `inventory_items`** (V5-SOURCEENTITY-001 is actively attaching
  source columns to this table). The guard does not span it. Add the relation to **three** places:
  the `UNION ALL` in both the `pre` and `post` gate SQL, the allowlist in *both* census gates, and
  `REFERRING_RELATIONS` in `delete-guard.js`. `delete-gate-coverage.test.js` fails until all of them
  agree — that is the ratchet, and it is deliberately not satisfiable by editing one file.
- **A `confdeltype` changed.** `v4-softdelcascade-001`'s README recorded
  `photos_inventory_item_id_fkey` as `CASCADE`; it reads `RESTRICT` today, so this surface does move.
  Weakening a RESTRICT to CASCADE or SET NULL is a real decision about data loss. Update the pair
  only alongside the decision.

**Bumping the list to make the red go away without widening the guard is the failure mode.** The
second census gate (`post_inventory_fk_census_still_finds_all_four`) exists because the first is a
`NOT IN` violation count and therefore also reports zero when `pg_constraint` returns *nothing* — a
dropped FK or a renamed table would disarm the census silently while reading green.

## Applying

```
psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-arm-guard.sql
```

**Applying makes the two findings above visible, and `gate-invariants.yml` goes RED on its next run
until each is resolved.** That is the point of the guard, not a bug in it. Two ways, both Dave's call
and neither decided here:

- **RESTORE** — the parent was deleted by mistake and the reference is the evidence. Clear its
  `deleted_at`; the child resolves again and the row returns to the drawer. Prefer this when the
  child is real history — and one of the two candidates is a fermenting seed lot.
- **DETACH** — the parent was correctly deleted and the child should not have pointed at it. NULL
  the pointer (the plants PUT already supports this via its `clear` array), or delete the child row
  if it is itself an artifact.

Rollback is `0r-rollback.sql`: one `DELETE` of the receipt, which returns every standing gate to
vacuously green without weakening an assertion. It does **not** disarm the handler-side check, which
is application code.

## Not closed here

- **The two findings are not resolved.** Read-only lane; resolving either is a data decision.
- **A soft-deleted *referrer* pointing at a soft-deleted parent is not counted.** The guard scopes to
  live referrers, matching `delete-guard.js` exactly — a detector that disagreed with the preventer
  would report findings the preventer considers fine. Restore such a referrer and the gate picks it
  up then, which is when it becomes real.
- **`photos` may want a cascade rather than a block.** A packet photo is arguably part of the item
  rather than an independent record, so refusing the item's delete because of its own photo may be
  the wrong product answer. Six prod photos carry an `inventory_item_id`. Flagged, not decided —
  it needs the same treatment `v4-softdelcascade-001` gave the other axes.
- **Duplicate seed rows** (OPS-SEEDDUPEROWS-001) remain unmerged and out of scope. This migration is
  what makes a future merge *safe*, not a decision to perform one.
