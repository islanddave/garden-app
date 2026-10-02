// Put-Up R2a, lane Df — the Put something up door's guards: its draft, its reload hold, and the rule that a
// door opened WITH a What is not dirty until something changes (plan V2 "Seeded door"; QA-B3, MOB 4, ARCH F-08).
//
// WHY THIS FILE EXISTS. Before R2a no test in any file that mounts the door asserted the reload gate: deleting
// setReloadBlocked from the door reddened nothing. The "Log a put-up" form's guard tests were the only proof
// that Put-Up's create surface holds a deploy's reload while someone is typing, and R2b deletes them with the
// form. These are their re-homes, written while the form still exists; their TITLES are the ones R2b's
// deletion list points at (QA 3.1, the PutUp.formGuard and PutUpStashHarvestLink tables; amendment D15).
//
// REAL reloadGate and REAL registerSW — nothing mocked between the door and a reload — as
// PutUp.formGuard.test.jsx does. mintKey is WRAPPED, not replaced, so "no key" is observed, not inferred.
//
// Also here (the brief's item 15): the older item route's 400 to an as-is save that carries an amount (ΔRIA
// N-10: a cached R2a bundle after a forward undo) leaves the door open and intact and sends nothing more; and
// a candy preview says "house estimate" (RIA I-8).
// MUTATIONS (run, see the lane report): a seeded open is dirty at mount -> "a seeded, untouched open: no
// draft, no hold, no key"; a new field left out of `dirty` -> "… typed alone holds the reload gate"; delete
// setReloadBlocked -> the hold and the registerSW tests.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch, apiError } from './helpers/pantryFake.js'

installStoragePolyfill()

let fake
const { stableFetch, minted } = vi.hoisted(() => ({ stableFetch: { fn: null }, minted: { n: 0 } }))
vi.mock('../lib/api.js', () => {
  const f = (...a) => stableFetch.fn(...a)
  return { useApiFetch: () => ({ fetch: f, getToken: () => Promise.resolve('t') }), apiFetch: f }
})
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))
vi.mock('../components/kitchen/idempotencyKey.js', async (importActual) => {
  const actual = await importActual()
  return { ...actual, mintKey: (...a) => { minted.n += 1; return actual.mintKey(...a) } }
})

import PutSomethingUpSheet, { isDoorDraft } from '../components/pantry/PutSomethingUpSheet.jsx'
import { DOOR_SHEET, previewLine } from '../components/pantry/putSomethingUp.js'
import { sheetDraftKey, writeSheetDraft, readSheetDraft } from '../components/kitchen/sheetDraft.js'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'
import { registerServiceWorker } from '../lib/registerSW.js'

const NOW = new Date(2026, 9, 1, 14, 0)
const DRAFT_KEY = sheetDraftKey('user_dave', DOOR_SHEET, 'new')
const P1 = { source: 'planting', name: 'Sungold cherry', plant_id: 'p1', crop_type_slug: 'tomato', variety_id: 'v1' }
const P2 = { source: 'planting', name: 'Sungold cherry', plant_id: 'p2', crop_type_slug: 'tomato', variety_id: 'v1' }   // a second wave, same name
const K1 = '11111111-1111-4111-8111-111111111111'
const STORED = {
  key: K1, what: { source: 'typed', name: 'Kale' }, place: { key: 'id:loc-3', id: 'loc-3', label: 'Kitchen fridge', kind: 'fridge' },
  method: 'as_is', count: '1', whenChip: 'today', estimate: null, pickedDate: '', discard: { mode: 'auto', date: '' }, notes: 'from Jen',
}
const EMPTY_DRAFT = { key: K1, what: null, place: null, method: null, count: '1' }

