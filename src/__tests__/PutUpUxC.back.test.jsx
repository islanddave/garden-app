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
  await new Promise((r) => setTimeout(r, 0))
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
