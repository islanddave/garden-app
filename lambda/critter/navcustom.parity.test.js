// Lambda writer <-> client reader parity for the per-person nav prefs. V5-NAVCUSTOM-001.
// Contract: project-state/_navcustom-build-20260924/CONTRACT.md §4 (shared constants) and §5 (the two
// invariants this file checks).
//
// WHY TWO COPIES. The Lambda refuses a bad more_pins / bar_layout at WRITE time, so the editor gets a
// 400 it can state instead of a save that reports success and changes nothing. The client resolvers
// must render ANY stored value — a hand-written row, a value from an older or newer build — without
// throwing, so they fall back instead of refusing. Neither side can serve the other: the Lambda cannot
// import from src/, and the client cannot be the write-time guard. Same house pattern as
// critterSpecies.parity.test.js and appConfig.parity.test.js (the retired global path's twin).
//
// IF THIS FAILS, a copy diverged. Fix the divergence, or change the contract on BOTH sides in one
// release: a layout the Lambda stores but the client will not apply is a save that silently no-ops,
// and a layout the client produces but the Lambda refuses is an editor whose Save always 400s.

import { describe, it, expect } from 'vitest'
import {
  validatePrefsPatchBody, NAV_TAB_KEYS, MOVABLE_TAB_KEYS, MORE_PIN_ID_RE, MORE_PINS_MAX,
} from './validators.js'
import {
  DEFAULT_NAV_TABS, MOVABLE_TAB_KEYS as CLIENT_MOVABLE_TAB_KEYS, resolveBarLayout,
} from '../../src/lib/navConfig.js'
import {
  MORE_PIN_ID_RE as CLIENT_MORE_PIN_ID_RE, MORE_PINS_MAX_STORED, MORE_ID_ALIASES, resolvePins,
} from '../../src/lib/moreRegistry.js'

const serverAcceptsLayout = (bar_layout) => validatePrefsPatchBody({ bar_layout }) === null
const serverAcceptsPins = (more_pins) => validatePrefsPatchBody({ more_pins }) === null

// Every sequence of length 0..maxLen over `alphabet`, repeats allowed.
function sequences(alphabet, maxLen) {
  const out = [[]]
  let frontier = [[]]
  for (let len = 1; len <= maxLen; len++) {
    const next = []
    for (const s of frontier) for (const a of alphabet) next.push([...s, a])
    out.push(...next)
    frontier = next
  }
  return out
}

describe('shared constants — Lambda and client agree', () => {
  it('the tab vocabulary is identical, order included', () => {
    expect(NAV_TAB_KEYS).toEqual(DEFAULT_NAV_TABS)
    expect(NAV_TAB_KEYS.length).toBe(5)
  })

  it('the movable tabs are identical, and never include Today or ＋', () => {
    expect(MOVABLE_TAB_KEYS).toEqual(CLIENT_MOVABLE_TAB_KEYS)
    expect(MOVABLE_TAB_KEYS.length).toBeGreaterThan(0)
    expect(MOVABLE_TAB_KEYS).not.toContain('today')
    expect(MOVABLE_TAB_KEYS).not.toContain('create')
  })

  it('the pin id pattern is identical, flags included', () => {
    expect(MORE_PIN_ID_RE.source).toBe(CLIENT_MORE_PIN_ID_RE.source)
    expect(MORE_PIN_ID_RE.flags).toBe(CLIENT_MORE_PIN_ID_RE.flags)
  })

  it('the stored pin cap is identical', () => {
    expect(MORE_PINS_MAX).toBe(MORE_PINS_MAX_STORED)
    expect(MORE_PINS_MAX).toBeGreaterThan(0)
  })
})

