// spots.js — the redesigned Today's Needs care, as data (V5-TODAYREDESIGN-001 S4; plan-v2 §2.4, §2.6, §4,
// §11.0 E8, §13 MF3/SF2/SF5/SF7/SF8, Dave's D3/D7/D9/D11/D12). PURE: rows, /api/plants and /api/locations in,
// the page's groups / spots / exceptions / cohort / product groups / counts out. No fetch, no React.
//
// Which plantings need what stays careNeeded.js's (buildCareNeeded). This file only arranges them:
//   GROUP (D7, SF5)  Outside, or a covered TOP-LEVEL location named by itself (Stable; House). A planting's
//                    group is decided by its top-level ancestor: covered → that location, else Outside. So a
//                    covered shelf under Stable is Stable, and "Yard > Yard - Stable" (Yard is uncovered) is
//                    Outside. On Dave's locations (S0's read-only dump) this yields exactly Outside / Stable /
//                    House. Rain and the bed-wait rule apply to Outside only.
//   SPOT (D3)        the planting's own location. Unplaced plantings share one "Unplaced" spot in Outside
//                    (the gate's own reading, v2groups.mjs, puts them there too).
//   TASKS            water (water_due + no_history), feed (fertilize), check (pest + overwintering). Cold rows
//                    are Protect tonight's alone (§2.4) and never reach this file.
export const OUTSIDE = 'Outside'
export const UNPLACED = '_unplaced'
export const TASKS = ['water', 'feed', 'check']
export const TASK_LABEL = { water: 'Water', feed: 'Feed', check: 'Check' }
export const TASK_ETYPE = { water: 'watering', feed: 'fertilizing', check: 'observation' }
export const TASK_OF_NEED = { water_due: 'water', no_history: 'water', fertilize: 'feed', pest: 'check', overwintering: 'check' }
// lambda/daily-plan/engine.js SMALL_VESSEL_TYPES — the "dries fastest" vessels (a parity test reads the engine).
export const SMALL_VESSEL_TYPES = new Set(['tray_cell', 'soil_block', 'solo_cup'])
const VESSEL_LABEL = { tray_cell: 'Tray cell', soil_block: 'Soil block', solo_cup: 'Solo cup' }
const VESSEL_PLURAL = { tray_cell: 'tray cells', soil_block: 'soil blocks', solo_cup: 'solo cups' }
// §11.0 E8: a spot with this many water rows or fewer shows every row; a cohort under COHORT_MIN is not one.
export const SMALL_SPOT_MAX = 5
export const COHORT_MIN = 3
// §4 "Cohort line": a disclosed cohort renders this many rows until "Show N more".
export const COHORT_CAP = 20

const isWater = (r) => r && (r.need === 'water_due' || r.need === 'no_history')

// GET /api/locations → { locations:[{id,name,parent_id,covered}], locations_with_path } (an array is taken as
// the locations list). Tolerant: anything unreadable indexes nothing, and `ok` is false.
export function locationIndex(payload) {
  const list = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.locations) ? payload.locations : [])
  const byId = new Map()
  for (const l of list) if (l && l.id) byId.set(l.id, l)
  const chain = (id) => {
    const out = []
    for (let cur = byId.get(id), hops = 0; cur && hops < 64; cur = byId.get(cur.parent_id), hops++) out.push(cur)
    return out
  }
  const groupOf = (id) => {
    const c = chain(id)
    const top = c[c.length - 1]
    return top && top.covered ? top.name : OUTSIDE
  }
  // Covered top-level locations, in the payload's order (the Lambda sorts level, sort_order, name).
  const coveredTops = list.filter((l) => l && !l.parent_id && l.covered).map((l) => l.name)
  const spotOf = (id) => {
    const c = chain(id)
    if (!c.length) return { key: UNPLACED, name: 'Unplaced', parentPath: null, group: OUTSIDE }
    return { key: c[0].id, name: c[0].name || 'Spot', parentPath: c.length > 1 ? c.slice(1).reverse().map((l) => l.name).join(' › ') : null, group: groupOf(id) }
  }
  return { ok: byId.size > 0, byId, groupOf, spotOf, groupOrder: [OUTSIDE, ...coveredTops] }
}

