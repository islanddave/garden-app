import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildDisplayList, groupPlantingsByProjectId, buildGardenTree, nodeHasChildren,
  loadExpanded, saveExpanded,
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
