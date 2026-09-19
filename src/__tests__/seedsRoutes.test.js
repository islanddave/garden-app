// V5-SEEDSTAB-001 — the one spelling of every URL into the Seeds page (src/lib/seedsRoutes.js).
import { describe, it, expect, beforeEach } from 'vitest'
import {
  SEEDS_PATH, SEEDS_VIEWS, resolveView, seedsHref, addPacketHref, seedsReturnState, seedsReturnOf,
  seedsReturnFromHistory, noteSeedAdded, peekSeedAdded, clearSeedAdded,
} from '../lib/seedsRoutes.js'

describe('resolveView — exact, case-sensitive, first value wins', () => {
  it('accepts exactly mine / saved / sow', () => {
    expect(SEEDS_VIEWS.map((v) => v.value)).toEqual(['mine', 'saved', 'sow'])
    for (const v of ['mine', 'saved', 'sow']) expect(resolveView(v)).toBe(v)
  })
  it('refuses anything else, including near misses', () => {
    for (const v of [null, undefined, '', 'Saved', 'MINE', 'saving', ' sow', 'garbage']) expect(resolveView(v)).toBeNull()
  })
  it('first value wins when the param repeats', () => {
    const p = new URLSearchParams('view=sow&view=mine')
    expect(resolveView(p.get('view'))).toBe('sow')
  })
})

describe('seedsHref / addPacketHref', () => {
  it('builds the canonical URLs every door uses', () => {
    expect(SEEDS_PATH).toBe('/seeds')
    expect(seedsHref()).toBe('/seeds')
    expect(seedsHref('sow')).toBe('/seeds?view=sow')
    expect(seedsHref('saved', { lot: 'abc-1' })).toBe('/seeds?view=saved&lot=abc-1')
    expect(seedsHref('bogus')).toBe('/seeds')
  })
  it('encodes the return target WHOLE, so an & inside it cannot cut it short', () => {
    expect(addPacketHref(seedsHref('mine')))
      .toBe('/inventory/add?type=consumable&category=seeds&return=%2Fseeds%3Fview%3Dmine')
    const back = new URLSearchParams(addPacketHref('/seeds?view=saved&lot=x').split('?')[1]).get('return')
    expect(back).toBe('/seeds?view=saved&lot=x')
  })
})

describe('the Seeds return marker', () => {
  it('round-trips through location.state and refuses anything that is not a Seeds URL', () => {
    expect(seedsReturnOf(seedsReturnState('/seeds?view=mine'))).toBe('/seeds?view=mine')
    expect(seedsReturnOf({ seedsReturn: '/inventory' })).toBeNull()
    expect(seedsReturnOf({ seedsReturn: 42 })).toBeNull()
    expect(seedsReturnOf(null)).toBeNull()
  })
  it('reads the same answer off window.history.state.usr, where BrowserRouter keeps it', () => {
    window.history.replaceState({ usr: seedsReturnState('/seeds?view=sow'), key: 'k', idx: 1 }, '')
    expect(seedsReturnFromHistory()).toBe('/seeds?view=sow')
    window.history.replaceState(null, '')
    expect(seedsReturnFromHistory()).toBeNull()
  })
})

describe('the added-row note (add form → Seeds)', () => {
  beforeEach(() => { try { window.sessionStorage.clear() } catch { /* jsdom */ } })
  it('peek reads without clearing (StrictMode runs the initialiser twice); clear clears', () => {
    noteSeedAdded('row-9')
    expect(peekSeedAdded()).toBe('row-9')
    expect(peekSeedAdded()).toBe('row-9')
    clearSeedAdded()
    expect(peekSeedAdded()).toBeNull()
    noteSeedAdded(null)
    expect(peekSeedAdded()).toBeNull()
  })
})
