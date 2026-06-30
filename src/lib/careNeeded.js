// careNeeded.js — Slice 7 (V4-THEME-001) Care-Needed-Today canonicalizer.
// SINGLE SOURCE OF TRUTH for which plantings need care today, the event each need logs, its
// due-state, and ordering. BOTH the CareNeeded component AND the parity test consume this; the
// component does ZERO classification/ordering of its own (read-path parity anchor — L-104/L-237).
// Pure: a daily-plan `plan` object in, a canonical row array out. No fetch, no effects, no engine
// or care-contract change (frontend-only): we derive everything from the buckets the engine
// already emits. A planting present in two buckets yields two rows (two distinct needs/events).
// Dormant carries no action and is excluded from the actionable list.

// Bucket -> the event_type a one-tap log writes (identical to the Log form's write path so the
// events Lambda side effects — critter award + entity_memory.next_water_at — fire). dormant: none.
export const NEED_EVENT_TYPE = {
  water_due: 'watering',
  no_history: 'watering',
  fertilize: 'fertilizing',
  pest: 'observation',
  cold: 'brought_inside',
}

// Bucket -> short care verb (the "By type" group label + chip label). Text channel, never color-only.
export const NEED_LABEL = {
  water_due: 'Water',
  no_history: 'Water',
  fertilize: 'Feed',
  pest: 'Check',
  cold: 'Protect',
}

// Render/auto-expand order. Water needs lead (most time-sensitive), then never-watered, feed, pest, cold.
export const NEED_ORDER = ['water_due', 'no_history', 'fertilize', 'pest', 'cold']

// One-clause primary reason. Mirrors the engine's per-bucket reason strings (single clause; any
// supporting detail is the row's secondary/expand content, not here).
export function needReason(need, it) {
  switch (need) {
    case 'water_due':
      if (it.rain_note) return it.rain_note
      if (typeof it.overdue_by === 'number' && it.overdue_by > 0) return it.overdue_by + 'd overdue'
      return 'Due today'
    case 'no_history':
      return 'Never watered'
    case 'fertilize':
      return [it.item, it.apply].filter(Boolean).join(' · ') || 'Feed due'
    case 'pest':
      return it.label || 'Scout for pests'
    case 'cold':
      return it.text || 'Protect tonight'
    default:
      return it.project || ''
  }
}

// Synthetic severity tier from the fields the plan DOES expose (no next_water_at in plan items).
// Shares the waterDue.js SEVERITY_STYLES vocabulary so Today rows and the detail CareStatus band
// never disagree (one mental model — L-075). Non-water needs are "needed today" => gold.
export function needTier(need, it) {
  if (need === 'water_due') {
    const o = it.overdue_by
    if (typeof o === 'number') {
      if (o >= 3) return 'terra-bold'
      if (o >= 1) return 'terra'
    }
    return 'gold'
  }
  return 'gold'
}

// Bed-wait exclusion signal — matches the engine's rain callout gate (tomorrow_precip_in>=0.3
// && pop>=50): "water containers today, let in-ground beds wait". When active, in-ground beds are
// excluded from the BULK watering pre-check (still individually loggable). rain_skipped plantings
// are already withheld by the engine, so this only guards bulk over-watering of beds.
export function bedWaitActive(plan) {
  const h = plan && plan.hydrology
  if (!h) return false
  const amt = typeof h.tomorrow_precip_in === 'number' ? h.tomorrow_precip_in : 0
  const pop = typeof h.tomorrow_pop === 'number' ? h.tomorrow_pop : 0
  return amt >= 0.3 && pop >= 50
}

// The canonical flat row list. Excludes engine-marked `done` items (V3-TODAYDONE-001) — same set
// the current PlanBuckets surfaces. Order = NEED_ORDER, preserving each bucket's engine array order
// (water is pre-sorted most-overdue-first by the engine). This is the regression-locked output.
export function buildCareNeeded(plan) {
  if (!plan) return []
  const rows = []
  for (const need of NEED_ORDER) {
    const items = Array.isArray(plan[need]) ? plan[need] : []
    for (const it of items) {
      if (it && it.done) continue
      rows.push({
        key: it.id + ':' + need,
        plantingId: it.id,
        name: it.name || it.crop || 'Planting',
        crop: it.crop || null,
        project: it.project || null,
        projectId: it.project_id || null,
        need,
        eventType: NEED_EVENT_TYPE[need],
        reason: needReason(need, it),
        tier: needTier(need, it),
        overdueBy: typeof it.overdue_by === 'number' ? it.overdue_by : null,
        inGround: !!it.in_ground,
        never: !!it.never,
      })
    }
  }
  return rows
}

// Group-severity score: water-overdue dominates so the "most overdue" group sorts first and is the
// auto-expand target on a long list. Non-water needs score ~0 (present but not on an overdue clock).
export function groupSeverity(rows) {
  let s = -1
  for (const r of rows) {
    const v = r.need === 'water_due' ? (typeof r.overdueBy === 'number' ? r.overdueBy : 0) : -0.5
    if (v > s) s = v
  }
  return s
}

// Group rows for render. mode: 'location' (by project proxy — the only location-ish field the plan
// carries; TRUE location names + Containers/beds sub-split are deferred to V4-TODAYLOC-001, blocked
// on container_type population) | 'type' (by care need). Returns [{ key, label, rows, severity }].
export function groupRows(rows, mode) {
  const map = new Map()
  for (const r of rows) {
    const gkey = mode === 'type' ? r.need : (r.projectId || '_none')
    const glabel = mode === 'type' ? NEED_LABEL[r.need] : (r.project || 'Other')
    if (!map.has(gkey)) map.set(gkey, { key: gkey, label: glabel, rows: [] })
    map.get(gkey).rows.push(r)
  }
  const groups = [...map.values()].map(g => ({ ...g, severity: groupSeverity(g.rows) }))
  if (mode === 'type') {
    groups.sort((a, b) => NEED_ORDER.indexOf(a.key) - NEED_ORDER.indexOf(b.key))
  } else {
    // Most-overdue group first (auto-expand target); ties broken by label for determinism.
    groups.sort((a, b) => (b.severity - a.severity) || a.label.localeCompare(b.label))
  }
  return groups
}

// ADHD chunking: <= this many total needs => all groups expanded; more => collapse all but the
// most-overdue group (expand-all defeats chunking — build-plan Slice 7).
export const EXPAND_ALL_THRESHOLD = 8