function wire(opts = {}) {
  fake = pantryFetch({ rows: [], ...opts })
  stableFetch.fn = fake
}
// The host's two lines: the door does not close itself after a save — its host does, in onSaved.
function Host({ seen = {}, ...props }) {
  const [open, setOpen] = useState(true)
  return <PutSomethingUpSheet open={open} now={NOW.getTime()} onClose={() => { seen.closed = (seen.closed ?? 0) + 1; setOpen(false) }}
    onSaved={(s) => { seen.saved = s; setOpen(false) }} {...props} />
}
async function openDoor(props = {}) {
  const seen = {}
  const view = render(<Host seen={seen} {...props} />)
  await screen.findByTestId('door-place-id:loc-1')
  await flush()
  return { ...view, seen }
}
const flush = () => new Promise((r) => setTimeout(r, 0))
const tap = (id) => fireEvent.click(screen.getByTestId(id))
const typeInto = (id, v) => fireEvent.change(screen.getByTestId(id), { target: { value: v } })
const draft = () => readSheetDraft(DRAFT_KEY, DOOR_SHEET, isDoorDraft)
const stored = () => localStorage.getItem(DRAFT_KEY)
const posts = (path) => fake.calls('POST').filter(c => c.path === path)

// Mirrors registerSW.test.js makeEnv (via PutUp.formGuard.test.jsx), with a prior controller so
// controllerchange counts as an UPDATE (the reload path), not a first install.
function makeSwEnv() {
  const registration = { update: vi.fn().mockResolvedValue(undefined) }
  const sw = new EventTarget()
  sw.controller = {}
  sw.register = vi.fn().mockResolvedValue(registration)
  const nav = { serviceWorker: sw }
  const win = Object.assign(new EventTarget(), { location: { reload: vi.fn() } })
  const doc = Object.assign(new EventTarget(), { readyState: 'complete', visibilityState: 'visible' })
  const reload = vi.fn()
  return { registration, sw, nav, win, doc, reload }
}

beforeEach(() => { wire(); localStorage.clear(); sessionStorage.clear(); clearReloadBlocks(); minted.n = 0 })
afterEach(() => { vi.useRealTimers() })

const SEEDS = [
  ['a typed seed', { initialName: 'Garlic' }],
  ['a planting', { initialWhat: P1 }],
]

describe('the door\'s draft', () => {
  it.each([['plain', {}], ...SEEDS])('an untouched open writes no draft (%s)', async (_n, props) => {
    await openDoor(props)
    expect(stored()).toBeNull()
  })

  it.each(SEEDS)('a seeded, untouched open: no draft, no hold, no key (%s)', async (_n, props) => {
    await openDoor(props)
    expect(stored()).toBeNull()
    expect(isReloadBlocked()).toBe(false)
    expect(minted.n).toBe(0)
    // The first real change is what makes it dirty: one key, a draft, the hold.
    tap('door-place-id:loc-3')
    await waitFor(() => expect(stored()).not.toBeNull())
    expect(isReloadBlocked()).toBe(true)
    expect(minted.n).toBe(1)
    expect(draft().key).toMatch(/^[0-9a-f-]{36}$/)
  })

  it.each(SEEDS)('a seeded, untouched door closes with no confirm and leaves no draft (%s)', async (_n, props) => {
    const { seen } = await openDoor(props)
    fireEvent.click(document.querySelector('[data-sheet-close]'))
    await waitFor(() => expect(screen.queryByTestId('door-sheet')).toBeNull())
    expect(seen.closed).toBe(1)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(stored()).toBeNull()
    expect(isReloadBlocked()).toBe(false)
  })

  it('a seed with a different name replaces an unrelated stored draft — at the first real change, and not before', async () => {
    writeSheetDraft(DRAFT_KEY, DOOR_SHEET, STORED)
    const before = stored()
    await openDoor({ initialName: 'Garlic' })
    expect(screen.getByTestId('door-what-name').value).toBe('Garlic')         // the seed, not the stored Kale
    expect(within(screen.getByTestId('door-places')).getAllByRole('radio').filter(r => r.getAttribute('aria-checked') === 'true')).toEqual([])
    expect(stored()).toBe(before)                                             // left alone, byte for byte
    expect(isReloadBlocked()).toBe(false)
    tap('door-place-id:loc-1')
    await waitFor(() => expect(draft()?.what?.name).toBe('Garlic'))
    expect(draft().key).not.toBe(K1)
    expect(draft().place.id).toBe('loc-1')
  })

  it('after a landed save the gate is released and the draft is gone', async () => {
    const { seen } = await openDoor()
    typeInto('door-what-name', 'Corn'); tap('door-place-id:loc-1'); tap('door-method-whole_freeze')
    await waitFor(() => expect(stored()).not.toBeNull())
    expect(isReloadBlocked()).toBe(true)
    tap('door-save')
    await waitFor(() => expect(seen.saved).toBeTruthy())
    await waitFor(() => expect(screen.queryByTestId('door-sheet')).toBeNull())
    expect(isReloadBlocked()).toBe(false)
    expect(stored()).toBeNull()
  })

  it('fake timers past midnight on an untouched door: no hold, no draft', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 1, 23, 59))
    render(<PutSomethingUpSheet open onClose={vi.fn()} onSaved={vi.fn()} initialWhat={P1} />)   // no `now`: the door reads the clock
    await screen.findByTestId('door-place-id:loc-1')
    expect([isReloadBlocked(), stored()]).toEqual([false, null])
    vi.setSystemTime(new Date(2026, 9, 2, 0, 1))
    tap('door-more'); tap('door-from')                                        // a re-render; a disclosure is not a change
    expect([isReloadBlocked(), stored()]).toEqual([false, null])
    expect(minted.n).toBe(0)
  })
})

