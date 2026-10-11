// V5-SEEDSTAB-001 — the one spelling of every URL into the Seeds page (src/lib/seedsRoutes.js).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  SEEDS_PATH, SEEDS_VIEWS, resolveView, seedsHref, addPacketHref, seedsReturnState, seedsReturnOf,
  seedsReturnFromHistory, seedsReturnReader, noteSeedAdded, peekSeedAdded, clearSeedAdded,
} from '../lib/seedsRoutes.js'
import { CONTINUES_ENTRY_KEY } from '../lib/pageEntry.js'

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

// BUG-SEEDSRETURNUNDEROVERLAY-001 — the answer for a page's whole visit. jsdom holds one history entry,
// so a traversal is modelled by rewriting it to the state the entry landed on carries; the traversals
// themselves are gate:seeds-scroll flows l and m, in real Chrome.
describe('seedsReturnReader — asked when the page leaves', () => {
  const MINE = '/seeds?view=mine'
  // The entries of [Seeds, k2: the page a Seeds door pushed, k3: Search over it], as BrowserRouter and
  // OverlayContext write them.
  const own = { usr: seedsReturnState(MINE), key: 'k2', idx: 2 }
  const background = { pathname: '/inventory/inv-1', search: '', hash: '', state: seedsReturnState(MINE), key: 'k2', historyEntry: { idx: 2, doc: 'd' } }
  const overlay = { usr: { background }, key: 'k3', idx: 3 }
  // What an overlay's replace-close leaves where the overlay's entry was (useOverlayDismiss).
  const replaced = { usr: { [CONTINUES_ENTRY_KEY]: 'k2' }, key: 'k4', idx: 3 }
  const stand = (state) => window.history.replaceState(state, '')

  afterEach(() => { vi.restoreAllMocks(); stand(null) })

  it('a page that mounts on its own entry is answered ONCE, at mount — both ways', () => {
    stand(own)
    const pushed = seedsReturnReader()
    stand(null)
    expect(pushed()).toBe(MINE)

    const notPushed = seedsReturnReader()
    stand(own)
    expect(notPushed()).toBeNull()
  })

  it('a page that mounts UNDER an overlay is answered by the entry it stands on when it leaves', () => {
    stand(overlay)
    const read = seedsReturnReader()
    // Still under Search: the overlay's entry is no Seeds door's. The background is NOT read through —
    // how the overlay will close is not decided yet.
    expect(read()).toBeNull()
    // The X walked (or the system Back popped) onto the page's own entry.
    stand(own)
    expect(read()).toBe(MINE)
  })

  it('…and by nothing after a REPLACE-close: Back from that entry is the same page again', () => {
    stand(overlay)
    const read = seedsReturnReader()
    stand(replaced)
    expect(read()).toBeNull()
  })

  it('…each time it is asked, so a later overlay closed the other way is seen too', () => {
    stand(overlay)
    const read = seedsReturnReader()
    stand(own)
    expect(read()).toBe(MINE)
    stand(replaced)
    expect(read()).toBeNull()
  })

  it('a Back marker over the page\'s own entry copies its state, so it answers the same', () => {
    stand(overlay)
    const read = seedsReturnReader()
    stand({ ...own, __backnav: { v: 2, seq: 1 } })
    expect(read()).toBe(MINE)
  })

  it('a background that is not a location is no overlay: read once, as on any own entry', () => {
    stand({ usr: { ...seedsReturnState(MINE), background: 'nope' }, key: 'k2', idx: 2 })
    const read = seedsReturnReader()
    stand(null)
    expect(read()).toBe(MINE)
  })

  it('a history state that cannot be read is no Seeds door', () => {
    vi.spyOn(window.history, 'state', 'get').mockImplementation(() => { throw new Error('SecurityError') })
    expect(() => window.history.state).toThrow('SecurityError')
    expect(seedsReturnReader()()).toBeNull()
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
