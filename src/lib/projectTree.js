import { PLANT_STATUSES, statusLabel } from './constants.js'

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

// BUG-ORDER-001: recency comparator — most-recently-active first. Prefers the
// server-computed last_activity_at (max event date), else updated_at, else
// created_at. Missing/equal keys -> 0 so a stable sort preserves server order.
function recencyKey(x) {
  const t = Date.parse(x?.last_activity_at || x?.updated_at || x?.created_at || '')
  return Number.isNaN(t) ? 0 : t
}
export function byRecency(a, b) {
  return recencyKey(b) - recencyKey(a)
}

// Sort orders. 'alpha' = byName (case-insensitive, numeric-aware) — the DEFAULT.
// 'recency' = most-recently-active first (last_activity_at from the server; created_at fallback).
// OWNER OVERRIDE (Dave, 2026-06-04): alphabetical is the default per Dave's explicit decision,
// overriding the Crucible's recency-default (V002 §5 / V3-ORDER-001). This restores Dave's
// original ss1-screenshot intent. Recency remains available and persists one tap away via the
// SortToggle. Do NOT revert to a recency default without a fresh owner decision.
export const SORT_RECENCY = 'recency'
export const SORT_ALPHA = 'alpha'

// V4-CAPTURE-002: synthetic node id for the "No project" bucket that collects project-less plantings
// (container_id NULL). Not a real project — TreeNode renders it inert (no detail link / favorite / badge).
export const NO_PROJECT_ID = '__noproject__'

// Return a NEW array sorted by name when order==='alpha'; otherwise return the input untouched
// (preserves server/recency order without copying). Null-safe.
export function applyNameSort(arr, order) {
  const list = arr || []
  if (order === SORT_ALPHA) return [...list].sort(byName)
  // BUG-ORDER-001: recency = most-recently-active first; stable sort preserves
  // server order when activity timestamps are equal/absent.
  return [...list].sort(byRecency)
}