describe('the door holds the reload gate while it is dirty', () => {
  it('a pristine door does not hold the reload gate', async () => {
    await openDoor()
    expect(isReloadBlocked()).toBe(false)
  })

  it('a typed name holds the reload gate; clearing it back to pristine releases the hold', async () => {
    await openDoor()
    typeInto('door-what-name', 'Corn')
    expect(isReloadBlocked()).toBe(true)
    typeInto('door-what-name', '')
    expect(isReloadBlocked()).toBe(false)
    await waitFor(() => expect(stored()).toBeNull())
  })

  // Each new field ALONE — restored from a draft that holds nothing else, the one state in which a field under
  // a method's row is the only thing the door holds.
  it.each([
    ['a size', { sizeValue: '2' }],
    ['a size\'s unit', { sizeUnit: 'qt' }],
    ['an amount', { amountValue: '2' }],
    ['an amount\'s unit', { amountUnit: 'lb' }],
    ['where it is from', { sourceKind: 'store' }],
    ['a where-from name', { sourceLabel: 'Costco' }],
    ['Raw', { isRaw: true }],
    ['In oil', { inOil: true }],
    ['a texture', { texture: 'bends' }],
  ])('%s typed alone holds the reload gate', async (_n, only) => {
    writeSheetDraft(DRAFT_KEY, DOOR_SHEET, { ...EMPTY_DRAFT, ...only })
    await openDoor()
    expect(isReloadBlocked()).toBe(true)
    expect(draft()).toMatchObject(only)                                       // and its draft is kept, not cleared as pristine
  })

  it('unmounting a dirty door releases the hold (never wedge updates)', async () => {
    const { unmount } = await openDoor()
    typeInto('door-what-name', 'Corn')
    expect(isReloadBlocked()).toBe(true)
    unmount()
    expect(isReloadBlocked()).toBe(false)
  })

  it('the hold lasts while a save is in flight, and through a refusal', async () => {
    let answer
    wire({ overrides: { 'POST /api/preservation': () => new Promise((_r, reject) => { answer = () => reject(apiError(400, { error: 'no' })) }) } })
    await openDoor()
    typeInto('door-what-name', 'Corn'); tap('door-place-id:loc-1'); tap('door-method-whole_freeze')
    tap('door-save')
    await waitFor(() => expect(posts('/api/preservation')).toHaveLength(1))
    expect(isReloadBlocked()).toBe(true)
    answer()
    await screen.findByTestId('door-error')
    expect(isReloadBlocked()).toBe(true)
    expect(screen.getByTestId('door-sheet')).toBeTruthy()
  })
})

