import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildDisplayList, groupPlantingsByProjectId, buildGardenTree, nodeHasChildren,
  loadExpanded, saveExpanded,
  byName, applyNameSort, loadSortOrder, saveSortOrder, SORT_RECENCY, SORT_ALPHA, buildTagGroupedList,
  NO_PROJECT_ID, cropTypeLabel,
} from '../lib/projectTree.js'

const PROJECTS = [
  { id: 'a', name: 'Tomatoes', parent_project_id: null },
  { id: 'b', name: 'Cherry',   parent_project_id: 'a' },
  { id: 'c', name: 'Beds',     parent_project_id: null },
  { id: 'orphan', name: 'Lost', parent_project_id: 'missing' },
]
const PLANTS = [
  { id: 'p1', name: 'Sungold', project_id: 'b', quantity: 3 },
  { id: 'p2', name: 'Roma',    project_id: 'a', quantity: 1 },
  { id: 'p3', name: 'Nohome',  project_id: null },
]

describe('buildDisplayList', () => {
  it('orders roots first then descendants, with depth (default = alpha)', () => {
    // Default is now alphabetical (owner override 2026-06-04). Roots: Beds(c), Tomatoes(a);
    // under a: Cherry(b). Orphan(Lost) is a root, sorts among roots: Beds, Lost, Tomatoes.
    const out = buildDisplayList(PROJECTS)
    expect(out.map(x => x.project.id)).toEqual(['c', 'orphan', 'a', 'b'])
    expect(out.find(x => x.project.id === 'b').depth).toBe(1)
    expect(out.find(x => x.project.id === 'a').depth).toBe(0)
  })
  it('preserves server order when recency is passed explicitly', () => {
    const out = buildDisplayList(PROJECTS, SORT_RECENCY)
    expect(out.map(x => x.project.id)).toEqual(['a', 'b', 'c', 'orphan'])
  })
  it('treats orphaned children as roots', () => {
    expect(buildDisplayList(PROJECTS).find(x => x.project.id === 'orphan').depth).toBe(0)
  })
  it('handles null/empty input', () => {
    expect(buildDisplayList(null)).toEqual([])
    expect(buildDisplayList([])).toEqual([])
  })
})

describe('groupPlantingsByProjectId', () => {
  it('groups by project_id and drops null project_id', () => {
    const g = groupPlantingsByProjectId(PLANTS)
    expect(g['b'].map(p => p.id)).toEqual(['p1'])
    expect(g['a'].map(p => p.id)).toEqual(['p2'])
    expect(g['null']).toBeUndefined()
    expect(Object.keys(g).sort()).toEqual(['a', 'b'])
  })
  it('handles null input', () => { expect(groupPlantingsByProjectId(null)).toEqual({}) })
})

describe('buildGardenTree', () => {
  it('nests sub-projects and plantings under their project (default = alpha)', () => {
    // Default alphabetical: roots Beds(c), Lost(orphan), Tomatoes(a), then the No-project bucket.
    const tree = buildGardenTree(PROJECTS, PLANTS)
    expect(tree.map(n => n.project.id)).toEqual(['c', 'orphan', 'a', NO_PROJECT_ID])
    const a = tree.find(n => n.project.id === 'a')
    expect(a.children.map(c => c.project.id)).toEqual(['b'])
    expect(a.plantings.map(p => p.id)).toEqual(['p2'])
    expect(a.children[0].plantings.map(p => p.id)).toEqual(['p1'])
    expect(a.depth).toBe(0)
    expect(a.children[0].depth).toBe(1)
  })
  it('preserves server order for roots when recency is passed explicitly', () => {
    const tree = buildGardenTree(PROJECTS, PLANTS, SORT_RECENCY)
    // Real roots keep server order; the No-project bucket is always appended last.
    expect(tree.map(n => n.project.id)).toEqual(['a', 'c', 'orphan', NO_PROJECT_ID])
  })
  // V4-CAPTURE-002: project-less plantings (container_id NULL) surface in a synthetic "No project" bucket.
  it('collects project-less plantings into a synthetic "No project" bucket appended last', () => {
    const tree = buildGardenTree(PROJECTS, PLANTS)
    const bucket = tree[tree.length - 1]
    expect(bucket.project.id).toBe(NO_PROJECT_ID)
    expect(bucket.project.__synthetic).toBe(true)
    expect(bucket.project.name).toBe('No project')
    expect(bucket.children).toEqual([])
    expect(bucket.plantings.map(p => p.id)).toEqual(['p3'])   // the null-project planting
    expect(nodeHasChildren(bucket)).toBe(true)                 // expandable so its plantings are reachable
  })
  it('adds NO bucket when every planting has a live project', () => {
    const tree = buildGardenTree(PROJECTS, [{ id: 'p2', name: 'Roma', project_id: 'a' }])
    expect(tree.find(n => n.project.id === NO_PROJECT_ID)).toBeUndefined()
  })
  it('routes plantings whose project_id points at a missing project into the bucket too', () => {
    const tree = buildGardenTree(PROJECTS, [{ id: 'px', name: 'Ghost', project_id: 'does-not-exist' }])
    const bucket = tree.find(n => n.project.id === NO_PROJECT_ID)
    expect(bucket.plantings.map(p => p.id)).toEqual(['px'])
  })
})