// The care rows, joined to what the page needs to arrange them: spot + group from /api/plants location_id,
// container type, the planting's thumbnail (V1's photo shape, BUG-TIERLESSPHOTOS-001), and the plan item's
// days_since / rain_note (buildCareNeeded does not carry them). `rows` = buildCareNeeded rows.
export function enrichRows(rows, { plan, plants, locations }) {
  const idx = locationIndex(locations)
  const plantById = new Map((Array.isArray(plants) ? plants : []).map((p) => [p.id, p]))
  const itemBy = new Map()
  for (const need of ['water_due', 'no_history', 'fertilize', 'pest', 'overwintering']) {
    for (const it of (plan && Array.isArray(plan[need]) ? plan[need] : [])) if (it && it.id) itemBy.set(it.id + ':' + need, it)
  }
  return rows.map((r) => {
    const pl = plantById.get(r.plantingId)
    const it = itemBy.get(r.key) || {}
    const spot = idx.ok
      ? idx.spotOf(pl && pl.location_id)
      : { key: 'project:' + (r.projectId || 'none'), name: r.project || 'Other', parentPath: null, group: null }
    return {
      ...r,
      task: TASK_OF_NEED[r.need] || null,
      spotKey: spot.key, spotName: spot.name, parentPath: spot.parentPath, group: spot.group,
      containerType: (pl && pl.container_type) || null,
      daysSince: typeof it.days_since === 'number' ? it.days_since : null,
      rainNote: it.rain_note || null,
      product: it.item || null, method: it.apply || null,
      checkLabel: it.label || null,
      photo: pl && pl.featured_photo_view_url ? {
        id: pl.featured_photo_id ?? null,
        featured_photo_view_url: pl.featured_photo_view_url,
        featured_photo_thumb_url: pl.featured_photo_thumb_url ?? null,
        plant_id: pl.id,
      } : null,
    }
  })
}

// Severity of a set of rows = V1's groupSeverity (careNeeded.js): presence + overdue days per water row.
function severity(rows) {
  let s = 0
  for (const r of rows) s += isWater(r) ? 1 + (typeof r.overdueBy === 'number' && r.overdueBy > 0 ? r.overdueBy : 0) : 0.5
  return s
}

// The visit's held order (§2.2), taken at the ready point over "rows minus skipped, logged kept" (BD-036's
// orderingRows): groups in their fixed order, spots within a group heaviest first (V1's group severity),
// ties by name. Returns { groups:[key], spots:{group:[spotKey]} }.
export function takeOrder(rows, groupOrder = [OUTSIDE]) {
  const bySpot = new Map()
  for (const r of rows) {
    if (!bySpot.has(r.spotKey)) bySpot.set(r.spotKey, { key: r.spotKey, name: r.spotName, group: r.group || OUTSIDE, rows: [] })
    bySpot.get(r.spotKey).rows.push(r)
  }
  const spots = {}
  for (const s of [...bySpot.values()].sort((a, b) => (severity(b.rows) - severity(a.rows)) || String(a.name).localeCompare(String(b.name)))) {
    (spots[s.group] ||= []).push(s.key)
  }
  const groups = [...groupOrder.filter((g) => spots[g]), ...Object.keys(spots).filter((g) => !groupOrder.includes(g))]
  return { groups, spots }
}

// Modal value of a list (ties → the larger value, so "last watered" never understates the wait).
function modeOf(values) {
  const n = new Map()
  for (const v of values) n.set(v, (n.get(v) || 0) + 1)
  let best = null, bestN = 0
  for (const [v, c] of n) if (c > bestN || (c === bestN && v > best)) { best = v; bestN = c }
  return { value: best, count: bestN }
}

export const cadenceWords = (interval) => (interval === 1 ? 'daily' : (typeof interval === 'number' && interval > 1 ? `every ${interval} days` : null))

