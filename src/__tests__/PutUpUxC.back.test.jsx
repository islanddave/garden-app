// Put-Up UX pass R1, lane C — the row sheet's Back, against REAL jsdom history and the REAL registry
// (PLAN-V3 D1 "One Back rule for all five row-sheet panels").
//
// THE RULE: Back in a panel returns to the action list with the sheet still open; Back on the list closes
// the sheet; and when it has closed the page's own entry is the current one again — no entry of the
// sheet's is left behind to eat a press, and none of the page's was taken.
//
// WHY A FILE OF ITS OWN. Every other Pantry test mounts MemoryRouter and no registry, where the sheet's
// Back entry does not exist: a Back test written that way passes over nothing. The rig below is
// BackNav.history.test.jsx's (a real floor entry under the page, the popstate awaited, never a sleep).
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch, jarRow, itemRow, PLACES } from './helpers/pantryFake.js'

installStoragePolyfill()

let fake
const { stableFetch } = vi.hoisted(() => ({ stableFetch: { fn: null } }))
vi.mock('../lib/api.js', () => {
  const f = (...a) => stableFetch.fn(...a)
  return { useApiFetch: () => ({ fetch: f, getToken: () => Promise.resolve('t') }), apiFetch: f }
})
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: null }) }))

import PantryRowSheet from '../components/pantry/PantryRowSheet.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { readMarker } from '../lib/backNav.js'

const NET_MS = 2000
let pops = 0
window.addEventListener('popstate', () => { pops += 1 })
const settle = (from = pops) => act(async () => {
  const deadline = Date.now() + NET_MS
  while (pops === from && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2))
  // BUG-BACKTWICECLOSESAPP-001: a Back the registry refuses or steps (busy, the discard question, a panel, a
  // stacked close) is answered by a RETURN to the same marker, history.go(1): a second traversal that lands two
  // jsdom tasks and one popstate later. Wait until a whole round of turns passes with no further popstate, so
  // the marker is read after it has settled. Equal-delay timers run first-in first-out: ordering, not a sleep.
  let seen
  do {
    seen = pops
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0))
  } while (pops !== seen && Date.now() < deadline)
})
const back = async () => { const from = pops; act(() => { window.history.back() }); await settle(from) }

// The page's own entry (the floor), with a real entry beneath it so no Back here is a silent no-op at
// index 0. `atPage` also requires the sheet's marker to be gone: arming MERGES history.state, so the
// marker entry carries the floor's keys too.
const PAGE_URL = '/put-up?view=pantry'
const armed = () => !!readMarker(window.history.state)
const atPage = () => !armed() && window.history.state?.__page === 1
const url = () => window.location.pathname + window.location.search

const JAR = jarRow({ stock_id: 'jar-1', name: 'Megatron reaper', place: PLACES[2], method: 'hot_sauce', count_left: 3 })
const ITEM = itemRow({ stock_id: 'item-1', name: 'Oat milk', place: PLACES[2] })
const BATCH_JAR = jarRow({ stock_id: 'jar-2', name: 'Petri Dish woozy', place: PLACES[2], method: 'hot_sauce', count_left: 2, batch_id: 'kb-7' })
const JarEditor = ({ rec, onCancel }) => (
  <div data-testid="jar-editor"><span>{rec.label}</span><button type="button" onClick={onCancel}>Cancel</button></div>
)

function Host({ row, ...rest }) {
  const [open, setOpen] = useState(row)
  return (
    <DismissRegistryProvider>
      <p data-testid="page">the Pantry</p>
      <PantryRowSheet row={open} fetch={stableFetch.fn} JarEditor={JarEditor} onClose={() => setOpen(null)} {...rest} />
    </DismissRegistryProvider>
  )
}
async function openSheet(row, props = {}) {
  await act(async () => { render(<Host row={row} {...props} />) })
  await waitFor(() => expect(armed()).toBe(true))
}

beforeEach(() => {
  fake = pantryFetch({ rows: [JAR, ITEM] })
  stableFetch.fn = fake
  window.history.replaceState({ __base: 1 }, '', '/today')
  window.history.pushState({ __page: 1 }, '', PAGE_URL)
})
afterEach(async () => {
  cleanup()
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  document.body.style.overflow = ''; document.body.style.overscrollBehavior = ''
})

