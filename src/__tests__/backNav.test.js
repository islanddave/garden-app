// V4-BACKNAV-001 Slice 3a — the pure decider's truth table.
//
// decideBack must return EXACTLY ONE outcome per input — never zero, never two. That closed-enum
// shape is what makes the Escape/Back parity claim falsifiable instead of aspirational, and it is
// the one part of Back that jsdom exercises faithfully (no gesture required).
//
// Carries forward the marker-validation table from the deleted useBackDismiss.test.jsx verbatim in
// intent, extended with the v1→v2 case that the version bump introduces.
import { describe, it, expect } from 'vitest'
import { LAYER } from '../lib/dismissLayers.js'
import {
  decideBack, hasArmable, isArmable, readMarker, readAnyMarker,
  MARKER_KEY, MARKER_VERSION, MAX_CONSECUTIVE_BLOCKS,
} from '../lib/backNav.js'

const e = (over = {}) => ({
  id: 'x', seq: 1, layer: LAYER.SHEET, kind: 'modal', armsBack: true,
  dirty: false, busy: false, canIntercept: false, cbRef: { current: () => {} }, ...over,
})

describe('decideBack — closed enum, exactly one outcome per input', () => {
  const ACTIONS = ['NONE', 'BLOCKED', 'CONFIRM', 'INTERCEPT', 'DISMISS']

  it('every input yields exactly one action from the closed set', () => {
    const cases = []
    for (const kind of ['modal', 'route']) {
      for (const armsBack of [true, false]) {
        for (const busy of [true, false]) {
          for (const canIntercept of [true, false]) {
            for (const layer of [LAYER.SHEET, LAYER.DIALOG, LAYER.SYSTEM]) {
              cases.push(decideBack([e({ kind, armsBack, busy, canIntercept, layer })]))
            }
          }
        }
      }
    }
    expect(cases).toHaveLength(48)
    for (const c of cases) expect(ACTIONS).toContain(c.action)
  })

  it('empty / all-null stacks are NONE with a null target — the caller must not swallow the event', () => {
    expect(decideBack([])).toEqual({ action: 'NONE', target: null })
    expect(decideBack(null)).toEqual({ action: 'NONE', target: null })
    expect(decideBack([null, undefined])).toEqual({ action: 'NONE', target: null })
  })

  it('a plain armable modal DISMISSes', () => {
    expect(decideBack([e()]).action).toBe('DISMISS')
  })

  // armsBack governs ARMING, not dismissal — so a lone un-armed surface still reports DISMISS from
  // the pure decider. It is never reached in practice because nothing armed a marker, so the
  // provider's handler early-returns. hasArmable is the predicate that keeps it unreachable.
  it('armsBack=false does not arm, even though the decider would dismiss it', () => {
    expect(hasArmable([e({ armsBack: false })])).toBe(false)
    expect(decideBack([e({ armsBack: false })]).action).toBe('DISMISS')
  })

  it('busy BLOCKS, and only when blockOnBusy is on', () => {
    expect(decideBack([e({ busy: true })]).action).toBe('BLOCKED')
    expect(decideBack([e({ busy: true })], { blockOnBusy: false }).action).toBe('DISMISS')
  })

  it('canIntercept beats DISMISS but loses to BLOCKED', () => {
    expect(decideBack([e({ canIntercept: true })]).action).toBe('INTERCEPT')
    expect(decideBack([e({ canIntercept: true, busy: true })]).action).toBe('BLOCKED')
  })

  it('CONFIRM is never emitted while confirmOnDirty is off (its default)', () => {
    expect(decideBack([e({ dirty: true })]).action).toBe('DISMISS')
    expect(decideBack([e({ dirty: true })], { confirmOnDirty: true }).action).toBe('CONFIRM')
  })
})