describe('nodeHasChildren', () => {
  it('true when sub-projects or plantings exist, false otherwise', () => {
    const tree = buildGardenTree(PROJECTS, PLANTS)
    expect(nodeHasChildren(tree.find(n => n.project.id === 'a'))).toBe(true)   // has both
    expect(nodeHasChildren(tree.find(n => n.project.id === 'c'))).toBe(false)  // leaf
  })
})

// ── V3-ORDER-001: numeric-aware comparator + per-level sort + recency default + persistence ──
describe('byName comparator', () => {
  it('is numeric-aware ("Bed 2" before "Bed 10")', () => {
    expect(byName({ name: 'Bed 2' }, { name: 'Bed 10' })).toBeLessThan(0)
  })
  it('is case-insensitive (apple == Apple at base sensitivity)', () => {
    expect(byName({ name: 'apple' }, { name: 'Apple' })).toBe(0)
  })
  it('is null-safe (missing/undefined name does not throw)', () => {
    expect(typeof byName({}, { name: 'x' })).toBe('number')
    expect(typeof byName({ name: null }, {})).toBe('number')
  })
})

describe('applyNameSort', () => {
  it('returns server order under recency when there are no activity timestamps (stable)', () => {
    const arr = [{ name: 'Z' }, { name: 'A' }]
    expect(applyNameSort(arr, SORT_RECENCY).map(x => x.name)).toEqual(['Z', 'A'])
  })
  it('sorts by last_activity_at DESC under recency (BUG-ORDER-001)', () => {
    const arr = [
      { name: 'old', created_at: '2026-01-01T00:00:00Z' },
      { name: 'fresh', last_activity_at: '2026-06-10T00:00:00Z' },
      { name: 'mid', last_activity_at: '2026-03-01T00:00:00Z' },
    ]
    expect(applyNameSort(arr, SORT_RECENCY).map(x => x.name)).toEqual(['fresh', 'mid', 'old'])
  })
  it('returns a NEW sorted array under alpha without mutating the input', () => {
    const arr = [{ name: 'Z' }, { name: 'A' }]
    const out = applyNameSort(arr, SORT_ALPHA)
    expect(out).not.toBe(arr)
    expect(out.map(x => x.name)).toEqual(['A', 'Z'])
    expect(arr.map(x => x.name)).toEqual(['Z', 'A'])  // input untouched
  })
  it('is null-safe', () => { expect(applyNameSort(null, SORT_ALPHA)).toEqual([]) })
})

