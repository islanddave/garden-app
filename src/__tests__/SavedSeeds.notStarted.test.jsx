// V5-SEEDSTAB-001 slice 2 — Saved seeds' "Not started" group, and the two doors off a saved lot's card.
//
// WHAT IS PINNED, and the regression each assertion catches:
//   · MEMBERSHIP IS THE ORIGIN. A saved lot with no stage — off one of your plants (source_plant_id) or out
//     of produce (source_kind) — is filed under Not started; a bought packet never is. The fixture's two
//     lots are both ones the sow engine's isUnstartedSave says NO to (a farm-stand kind, and an own-plant
//     lot that already carries a count), so a group rebuilt on that predicate empties and the id list reds.
//   · ORDER. Not started is the first step of the process, so it sits above the stage sections.
//   · START. "Start →" opens the process question for that lot and writes the stage the process decides,
//     through the page's one stage writer (POST /seed-stage) — never a stage picked for it.
//   · §16. A save made with "Not yet" from the Seeds header used to confirm with a toast alone: nothing on
//     Saved seeds could be outlined. It now lands, outlined, in Not started.
//   · THE PARENT IS A DOOR. "Saved from <planting>" links to the planting (44px), and Back from there
//     returns to the same Saved seeds view, on real jsdom history.
//
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent, cleanup, within } from '@testing-library/react'
import { MemoryRouter, BrowserRouter, Routes, Route, createMemoryRouter, RouterProvider, useLocation } from 'react-router-dom'

const { fetchSpy, saveSheetProps } = vi.hoisted(() => ({ fetchSpy: vi.fn(), saveSheetProps: { current: null } }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
  isFromCache: (v) => !!v && typeof v === 'object' && v[Symbol.for('garden-app.fromCache')] === true,
}))
// The sheet is its own suite's subject. Here only what the Seeds shell hands it matters: the onSaved that
// confirms a save in place. SeedCountBasis is the advance sheet's basis switch, not under test here.
vi.mock('../components/planting/SaveSeedSheet.jsx', () => ({
  default: (props) => { saveSheetProps.current = props; return <div data-testid="save-seed-sheet-stub" /> },
  SeedCountBasis: () => null,
}))

import SavedSeeds from '../pages/SavedSeeds.jsx'
import Seeds from '../pages/Seeds.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { readMarker } from '../lib/backNav.js'
import { isNotStartedLot, F2_LABEL, elapsedLabel } from '../components/seed/seedLots.js'
import { isUnstartedSave } from '../lib/sowEngine.js'
import { etDay } from '../lib/harvestSummary.js'

