import { P } from './constants.js'
import { severityTier, SEVERITY_STYLES, overdueLabel } from './waterDue.js'

// "Today" band item model (Inc 1 — full band). Merges the actionable "what needs me now?"
// signals ALREADY returned by /api/dashboard — watering overdue and long-unseen
// (stale) projects — into ONE ranked, de-duplicated, capped list, each row.
// FLAG-REMOVAL (2026-06-10): flagged-issue rows are no longer surfaced; the planting-flagging
// UI was retired (server still emits reason='flagged' heads_up rows — ignored here).
// V3-HARVEST-001 (2026-06-08): harvest-ready is INTENTIONALLY EXCLUDED from this above-nav band —
// a harvesting project stays harvest-ready for weeks, so surfacing it here was a constant nag.
//
// V3-ATTN-001 (2026-06-23): alerts should name the PLANTING, not the project/container grouping
// ("Houseplants needs water" -> "Dracaena needs water"). The dashboard rows now carry a `plantings`
// array (each actionable garden_node in the container: {id,name}). Rule: a container that holds
// EXACTLY ONE actionable planting collapses to that planting (name + planting-scoped deep-link) — the
// reported case. A container with MANY plantings (e.g. a "Peppers" bed of 50+) stays a single grouped
// row keyed by the container (expanding would flood the 5-item band; the bed shares one care cadence,
// so it is genuinely one action). Rows without a `plantings` array (older payloads / safety) fall back
// to the legacy project-level row so the band never goes blank.
//
// V4-ICON-001 (2026-08-26): rows carry `iconName` (a registry key) instead of the former `emoji`
// literal. The two reasons map to `care.drop` (water) and `status.unseen` (long-unseen); both are
// drawn SVGs with their own accessibleName, so the row's meaning survives a font that has no
// pictographs and is not carried by hue alone. TodayBand.jsx renders them through <Icon>.
//
// Each row carries a reason-label + a tap-to-log route. OPERATIONAL surface (harm-prevention +
// time-sensitive opportunity), NOT a reward surface: no streaks/badges/celebration; recent-activity
// stays on the Dashboard. Render-time cap (C5 / ADHD-overwhelm): at most TODAY_RENDER_CAP render;
// remainder reported as a non-interactive "+N more", never auto-expanded.

export const TODAY_RENDER_CAP = 5

// Priority — lower sorts first. Watering overdue = harm imminent (plants drying); stale =
// gentle "haven't looked" nudge. (harvest removed per V3-HARVEST-001; flag removed 2026-06-10.)
const KIND_PRIORITY = { water: 0, stale: 1 }

const STALE_STYLE   = SEVERITY_STYLES.gold

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null }
function projName(row) { return row.project_name ?? row.name ?? 'Untitled' }

// The single actionable planting to name when a container holds exactly one; else null (grouped row).
// `plantings` is the V3-ATTN-001 additive field; absent on legacy payloads (-> null -> project fallback).
function lonePlanting(row) {
  const ps = Array.isArray(row.plantings) ? row.plantings.filter(p => p && p.id) : []
  return ps.length === 1 ? ps[0] : null
}

function waterItem(row) {
  const tier = severityTier(row.next_water_at, row.location_type)
  const style = SEVERITY_STYLES[tier] || SEVERITY_STYLES.gold
  const detail = overdueLabel(row.next_water_at)
  const sort = -(Date.now() - new Date(row.next_water_at).getTime()) // most-overdue first
  const p = lonePlanting(row)
  if (p) return {
    key: `water:plant:${p.id}`, kind: 'water', priority: KIND_PRIORITY.water, sort,
    iconName: 'care.drop', label: 'Needs water',
    plantId: p.id, projectId: row.project_id, projectName: p.name || projName(row),
    detail, to: `/log?project=${row.project_id}&plant=${p.id}&event_type=watering`, style,
  }
  return {
    key: `water:${row.project_id}`, kind: 'water', priority: KIND_PRIORITY.water, sort,
    iconName: 'care.drop', label: 'Needs water',
    plantId: null, projectId: row.project_id, projectName: projName(row),
    detail, to: `/log?project=${row.project_id}&event_type=watering`, style,
  }
}

function staleItem(row) {
  const d = num(row.days_stale)
  const detail = d != null ? `${d} days unseen` : 'not seen lately'
  const sort = -(d ?? 0) // longest-unseen first
  const p = lonePlanting(row)
  if (p) return {
    key: `stale:plant:${p.id}`, kind: 'stale', priority: KIND_PRIORITY.stale, sort,
    iconName: 'status.unseen', label: 'Not seen lately',
    plantId: p.id, projectId: row.project_id, projectName: p.name || projName(row),
    detail, to: `/log?project=${row.project_id}&plant=${p.id}&event_type=observation`, style: STALE_STYLE,
  }
  return {
    key: `stale:${row.project_id}`, kind: 'stale', priority: KIND_PRIORITY.stale, sort,
    iconName: 'status.unseen', label: 'Not seen lately',
    plantId: null, projectId: row.project_id, projectName: projName(row),
    detail, to: `/log?project=${row.project_id}&event_type=observation`, style: STALE_STYLE,
  }
}

// Build the ranked, de-duplicated Today list from a /api/dashboard payload. Defensive against a
// null / array / partial payload (a dashboard fetch failure must never throw here). De-dup target =
// the PLANTING when one was named, else the project: each surfaces ONCE under its most-urgent reason.
export function buildTodayItems(dashboard) {
  const d = (dashboard && !Array.isArray(dashboard)) ? dashboard : {}
  const items = []
  for (const r of (d.water_due || []))     if (r && r.project_id) items.push(waterItem(r))
  // V3-HARVEST-001: harvest_ready deliberately NOT merged. FLAG-REMOVAL: reason='flagged' ignored.
  for (const r of (d.heads_up || []))      if (r && r.project_id && r.reason === 'stale') items.push(staleItem(r))

  const byTarget = new Map()
  for (const it of items) {
    const k = it.plantId != null ? `plant:${it.plantId}` : `proj:${it.projectId}`
    const prev = byTarget.get(k)
    if (!prev || it.priority < prev.priority) byTarget.set(k, it)
  }
  return [...byTarget.values()].sort(
    (a, b) => a.priority - b.priority || a.sort - b.sort || a.projectName.localeCompare(b.projectName)
  )
}

// Split into the rendered head (<= cap) + overflow count. Pure; the component renders
// `visible` then a "+ more" line when `more > 0`.
export function todayBand(dashboard, cap = TODAY_RENDER_CAP) {
  const all = buildTodayItems(dashboard)
  return { visible: all.slice(0, cap), more: Math.max(0, all.length - cap), total: all.length }
}