describe('ordering default = alpha (owner override), recency is opt-in', () => {
  const PROJS = [
    { id: 'b', name: 'Zebra',  parent_project_id: null },
    { id: 'a', name: 'Apple',  parent_project_id: null },
    { id: 'd', name: 'Banana', parent_project_id: 'a' },
    { id: 'c', name: 'Cherry', parent_project_id: 'a' },
  ]
  const PL = [
    { id: 'y', name: 'Yam',  project_id: 'a' },
    { id: 'x', name: 'Beet', project_id: 'a' },
  ]

  it('buildDisplayList default sorts roots AND every child level (alpha)', () => {
    // default alpha: roots Apple(a), Zebra(b); under a: Banana(d), Cherry(c)
    expect(buildDisplayList(PROJS).map(x => x.project.id)).toEqual(['a', 'd', 'c', 'b'])
  })
  it('buildDisplayList recency (opt-in) keeps server order', () => {
    expect(buildDisplayList(PROJS, SORT_RECENCY).map(x => x.project.id)).toEqual(['b', 'a', 'd', 'c'])
  })
  it('buildGardenTree default sorts roots, children, AND plantings (alpha)', () => {
    const tree = buildGardenTree(PROJS, PL)
    expect(tree.map(n => n.project.name)).toEqual(['Apple', 'Zebra'])
    const a = tree.find(n => n.project.id === 'a')
    expect(a.children.map(c => c.project.name)).toEqual(['Banana', 'Cherry'])
    expect(a.plantings.map(p => p.name)).toEqual(['Beet', 'Yam'])
  })
  it('buildGardenTree recency (opt-in) keeps server order for roots, children, AND plantings', () => {
    const tree = buildGardenTree(PROJS, PL, SORT_RECENCY)
    expect(tree.map(n => n.project.id)).toEqual(['b', 'a'])
    const a = tree.find(n => n.project.id === 'a')
    expect(a.children.map(c => c.project.id)).toEqual(['d', 'c'])
    expect(a.plantings.map(p => p.id)).toEqual(['y', 'x'])
  })
  it('identical ordering across surfaces (displayList roots == tree roots) under both orders', () => {
    const rootsAlpha = buildDisplayList(PROJS).filter(x => x.depth === 0).map(x => x.project.id)
    expect(buildGardenTree(PROJS, PL).map(n => n.project.id)).toEqual(rootsAlpha)
    const rootsRecency = buildDisplayList(PROJS, SORT_RECENCY).filter(x => x.depth === 0).map(x => x.project.id)
    expect(buildGardenTree(PROJS, PL, SORT_RECENCY).map(n => n.project.id)).toEqual(rootsRecency)
  })
})

describe('loadSortOrder / saveSortOrder (persisted toggle, alpha default — owner override)', () => {
  beforeEach(() => { localStorage.clear() })
  it('defaults to alpha when nothing persisted', () => {
    expect(loadSortOrder()).toBe(SORT_ALPHA)
  })
  it('round-trips recency (toggling persists the recency choice)', () => {
    saveSortOrder(SORT_RECENCY)
    expect(loadSortOrder()).toBe(SORT_RECENCY)
  })
  it('round-trips alpha', () => {
    saveSortOrder(SORT_RECENCY); saveSortOrder(SORT_ALPHA)
    expect(loadSortOrder()).toBe(SORT_ALPHA)
  })
  it('coerces an unknown persisted value to alpha (safe default)', () => {
    localStorage.setItem('garden.sortOrder.v1', 'garbage')
    expect(loadSortOrder()).toBe(SORT_ALPHA)
  })
})

describe('loadExpanded / saveExpanded', () => {
  beforeEach(() => { localStorage.clear() })
  it('defaults to empty set (collapsed-first)', () => {
    expect(loadExpanded().size).toBe(0)
  })
  it('round-trips a set of ids', () => {
    saveExpanded(new Set(['a', 'b']))
    const loaded = loadExpanded()
    expect(loaded.has('a')).toBe(true)
    expect(loaded.has('b')).toBe(true)
    expect(loaded.size).toBe(2)
  })
  it('returns empty set on corrupt storage', () => {
    localStorage.setItem('garden.expanded.v1', '{not json')
    expect(loadExpanded().size).toBe(0)
  })
})

// ── V3-ARCHIVE-001: archived exclusion (defence-in-depth; API also filters) ──────────────
describe('V3-ARCHIVE-001 archived exclusion', () => {
  it('buildDisplayList drops archived projects', () => {
    const projects = [
      { id: 'a', name: 'Active', parent_project_id: null },
      { id: 'z', name: 'Zarchived', parent_project_id: null, archived_at: '2026-06-12T00:00:00Z' },
    ]
    const ids = buildDisplayList(projects).map(({ project }) => project.id)
    expect(ids).toContain('a')
    expect(ids).not.toContain('z')
  })

  it('buildGardenTree drops archived projects and archived plantings', () => {
    const projects = [
      { id: 'a', name: 'Active', parent_project_id: null },
      { id: 'z', name: 'Zarchived', parent_project_id: null, archived_at: '2026-06-12T00:00:00Z' },
    ]
    const plants = [
      { id: 'p1', name: 'Live plant', project_id: 'a' },
      { id: 'p2', name: 'Put-away plant', project_id: 'a', archived_at: '2026-06-12T00:00:00Z' },
    ]
    const tree = buildGardenTree(projects, plants)
    const projIds = tree.map(n => n.project.id)
    expect(projIds).toEqual(['a'])
    const plantingIds = tree[0].plantings.map(pl => pl.id)
    expect(plantingIds).toEqual(['p1'])
  })

  it('an archived child project does not render under its active parent', () => {
    const projects = [
      { id: 'root', name: 'Root', parent_project_id: null },
      { id: 'kid', name: 'Kid', parent_project_id: 'root', archived_at: '2026-06-12T00:00:00Z' },
    ]
    const tree = buildGardenTree(projects, [])
    expect(tree.map(n => n.project.id)).toEqual(['root'])
    expect(tree[0].children).toEqual([])
  })
})


