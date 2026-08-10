# V4-CROPTYPEALOE-001 — Aloe was untypeable in the app

**Status:** authored, round-tripped against live prod inside `BEGIN`/`ROLLBACK`
(crop_type 1 · cultivar-via-view 1 · dangling 0 · planting typed 1 · exactly one aloe cultivar, then
`ROLLBACK`). **schema_version:** `4.23.6-croptypealoe-001`. **Ticket:** V4-CROPTYPEALOE-001.

## The defect

Dave, 2026-08-10: *"added Aloe Vera plant via Snap (no type - cannot add Aloe as a type in that form)"*.

Nothing was broken in the form. `crop_types` held **zero** aloe rows out of 135 — the reference data
simply never existed, despite the taxonomy already carrying a `succulent` category with 8 members.

## Why this is TWO rows and not one

The obvious reading — "add a crop type" — would have shipped and fixed nothing.

`src/pages/CaptureFlow.jsx:216` renders its picker from `/api/varieties`, and
`lambda/varieties/index.js:220-231` selects from **`public.cultivar`**, an unfiltered projection of
`plant_varieties`. So the Snap picker lists **cultivars**, not crop types. The cultivar is the row the
user can actually pick; the crop type is what it resolves to.

`post_aloe_cultivar_is_visible_to_the_picker` therefore asserts through the **view**, not the base
table — a base-table row the view did not project would satisfy a naive check while leaving the form
exactly as broken as Dave found it.

## What the values are, and why

Modelled on **`haworthia`**, the closest existing sibling: both are tender succulents that do not
survive frost, hence `tender_perennial` rather than the plain `perennial` used by the hardy members.

`default_unit` stays NULL and `variety_grams_required` stays `true`, matching **all 8** existing
succulents — these are ornamentals, not harvested by count or weight, and a crop-level gram fallback
would be meaningless for them. `harvest_habit` / `dtm_basis` stay NULL for the same reason.

## The third statement — adopting Dave's planting

The migration also sets `variety_id` on the one planting he could not type
(`ea1c5abb-…`, "Aloe Vera"). Narrow by construction: that exact id, **only while it is still untyped**,
and only if it is still named Aloe Vera. If he has since typed it himself the statement is a no-op and
his choice stands.

That row is an apply-time receipt (`post_daves_planting_is_typed`, `continuous:false`, `env: prod`) and
deliberately NOT a standing invariant — he may retype or remove that planting at will and it must
never red a scheduled gate.

## Idempotence and rollback

Every statement is guarded (`WHERE NOT EXISTS` / `ON CONFLICT DO NOTHING`), so a re-run is a no-op
rather than a duplicate — `post_exactly_one_aloe_cultivar` asserts that rather than trusting it.

`0r` un-adopts the planting FIRST (the FK would otherwise block the delete, and the snapshot table is
the only record of what was there), then deletes the cultivar **only if no planting still points at
it**, then the crop type **only if no cultivar still references it**. It reports what survived rather
than force-deleting anything another writer has adopted.

## Note for whoever revisits this

The round-trip is not ceremony here: the first attempt failed on `schema_version.description` being
NOT NULL, which no amount of reading the sibling migration had surfaced. Round-trip before applying.
