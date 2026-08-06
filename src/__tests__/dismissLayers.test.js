// V4-BACKNAV-001 Slice 1 — truth table for the pure dismiss decider (lib/dismissLayers.js).
//
// This is the half of back-nav that jsdom CAN verify faithfully. The harness cannot deliver a real
// Android Back gesture, cannot close a PWA, and has no CloseWatcher — so the arbitration logic is
// deliberately kept pure and exhaustively table-tested here, and the parts that genuinely need a
// device are named as device-only rather than faked with a mock that tests itself.
//
// B1 stated falsifiably: for ANY input, exactly one outcome — never zero, never two.
import { describe, it, expect } from 'vitest'
import { Z, LAYER, resolveTopmost, decideDismiss } from '../lib/dismissLayers.js'

const e = (seq, layer, extra = {}) => ({ id: 'e' + seq, seq, layer, ...extra })

describe('resolveTopmost', () => {
  it('returns null for an empty / absent / junk stack (caller must not swallow the gesture)', () => {
    expect(resolveTopmost([])).toBeNull()
    expect(resolveTopmost(null)).toBeNull()
    expect(resolveTopmost(undefined)).toBeNull()
  })

  it('breaks ties within one layer by insertion order — later wins', () => {
    const top = resolveTopmost([e(1, LAYER.SHEET), e(2, LAYER.SHEET), e(3, LAYER.SHEET)])
    expect(top.seq).toBe(3)
  })

  // THE CASE THE WHOLE SLICE EXISTS FOR. A Lightbox opened FIRST and a Sheet opened SECOND puts the
  // Sheet last in insertion order but the Lightbox visually on top (z 1000 vs 200). An arbiter that
  // used insertion order alone would dismiss the surface the user cannot see is on top.
  it('paint order beats insertion order: a Lightbox opened FIRST still outranks a later Sheet', () => {
    const top = resolveTopmost([e(1, LAYER.DIALOG), e(2, LAYER.SHEET)])
    expect(top.seq).toBe(1)
    expect(top.layer).toBe(LAYER.DIALOG)
  })

  it('the reserved SYSTEM layer outranks every ordinary surface', () => {
    const top = resolveTopmost([e(1, LAYER.SHEET), e(2, LAYER.DIALOG), e(3, LAYER.SYSTEM)])
    expect(top.layer).toBe(LAYER.SYSTEM)
  })

  it('skips null entries rather than throwing (a torn-down entry must not brick arbitration)', () => {
    expect(resolveTopmost([null, e(1, LAYER.SHEET), null]).seq).toBe(1)
  })

  it('layer tokens match the paint scale actually in use at the call sites', () => {
    expect(Z.sheet).toBe(200)
    expect(Z.dialog).toBe(1000)
    expect(LAYER.SYSTEM).toBeGreaterThan(LAYER.DIALOG)
    expect(LAYER.DIALOG).toBeGreaterThan(LAYER.SHEET)
  })
})

describe('decideDismiss', () => {
  it('NONE when nothing is registered — the caller must let Back navigate', () => {
    expect(decideDismiss([])).toEqual({ action: 'NONE', target: null })
  })

  it('DISMISS targets exactly the topmost, never a cascade', () => {
    const d = decideDismiss([e(1, LAYER.SHEET), e(2, LAYER.DIALOG)])
    expect(d.action).toBe('DISMISS')
    expect(d.target.seq).toBe(2)
  })

  // Slice 1 ships BOTH opt-ins OFF, reproducing today's shipped behaviour exactly: Sheet's Escape
  // closes regardless of dirty (only the BACKDROP tap consults it) and regardless of an in-flight
  // save. Pinning the defaults is what makes "arbitration repair, not behaviour change" checkable.
  it('DEFAULTS reproduce today: dirty and busy do not change the outcome', () => {
    expect(decideDismiss([e(1, LAYER.SHEET, { dirty: true })]).action).toBe('DISMISS')
    expect(decideDismiss([e(1, LAYER.SHEET, { busy: true })]).action).toBe('DISMISS')
  })

  it('opt-in confirmOnDirty yields CONFIRM (wired when the ConfirmSheet primitive exists)', () => {
    const d = decideDismiss([e(1, LAYER.SHEET, { dirty: true })], { confirmOnDirty: true })
    expect(d.action).toBe('CONFIRM')
  })

  it('opt-in blockOnBusy outranks confirmOnDirty — an in-flight write is refused, not discarded', () => {
    const d = decideDismiss([e(1, LAYER.SHEET, { dirty: true, busy: true })],
      { confirmOnDirty: true, blockOnBusy: true })
    expect(d.action).toBe('BLOCKED')
  })

  it('dirty/busy are read from the TOPMOST only, never from a buried surface', () => {
    const entries = [e(1, LAYER.SHEET, { dirty: true, busy: true }), e(2, LAYER.DIALOG)]
    const d = decideDismiss(entries, { confirmOnDirty: true, blockOnBusy: true })
    expect(d.action).toBe('DISMISS')
    expect(d.target.seq).toBe(2)
  })

  // B1 as a falsifiable property rather than an aspiration ("handled wherever possible" cannot fail).
  it('B1 PROPERTY: every input yields exactly one action from the closed enum', () => {
    const ACTIONS = ['NONE', 'BLOCKED', 'CONFIRM', 'DISMISS']
    const layers = [LAYER.SHEET, LAYER.DIALOG, LAYER.SYSTEM]
    const stacks = [[]]
    for (const l of layers) for (const dirty of [false, true]) for (const busy of [false, true]) {
      stacks.push([e(1, l, { dirty, busy })])
      stacks.push([e(1, LAYER.SHEET), e(2, l, { dirty, busy })])
    }
    for (const stack of stacks) {
      for (const confirmOnDirty of [false, true]) for (const blockOnBusy of [false, true]) {
        const d = decideDismiss(stack, { confirmOnDirty, blockOnBusy })
        expect(ACTIONS).toContain(d.action)
        // NONE is the only action with no target; every other action must name exactly one.
        if (d.action === 'NONE') expect(d.target).toBeNull()
        else expect(d.target).toBeTruthy()
      }
    }
  })
})