// Depth-ordered flat list: root projects first, each followed immediately by its descendants.
// Orphaned children (parent missing/deleted) render as roots. (Verbatim from ProjectList.jsx.)
// V3-ORDER-001: `order` ('recency'|'alpha') sorts roots + each childrenOf[] level when 'alpha';
// default is now 'alpha' (owner override 2026-06-04). 'recency' preserves server order.
export function buildDisplayList(projects, order = SORT_ALPHA) {
  // V3-ARCHIVE-001: archived projects never render in active surfaces (defence-in-depth;
  // the /api/projects list already excludes them, this also covers optimistic local state).
  const list = (projects || []).filter(p => p && !p.archived_at)
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
export function buildGardenTree(projects, plants, order = SORT_ALPHA) {
  // V3-ARCHIVE-001: drop archived projects AND archived plantings from the active tree.
  const list = (projects || []).filter(p => p && !p.archived_at)
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

  const livePlants = (plants || []).filter(pl => pl && !pl.archived_at)
  const plantingsBy = groupPlantingsByProjectId(livePlants)
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
  const nodes = applyNameSort(roots, order).map(r => build(r, 0))
  // V4-CAPTURE-002: project-less plantings (container_id NULL — photo-first capture, "V4 tagging will
  // re-home later") were invisible in the by-project tree because they hang under no project node.
  // Collect them (null project_id OR a project_id with no live project) into a synthetic "No project"
  // bucket appended after the real roots so they surface and can be opened/re-homed.
  const orphans = livePlants.filter(pl => pl.project_id == null || !byId[pl.project_id])
  if (orphans.length) {
    nodes.push({
      project: { id: NO_PROJECT_ID, name: 'No project', status: null, parent_project_id: null, __synthetic: true },
      depth: 0,
      children: [],
      plantings: applyNameSort(orphans, order),
    })
  }
  return nodes
}

// True if a node has anything to reveal when expanded (sub-projects or plantings).
export function nodeHasChildren(node) {
  return (node.children && node.children.length > 0) || (node.plantings && node.plantings.length > 0)
}

// ─── V4-GARDENIA-001: faceted group-by (ADDITIVE; buildGardenTree/buildDisplayList are
//     untouched and remain golden-gated to parity hash 8a3d78f098e55ff2) ──────────────────
export const UNSORTED_SLUG = '__unsorted__'

// Flatten a planting's bulk entity-tags entry { direct, projected } into one tag list.
export function tagsForPlanting(tagMap, plantingId) {
  const e = tagMap && tagMap[plantingId]
  if (!e) return []
  return [...(e.direct || []), ...(e.projected || [])]
}

// V4-HEATSORT-001 / V4-DETSORT-001 / V4-DAYLEN-001 — canonical group ORDER for the classification
// facets (V4-CLASSIFY-001). Alphabetical is nonsensical for these (Heat -> Hot, Medium, Mild, Sweet);
// each has a real semantic order. A facet listed here sorts its groups by slug index; any facet NOT
// listed (type, lifecycle tags, location, group, freeform) keeps the alpha default. Unknown/future
// slugs sort AFTER all known values (alpha among themselves); the no-value "Unsorted" group stays
// dead last (appended below). Slugs mirror lambda/tags/crop-derive.js (HEAT_BANDS + *_LABELS); the
// determinacy + day_length orders are horticulturally-locked (compact->sprawling; photoperiod
// continuum south->north with day-neutral off-axis last).
export const FACET_VALUE_ORDER = {
  heat: ['sweet', 'mild', 'medium', 'hot', 'very_hot', 'superhot'],
  determinacy: ['dwarf', 'determinate', 'semi_determinate', 'indeterminate'],
  day_length: ['short_day', 'intermediate', 'long_day', 'day_neutral'],
  allium_type: ['bulbing', 'bunching'],
  basil_use: ['culinary', 'thai', 'tulsi'],
  // V4-BEANFACET-001. bean_habit compact->sprawling (mirrors determinacy); bean_use young->mature
  // harvest stage with dual last; bean_type Phaseolus group, then Vigna, then Vicia/Glycine.
  bean_type: ['common', 'runner', 'lima', 'yardlong', 'cowpea', 'fava', 'soybean'],
  bean_habit: ['bush', 'half_runner', 'pole'],
  bean_use: ['snap', 'shell', 'dry', 'dual_purpose'],
}

// Comparator for facet-value groups: canonical slug order first (when the facet has one), label
// alpha as the tiebreak / for unlisted facets. Unknown slugs -> index 999 (after all known).
function compareFacetGroups(facet) {
  const order = FACET_VALUE_ORDER[facet]
  const idx = order ? (slug) => { const i = order.indexOf(slug); return i === -1 ? 999 : i } : null
  return (a, b) => {
    if (idx) { const d = idx(a.slug) - idx(b.slug); if (d !== 0) return d }
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
  }
}

// Group plantings by the active facet's tag values. tagMap = { [plantingId]: { direct:Tag[],
// projected:Tag[] } } from GET /api/entity-tags?entity_type=plant. A planting appears under EVERY
// tag value it carries in `facet` (multi-membership); plantings with no tag in that facet fall into
// a trailing "Unsorted" group. Groups sort by the facet's canonical order (FACET_VALUE_ORDER) when
// it has one, else alpha by label; Unsorted is always last. Returns null when `facet` is falsy — the
// caller then renders the legacy by-project tree (golden path).
export function buildTagGroupedList(plantings, tagMap, facet, order = SORT_ALPHA, locations = []) {
  if (!facet) return null
  const live = (plantings || []).filter(p => p && !p.archived_at)
  if (facet === 'status') return buildStatusGroupedList(live, order)
  if (facet === 'crop_type') return buildCropTypeGroupedList(live, order)
  if (facet === 'location') return buildLocationGroupedList(live, order, locations)
  const groups = new Map()
  const unsorted = []
  live.forEach(p => {
    const matches = tagsForPlanting(tagMap, p.id).filter(t => t && t.facet === facet)
    if (matches.length === 0) { unsorted.push(p); return }
    matches.forEach(t => {
      let g = groups.get(t.slug)
      if (!g) { g = { slug: t.slug, label: t.label || t.slug, facet, plantings: [] }; groups.set(t.slug, g) }
      g.plantings.push(p)
    })
  })
  const out = [...groups.values()]
    .sort(compareFacetGroups(facet))
    .map(g => ({ ...g, plantings: applyNameSort(g.plantings, order), count: g.plantings.length }))
  if (unsorted.length) {
    out.push({ slug: UNSORTED_SLUG, label: 'Unsorted', facet, isUnsorted: true,
      plantings: applyNameSort(unsorted, order), count: unsorted.length })
  }
  return out
}

// V4-GARDENLOCFILTER-001: group by PHYSICAL LOCATION. Structural, not tag-based — reads
// garden_node.location_id directly, same posture as crop_type/status, so it needs no entity_tag rows
// (there are zero 'location'-facet tags in prod and none are planned). `locations` = GET /api/locations
// rows ({id, name, parent_id, sort_order}).
//
// Owner decisions baked in (Dave 2026-08-05):
//   • NESTED — groups emit depth-first parent-then-children, each carrying `depth` so the renderer can
//     indent (zone -> area/rack -> shelf). A parent holds only its OWN direct plantings; children are
//     separate groups, because a zone like Drive has 9 of its own plus two child areas.
//   • EMPTY LOCATIONS ARE EMITTED (count 0). An empty shelf is a place to fill, not noise.
//   • No location_id -> the shared trailing Unsorted bucket, which Dave edits from.
//
// Robustness: a planting whose location_id names a missing/deleted location would otherwise vanish from
// the view entirely (silent data loss in a grouping is worse than a wrong bucket), so those fall through
// to Unsorted. A parent_id pointing at a missing row makes that location a root rather than dropping it,
// and `seen` guards against a parent cycle putting the walk into infinite recursion.
export function buildLocationGroupedList(live, order, locations) {
  const rows = (locations || []).filter(l => l && l.id)
  const byParent = new Map()
  for (const l of rows) {
    const key = l.parent_id ?? null
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key).push(l)
  }
  const known = new Set(rows.map(l => l.id))
  for (const arr of byParent.values()) {
    arr.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
      || String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }))
  }
  const direct = new Map()
  const unsorted = []
  live.forEach(p => {
    const id = p.location_id
    // Unknown id -> Unsorted, so the planting stays visible somewhere.
    if (!id || !known.has(id)) { unsorted.push(p); return }
    if (!direct.has(id)) direct.set(id, [])
    direct.get(id).push(p)
  })
  const out = []
  const seen = new Set()
  const emit = (l, depth) => {
    seen.add(l.id)
    const mine = direct.get(l.id) || []
    out.push({
      slug: l.id, label: l.name || 'Location', facet: 'location', depth,
      plantings: applyNameSort(mine, order), count: mine.length,
    })
  }
  const walk = (parentId, depth) => {
    for (const l of (byParent.get(parentId) || [])) {
      if (seen.has(l.id)) continue
      emit(l, depth)
      walk(l.id, depth + 1)
    }
  }
  walk(null, 0)
  // Roots by orphaning (parent_id set but that parent is gone) or by cycle — emit flat so nothing is lost.
  for (const l of rows) if (!seen.has(l.id)) emit(l, 0)
  if (unsorted.length) {
    out.push({
      slug: UNSORTED_SLUG, label: 'Unsorted', facet: 'location', isUnsorted: true, depth: 0,
      plantings: applyNameSort(unsorted, order), count: unsorted.length,
    })
  }
  return out
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