describe('the door ↔ registerSW, end to end', () => {
  it('a dirty door defers the reload; closing fires it once', async () => {
    const env = makeSwEnv()
    const teardown = registerServiceWorker(env)
    await flush()
    await openDoor()
    typeInto('door-what-name', 'Corn')
    env.sw.dispatchEvent(new Event('controllerchange'))                       // a deploy lands mid-entry
    expect(env.reload).not.toHaveBeenCalled()
    fireEvent.click(document.querySelector('[data-sheet-close]'))
    await waitFor(() => expect(env.reload).toHaveBeenCalledTimes(1))
    expect(draft().what.name).toBe('Corn')                                    // deferred, and what was typed is in the draft
    teardown()
  })

  it('with nothing dirty, a controllerchange still reloads at once (the gate is not a disarm)', async () => {
    const env = makeSwEnv()
    const teardown = registerServiceWorker(env)
    await flush()
    await openDoor()
    env.sw.dispatchEvent(new Event('controllerchange'))
    expect(env.reload).toHaveBeenCalledTimes(1)
    teardown()
  })

  it.each(SEEDS)('a seeded, untouched door does not defer a deploy\'s reload (%s)', async (_n, props) => {
    const env = makeSwEnv()
    const teardown = registerServiceWorker(env)
    await flush()
    await openDoor(props)
    env.sw.dispatchEvent(new Event('controllerchange'))
    expect(env.reload).toHaveBeenCalledTimes(1)
    teardown()
  })

  it('a save releases a reload deferred mid-entry', async () => {
    const env = makeSwEnv()
    const teardown = registerServiceWorker(env)
    await flush()
    const { seen } = await openDoor()
    typeInto('door-what-name', 'Corn'); tap('door-place-id:loc-1'); tap('door-method-whole_freeze')
    env.sw.dispatchEvent(new Event('controllerchange'))
    expect(env.reload).not.toHaveBeenCalled()
    tap('door-save')
    await waitFor(() => expect(seen.saved).toBeTruthy())
    await waitFor(() => expect(env.reload).toHaveBeenCalledTimes(1))
    teardown()
  })
})

describe('a seed and a stored draft', () => {
  it('a plain open after an untouched seeded open shows no planting', async () => {
    const first = await openDoor({ initialWhat: P1 })
    expect(screen.getByTestId('door-what-picked').textContent).toContain('Sungold cherry')
    first.unmount()
    await openDoor()
    expect(screen.queryByTestId('door-what-picked')).toBeNull()
    expect(screen.getByTestId('door-what-name').value).toBe('')
  })

  it('a stored Pantry draft survives a seeded open closed untouched, and the plain door then restores it', async () => {
    writeSheetDraft(DRAFT_KEY, DOOR_SHEET, STORED)
    const first = await openDoor({ initialWhat: P1 })
    fireEvent.click(document.querySelector('[data-sheet-close]'))
    await waitFor(() => expect(screen.queryByTestId('door-sheet')).toBeNull())
    first.unmount()
    await openDoor()
    expect(screen.getByTestId('door-what-name').value).toBe('Kale')
    expect(draft().key).toBe(K1)
  })

  it('the same seed and a stored draft for it: the stored draft is restored whole', async () => {
    const mine = { ...STORED, what: { ...P1, name: 'Sungold cherry, the early ones' }, method: 'whole_freeze', count: '3', notes: 'first flush', sizeValue: '1', sizeUnit: 'qt' }
    writeSheetDraft(DRAFT_KEY, DOOR_SHEET, mine)
    await openDoor({ initialWhat: P1 })
    expect(screen.getByTestId('door-what-picked').textContent).toContain('Sungold cherry, the early ones')   // its edited name included
    expect(screen.getByTestId('door-place-id:loc-3').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('door-count-count').value).toBe('3')
    expect(screen.getByTestId('door-size-value').value).toBe('1')
    expect(draft().key).toBe(K1)
    expect(isReloadBlocked()).toBe(true)                                      // a restored draft is work in hand
  })

  it('the same typed seed, whatever its case or spacing, restores its draft too', async () => {
    writeSheetDraft(DRAFT_KEY, DOOR_SHEET, STORED)
    await openDoor({ initialName: '  kale ' })
    expect(screen.getByTestId('door-what-name').value).toBe('Kale')
    expect(screen.getByTestId('door-method-as_is').getAttribute('aria-checked')).toBe('true')
    expect(draft().key).toBe(K1)
  })

  it('a draft made for one planting is not kept for another of the same name: a different seed replaces it at the first change', async () => {
    const forP1 = { ...STORED, what: P1, method: 'whole_freeze' }
    writeSheetDraft(DRAFT_KEY, DOOR_SHEET, forP1)
    const before = stored()
    await openDoor({ initialWhat: P2 })
    expect(within(screen.getByTestId('door-methods')).getAllByRole('radio').filter(r => r.getAttribute('aria-checked') === 'true')).toEqual([])
    expect(stored()).toBe(before)
    tap('door-place-id:loc-1')
    await waitFor(() => expect(draft()?.what?.plant_id).toBe('p2'))
    expect(draft().key).not.toBe(K1)
  })

  it('Change tapped, the door closed, and the same link tapped again: the seed re-applies', async () => {
    const first = await openDoor({ initialWhat: P1 })
    tap('door-what-change')                                                   // the planting dropped: a typed name now
    await waitFor(() => expect(draft()?.what).toEqual({ source: 'typed', name: 'Sungold cherry' }))
    first.unmount()
    await openDoor({ initialWhat: P1 })
    expect(screen.getByTestId('door-what-picked').textContent).toContain('Sungold cherry')
    expect(draft().what).toEqual({ source: 'typed', name: 'Sungold cherry' })   // the stored one is still there, untouched
  })
})

