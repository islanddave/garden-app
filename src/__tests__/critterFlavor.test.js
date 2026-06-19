import { describe, it, expect } from 'vitest'
import { getFlavor, FLAVOR_BY_ID } from '../lib/critterFlavor.js'
import roster from '../data/critters-roster.json'

const FLAGGED = ['C014', 'C066', 'C068', 'L002']

describe('critterFlavor data (V3-CRITFLAVOR-001)', () => {
  it('has a flavor entry with fun_fact for every roster critter', () => {
    const missing = roster.filter(c => !FLAVOR_BY_ID[c.id] || !FLAVOR_BY_ID[c.id].fun_fact).map(c => c.id)
    expect(missing).toEqual([])
  })
  it('covers all 168', () => {
    expect(Object.keys(FLAVOR_BY_ID).length).toBe(168)
  })
})

describe('getFlavor gating + shape', () => {
  it('returns fun_fact for a normal critter', () => {
    const f = getFlavor({ id: 'C001' })
    expect(f).toBeTruthy()
    expect(typeof f.fun_fact).toBe('string')
    expect(f.fun_fact.length).toBeGreaterThan(10)
  })
  it('returns null for Dave-review-flagged critters until cleared', () => {
    for (const id of FLAGGED) expect(getFlavor({ id })).toBeNull()
  })
  it('returns null for unknown/empty critter', () => {
    expect(getFlavor(null)).toBeNull()
    expect(getFlavor({ id: 'NOPE' })).toBeNull()
  })
  it('includes call only when present', () => {
    // C013 American Robin has a call; C003 ladybug (insect) does not
    const robin = getFlavor({ id: 'C013' })
    expect(robin.call).toBeTruthy()
    const ladybug = getFlavor({ id: 'C003' })
    expect(ladybug.call).toBeUndefined()
  })
  it('never leaks the flag field to the UI shape', () => {
    const f = getFlavor({ id: 'C001' })
    expect('flag' in f).toBe(false)
  })
})