describe('buildTagGroupedList — Lifecycle (status) grouping', () => {
  const PL = [
    { id: '1', name: 'B-plant', status: 'seedling' },
    { id: '2', name: 'A-plant', status: 'vegetative' },
    { id: '3', name: 'C-plant', status: 'seedling' },
    { id: '4', name: 'D-plant', status: null },
  ]
  it('groups by plant.status in PLANT_STATUSES (lifecycle) order, not alpha', () => {
    const groups = buildTagGroupedList(PL, {}, 'status')
    // seedling (idx 1) before vegetative (idx 2); status-less -> Unstaged last
    const labels = groups.map(g => g.label)
    expect(labels[0]).toBe('Seedling')
    expect(labels[1]).toBe('Vegetative')
    expect(labels[groups.length - 1]).toBe('Unstaged')
  })
  it('counts members and name-sorts within a status group', () => {
    const groups = buildTagGroupedList(PL, {}, 'status')
    const seedling = groups.find(g => g.slug === 'seedling')
    expect(seedling.count).toBe(2)
    expect(seedling.facet).toBe('status')
    expect(seedling.plantings.map(p => p.name)).toEqual(['B-plant', 'C-plant'].sort((a, b) => a.localeCompare(b)))
  })
})

describe('buildTagGroupedList — crop_type grouping (V4-PROJHIDE-001)', () => {
  const CT = [
    { id: 'p1', name: 'Sungold',  variety_ref: { crop_type_slug: 'tomato' } },
    { id: 'p2', name: 'Roma',     variety_ref: { crop_type_slug: 'tomato' } },
    { id: 'p3', name: 'Jalapeño', variety_ref: { crop_type_slug: 'pepper' } },
    { id: 'p4', name: 'Mystery',  variety_ref: null },  // variety but no crop type
    { id: 'p5', name: 'Novar' },                          // no variety_ref at all
  ]
  it('groups by variety_ref.crop_type_slug, single-membership', () => {
    const byLabel = Object.fromEntries(buildTagGroupedList(CT, null, 'crop_type').map(g => [g.label, g]))
    expect(byLabel.Tomato.count).toBe(2)
    expect(byLabel.Pepper.count).toBe(1)
    expect(byLabel.Tomato.plantings.map(p => p.id).sort()).toEqual(['p1', 'p2'])
  })
  it('sorts crop groups alpha by label with "Other" last', () => {
    expect(buildTagGroupedList(CT, null, 'crop_type').map(g => g.label)).toEqual(['Pepper', 'Tomato', 'Other'])
  })
  it('collects crop-type-less plantings into a trailing "Other" (isUnsorted) group', () => {
    const other = buildTagGroupedList(CT, null, 'crop_type').find(g => g.isUnsorted)
    expect(other.label).toBe('Other')
    expect(other.plantings.map(p => p.id).sort()).toEqual(['p4', 'p5'])
  })
  it('tags every group with facet:"crop_type" (header coloring) and needs no tagMap', () => {
    expect(buildTagGroupedList(CT, null, 'crop_type').every(g => g.facet === 'crop_type')).toBe(true)
  })
})

describe('cropTypeLabel (V4-PROJHIDE-001)', () => {
  it('title-cases single and multi-word slugs', () => {
    expect(cropTypeLabel('pepper')).toBe('Pepper')
    expect(cropTypeLabel('sweet-potato')).toBe('Sweet Potato')
    expect(cropTypeLabel('brussels_sprouts')).toBe('Brussels Sprouts')
  })
  it('is null/empty-safe', () => {
    expect(cropTypeLabel(null)).toBe('')
    expect(cropTypeLabel('')).toBe('')
  })
})