// V4-NAVSTATE-001: the FACETED/grouped Garden view (groupBy !== 'none') tracked its expanded
// sections in component-local state, so a drill-in + back remount reset every section to collapsed
// (the "back button collapses the tree" bug). Persist it per-browser, mirroring loadExpanded/
// saveExpanded. Keyed separately (groups are tag-facet slugs, not project ids). Default = empty
// Set (collapsed-first — same ADHD-overwhelm posture as the by-project tree).
const GROUPS_LS_KEY = 'garden.groupsExpanded.v1'

export function loadGroupsExpanded() {
  try {
    const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(GROUPS_LS_KEY) : null
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr : [])
  } catch (_e) {
    return new Set()
  }
}

export function saveGroupsExpanded(set) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(GROUPS_LS_KEY, JSON.stringify([...set]))
  } catch (_e) { /* non-fatal: disclosure persistence is best-effort */ }
}

// ── V3-ORDER-001 persisted sort-order toggle ───────────────────────────────────
// TRACKED EXPEDIENT (V002 §5 + Cross-Device State Principle): persistence lives in localStorage,
// so the chosen sort order is per-device, NOT cross-device. The cross-device-preferred home is a
// per-user server preference; deferring that here keeps Lane C frontend-only. FOLLOW-UP (V4):
// migrate this toggle to a server/per-user pref so a sort choice on phone carries to desktop.
// Mirrors loadExpanded/saveExpanded: best-effort, never throws. Default (nothing stored) = ALPHA
// per the owner override (Dave, 2026-06-04); returns RECENCY only when localStorage explicitly
// holds the recency value. Any other/missing/corrupt value falls back to the alpha default.
const SORT_LS_KEY = 'garden.sortOrder.v1'

