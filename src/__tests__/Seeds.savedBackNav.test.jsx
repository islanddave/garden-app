// V5-SEEDSTAB-001 §5.2 — Saved seeds' two sheets arm Android Back, against REAL jsdom history.
//
// THE CHANGE UNDER TEST. Before slice 1 neither sheet on Saved seeds armed Back: a system Back over the
// advance sheet or the "Track a saved-seed lot" sheet fell through to a history pop and LEFT the page,
// taking the half-filled form with it. Slice 1 arms both (SavedSeeds.jsx, `armsBack` on each <Sheet>),
// and the track sheet's one navigating link, "Add the packet →", became a SheetRowLink so leaving
// through it consumes the marker instead of stranding it mid-stack (backNav.js: a surface that
// navigates away MUST consume the marker or stay unarmed). None of that was pinned: no SavedSeeds,
// Seeds or MySeeds suite mounted the DismissRegistry or looked at history.
//
// HARNESS: the real-history conventions of BottomNav.backNav.test.jsx and BackNav.history.test.jsx.
// A REAL BrowserRouter, never MemoryRouter (it never touches window.history, so every assertion here
// would pass vacuously), the real DismissRegistryProvider, and a floor sentinel. The floor sits ABOVE
// a /today entry rather than at the bottom of the stack, so an unarmed sheet's Back has somewhere to go
// and does what the shipped defect did — leaves Seeds — instead of being jsdom's silent no-op at
// index 0. Mounted as `<Seeds>` at `/seeds?view=saved`, the only render Dave can reach: the standalone
// SavedSeeds page has no route any more.
//
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'

const flags = { DISMISS_REGISTRY_ENABLED: true, BACKNAV_ENABLED: true }
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  get DISMISS_REGISTRY_ENABLED() { return flags.DISMISS_REGISTRY_ENABLED },
  get BACKNAV_ENABLED() { return flags.BACKNAV_ENABLED },
}))

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
// isFromCache is required: Seeds' useSeedItems calls it on every load (the Seeds.test.jsx shape).
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
  isFromCache: (v) => !!v && typeof v === 'object' && v[Symbol.for('garden-app.fromCache')] === true,
}))

import Seeds from '../pages/Seeds.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { readMarker } from '../lib/backNav.js'

const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString()
const lot = (over = {}) => ({
  id: 'lot-x', name: 'Brandywine — saved 2026', variety_name: 'Brandywine', category: 'seeds',
  type: 'consumable', unit: 'packet', status: 'active', quantity_on_hand: 1, variety_id: 'v-b',
  crop_slug: 'tomato', seed_stage: null, seed_process: null, source_plant_id: null, source_kind: null,
  source_id: null, stage_entered_at: null, seed_count: null, seed_weight_g: null, created_at: '2026-07-01T12:00:00Z',
  ...over,
})
// One lot in flight (its card carries the advance button) and one untracked packet (the track sheet's
// only candidate).
const DRYING = lot({ id: 'lot-dry', name: 'Gong Bao — saved 2026', variety_name: 'Gong Bao', crop_slug: 'pepper', seed_stage: 'drying', stage_entered_at: daysAgo(3) })
const BOUGHT = lot({ id: 'pkt-1', name: 'Sungold', variety_name: 'Sungold', quantity_on_hand: 2 })

const SAVED = '/seeds?view=saved'
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)) })
const back = async () => { act(() => { window.history.back() }); await settle() }
// Restored in afterEach, never inline: an assertion that fails between spyOn and an inline restore
// would leave the spy on, and the NEXT test's count would include this one's pushes.
let pushSpy = null
const spyPush = () => { pushSpy = vi.spyOn(window.history, 'pushState'); return pushSpy }

// Floor sentinel — see BottomNav.backNav.test.jsx. arm() MERGES state, so the marker entry carries
// __floor forward; a react-router push/replace writes a fresh {usr,key,idx} and drops it. After a
// navigate + ONE Back, atFloor() is only reachable if no marker entry was left standing mid-stack.
const SENTINEL = { __floor: 1 }
const armed = () => !!readMarker(window.history.state)
const atFloor = () => !armed() && window.history.state?.__floor === 1

function Probe() {
  const loc = useLocation()
  return <span data-testid="path" data-search={loc.search} data-seeds-return={loc.state?.seedsReturn ?? ''}>{loc.pathname}</span>
}
const path = () => screen.getByTestId('path').textContent
const search = () => screen.getByTestId('path').getAttribute('data-search')

function renderSeeds() {
  return render(
    <BrowserRouter>
      <DismissRegistryProvider>
        <ToastProvider>
          <Routes>
            <Route path="/seeds" element={<Seeds />} />
            <Route path="/today" element={<div data-testid="today" />} />
            <Route path="/inventory/add" element={<div data-testid="add-form" />} />
            <Route path="/inventory/:id" element={<div data-testid="detail" />} />
          </Routes>
          <Probe />
        </ToastProvider>
      </DismissRegistryProvider>
    </BrowserRouter>,
  )
}

