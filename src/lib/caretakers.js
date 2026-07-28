// src/lib/caretakers.js — V4-ASSIGNLENS-001 shared caretaker/assignee helpers.
// The "effective caretaker" of a planting is its own assignee_user_id, else the parent project's
// assignee_user_id, else null (unassigned). System/bot subs resolve to null so they never
// masquerade as a human caretaker. Pure + unit-tested; consumed by Garden, DrG, and Today lenses.
import { P } from './constants.js'

// Stable warm hues for non-self caretakers; the current user always reads P.green ("you").
const OTHER_HUES = [P.terra, '#c9a84c', '#6b8fb5', '#a86b9c']

export function buildProjectsById(projects) {
  const m = new Map()
  for (const p of (projects || [])) if (p && p.id) m.set(p.id, p)
  return m
}

export function effectiveAssignee(planting, projectsById, systemSubs = null) {
  if (!planting) return null
  let sub = planting.assignee_user_id ?? null
  if (!sub) {
    const proj = projectsById && projectsById.get ? projectsById.get(planting.project_id) : null
    sub = proj?.assignee_user_id ?? null
  }
  if (!sub) return null
  if (systemSubs && systemSubs.has(sub)) return null
  return sub
}

// members: [{ id, display_name }] (useMembers; email dropped 0A.6 — never rendered here).
// Returns Map<sub, { id, name, short, initial, color, isMe }>.
export function buildCaretakerMap(members, meId) {
  const map = new Map()
  let i = 0
  for (const m of (members || [])) {
    if (!m || !m.id) continue
    const isMe = m.id === meId
    const name = (m.display_name || '').trim() || 'Gardener'
    const first = name.split(/\s+/)[0]
    map.set(m.id, {
      id: m.id,
      name,
      short: isMe ? 'Mine' : first,
      initial: (first[0] || '?').toUpperCase(),
      color: isMe ? P.green : OTHER_HUES[(i++) % OTHER_HUES.length],
      isMe,
    })
  }
  return map
}

// Lens option list for the segmented control: [Mine, <others…>, Everyone]. 'all' = Everyone.
// meId first (labelled "Mine"), then other members by name, then Everyone.
export function lensOptions(members, meId) {
  const mine = []
  const others = []
  for (const m of (members || [])) {
    if (!m || !m.id) continue
    if (m.id === meId) mine.push({ value: m.id, label: 'Mine' })
    else {
      const name = (m.display_name || '').trim() || 'Gardener'
      others.push({ value: m.id, label: name.split(/\s+/)[0] })
    }
  }
  return [...mine, ...others, { value: 'all', label: 'Everyone' }]
}

// True when the visible set spans >1 distinct effective caretaker (incl. unassigned) — the
// only case where per-tile badges add signal. Single-caretaker sets suppress badges (noise).
export function hasMixedCaretakers(plantings, projectsById, systemSubs = null) {
  const seen = new Set()
  for (const pl of (plantings || [])) {
    seen.add(effectiveAssignee(pl, projectsById, systemSubs) || '∅')
    if (seen.size > 1) return true
  }
  return false
}