describe('SELF-TEST — the rig, before any behaviour is asserted', () => {
  it('a real popstate arrives, and the page entry has a real entry beneath it', async () => {
    expect(atPage()).toBe(true)
    await back()
    expect(window.history.state?.__base).toBe(1)
    expect(url()).toBe('/today')
  })

  it('the open row sheet holds a Back entry of its own, on the page\'s URL', async () => {
    await openSheet(JAR)
    expect(armed()).toBe(true)
    expect(url()).toBe(PAGE_URL)
    expect(screen.getByRole('dialog', { name: 'Megatron reaper' })).toBeTruthy()
  })
})

describe('Back on the action list closes the sheet', () => {
  it('one Back: the sheet is gone, the page\'s entry is current, the URL never moved', async () => {
    await openSheet(JAR)
    await back()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(atPage()).toBe(true)
    expect(url()).toBe(PAGE_URL)
    expect(screen.getByTestId('page')).toBeTruthy()
  })
})

// [the action tapped, what shows that its panel is open]
const JAR_PANELS = [
  ['row-move', 'move-panel'],
  ['row-next', 'next-panel'],
  ['row-give', 'give-panel'],
  ['row-went-bad', 'went-bad-panel'],
  ['row-edit', 'jar-edit-panel'],
]

describe('Back in a panel returns to the action list; Back again closes the sheet', () => {
  it.each(JAR_PANELS)('a put-up — %s: Back → the list, the sheet still open; Back → the sheet closed, the URL unchanged', async (action, panel) => {
    await openSheet(JAR)
    fireEvent.click(screen.getByTestId(action))
    expect(await screen.findByTestId(panel)).toBeTruthy()
    expect(screen.queryByTestId('row-move')).toBeNull()          // the panel replaced the list

    await back()
    expect(screen.queryByTestId(panel)).toBeNull()
    expect(screen.getByTestId('row-move')).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Megatron reaper' })).toBeTruthy()
    expect(armed()).toBe(true)                                   // the sheet's Back entry is held again
    expect(url()).toBe(PAGE_URL)

    await back()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(atPage()).toBe(true)                                  // nothing left behind, nothing of the page's taken
    expect(url()).toBe(PAGE_URL)
    expect(fake.calls('POST')).toEqual([])                       // Back writes nothing
    expect(fake.calls('PATCH')).toEqual([])
  })

  it('a bought item — row-edit: the same two steps', async () => {
    await openSheet(ITEM)
    fireEvent.click(screen.getByTestId('row-edit'))
    expect(await screen.findByTestId('item-edit-panel')).toBeTruthy()
    await back()
    expect(screen.queryByTestId('item-edit-panel')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Oat milk' })).toBeTruthy()
    expect(armed()).toBe(true)
    await back()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(atPage()).toBe(true)
    expect(url()).toBe(PAGE_URL)
  })

  // M9's test, in the plan's words. As a sheet of its own (the base) Move it took the row sheet's Back entry
  // with it: the first Back closed Move, the row sheet came back UNARMED, and the second Back left the page.
  it('Move it, Back → the action list with the sheet still open; Back → sheet closed, URL unchanged', async () => {
    await openSheet(JAR)
    fireEvent.click(screen.getByTestId('row-move'))
    fireEvent.click(await screen.findByTestId('move-place-id:loc-1'))     // a place tapped, nothing saved
    expect(screen.getAllByRole('dialog')).toHaveLength(1)                 // one sheet, one Back entry
    await back()
    expect(screen.queryByTestId('move-panel')).toBeNull()
    expect(screen.getByTestId('row-move')).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Megatron reaper' })).toBeTruthy()
    expect(armed()).toBe(true)
    expect(url()).toBe(PAGE_URL)
    await back()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(atPage()).toBe(true)
    expect(url()).toBe(PAGE_URL)
    expect(fake.calls('POST')).toEqual([])
  })

  it('a bought item — row-move: the same two steps', async () => {
    await openSheet(ITEM)
    fireEvent.click(screen.getByTestId('row-move'))
    expect(await screen.findByTestId('move-panel')).toBeTruthy()
    await back()
    expect(screen.queryByTestId('move-panel')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Oat milk' })).toBeTruthy()
    expect(armed()).toBe(true)
    await back()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(atPage()).toBe(true)
  })

  // The host is told of the move only once the sheet's Back entry is consumed: it brings its line into
  // view, and a scroll made while that entry is still being popped is undone by the pop.
  it('a move that SAVES closes the sheet, leaves the page\'s entry current, and only THEN tells the host', async () => {
    const seen = []
    const onMoved = vi.fn((m) => seen.push({ place: m.place.label, sheetOpen: !!screen.queryByRole('dialog'), atPage: atPage() }))
    const onChanged = vi.fn()
    await openSheet(JAR, { onMoved, onChanged })
    fireEvent.click(screen.getByTestId('row-move'))
    fireEvent.click(await screen.findByTestId('move-place-id:loc-1'))
    const from = pops
    fireEvent.click(screen.getByTestId('move-save'))
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('moved'))
    await settle(from)
    await waitFor(() => expect(onMoved).toHaveBeenCalledTimes(1))
    expect(seen).toEqual([{ place: 'Chest Freezer 1', sheetOpen: false, atPage: true }])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(atPage()).toBe(true)
    expect(url()).toBe(PAGE_URL)
  })

  it('a panel, Back, another panel, Back: each returns to the list — the entry is re-armed every time', async () => {
    await openSheet(JAR)
    for (const [action, panel] of JAR_PANELS) {
      fireEvent.click(screen.getByTestId(action))
      expect(await screen.findByTestId(panel)).toBeTruthy()
      await back()
      expect(screen.queryByTestId(panel)).toBeNull()
      expect(screen.getByRole('dialog', { name: 'Megatron reaper' })).toBeTruthy()
      expect(armed()).toBe(true)
    }
    await back()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(atPage()).toBe(true)
  })

  it('Cancel in a panel and the sheet\'s Close leave the same clean history as Back does', async () => {
    await openSheet(JAR)
    fireEvent.click(screen.getByTestId('row-give'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('row-move')).toBeTruthy()
    expect(armed()).toBe(true)
    const from = pops
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await settle(from)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(atPage()).toBe(true)
    expect(url()).toBe(PAGE_URL)
  })
})

// PLAN-V3 section 3 point 2, rule 4: a caller inside an armed sheet LANDS FIRST. A push made while the
// sheet's Back entry is current strands that entry under the batch — one Back press that does nothing.
describe('What went in → lands first', () => {
  const BATCH_URL = '/put-up?view=pantry&batch=kb-7'

  it('the page is told only after the sheet has closed and its Back entry is consumed — once, with the origin', async () => {
    const seen = []
    const onOpenBatch = vi.fn((id, origin) => seen.push({
      id, origin, sheetOpen: !!screen.queryByRole('dialog'), markerCurrent: armed(), atPage: atPage(), url: url(),
    }))
    await openSheet(BATCH_JAR, { onOpenBatch })
    const from = pops
    fireEvent.click(screen.getByTestId('row-what-went-in'))
    expect(onOpenBatch).not.toHaveBeenCalled()                   // not in the tap: the entry is still the sheet's
    await settle(from)
    await waitFor(() => expect(onOpenBatch).toHaveBeenCalledTimes(1))
    expect(seen).toEqual([{ id: 'kb-7', origin: { label: 'Pantry' }, sheetOpen: false, markerCurrent: false, atPage: true, url: PAGE_URL }])
  })

  it('so the page\'s push sits directly on the Pantry: ONE Back returns there, and there is no dead press', async () => {
    const onOpenBatch = vi.fn(() => window.history.pushState({ __batch: 1 }, '', BATCH_URL))   // what the page's opener does
    await openSheet(BATCH_JAR, { onOpenBatch })
    const from = pops
    fireEvent.click(screen.getByTestId('row-what-went-in'))
    await settle(from)
    await waitFor(() => expect(url()).toBe(BATCH_URL))
    expect(armed()).toBe(false)
    await back()
    expect(url()).toBe(PAGE_URL)
    expect(atPage()).toBe(true)                                  // the Pantry's own entry, not a stale one of the sheet's
    await back()
    expect(url()).toBe('/today')                                 // and the next Back leaves, as it would have
  })
})
