import { P } from './constants.js'
import { severityTier, SEVERITY_STYLES, overdueLabel } from './waterDue.js'

// "Today" band item model (Inc 1 — full band). Merges the actionable "what needs me now?"
// signals ALREADY returned by /api/dashboard — watering overdue, flagged issues, harvest-ready,
// and long-unseen (stale) projects — into ONE ranked, de-duplicated, capped list, each row
// carrying a reason-label + a tap-to-log route. This is an OPERATIONAL surface (harm-prevention
// + time-sensitive opportunity), NOT a reward surface: no streaks/badges/celebration, and
// recent-activity (a non-actionable recognition feed) is deliberately EXCLUDED — it stays on the
// Dashboard. Frontend-only: composes an endpoint that already exists; no backend/schema change.
//
// Render-time merged-set cap (C5 / ADHD-overwhelm): at most TODAY_RENDER_CAP items render; any
// remainder is reported as a non-interactive "+N more" count, never auto-expanded.

export const TODAY_RENDER_CAP = 5

// Priority — lower sorts first. Watering overdue = harm imminent (plants drying); flagged issue =
// active problem; harvest-ready = time-sensitive opportunity; stale = gentle "haven't looked" nudge.
const KIND_PRIORITY = { water: 0, flag: 1, harvest: 2, stale: 3 }

const HARVEST_STYLE = { bg: P.greenPale, border: P.greenLight, text: P.green }
const STALE_STYLE   = SEVERITY_STYLES.gold
const FLAG_STYLE    = { bg: P.alert, border: P.alertBorder, text: P.terra }

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

function flagItem(row) {
  const sev = num(row.severity)
  return {
    key: `flag:${row.project_id}`, kind: 'flag', priority: KIND_PRIORITY.flag,
    sort: -(sev ?? 0), // higher severity first
    emoji: '⚠️', label: 'Needs a look',
    projectId: row.project_id, projectName: projName(row),
    detail: sev ? `flagged · severity ${sev}` : 'flagged issue',
    to: `/log?project=${row.project_id}&event_type=observation`,
    style: FLAG_STYLE,
  }
}

function harvestItem(row) {
  const d = num(row.days_since_obs)
  return {
    key: `harvest:${row.project_id}`, kind: 'harvest', priority: KIND_PRIORITY.harvest,
    sort: -(d ?? 0), // longest-waiting harvest first
    emoji: '\u{1F9FA}', label: 'Ready to harvest',
    projectId: row.project_id, projectName: projName(row),
    detail: d != null && d > 0 ? `${d}d since last check` : 'ready now',
    to: `/log?project=${row.project_id}&event_type=harvest`,
    style: HARVEST_STYLE,
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
  for (const r of (d.heads_up || []))      if (r && r.project_id && r.reason === 'flagged') items.push(flagItem(r))
  for (const r of (d.harvest_ready || [])) if (r && r.project_id) items.push(harvestItem(r))
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