describe('bar_layout invariant 1 — whatever the Lambda stores, the client applies exactly', () => {
  // `moon` stands for every key neither side knows; repeats, short and long lists are all in the set.
  const ORDER_ALPHABET = [...NAV_TAB_KEYS, 'moon']
  const HIDDEN_ALPHABET = [...NAV_TAB_KEYS, 'moon']

  it('over every order of length 0..6 (with two hidden lists)', () => {
    let accepted = 0
    for (const order of sequences(ORDER_ALPHABET, 6)) {
      for (const hidden of [[], ['put-up']]) {
        const value = { order, hidden }
        if (!serverAcceptsLayout(value)) continue
        accepted++
        const r = resolveBarLayout(value)
        expect(r.applied).toEqual({ order: true, hidden: true })
        expect(r.order).toEqual(order)
        expect(r.hidden).toEqual(hidden)
      }
    }
    // 120 permutations × 2 hidden lists. Anti-vacuity: a validator that refused everything would pass
    // the loop above with zero assertions.
    expect(accepted).toBe(240)
  })

  it('over every hidden list of length 0..4 (with two orders)', () => {
    let accepted = 0
    const orders = [NAV_TAB_KEYS, ['put-up', 'harvests', 'create', 'garden', 'today']]
    for (const hidden of sequences(HIDDEN_ALPHABET, 4)) {
      for (const order of orders) {
        const value = { order, hidden }
        if (!serverAcceptsLayout(value)) continue
        accepted++
        const r = resolveBarLayout(value)
        expect(r.applied).toEqual({ order: true, hidden: true })
        expect(r.order).toEqual(order)
        expect(r.hidden).toEqual(hidden)
        // Today and ＋ stay on the bar under every accepted layout.
        expect(r.bar).toContain('today')
        expect(r.bar).toContain('create')
      }
    }
    // Ordered lists of distinct movable keys: 1 + 3 + 6 + 6 = 16, × 2 orders.
    expect(accepted).toBe(32)
  })
})

describe('bar_layout invariant 2 — whatever the client resolves, the Lambda would accept', () => {
  const RAW = [
    undefined, null, 0, 1, true, 'today', [], {}, { order: null }, { hidden: 'put-up' },
    { order: NAV_TAB_KEYS }, { hidden: ['garden'] }, { order: ['today'] }, { order: [['today']] },
    { order: ['toString', 'garden', 'create', 'harvests', 'put-up'] },
    { order: [...NAV_TAB_KEYS, 'today'] }, { hidden: ['create'] }, { hidden: ['today'] },
    { hidden: ['garden', 'garden'] }, { hidden: [null] }, { order: NAV_TAB_KEYS, hidden: ['moon'] },
    { order: NAV_TAB_KEYS, hidden: MOVABLE_TAB_KEYS, extra: 1 },
    ...sequences([...NAV_TAB_KEYS, 'moon'], 3).map(order => ({ order, hidden: order })),
  ]

  it('the {order, hidden} a resolver produces is always a valid PATCH body', () => {
    for (const raw of RAW) {
      const r = resolveBarLayout(raw)
      expect(serverAcceptsLayout({ order: r.order, hidden: r.hidden })).toBe(true)
    }
    expect(RAW.length).toBeGreaterThan(200)
  })
})

describe('more_pins — resolvePins output is always a valid PATCH body', () => {
  const ENTRIES = [
    'seeds', 'photos', 'put-up', 'settings-controls', 'sow', 'saved-seeds', 'future-row',
    'Seeds', '1seeds', '', 'a'.repeat(41), 'a'.repeat(40), 'seeds ', 'seeds_x', null, 7, ['seeds'], {},
  ]

  it('for every list of up to 3 entries drawn from good, bad and aliased ids', () => {
    let checked = 0
    for (const raw of sequences(ENTRIES, 3)) {
      expect(serverAcceptsPins(resolvePins(raw))).toBe(true)
      checked++
    }
    expect(checked).toBe(1 + 18 + 18 ** 2 + 18 ** 3)
  })

  it('for lists longer than the stored cap', () => {
    const many = Array.from({ length: 80 }, (_, i) => `row-${i}`)
    const out = resolvePins(many)
    expect(out.length).toBe(MORE_PINS_MAX)
    expect(serverAcceptsPins(out)).toBe(true)
  })

  it('a list the Lambda accepts survives the client unchanged, apart from aliases', () => {
    const accepted = ['seeds', 'photos', 'future-row', 'put-up']
    expect(serverAcceptsPins(accepted)).toBe(true)
    expect(resolvePins(accepted)).toEqual(accepted)
    // Aliases are the one deliberate rewrite, and every alias target is itself a storable id.
    for (const [from, to] of Object.entries(MORE_ID_ALIASES)) {
      expect(serverAcceptsPins([from])).toBe(true)
      expect(serverAcceptsPins([to])).toBe(true)
      expect(resolvePins([from])).toEqual([to])
    }
  })
})
