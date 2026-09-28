// v2groups.mjs — the gate's OWN reading of D7's three watering groups, for fixture assertions only.
//
// Plan-v2 §8 S4 / §13 SF5: a planting's group is its nearest COVERED location's top-level covered
// ancestor, named by that location (Stable; House); a planting with no covered ancestor is "Outside".
// This is NOT src/lib/todayV2/spots.js (S4 writes that, as product code). It exists so the fixture can be
// checked BEFORE S4 — "the dump yields exactly Outside / Stable / House" is a precondition S4 builds on,
// and a gate that asked the product to grade its own input would certify whatever the product computed.
export const EXPECTED_GROUPS = ['Outside', 'Stable', 'House']

export function groupIndex(locationsFull) {
  const locs = new Map((locationsFull?.locations || []).map((l) => [l.id, l]))
  const groupOf = (id) => {
    let top = null
    for (let cur = locs.get(id), hops = 0; cur && hops < 64; cur = locs.get(cur.parent_id), hops++) {
      if (cur.covered) top = cur
    }
    return top ? top.name : 'Outside'
  }
  return { groupOf, size: locs.size }
}

// Every group the given rows land in, keyed by name, via /api/plants location_id.
export function groupsOfRows(rows, plants, locationsFull) {
  const { groupOf } = groupIndex(locationsFull)
  const loc = new Map((plants || []).map((p) => [p.id, p.location_id]))
  const out = {}
  for (const r of rows || []) { const g = groupOf(loc.get(r.id)); out[g] = (out[g] || 0) + 1 }
  return out
}