beforeEach(() => {
  flags.DISMISS_REGISTRY_ENABLED = true
  flags.BACKNAV_ENABLED = true
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((p, opts) => {
    if (opts?.method) return Promise.resolve({ ok: true })
    if (String(p).startsWith('/api/inventory-items?category=seeds')) return Promise.resolve([DRYING, BOUGHT])
    return Promise.resolve([])
  })
  try { window.sessionStorage.clear() } catch { /* jsdom */ }
  window.history.replaceState({}, '', '/today')
  window.history.pushState(SENTINEL, '', SAVED)
})
afterEach(() => {
  pushSpy?.mockRestore()
  pushSpy = null
  cleanup()
  document.body.style.overflow = ''
  document.body.style.overscrollBehavior = ''
})

async function onSavedSeeds() {
  renderSeeds()
  await waitFor(() => expect(screen.getByTestId('saved-seeds-view')).toBeTruthy())
  await waitFor(() => expect(screen.getByTestId('track-a-lot')).toBeTruthy())
  expect(path() + search()).toBe(SAVED)
  expect(atFloor(), 'precondition: the floor sentinel is the current entry').toBe(true)
}

describe('SELF-TEST — the harness, before any behaviour is asserted', () => {
  it('an unarmed Back from the floor LEAVES Seeds (so a sheet that fails to arm is visible here)', async () => {
    await onSavedSeeds()
    await back()
    expect(path()).toBe('/today')
  })
})

describe('Saved seeds — Back closes each sheet in place', () => {
  it('the advance sheet: armed while open; Back closes it and stays on Seeds › Saved seeds', async () => {
    await onSavedSeeds()
    await act(async () => { fireEvent.click(screen.getByTestId('advance-stage')) })
    await settle()
    expect(screen.getByTestId('stage-save')).toBeTruthy()
    expect(armed(), 'the advance sheet did not arm Back').toBe(true)
    await back()
    expect(screen.queryByTestId('stage-save')).toBeNull()   // the sheet closed…
    expect(path() + search()).toBe(SAVED)                    // …the page did not move…
    expect(atFloor()).toBe(true)                             // …and the marker was consumed.
  })

  it('the track sheet: armed while open; Back closes it and stays on Seeds › Saved seeds', async () => {
    await onSavedSeeds()
    await act(async () => { fireEvent.click(screen.getByTestId('track-a-lot')) })
    await settle()
    expect(screen.getByTestId('add-seed-packet')).toBeTruthy()
    expect(armed(), 'the track sheet did not arm Back').toBe(true)
    await back()
    expect(screen.queryByTestId('add-seed-packet')).toBeNull()
    expect(path() + search()).toBe(SAVED)
    expect(atFloor()).toBe(true)
  })
})

describe('Saved seeds — "Add the packet →" leaves the armed track sheet with a REPLACE', () => {
  it('replaces the marker entry, carries seedsReturn, and ONE Back returns to Seeds › Saved seeds', async () => {
    await onSavedSeeds()
    await act(async () => { fireEvent.click(screen.getByTestId('track-a-lot')) })
    await settle()
    expect(armed()).toBe(true)

    const push = spyPush()
    await act(async () => { fireEvent.click(screen.getByTestId('add-seed-packet')) })
    await settle()
    expect(path()).toBe('/inventory/add')
    expect(search()).toBe('?type=consumable&category=seeds&return=%2Fseeds%3Fview%3Dsaved')
    // A push here strands the marker mid-stack: [saved, saved+marker, add] — a dead Back later.
    expect(push).not.toHaveBeenCalled()
    // The replace carries the way back, so the form can leave with navigate(-1).
    expect(window.history.state?.usr).toEqual({ seedsReturn: SAVED })
    expect(screen.getByTestId('path').getAttribute('data-seeds-return')).toBe(SAVED)
    expect(armed()).toBe(false)

    await back()
    expect(path() + search()).toBe(SAVED)
    expect(atFloor()).toBe(true)
  })

  it('control: Back navigation off, so nothing is armed — the link is a plain push, still with seedsReturn', async () => {
    // Without this, a link that replaced unconditionally would pass the case above — and would
    // overwrite Saved seeds' own entry on every unarmed stack.
    flags.BACKNAV_ENABLED = false
    await onSavedSeeds()
    await act(async () => { fireEvent.click(screen.getByTestId('track-a-lot')) })
    await settle()
    expect(armed()).toBe(false)

    const push = spyPush()
    await act(async () => { fireEvent.click(screen.getByTestId('add-seed-packet')) })
    await settle()
    expect(path()).toBe('/inventory/add')
    expect(push).toHaveBeenCalledTimes(1)
    expect(window.history.state?.usr).toEqual({ seedsReturn: SAVED })

    await back()
    expect(path() + search()).toBe(SAVED)
    expect(atFloor()).toBe(true)
  })
})
