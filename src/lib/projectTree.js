// Shared project/planting tree utilities for the Garden tab (Increment 1, post-V2 UX overhaul).
// Garden unifies Projects + Plants into one nested accordion: projects form a parent/child
// tree (parent_project_id), and each project's plantings hang under it as leaf rows.
// Frontend-only — composes /api/projects + /api/plants (both already fetched elsewhere).
//
// buildDisplayList: lifted verbatim from ProjectList.jsx so the project ordering/indent
// stays identical across surfaces. buildGardenTree: nests plantings under their owning
// project for the unified accordion. Disclosure state persists in localStorage (production
// PWA — the artifact-only localStorage ban does not apply here).

// V3-ORDER-001 (Lane C / PR1): numeric-aware, null-safe, case-insensitive name comparator.
// localeCompare with numeric:true gives natural ordering — "Bed 2" before "Bed 10" — and
// sensitivity:'base' folds case/accents so "apple" and "Apple" sort together. Null/undefined
// names sort as empty string (stable at the front) so a nameless row never throws.
export function byName(a, b) {
  return (a?.name || '').localeCompare(b?.name || '', undefined, { numeric: true, sensitivity: 'base' })
}

// Sort orders. 'recency' = server order (created_at DESC for plantings; API order for projects) —
// the DEFAULT, preserving the ADHD recency / interrupt re-entry anchor (Jen). 'alpha' = byName.
// V002 §5 AUTHORITATIVE: alphanumeric is OPT-IN via a persisted toggle, never the default.
export const SORT_RECENCY = 'recency'
export const SORT_ALPHA = 'alpha'

// Return a NEW array sorted by name when order==='alpha'; otherwise return the input untouched
// (preserves server/recency order without copying). Null-safe.
export function applyNameSort(arr, order) {
  const list = arr || []
  if (order !== SORT_ALPHA) return list
  return [...list].sort(byName)
}

// Depth-ordered flat list: root projects first, each followed immediately by its descendants.
// Orphaned children (parent missing/deleted) render as roots. (Verbatim from ProjectList.jsx.)
// V3-ORDER-001: `order` ('recency'|'alpha') sorts roots + each childrenOf[] level when 'alpha';
// default 'recency' = original behavior (server order) — bytewise-identical traversal.
export function buildDisplayList(projects, order = SORT_RECENCY) {
  const list = projects || []
  const byId = {}
  list.forEach(p => { byId[p.id] = p })

  const roots = []
  const childrenOf = {}
  list.forEach(p => {
    const pid = p.parent_project_id
    if (!pid || !byId[pid]) {
      roots.push(p)
    } else {
      if (!childrenOf[pid]) childrenOf[pid] = []
      childrenOf[pid].push(p)
    }
  })

  const sortedRoots = applyNameSort(roots, order)
  const result = []
  function walk(project, depth) {
    result.push({ project, depth })
    const kids = applyNameSort(childrenOf[project.id] || [], order)
    kids.forEach(child => walk(child, depth + 1))
  }
  sortedRoots.forEach(r => walk(r, 0))
  return result
}

// { [project_id]: [planting, ...] }. Plantings with no project_id are dropped (no home node).
export function groupPlantingsByProjectId(plants) {
  const m = {}
  ;(plants || []).forEach(pl => {
    const k = pl.project_id
    if (k == null) return
    if (!m[k]) m[k] = []
    m[k].push(pl)
  })
  return m
}

// Nested tree: each node = { project, depth, children: [node...], plantings: [planting...] }.
// children are sub-projects; plantings are this project's leaf rows. Used by the accordion,
// which renders children + plantings only when the node is expanded.
export function buildGardenTree(projects, plants, order = SORT_RECENCY) {
  const list = projects || []
  const byId = {}
  list.forEach(p => { byId[p.id] = p })

  const byParent = {}
  const roots = []
  list.forEach(p => {
    const pid = p.parent_project_id
    if (!pid || !byId[pid]) {
      roots.push(p)
    } else {
      if (!byParent[pid]) byParent[pid] = []
      byParent[pid].push(p)
    }
  })

  const plantingsBy = groupPlantingsByProjectId(plants)
  // V3-ORDER-001: when order==='alpha', sort sub-projects (every depth) AND each project's
  // plantings; default 'recency' leaves both in server order (no copy, original behavior).
  function build(p, depth) {
    return {
      project: p,
      depth,
      children: applyNameSort(byParent[p.id] || [], order).map(c => build(c, depth + 1)),
      plantings: applyNameSort(plantingsBy[p.id] || [], order),
    }
  }
  return applyNameSort(roots, order).map(r => build(r, 0))
}

// True if a node has anything to reveal when expanded (sub-projects or plantings).
export function nodeHasChildren(node) {
  return (node.children && node.children.length > 0) || (node.plantings && node.plantings.length > 0)
}

const LS_KEY = 'garden.expanded.v1'

// Disclosure state: a Set of expanded project ids, persisted per-browser. Default = empty
// (collapsed-first — the ADHD-overwhelm mitigation).
export function loadExpanded() {
  try {
    const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(LS_KEY) : null
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr : [])
  } catch (_e) {
    return new Set()
  }
}

export function saveExpanded(set) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY, JSON.stringify([...set]))
  } catch (_e) { /* non-fatal: disclosure persistence is best-effort */ }
}

// ── V3-ORDER-001 persisted sort-order toggle ────────────────────────────────────────────────
// TRACKED EXPEDIENT (V002 §5 + Cross-Device State Principle): persistence lives in localStorage,
// so the chosen sort order is per-device, NOT cross-device. The cross-device-preferred home is a
// per-user server preference; deferring that here keeps Lane C frontend-only. FOLLOW-UP (V4):
// migrate this toggle to a server/per-user pref so a sort choice on phone carries to desktop.
// Mirrors loadExpanded/saveExpanded: best-effort, never throws, recency-default on any failure.
const SORT_LS_KEY = 'garden.sortOrder.v1'

export function loadSortOrder() {
  try {
    const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(SORT_LS_KEY) : null
    return raw === SORT_ALPHA ? SORT_ALPHA : SORT_RECENCY
  } catch (_e) {
    return SORT_RECENCY
  }
}

export function saveSortOrder(order) {
  try {
    const v = order === SORT_ALPHA ? SORT_ALPHA : SORT_RECENCY
    if (typeof localStorage !== 'undefined') localStorage.setItem(SORT_LS_KEY, v)
  } catch (_e) { /* non-fatal: sort-order persistence is best-effort */ }
}
