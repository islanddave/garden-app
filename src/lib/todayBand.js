import { P } from './constants.js'
import { severityTier, SEVERITY_STYLES, overdueLabel } from './waterDue.js'

// "Today" band item model (Inc 1 — full band). Merges the actionable "what needs me now?"
// signals ALREADY returned by /api/dashboard — watering overdue and long-unseen
// (stale) projects — into ONE ranked, de-duplicated, capped list, each row.
// FLAG-REMOVAL (2026-06-10): flagged-issue rows are no longer surfaced; the planting-flagging
// UI was retired (server still emits reason='flagged' heads_up rows — ignored here).
// V3-HARVEST-001 (2026-06-08): harvest-ready is INTENTIONALLY EXCLUDED from this above-nav band —
// a harvesting project stays harvest-ready for weeks, so surfacing it here was a constant nag.
// Harvest-ready still lives on the Dashboard HarvestReadyTile; harvest alerting may be rethought later.
// Each row
// carrying a reason-label + a tap-to-log route. This is an OPERATIONAL surface (harm-prevention
// + time-sensitive opportunity), NOT a reward surface: no streaks/badges/celebration, and
// recent-activity (a non-actionable recognition feed) is deliberately EXCLUDED — it stays on the
// Dashboard. Frontend-only: composes an endpoint that already exists; no backend/schema change.
//
// Render-time merged-set cap (C5 / ADHD-overwhelm): at most TODAY_RENDER_CAP items render; any
// remainder is reported as a non-interactive "+N more" count, never auto-expanded.

export const TODAY_RENDER_CAP = 5

// Priority — lower sorts first. Watering overdue = harm imminent (plants drying); stale =
// gentle "haven't looked" nudge. (harvest removed per V3-HARVEST-001; flag removed 2026-06-10.)
const KIND_PRIORITY = { water: 0, stale: 1 }

const STALE_STYLE   = SEVERITY_STYLES.gold

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null }
function projName(row) { return row.project_name ?? row.name ?? 'Untitled' }

function waterItem(row) {
  const tier = severityTier(row.next_water_at, row.location_type)
  return {
    key: `water:${row.project_id}`, kind: 'water', priority: KIND_PRIORITY.water,
    sort: -(Date.now() - new Date(row.next_water_at).getTime()), // most-overdue first
    emoji: '\u{1F4A7}', label: 'Needs water',
    projectId: row.project_id, projectName: projName(row),
    detail: overdueLabel(row.next_water_at),
    to: `/log?project=${row.project_id}&event_type=watering`,
    style: SEVERITY_STYLES[tier] || SEVERITY_STYLES.gold,
  }
}

function staleItem(row) {
  const d = num(row.days_stale)
  return {
    key: `stale:${row.project_id}`, kind: 'stale', priority: KIND_PRIORITY.stale,
    sort: -(d ?? 0), // longest-unseen first
    emoji: '\u{1F440}', label: 'Not seen lately',
    projectId: row.project_id, projectName: projName(row),
    detail: d != null ? `${d} days unseen` : 'not seen lately',
    to: `/log?project=${row.project_id}&event_type=observation`,
    style: STALE_STYLE,
  }
}

// Build the ranked, de-duplicated Today list from a /api/dashboard payload. Defensive against a
// null / array / partial payload (a dashboard fetch failure must never throw here). De-dup: each
// project surfaces ONCE, under its single most-urgent reason (lowest KIND_PRIORITY).
export function buildTodayItems(dashboard) {
  const d = (dashboard && !Array.isArray(dashboard)) ? dashboard : {}
  const items = []
  for (const r of (d.water_due || []))     if (r && r.project_id) items.push(waterItem(r))
  // V3-HARVEST-001: harvest_ready is deliberately NOT merged into the band (see header note).
  // FLAG-REMOVAL (2026-06-10): reason='flagged' heads_up rows are deliberately ignored.
  for (const r of (d.heads_up || []))      if (r && r.project_id && r.reason === 'stale') items.push(staleItem(r))

  const byProject = new Map()
  for (const it of items) {
    const prev = byProject.get(it.projectId)
    if (!prev || it.priority < prev.priority) byProject.set(it.projectId, it)
  }
  return [...byProject.values()].sort(
    (a, b) => a.priority - b.priority || a.sort - b.sort || a.projectName.localeCompare(b.projectName)
  )
}

// Split into the rendered head (<= cap) + overflow count. Pure; the component renders
// `visible` then a "+ more" line when `more > 0`.
export function todayBand(dashboard, cap = TODAY_RENDER_CAP) {
  const all = buildTodayItems(dashboard)
  return { visible: all.slice(0, cap), more: Math.max(0, all.length - cap), total: all.length }
}
