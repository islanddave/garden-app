# v4-germrate-001 — per-packet germination rate

**V4-SEEDGERMRATE-001 (BD-057).** Two nullable integer columns on `public.plants`
(`seeds_sown`, `seeds_germinated`), exposed on the `garden_node` view and added to the plants audit
watched set.

## The design was settled with Dave, and the first answer corrected my recon

BD-057 flagged two questions as must-ask rather than guess.

I measured `SELECT count(*) FROM event_log WHERE event_type='sowing'` = **0** and reported there was
nothing to derive a rate from. Dave: *"The Sow event triggers the creation of a planting, so it
isn't really an event unless it gets saved as such at that point."* The count was right and the
inference was wrong — sowing is not logged as an event because **the sowing IS the planting**.
InventoryDetail's Sow CTA carries `source_inventory_item_id` into PlantingEditor, which POSTs a
planting bearing that packet id (44 of 313 plantings carry one today).

So a sowing is a planting row, and both counts live on it:
> *"I will put in seed count sown and later record germinations (not the first germination event,
> that is just noting at least one popped up, it would be a separate log of some sort — doubt it is
> an event - its a data point.)"*

Hence two plain columns — **not** an event type, **not** a side table. `germinated_at` keeps its
existing meaning (the DATE something first came up) and is untouched; `seeds_germinated` is the
COUNT, which is the thing a date could never carry.

**Q2 — accumulation across sowings:** Dave chose *"combine them, keep the history."* That needs no
schema of its own. Each sowing is already its own planting row, so a packet's rate is
`SUM(seeds_germinated) / SUM(seeds_sown)` over the plantings naming it, and the history is those
rows. This is the reason the counts go on the planting and not on `inventory_items`: one pair of
numbers on the packet could not answer *"80% in March, 45% in July"* without inventing a history
table.

## Why not reuse `qty_initial`

Checked before adding a column. `qty_initial` is set on 247 of 264 live plantings and
**server-defaults to `quantity`** — it is a PLANT count. Sow 20, get 14 up, keep 12 after thinning:
none of those three numbers is the other two.

## Three objects

| object | change |
|---|---|
| `public.plants` | 2 nullable int columns + 2 CHECKs |
| `public.garden_node` (VIEW) | columns appended — `lambda/plants` binds the view, so a table-only column is invisible to every API path |
| `trg_audit_plants_upd` | watched set 46 → 48, so the counts are not editable without a trace |

Deploy: `0a-additive-ddl.sql`, rollback `0r-rollback.sql`. Gates:
`python3 scripts/gate_runner.py --migration migrations/v4-germrate-001 --env <env>`.
Applied to **staging and prod** 2026-08-26; 7/7 gates on both.

## Verified end to end on staging before prod

Writing through the VIEW (the path `lambda/plants` uses), in a rolled-back transaction:
`seeds_sown = 20` stored · `seeds_germinated = 14` **captured by the audit trigger** with the new
value · rate computed 70.0% · the CHECK correctly **rejected** `seeds_sown = 0`. `0r` was then run
on staging and put everything back — columns dropped, view back to 53 columns, watched set back to
46, receipt removed — before re-applying.

## NULL is not zero

Blank stays NULL from PlantForm through PlantingEditor to the Lambda, and the Lambda defaults
neither column (unlike `qty_harvested`/`qty_lost`, which default to 0). **NULL means "not counted";
0 means "none came up".** Defaulting would file every planting ever created as a total germination
failure, and the packet rate would read 0% off it. The packet aggregate carries the same rule the
other way: only rows WITH a sown count take part, so an uncounted sowing cannot drag the rate down.
