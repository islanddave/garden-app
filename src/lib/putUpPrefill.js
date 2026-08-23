// V4-PUTUPENGINE-001 slice 2 — build a Put-Up prefill from a harvest entry the user explicitly
// picked on the Put-Up tab.
//
// WHY THIS IS A MODULE AND NOT THREE LINES INLINE. PutUp.jsx's UNIT_GROUPS comment named this exact
// hazard before anything consumed it: "a CHECK pinned to this list would 400 any future
// harvest-to-put-up prefill that copies harvest_log.unit", and "reconciling the two vocabularies is
// its own piece of work and must not be smuggled into a units addition". The two tables really do
// disagree — harvest_log stores SINGULAR ('cup','head','bunch','count' on prod), the Put-Up
// pick-list is PLURAL ('cups','lbs'). Copying the unit across is the bug. Mapping it is the feature.
// Pure + import-free so the mapping is assertable without mounting the page.
//
// WHAT THIS DELIBERATELY DOES NOT DO: convert. There is no kg/g in the Put-Up vocabulary, and
// PutUp.jsx already rejected inferred quantities in the Bulk-units comment — "silently storing an
// inferred poundage would be writing a guess into a column the UI shows as fact". So an unmappable
// unit drops the quantity PAIR rather than converting it or half-filling a number against the wrong
// unit. A half-prefill is the silent-wrong-value class; an absent one costs two taps.

// Harvest vocabulary is src/lib/harvest-constants.js HARVEST_UNITS:
//   ['lb','oz','kg','g','count','bunch','cup','head']
// Put-Up vocabulary is PutUp.jsx UNIT_GROUPS flattened:
//   ['lbs','oz','count','cups','pints','quarts','bushels','half-bushels','pecks','flats','jars','bags']
//
// 'kg' and 'g' are ABSENT ON PURPOSE, not overlooked: mapping either one needs an arithmetic
// conversion into lbs/oz, which is the guess this module refuses to write. Both are zero-row on prod
// today (count 699 / cup 105 / head 17 / bunch 6, live query 2026-08-22), so this is a defensive
// branch — but a crop later logged in grams must not silently become that number of pounds.
//
// 'bunch' and 'head' -> 'count' preserves the NUMBER exactly and loses only the noun, which the crop
// name already carries. That is lossless in the column the UI does arithmetic on.
export const HARVEST_TO_PUTUP_UNIT = Object.freeze({
  lb: 'lbs',
  oz: 'oz',
  count: 'count',
  cup: 'cups',
  bunch: 'count',
  head: 'count',
})

// Returns the Put-Up unit, or null when there is no lossless mapping. Null is a real answer here —
// callers must drop the quantity pair on it, never substitute a default.
export function mapHarvestUnit(unit) {
  if (unit == null) return null
  const key = String(unit).trim().toLowerCase()
  return HARVEST_TO_PUTUP_UNIT[key] ?? null
}

function positiveNumber(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

// Build the `location.state.prefill` object for a picked harvest entry.
//
// SHAPE CONTRACT: the four IDENTITY keys (crop_type_slug, variety_id, plant_id, harvest_log_id) are
// exactly the set prefillContextKey() hashes, and they keep that meaning here — this navigates
// through the SAME prefill door PreserveOffer / PutUpFromPlanting / PutUpUseSoonBand already use, so
// BUG-PUTUPSTASHHARVLINK-001's "is this the same context?" guard keeps working by construction: two
// different harvests produce two different context keys and neither resumes the other's draft.
//
// quantity_value / quantity_unit are PAYLOAD, not identity, and are deliberately NOT part of the
// context key — picking the same harvest twice is the same context whatever the amount.
//
// plant_id is carried even when the planting was soft-deleted (entry.planting_removed). That follows
// the project's Deleted-Planting History Rule: soft-deleting a planting "retracts the record, not the
// history" and its harvest events stay live and visible. The pick came from a real harvest; dropping
// its provenance to tidy a join would be the wrong trade.
export function prefillFromHarvestEntry(entry) {
  if (!entry || typeof entry !== 'object') return {}
  const out = {}
  if (entry.crop_type_slug) out.crop_type_slug = entry.crop_type_slug
  if (entry.variety_id) out.variety_id = entry.variety_id
  if (entry.plant_id) out.plant_id = entry.plant_id
  if (entry.harvest_log_id) out.harvest_log_id = entry.harvest_log_id

  // Pair or nothing. A quantity without its unit is meaningless and a unit without its quantity is
  // noise, so both land together or neither does.
  const qty = positiveNumber(entry.quantity)
  const unit = mapHarvestUnit(entry.unit)
  if (qty != null && unit != null) {
    out.quantity_value = qty
    out.quantity_unit = unit
  }
  return out
}

// One-line label for a picker row: what the user needs to recognise WHICH pick this was.
// Planting name is the most specific handle Dave has (his flow is planting -> ... -> put-up), so it
// leads; crop name is the fallback for an unattributed row, which really does exist in the feed
// (plant_id is nullable and the read model renders an "Other" bucket for it).
export function harvestPickLabel(entry) {
  if (!entry || typeof entry !== 'object') return 'Harvest'
  return (
    entry.planting_name ||
    entry.variety_name ||
    entry.crop_name ||
    entry.crop_type_slug ||
    'Unattributed harvest'
  )
}

// "2 cups" / "3 count" — the amount as the HARVEST recorded it, shown verbatim in its own vocabulary
// so the row reads like the harvest log the user remembers. The MAPPED unit is what gets written on
// submit; showing the mapped form here would make the picker disagree with the Harvests page.
export function harvestPickAmount(entry) {
  const qty = positiveNumber(entry?.quantity)
  if (qty == null) return null
  const unit = entry?.unit ? String(entry.unit).trim() : ''
  return unit ? `${qty} ${unit}` : String(qty)
}
