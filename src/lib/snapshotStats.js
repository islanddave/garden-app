// snapshotStats.js — V4-HARVESTVIEW-001 S2b. Pure derivation of the 3 snapshot tiles (design §3a).
// No API/date coupling and no clock — every window is resolved server-side, in HARVEST_TZ, and
// arrives as its own already-scoped aggregate. No unit conversion, ever.
//
//   (a) lastHarvest  — the most recent SEASON entry (entries are (event_date,id) DESC), or null.
//   (b) last7        — the rolling 7-day window: total pick count + top ≤2 crops BY EVENT COUNT.
//                      Each top crop carries its unit map so the view can phrase it in native units
//                      when single-unit, or fall back to a count phrase when mixed.
//   (c) seasonCropCount — distinct crops this season (aggregates.crop_list length; denominator-free).
//
// BUG-HARVSNAPSHOT7D-001 — (b) IS DERIVED FROM AN AGGREGATE, NOT FROM ENTRIES. It used to filter
// the season entries array by day_key, and that array is a 50-row PAGE: the tile read 50 against a
// true 163 on live prod, and the crop phrase beside it was computed from the ~3.5 days those rows
// happened to cover. `aggregates` is the uncapped half of the same response (no cursor, no limit),
// so asking the server for `timeframe=7d&include=aggregates` makes the number structurally
// un-truncatable rather than merely larger. The window keys this function used to take are gone
// with it — a client-side window over a server-truncated list is the whole defect in one line.
export function snapshotStats(entries, aggregates, last7Aggregates) {
  const list = Array.isArray(entries) ? entries : []
  const lastHarvest = list[0] ?? null
  const seasonCropCount = Array.isArray(aggregates?.crop_list) ? aggregates.crop_list.length : 0
  return { lastHarvest, seasonCropCount, last7: last7Stats(last7Aggregates) }
}

// One aggregate bucket's EVENT count. computeAggregates puts every row in exactly one place — into
// a unit's `count` when it carried a usable quantity, into `unquantified` when it did not — so the
// two together are the row count, and neither alone is. Summing only the unit counts would drop the
// quantity-less picks the Log renders, which is the same silent under-report in a different place.
function bucketCount(b) {
  const units = Array.isArray(b?.units) ? b.units : []
  return units.reduce((n, u) => n + Number(u.count ?? 0), 0) + Number(b?.unquantified ?? 0)
}

// Absent aggregate → a zero window, never a guess. The hook fetches this alongside the season
// request, so absence means the request failed or the shape changed; "A quiet week" is at least an
// honest reading of no data, where falling back to a filtered entries page is the defect returning.
function last7Stats(agg) {
  const crops = Array.isArray(agg?.crops) ? agg.crops : []
  const other = Array.isArray(agg?.other) ? agg.other : []
  // Unattributed picks (no planting → no crop) live in other[] and are counted here for the same
  // reason the entries derivation counted them: they are picks, and a "picks this week" number that
  // silently omits some of them is wrong in the direction this whole fix exists to close.
  const buckets = [
    ...crops.map((c) => ({ name: c.crop_name || c.crop_type_slug || 'harvest', units: c.units, unquantified: c.unquantified })),
    ...other.map((o) => ({ name: o.project_name || 'harvest', units: o.units, unquantified: o.unquantified })),
  ].map((b) => ({ ...b, count: bucketCount(b) }))

  const count = buckets.reduce((n, b) => n + b.count, 0)
  const top = buckets
    .sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)))
    .slice(0, 2)
    .map((b) => {
      const units = Array.isArray(b.units) ? b.units : []
      // Native units only when a single unit AND every event in the window is quantified; else the
      // sum would misrepresent (mixed units are incomparable; unquantified picks aren't summable).
      const nativeUnit = units.length === 1 && !(Number(b.unquantified) > 0)
        ? { unit: units[0].unit, total: Number(units[0].total) }
        : null
      return { name: b.name, count: b.count, nativeUnit }
    })

  return { count, top }
}