export function loadSortOrder() {
  try {
    const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(SORT_LS_KEY) : null
    return raw === SORT_RECENCY ? SORT_RECENCY : SORT_ALPHA
  } catch (_e) {
    return SORT_ALPHA
  }
}

export function saveSortOrder(order) {
  try {
    const v = order === SORT_ALPHA ? SORT_ALPHA : SORT_RECENCY
    if (typeof localStorage !== 'undefined') localStorage.setItem(SORT_LS_KEY, v)
  } catch (_e) { /* non-fatal: sort-order persistence is best-effort */ }
}

// V4-GARDENIA-001: persisted active group-by facet ('none' = legacy by-project tree).
// Per-browser localStorage like sort/expanded; cross-device server-state is tracked tech-debt
// (Cross-Device State Principle) under V4-GARDENIA-PREFS follow-up.
const GROUPBY_KEY = 'garden.groupBy.v1'
export function loadGroupBy() {
  try { return localStorage.getItem(GROUPBY_KEY) || 'none' } catch { return 'none' }
}
export function saveGroupBy(value) {
  try { localStorage.setItem(GROUPBY_KEY, value) } catch { /* private mode / quota — non-fatal */ }
}


// V4: group plantings by lifecycle STAGE (plant.status: seed->seedling->...->ended). Not a tag
// facet — status is a first-class plant field. Groups order by PLANT_STATUSES (the canonical
// lifecycle order), labelled via statusLabel(); the group `facet` is 'status' so headers color
// through getStatusColors. Status-less plantings fall into an "Unstaged" group.
function buildStatusGroupedList(live, order) {
  const groups = new Map()
  const unsorted = []
  live.forEach(p => {
    const st = p.status
    if (!st) { unsorted.push(p); return }
    let g = groups.get(st)
    if (!g) { g = { slug: st, label: statusLabel(st), facet: 'status', plantings: [] }; groups.set(st, g) }
    g.plantings.push(p)
  })
  const idx = (st) => { const i = PLANT_STATUSES.indexOf(st); return i === -1 ? 999 : i }
  const out = [...groups.values()]
    .sort((a, b) => idx(a.slug) - idx(b.slug) || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
    .map(g => ({ ...g, plantings: applyNameSort(g.plantings, order), count: g.plantings.length }))
  if (unsorted.length) {
    out.push({ slug: UNSORTED_SLUG, label: 'Unstaged', facet: 'status', isUnsorted: true,
      plantings: applyNameSort(unsorted, order), count: unsorted.length })
  }
  return out
}

// V4-PROJHIDE-001: title-case a crop_type_slug for display ('sweet-potato' -> 'Sweet Potato',
// 'pepper' -> 'Pepper'). The /api/plants variety_ref carries only the slug (no display name), so the
// label is derived here. Split on -/_/space so multi-word slugs read naturally.
export function cropTypeLabel(slug) {
  return String(slug || '').split(/[-_ ]+/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

// V4-PROJHIDE-001: group plantings by CROP TYPE (tomato, pepper, tomatillo...) — the user-facing
// organizing axis once projects are hidden. Crop type comes from the planting's cultivar join
// (variety_ref.crop_type_slug on /api/plants), NOT the entity-tags 'type' facet, which is unpopulated
// in prod (2 smoke rows). A planting belongs to exactly ONE crop type (single-membership, unlike tag
// facets); those with no resolved crop type fall into a trailing "Other" group. Groups sort alpha by
// label (no semantic order for crops); "Other" is always last. Dispatched from buildTagGroupedList
// when facet === 'crop_type'.
function buildCropTypeGroupedList(live, order) {
  const groups = new Map()
  const other = []
  live.forEach(p => {
    const slug = p.variety_ref?.crop_type_slug
    if (!slug) { other.push(p); return }
    let g = groups.get(slug)
    if (!g) { g = { slug, label: cropTypeLabel(slug), facet: 'crop_type', plantings: [] }; groups.set(slug, g) }
    g.plantings.push(p)
  })
  const out = [...groups.values()]
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }))
    .map(g => ({ ...g, plantings: applyNameSort(g.plantings, order), count: g.plantings.length }))
  if (other.length) {
    out.push({ slug: UNSORTED_SLUG, label: 'Other', facet: 'crop_type', isUnsorted: true,
      plantings: applyNameSort(other, order), count: other.length })
  }
  return out
}