describe('topmost selection — judge the top, do NOT filter then pick', () => {
  // The whole point of the route carve-out being a JUDGEMENT rather than a FILTER. An overlay
  // opened from inside an open sheet registers ABOVE it; filtering route entries out first would
  // target the sheet UNDERNEATH and close a surface the user cannot see.
  it('a route entry on top yields NONE — it does not fall through to the sheet beneath', () => {
    const sheet = e({ id: 'sheet', seq: 1, layer: LAYER.SHEET })
    const route = e({ id: 'route', seq: 2, layer: LAYER.SHEET, kind: 'route', armsBack: false })
    const d = decideBack([sheet, route])
    expect(d.action).toBe('NONE')
    expect(d.target.id).toBe('route')
  })

  it('paint order wins over insertion order', () => {
    const dialog = e({ id: 'dialog', seq: 1, layer: LAYER.DIALOG })
    const sheet = e({ id: 'sheet', seq: 2, layer: LAYER.SHEET })
    expect(decideBack([dialog, sheet]).target.id).toBe('dialog')
  })

  it('equal layers break by insertion order — later is on top', () => {
    const a = e({ id: 'a', seq: 1 })
    const b = e({ id: 'b', seq: 2 })
    expect(decideBack([a, b]).target.id).toBe('b')
  })

  // Once a marker is armed by ANY surface, Back closes the topmost — including a registry-only
  // dialog that never arms on its own. Gating dismissal on armsBack produced a dead press and
  // re-created the Escape/Back divergence; armsBack governs ARMING only.
  it('a registry-only dialog on top of an armed sheet is still the one dismissed', () => {
    const sheet = e({ id: 'sheet', seq: 1, layer: LAYER.SHEET, armsBack: true })
    const bare = e({ id: 'bare', seq: 2, layer: LAYER.DIALOG, armsBack: false })
    const d = decideBack([sheet, bare])
    expect(d.action).toBe('DISMISS')
    expect(d.target.id).toBe('bare')
  })
})

describe('marker validation — history.state is untrusted input', () => {
  const ok = { [MARKER_KEY]: { v: MARKER_VERSION, seq: 3 } }

  it('accepts our current-version marker', () => {
    expect(readMarker(ok)).toEqual({ v: 2, seq: 3 })
  })

  it.each([
    ['null state', null],
    ['no marker', { usr: {}, idx: 2 }],
    ['v1 marker from the previously shipped bundle', { [MARKER_KEY]: { v: 1, id: 'lightbox' } }],
    ['future version', { [MARKER_KEY]: { v: 99, seq: 1 } }],
    ['wrong seq type', { [MARKER_KEY]: { v: 2, seq: 'nope' } }],
    ['garbage', { [MARKER_KEY]: 'hello' }],
  ])('rejects %s — degrades to "not ours"', (_label, state) => {
    expect(readMarker(state)).toBeNull()
  })

  // The v1 case is the one that matters on Dave's device: the service worker serves JS cache-first,
  // so a v1 marker written by v3.103.0 can still be sitting in the stack when this bundle loads.
  // readMarker must REJECT it (never consume it as a session marker) while readAnyMarker still
  // RECOGNISES it, so the provider can strip it rather than act on it.
  it('readAnyMarker recognises a v1 marker that readMarker rejects', () => {
    const v1 = { [MARKER_KEY]: { v: 1, id: 'lightbox' } }
    expect(readMarker(v1)).toBeNull()
    expect(readAnyMarker(v1)).toEqual({ v: 1, id: 'lightbox' })
  })

  it('readAnyMarker still rejects a non-marker', () => {
    expect(readAnyMarker({ usr: {}, idx: 1 })).toBeNull()
    expect(readAnyMarker(null)).toBeNull()
  })
})

describe('hasArmable / isArmable — the arm and re-arm predicate, shared so it cannot drift', () => {
  it('route and un-armed entries never arm', () => {
    expect(isArmable(e({ kind: 'route' }))).toBe(false)
    expect(isArmable(e({ armsBack: false }))).toBe(false)
    expect(isArmable(e())).toBe(true)
  })

  it('hasArmable is false for a stack of only route overlays', () => {
    expect(hasArmable([e({ kind: 'route', armsBack: false })])).toBe(false)
    expect(hasArmable([e({ kind: 'route' }), e()])).toBe(true)
    expect(hasArmable([])).toBe(false)
  })
})

it('the block cap is bounded and small — an unbounded refusal is a user trap', () => {
  expect(MAX_CONSECUTIVE_BLOCKS).toBeGreaterThan(0)
  expect(MAX_CONSECUTIVE_BLOCKS).toBeLessThanOrEqual(3)
})
