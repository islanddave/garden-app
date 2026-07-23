// snapshotStats.js — V4-HARVESTVIEW-001 S2b. Pure derivation of the 3 snapshot tiles (design §3a)
// from season-scoped entries (DESC) + aggregates. No API/date coupling — the caller passes the
// window keys (today / 7-days-ago in the garden zone). No unit conversion, ever.
//
//   (a) lastHarvest  — the most recent entry (entries are (event_date,id) DESC), or null.
//   (b) last7        — harvests in the rolling 7-day window: total event count + top ≤2 crops BY
//                      EVENT COUNT. Each top crop carries its unit map so the view can phrase it in
//                      native units when single-unit, or fall back to a count phrase when mixed.
//   (c) seasonCropCount — distinct crops this season (aggregates.crop_list length; denominator-free).
export function snapshotStats(entries, aggregates, { todayKey, sevenDaysAgoKey } = {}) {
  const list = Array.isArray(entries) ? entries : []
  const lastHarvest = list[0] ?? null
  const seasonCropCount = Array.isArray(aggregates?.crop_list) ? aggregates.crop_list.length : 0

  const recent = sevenDaysAgoKey
    ? list.filter((e) => (e?.day_key || '') >= sevenDaysAgoKey && (todayKey ? (e?.day_key || '') <= todayKey : true))
    : list

  const byCrop = new Map()
  for (const e of recent) {
    const key = e.crop_type_slug || e.crop_name || e.project_name || '__other__'
    let c = byCrop.get(key)
    if (!c) {
      c = { key, name: e.crop_name || e.variety_name || e.planting_name || 'harvest', count: 0, units: new Map(), quantified: 0 }
      byCrop.set(key, c)
    }
    c.count += 1
    if (e.harvest_log_id != null && e.quantity != null) {
      c.quantified += 1
      const u = String(e.unit ?? '').trim().toLowerCase()
      c.units.set(u, (c.units.get(u) ?? 0) + Number(e.quantity))
    }
  }
  const top = [...byCrop.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 2)
    .map((c) => {
      const units = [...c.units.entries()].map(([unit, total]) => ({ unit, total }))
      // Native units only when a single unit AND every event in the window is quantified; else the
      // sum would misrepresent (mixed units are incomparable; unquantified picks aren't summable).
      const nativeUnit = units.length === 1 && c.quantified === c.count ? units[0] : null
      return { name: c.name, count: c.count, nativeUnit }
    })

  return { lastHarvest, seasonCropCount, last7: { count: recent.length, top } }
}