// §11.0 E8 + D11: a spot's water rows split into the few that differ (shown first, never capped) and the
// cohort that is "like the rest" (one line, "Show them"). A cohort exists only where most of the spot shares
// one watering record — the batch-watered case the split is for (Bag Area: 97 rows, all 4 d). A row differs
// when it is a small, fast-drying vessel, has never been watered, carries a rain note, or its record sits
// its own interval or more from the spot's (R11's rule, kept). Size rules: ≤ 5 water rows → every row, no
// split; a cohort under 3 → every row, the differing ones first. Returns exception KEYS (held for the visit).
export function exceptionKeys(waterRows) {
  const rows = waterRows.filter(isWater)
  if (rows.length <= SMALL_SPOT_MAX) return null
  const ages = rows.map((r) => r.daysSince).filter((d) => typeof d === 'number')
  const m = modeOf(ages)
  if (m.value == null || m.count * 2 <= rows.length) return null
  const differs = (r) => r.need === 'no_history' || !!r.rainNote || SMALL_VESSEL_TYPES.has(r.containerType)
    || (typeof r.daysSince === 'number' && Math.abs(r.daysSince - m.value) >= Math.max(1, r.interval || 1))
  const ex = rows.filter(differs)
  if (rows.length - ex.length < COHORT_MIN) return null
  return ex.map((r) => r.key)
}

// Why a differing row differs, then its cadence and record: "Tray cell — dries fastest · every 2 days ·
// last watered 4 d ago" (§4 Exception row).
export function exceptionReason(r) {
  const why = r.need === 'no_history' ? 'Never watered'
    : SMALL_VESSEL_TYPES.has(r.containerType) ? `${VESSEL_LABEL[r.containerType]} — dries fastest`
      : r.rainNote ? r.rainNote : null
  const parts = [why, cadenceWords(r.interval), typeof r.daysSince === 'number' ? `last watered ${r.daysSince} d ago` : null]
  return parts.filter(Boolean).join(' · ') || r.reason || ''
}

// SF2: the disclosed cohort, longest-waiting first, then crop, then name — so on a batch-watered spot (every
// age tied) it reads by crop, and the cap note drops "longest-waiting" (cohortCapNote).
export function sortCohort(rows) {
  return [...rows].sort((a, b) => ((b.daysSince ?? -1) - (a.daysSince ?? -1))
    || String(a.crop || '').localeCompare(String(b.crop || '')) || String(a.name).localeCompare(String(b.name)))
}
export function cohortLine(cohort, hasExceptions) {
  const n = cohort.length
  const iv = modeOf(cohort.map((r) => r.interval).filter((v) => typeof v === 'number'))
  const age = modeOf(cohort.map((r) => r.daysSince).filter((v) => typeof v === 'number'))
  const cad = cadenceWords(iv.value)
  const bits = [hasExceptions ? `${n} more like this` : `${n} alike`]
  if (cad) bits.push((iv.count < n ? 'mostly ' : '') + cad)
  if (age.value != null) bits.push(`last watered ${age.value} d ago`)
  return bits.join(' · ')
}
export function cohortCapNote(cohort, shown) {
  if (shown >= cohort.length) return null
  const ages = new Set(cohort.map((r) => r.daysSince))
  return ages.size > 1 ? `Showing the longest-waiting ${shown}.` : `Showing ${shown} of ${cohort.length}.`
}

// Counts for a set of rows, per task. Zero counts are dropped from any line built from these (SF7).
export function taskCounts(rows) {
  const c = { water: 0, feed: 0, check: 0 }
  for (const r of rows) if (c[r.task] != null) c[r.task]++
  return c
}

// Bulk candidates for one spot's rows (§2.4 candidateKeys, careNeeded.js's predicate): watering rows, minus
// in-ground beds while bed-wait is on — Outside only (D7). `bedsWaiting` = the beds that rule held back.
// `exclude` (S4g, MF3): keys a bulk never takes — rows whose write failed this visit, which only their Retry
// re-posts (so a fresh Water all cannot split one run's failures into a second batch). Absent = none.
export function waterCandidates(rows, group, bedWait, exclude) {
  const wait = !!bedWait && (group == null || group === OUTSIDE)
  const keys = new Set()
  let bedsWaiting = 0
  for (const r of rows) {
    if (r.eventType !== 'watering') continue
    if (wait && r.inGround) { bedsWaiting++; continue }
    if (exclude && exclude.has(r.key)) continue
    keys.add(r.key)
  }
  return { keys, bedsWaiting }
}

