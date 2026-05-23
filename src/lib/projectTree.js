// Shared project/planting tree utilities for the Garden tab (Increment 1, post-V2 UX overhaul).
// Garden unifies Projects + Plants into one nested accordion: projects form a parent/child
// tree (parent_project_id), and each project's plantings hang under it as leaf rows.
// Frontend-only — composes /api/projects + /api/plants (both already fetched elsewhere).
//
// buildDisplayList: lifted verbatim from ProjectList.jsx so the project ordering/indent
// stays identical across surfaces. buildGardenTree: nests plantings under their owning
// project for the unified accordion. Disclosure state persists in localStorage (production
// PWA — the artifact-only localStorage ban does not apply here).

// Depth-ordered flat list: root projects first, each followed immediately by its descendants.
// Orphaned children (parent missing/deleted) render as roots. (Verbatim from ProjectList.jsx.)
export function buildDisplayList(projects) {
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

  const result = []
  function walk(project, depth) {
    result.push({ project, depth })
    const kids = childrenOf[project.id] || []
    kids.forEach(child => walk(child, depth + 1))
  }
  roots.forEach(r => walk(r, 0))
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
export function buildGardenTree(projects, plants) {
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
  function build(p, depth) {
    return {
      project: p,
      depth,
      children: (byParent[p.id] || []).map(c => build(c, depth + 1)),
      plantings: plantingsBy[p.id] || [],
    }
  }
  return roots.map(r => build(r, 0))
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