describe('an older item route answers 400 to an as-is save that carries an amount (a cached bundle after a forward undo)', () => {
  it('the door stays open with every field intact, says the server\'s sentence, and sends no second request', async () => {
    const SAID = 'unknown field(s): quantity_value, quantity_unit'
    wire({ overrides: { 'POST /api/pantry/items': () => { throw apiError(400, { error: SAID }) } } })
    const { seen } = await openDoor()
    typeInto('door-what-name', 'Rice'); tap('door-place-id:loc-3'); tap('door-method-as_is')
    tap('door-amount-open'); typeInto('door-amount-value', '2'); tap('door-amount-unit-lb')
    tap('door-from'); typeInto('door-notes', 'the big bag')
    tap('door-save')
    await waitFor(() => expect(screen.getByTestId('door-error').textContent).toBe(SAID))
    await flush()
    expect(posts('/api/pantry/items')).toHaveLength(1)
    expect(posts('/api/pantry/items')[0].body).toMatchObject({ quantity_value: 2, quantity_unit: 'lb' })
    expect(seen.saved).toBeUndefined()
    expect(screen.getByTestId('door-sheet')).toBeTruthy()
    expect([
      screen.getByTestId('door-what-name').value, screen.getByTestId('door-place-id:loc-3').getAttribute('aria-checked'),
      screen.getByTestId('door-method-as_is').getAttribute('aria-checked'), screen.getByTestId('door-amount-value').value,
      screen.getByTestId('door-amount-unit-lb').getAttribute('aria-checked'), screen.getByTestId('door-notes').value,
    ]).toEqual(['Rice', 'true', 'true', '2', 'true', 'the big bag'])
    // He can take the amount off and save: nothing was written, and nothing is retried behind his back.
    expect(screen.getByTestId('door-amount-clear')).toBeTruthy()
    expect(draft()).toMatchObject({ amountValue: '2', amountUnit: 'lb', notes: 'the big bag' })
  })
})

describe('candy at the moment of logging', () => {
  it('a candy preview contains "house estimate", and Freeze whole\'s does not', async () => {
    await openDoor()
    typeInto('door-what-name', 'Candied peel'); tap('door-place-new:pantry:pantry shelf')
    tap('door-method-more'); tap('door-method-candy')
    expect(screen.getByTestId('door-method-candy').textContent).toBe('Candied (pieces or sweets)')
    expect(screen.getByTestId('door-preview').textContent).toContain('house estimate')
    expect(screen.getByTestId('door-preview').textContent).toBe(previewLine({ method: 'candy', place: { kind: 'pantry' }, when: { date: '2026-10-01', precision: 'day' }, now: NOW }))
    tap('door-method-whole_freeze')
    expect(screen.getByTestId('door-preview').textContent).not.toContain('house estimate')
  })
})