// The page's model for one render. `rows` = the enriched rows ON THE LIST (logged and skipped removed);
// `held` = the visit's order ({groups, spots}); `tasks` / `spots` = the filter selections (empty = all);
// `exclude` = keys no bulk takes (waterCandidates). Filters hide, never re-sort (§2.6). New spots (a refetch)
// are appended to their group in held order's tail.
export function buildModel(rows, { held, tasks = [], spots = [], bedWait = false, exclude } = {}) {
  const taskSet = new Set(tasks), spotSet = new Set(spots)
  const inTask = (r) => !taskSet.size || taskSet.has(r.task)
  const bySpot = new Map()
  for (const r of rows) {
    if (!r.task) continue
    if (!bySpot.has(r.spotKey)) bySpot.set(r.spotKey, { key: r.spotKey, name: r.spotName, parentPath: r.parentPath, group: r.group || OUTSIDE, all: [] })
    bySpot.get(r.spotKey).all.push(r)
  }
  const order = held || takeOrder(rows)
  const groupKeys = [...order.groups, ...[...new Set([...bySpot.values()].map((s) => s.group))].filter((g) => !order.groups.includes(g))]
  const groups = []
  for (const g of groupKeys) {
    const heldSpots = order.spots?.[g] || []
    const present = [...bySpot.values()].filter((s) => s.group === g)
    const keys = [...heldSpots.filter((k) => bySpot.has(k)), ...present.map((s) => s.key).filter((k) => !heldSpots.includes(k))]
    const list = []
    for (const k of keys) {
      const s = bySpot.get(k)
      if (spotSet.size && !spotSet.has(k)) continue
      const view = s.all.filter(inTask)
      const cand = waterCandidates(view, s.group, bedWait, exclude)
      list.push({
        ...s, rows: view, counts: taskCounts(view), allCounts: taskCounts(s.all),
        dryFastest: view.filter((r) => isWater(r) && SMALL_VESSEL_TYPES.has(r.containerType)).length,
        candidates: cand.keys, bedsWaiting: cand.bedsWaiting,
      })
    }
    const keysAll = new Set()
    let spotsWithWater = 0
    for (const s of list) { if (s.candidates.size) spotsWithWater++; for (const k of s.candidates) keysAll.add(k) }
    groups.push({ key: g, spots: list, candidates: keysAll, spotsWithWater })
  }
  return { groups, spotCount: bySpot.size }
}

// D12 / SF3: under the Feed filter, one row per product + method across the garden.
export function productGroups(rows) {
  const map = new Map()
  for (const r of rows) {
    if (r.task !== 'feed') continue
    const k = (r.product || 'Feed') + '|' + (r.method || '')
    if (!map.has(k)) map.set(k, { key: k, product: r.product || 'Feed', method: r.method || null, rows: [] })
    map.get(k).rows.push(r)
  }
  return [...map.values()].sort((a, b) => (b.rows.length - a.rows.length) || a.product.localeCompare(b.product))
}

// SF8: the Needs care summary carries REASONS and spots, never counts (the counts live on the chips and the
// header). "8 tray cells due · 9 spots". `reasons` = triggers.js careReasons().
export function careSummary({ reasons, rows, spotCount }) {
  const bits = []
  if (reasons?.never?.length) bits.push(`${reasons.never.length} never watered`)
  if (reasons?.small?.length) {
    const types = new Set(rows.filter((r) => reasons.small.includes(r.key)).map((r) => r.containerType))
    const noun = types.size === 1 ? (VESSEL_PLURAL[[...types][0]] || 'small pots') : 'small pots'
    bits.push(`${reasons.small.length} ${reasons.small.length === 1 ? noun.replace(/s$/, '') : noun} due`)
  }
  if (reasons?.hot) bits.push('hot day — containers due')
  if (spotCount) bits.push(`${spotCount} spot${spotCount === 1 ? '' : 's'}`)
  return bits.join(' · ') || null
}
