import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildDisplayList, groupPlantingsByProjectId, buildGardenTree, nodeHasChildren,
  loadExpanded, saveExpanded,
  byName, applyNameSort, loadSortOrder, saveSortOrder, SORT_RECENCY, SORT_ALPHA,
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
  it('orders roots first then descendants, with depth', () => {
    const out = buildDisplayList(PROJECTS)
    expect(out.map(x => x.project.id)).toEqual(['a', 'b', 'c', 'orphan'])
    expect(out.find(x => x.project.id === 'b').depth).toBe(1)
    expect(out.find(x => x.project.id === 'a').depth).toBe(0)
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
  it('nests sub-projects and plantings under their project', () => {
    const tree = buildGardenTree(PROJECTS, PLANTS)
    expect(tree.map(n => n.project.id)).toEqual(['a', 'c', 'orphan'])
    const a = tree.find(n => n.project.id === 'a')
    expect(a.children.map(c => c.project.id)).toEqual(['b'])
    expect(a.plantings.map(p => p.id)).toEqual(['p2'])
    expect(a.children[0].plantings.map(p => p.id)).toEqual(['p1'])
    expect(a.depth).toBe(0)
    expect(a.children[0].depth).toBe(1)
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
  it('returns the SAME array reference under recency (no copy, server order preserved)', () => {
    const arr = [{ name: 'Z' }, { name: 'A' }]
    expect(applyNameSort(arr, SORT_RECENCY)).toBe(arr)
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

describe('ordering default = recency (server order), alpha is opt-in', () => {
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

  it('buildDisplayList default keeps server order (recency anchor)', () => {
    expect(buildDisplayList(PROJS).map(x => x.project.id)).toEqual(['b', 'a', 'd', 'c'])
  })
  it('buildDisplayList alpha sorts roots AND every child level', () => {
    // roots: Apple(a), Zebra(b); under a: Banana(d), Cherry(c)
    expect(buildDisplayList(PROJS, SORT_ALPHA).map(x => x.project.id)).toEqual(['a', 'd', 'c', 'b'])
  })
  it('buildGardenTree default keeps server order for roots, children, AND plantings', () => {
    const tree = buildGardenTree(PROJS, PL)
    expect(tree.map(n => n.project.id)).toEqual(['b', 'a'])
    const a = tree.find(n => n.project.id === 'a')
    expect(a.children.map(c => c.project.id)).toEqual(['d', 'c'])
    expect(a.plantings.map(p => p.id)).toEqual(['y', 'x'])
  })
  it('buildGardenTree alpha sorts roots, children, AND plantings at every level', () => {
    const tree = buildGardenTree(PROJS, PL, SORT_ALPHA)
    expect(tree.map(n => n.project.name)).toEqual(['Apple', 'Zebra'])
    const a = tree.find(n => n.project.id === 'a')
    expect(a.children.map(c => c.project.name)).toEqual(['Banana', 'Cherry'])
    expect(a.plantings.map(p => p.name)).toEqual(['Beet', 'Yam'])
  })
  it('identical ordering across surfaces (displayList roots == tree roots) under both orders', () => {
    const rootsRecency = buildDisplayList(PROJS).filter(x => x.depth === 0).map(x => x.project.id)
    expect(buildGardenTree(PROJS, PL).map(n => n.project.id)).toEqual(rootsRecency)
    const rootsAlpha = buildDisplayList(PROJS, SORT_ALPHA).filter(x => x.depth === 0).map(x => x.project.id)
    expect(buildGardenTree(PROJS, PL, SORT_ALPHA).map(n => n.project.id)).toEqual(rootsAlpha)
  })
})

describe('loadSortOrder / saveSortOrder (persisted toggle, recency default)', () => {
  beforeEach(() => { localStorage.clear() })
  it('defaults to recency when nothing persisted', () => {
    expect(loadSortOrder()).toBe(SORT_RECENCY)
  })
  it('round-trips alpha', () => {
    saveSortOrder(SORT_ALPHA)
    expect(loadSortOrder()).toBe(SORT_ALPHA)
  })
  it('round-trips recency', () => {
    saveSortOrder(SORT_ALPHA); saveSortOrder(SORT_RECENCY)
    expect(loadSortOrder()).toBe(SORT_RECENCY)
  })
  it('coerces an unknown persisted value to recency (safe default)', () => {
    localStorage.setItem('garden.sortOrder.v1', 'garbage')
    expect(loadSortOrder()).toBe(SORT_RECENCY)
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