const DAY = 86400000
// The Eastern calendar date `n` days before today, at 16:00Z — noon EDT / 11:00 EST, the same date either
// way — as SavedSeeds.processAndElapsed's stageDaysAgo does it. The card counts CALENDAR days in Eastern
// (seedLots.elapsedDays), so an instant n x 24 h back lands on the wrong day in the hour after a DST
// change: 48 h back reads "3 days" from 00:00 to 01:00 ET on the Monday after spring-forward and "1 day"
// from 23:00 to 24:00 ET on the Monday after fall-back (pre-ship QA; pinned at the foot of this file).
const daysAgo = (n) =>
  `${new Date(Date.parse(`${etDay(new Date())}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10)}T16:00:00Z`
const lot = (over = {}) => ({
  id: 'lot-x', name: 'Brandywine — saved 2026', variety_name: 'Brandywine', category: 'seeds',
  type: 'consumable', unit: 'packet', status: 'active', quantity_on_hand: 1, variety_id: 'v-b',
  crop_slug: 'tomato', seed_stage: null, seed_process: null, source_plant_id: null, source_kind: null,
  source_id: null, stage_entered_at: null, seed_count: null, seed_weight_g: null, seed_count_estimated: null,
  created_at: daysAgo(3), ...over,
})
// Off one of Dave's plants, not started, and already COUNTED — isUnstartedSave says no (it has a measure).
const OWN = lot({
  id: 'lot-own', name: 'Big Boy — saved 2026', variety_name: 'Big Boy', source_plant_id: 'pl-bigboy',
  seed_count: 40, seed_count_estimated: false, created_at: daysAgo(5),
})
// Out of a farm-stand pepper, not started — isUnstartedSave says no (its kind is not own_garden).
const PRODUCE_ROW = () => lot({
  id: 'lot-stand', name: 'Aji Amarillo — saved 2026', variety_name: 'Aji Amarillo', crop_slug: 'pepper',
  source_kind: 'farm_stand', created_at: daysAgo(2),
})
const PRODUCE = PRODUCE_ROW()
const BOUGHT = lot({ id: 'pkt-1', name: 'Sungold', variety_name: 'Sungold', quantity_on_hand: 2 })
const DRYING = lot({
  id: 'lot-dry', name: 'Gong Bao — saved 2026', variety_name: 'Gong Bao', crop_slug: 'pepper',
  seed_stage: 'drying', seed_process: 'fresh', stage_entered_at: daysAgo(3), source_plant_id: 'pl-gongbao',
})
const PLANTINGS = [
  { id: 'pl-bigboy', name: 'Big Boy, bed 3', quantity: 2, variety_id: 'v-b', project_name: null, variety_ref: null, sown_at: null, succession_order: null },
  { id: 'pl-gongbao', name: 'Gong Bao pot', quantity: 1, variety_id: 'v-g', project_name: null, variety_ref: null, sown_at: null, succession_order: null },
]

let seedRows
beforeEach(() => {
  fetchSpy.mockReset()
  saveSheetProps.current = null
  seedRows = []
  try { window.sessionStorage.clear() } catch { /* jsdom */ }
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    if (opts?.method) return Promise.resolve({ ok: true })
    if (p.startsWith('/api/plants?view=picker')) return Promise.resolve(PLANTINGS)
    if (p.startsWith('/api/inventory-items?category=seeds')) return Promise.resolve(seedRows)
    return Promise.resolve([])
  })
})
afterEach(() => cleanup())

const mountPage = async (rows) => {
  seedRows = rows
  await act(async () => {
    render(<MemoryRouter><ToastProvider><SavedSeeds /></ToastProvider></MemoryRouter>)
  })
  await waitFor(() => expect(screen.getByText('Saved seeds')).toBeTruthy())
}
const section = () => screen.queryByTestId('stage-section-unstarted')
const idsIn = (el) => [...el.querySelectorAll('[data-testid="seed-lot-card"]')].map((c) => c.getAttribute('data-lot-id'))
const writes = () => fetchSpy.mock.calls.filter(([, o]) => o?.method)

describe('isNotStartedLot — the origin decides, not the sow engine', () => {
  it('is a saved lot with no stage; never a bought packet, never a staged lot', () => {
    expect(isNotStartedLot(OWN)).toBe(true)
    expect(isNotStartedLot(PRODUCE)).toBe(true)
    expect(isNotStartedLot(lot({ source_kind: 'own_garden' }))).toBe(true)
    expect(isNotStartedLot(BOUGHT)).toBe(false)
    expect(isNotStartedLot(DRYING)).toBe(false)
    expect(isNotStartedLot({ ...OWN, seed_stage: 'stored' })).toBe(false)
    expect(isNotStartedLot(null)).toBe(false)
    // The reason the group is not built on the engine's predicate: both of these are not-started saves
    // the engine does not call unstarted (§15, BUG-SOWSEEDSTATEGAPS-001).
    expect(isUnstartedSave(OWN)).toBe(false)
    expect(isUnstartedSave(PRODUCE)).toBe(false)
  })
})

describe('Saved seeds — the Not started group', () => {
  it('files own-plant AND produce-derived lots with no stage, oldest first, and never a bought packet', async () => {
    await mountPage([BOUGHT, PRODUCE, DRYING, OWN])
    await waitFor(() => expect(section()).toBeTruthy())
    expect(idsIn(section())).toEqual(['lot-own', 'lot-stand'])
    // The bought packet has no card anywhere on the page.
    expect(document.querySelector('[data-lot-id="pkt-1"]')).toBeNull()
    expect(within(section()).getByRole('heading', { name: 'Not started' })).toBeTruthy()
  })

  it('sits first: the step before the first stage, above the stage sections', async () => {
    await mountPage([DRYING, OWN])
    await waitFor(() => expect(section()).toBeTruthy())
    const order = [...document.querySelectorAll('section[data-testid^="stage-section-"]')].map((s) => s.getAttribute('data-testid'))
    expect(order).toEqual(['stage-section-unstarted', 'stage-section-drying'])
  })

  it('a not-started lot off an F1 plant carries the same F2 badge as the stage cards; others carry none', async () => {
    await mountPage([{ ...OWN, breeding_system: 'f1' }, { ...PRODUCE, breeding_system: 'open_pollinated' }])
    await waitFor(() => expect(section()).toBeTruthy())
    const f1Card = section().querySelector('[data-lot-id="lot-own"]')
    const opCard = section().querySelector('[data-lot-id="lot-stand"]')
    expect(within(f1Card).getByTestId('lot-f2').textContent).toBe(F2_LABEL)
    expect(within(opCard).queryByTestId('lot-f2')).toBeNull()
  })

  it('leaves out a lot that is retired or used up — it is not waiting to be started', async () => {
    await mountPage([DRYING, { ...OWN, status: 'retired' }, { ...PRODUCE, status: 'depleted' }])
    await waitFor(() => expect(screen.getByTestId('stage-section-drying')).toBeTruthy())
    expect(section()).toBeNull()
  })

  it('says it has not started, how long ago it was added, and where it came from', async () => {
    await mountPage([OWN, PRODUCE, lot({ id: 'lot-today', name: 'Dill — saved 2026', variety_name: 'Dill', source_kind: 'gift', created_at: new Date().toISOString() })])
    const card = (id) => document.querySelector(`[data-lot-id="${id}"]`)
    await waitFor(() => expect(within(card('lot-own')).getByTestId('lot-source-plant')).toBeTruthy())
    expect(within(card('lot-stand')).getByTestId('lot-unstarted-line').textContent).toBe('Not started · added 2 days ago')
    expect(within(card('lot-today')).getByTestId('lot-unstarted-line').textContent).toBe('Not started · added today')
    // Produce-derived: My seeds' words for the same lot.
    expect(within(card('lot-stand')).getByTestId('lot-origin').textContent).toBe('Saved · farm stand')
    // Own plant: the parent, as a door to it.
    const parent = within(card('lot-own')).getByTestId('lot-source-plant')
    expect(parent.getAttribute('href')).toBe('/plantings/pl-bigboy')
    expect(parent.textContent).toContain('Big Boy, bed 3')
    expect(within(card('lot-own')).getByTestId('lot-seed-measure').textContent).toBe('40 seeds')
    // No stage to correct, and no advance to a stage the process has not chosen.
    expect(within(card('lot-own')).queryByTestId('change-stage')).toBeNull()
    expect(within(card('lot-own')).queryByTestId('advance-stage')).toBeNull()
  })

  it('Start → asks how THIS lot was processed and starts it in the stage the process decides', async () => {
    await mountPage([PRODUCE, DRYING])
    await waitFor(() => expect(section()).toBeTruthy())
    const start = within(section()).getByTestId('start-lot')
    expect(start.getAttribute('aria-label')).toBe('Start Aji Amarillo')
    await act(async () => { fireEvent.click(start) })
    // Straight to the process step, for this lot — not the packet picker.
    expect(screen.getByTestId('start-process-step').textContent).toContain('Aji Amarillo')
    expect(screen.queryByTestId('track-candidate')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByTestId('start-process-fresh')) })
    expect(screen.getByRole('dialog', { name: 'Start in drying' })).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByTestId('stage-save')) })
    await waitFor(() => expect(writes().length).toBe(1))
    const [path, opts] = writes()[0]
    expect(`${opts.method} ${path}`).toBe('POST /api/inventory-items/lot-stand/seed-stage')
    const body = JSON.parse(opts.body)
    expect(body.stage).toBe('drying')
    expect(body.seed_process).toBe('fresh')
  })

  it('is not an empty page when the only saved lots have not started', async () => {
    await mountPage([PRODUCE, BOUGHT])
    await waitFor(() => expect(section()).toBeTruthy())
    expect(screen.queryByTestId('saved-seeds-empty')).toBeNull()
  })

  it('the crop filter covers Not started lots too', async () => {
    // Two crops, both only among lots that have not started: the chip row has to exist to narrow them.
    await mountPage([PRODUCE, OWN])
    await waitFor(() => expect(screen.getByTestId('tracked-crop-filter')).toBeTruthy())
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('tracked-crop-filter')).getByRole('button', { name: /Tomato/ }))
    })
    expect(idsIn(section())).toEqual(['lot-own'])
    expect(screen.queryByTestId('tracked-no-match')).toBeNull()
  })
})

describe('Seeds › Saved seeds — a save made with "Not yet" is outlined in Not started (design V102 §16)', () => {
  it('the rows reload, the view stays, and the new lot is outlined in its group', async () => {
    seedRows = [DRYING]
    const router = createMemoryRouter(
      [{ path: '/seeds', element: <ToastProvider><Seeds /></ToastProvider> }],
      { initialEntries: ['/seeds?view=saved'] },
    )
    render(<RouterProvider router={router} />)
    await waitFor(() => expect(document.querySelector('[data-lot-id="lot-dry"]')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId('seeds-save-seed')) })
    const NEW = lot({ id: 'lot-new', name: 'Big Boy — saved 2026', variety_name: 'Big Boy', source_plant_id: 'pl-bigboy', created_at: new Date().toISOString() })
    seedRows = [DRYING, NEW]
    await act(async () => { saveSheetProps.current.onClose(); saveSheetProps.current.onSaved(NEW, { stageWritten: null }) })
    await waitFor(() => expect(document.querySelector('[data-lot-id="lot-new"]')?.getAttribute('data-outlined')).toBe('true'))
    expect(document.querySelector('[data-lot-id="lot-new"]').closest('section').getAttribute('data-testid')).toBe('stage-section-unstarted')
    expect(router.state.location.search).toBe('?view=saved')
  })
})

// Real history, never MemoryRouter: "Back returns to the same view" is a statement about window.history.
// The Seeds.savedBackNav.test.jsx conventions — a floor sentinel above a /today entry, so a Back that
// escapes the page has somewhere to go and shows up here.
describe('Seeds › Saved seeds — doors off a lot card, on real history', () => {
  const SAVED = '/seeds?view=saved'
  const SENTINEL = { __floor: 1 }
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)) })
  const back = async () => { act(() => { window.history.back() }); await settle() }
  const armed = () => !!readMarker(window.history.state)
  const atFloor = () => !armed() && window.history.state?.__floor === 1
  function Probe() {
    const loc = useLocation()
    return <span data-testid="path" data-search={loc.search}>{loc.pathname}</span>
  }
  const where = () => screen.getByTestId('path').textContent + screen.getByTestId('path').getAttribute('data-search')

  beforeEach(() => {
    seedRows = [DRYING, OWN]
    window.history.replaceState({}, '', '/today')
    window.history.pushState(SENTINEL, '', SAVED)
  })
  afterEach(() => {
    document.body.style.overflow = ''
    document.body.style.overscrollBehavior = ''
  })

  const renderSeeds = async () => {
    render(
      <BrowserRouter>
        <DismissRegistryProvider>
          <ToastProvider>
            <Routes>
              <Route path="/seeds" element={<Seeds />} />
              <Route path="/today" element={<div data-testid="today" />} />
              <Route path="/plantings/:id" element={<div data-testid="planting" />} />
              <Route path="/inventory/:id" element={<div data-testid="detail" />} />
            </Routes>
            <Probe />
          </ToastProvider>
        </DismissRegistryProvider>
      </BrowserRouter>,
    )
    await waitFor(() => expect(screen.getByTestId('saved-seeds-view')).toBeTruthy())
    expect(where()).toBe(SAVED)
  }

  it('"Saved from <planting>" opens the planting (44px), and Back returns to the same Saved seeds view', async () => {
    await renderSeeds()
    const dry = () => document.querySelector('[data-lot-id="lot-dry"]')
    await waitFor(() => expect(within(dry()).getByTestId('lot-source-plant')).toBeTruthy())
    const link = within(dry()).getByTestId('lot-source-plant')
    expect(link.tagName).toBe('A')
    expect(link.style.minHeight).toBe('44px')
    await act(async () => { fireEvent.click(link) })
    await settle()
    expect(where()).toBe('/plantings/pl-gongbao')
    await back()
    expect(where()).toBe(SAVED)
    await waitFor(() => expect(screen.getByTestId('saved-seeds-view')).toBeTruthy())
    expect(atFloor()).toBe(true)
  })

  it('Start → opens its sheet armed: Back closes it and stays on Saved seeds', async () => {
    await renderSeeds()
    await waitFor(() => expect(section()).toBeTruthy())
    await act(async () => { fireEvent.click(within(section()).getByTestId('start-lot')) })
    await settle()
    expect(screen.getByTestId('start-process-step')).toBeTruthy()
    expect(armed(), 'the start sheet did not arm Back').toBe(true)
    await back()
    expect(screen.queryByTestId('start-process-step')).toBeNull()
    expect(where()).toBe(SAVED)
    expect(atFloor()).toBe(true)
  })
})

// The fixture's day anchor, held to the two one-hour windows where a 48-hour offset lands on the wrong
// Eastern date. Only Date is faked (the page's timers stay real), and the row is built AFTER the clock is
// pinned, so the fixture helper runs at the pinned instant exactly as the module-level rows run at the real one.
describe('"added N days ago" is right inside both DST windows (pinned clock)', () => {
  afterEach(() => vi.useRealTimers())

  it.each([
    ['00:30 EDT on the Monday after spring-forward', '2027-03-15T04:30:00Z', '3 days'],
    ['23:30 EST on the Monday after fall-back', '2026-11-03T04:30:00Z', '1 day'],
  ])('%s', async (_when, instant, fortyEightHoursReads) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(instant))
    // The window is real at this instant: 48 hours back is the wrong calendar day here.
    expect(elapsedLabel(new Date(Date.now() - 2 * DAY).toISOString())).toBe(fortyEightHoursReads)
    await mountPage([PRODUCE_ROW()])
    const card = document.querySelector('[data-lot-id="lot-stand"]')
    expect(within(card).getByTestId('lot-unstarted-line').textContent).toBe('Not started · added 2 days ago')
  })
})
