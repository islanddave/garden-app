// V5-SEEDLOTADDITION-001 (seed release 3) — the planting page after seed went into one of its lots
// (contract T19). The page stays where it is, reads the plant's lots a second time, and the lot's row
// shows the new count without a reload. Both flags are held on by ONE static mock;
// PlantingDetail.seedLots.test.jsx has none and keeps pinning the section itself. No jest-dom (L-182).
// Also: the sheet closed while an add had no definite answer. The page reads the lots again then too,
// so the row says what the lot holds whichever way the add went.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()), SEED_MULTI_PARENT: true, SEED_ADD_TO_LOT: true,
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
vi.mock('../lib/uxEvents.js', () => ({
  FLOWS: { OPEN_PLANTING: 'open_planting' },
  useUxFlow: () => ({ step: vi.fn(), tap: vi.fn(), complete: vi.fn(), reset: vi.fn() }),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => null }))
vi.mock('../lib/harvestWindows.js', () => import('./helpers/harvestWindowsSyncStub.js'))

import PlantingDetail from '../pages/PlantingDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { additionReply, plantSeedLot, plantSeedLotsReply } from './fixtures/seedMix.fixture.js'

const LOT = plantSeedLot({ name: 'Cinderella — saved 2026', variety_name: 'Cinderella', seed_count: 120, seed_count_estimated: false, seed_weight_g: null })
const PLANTING = {
  id: 'pl1', name: 'Cinderella #2', project_id: 'proj1', project_name: 'Pumpkins',
  status: 'growing', quantity: 1, variety_id: 'v-cind',
  variety_ref: { id: 'v-cind', name: 'Cinderella', crop_type_slug: 'pumpkin' },
  featured_photo_view_url: null,
}
const SEED_LOTS_PATH = '/api/plants/pl1/seed-lots'
const paths = (test) => apiFetchSpy.mock.calls.filter(([p, o]) => test(String(p), o ?? {}))
const lotReads = () => paths((p) => p === SEED_LOTS_PATH).length
const eventReads = () => paths((p, o) => p.startsWith('/api/events') && !p.startsWith('/api/events/') && o.method == null).length

beforeEach(() => {
  apiFetchSpy.mockReset()
  window.scrollTo = vi.fn()
  let lots = [LOT]
  apiFetchSpy.mockImplementation((path, opts = {}) => {
    const p = String(path)
    if (p === SEED_LOTS_PATH) return Promise.resolve(plantSeedLotsReply({ plant_id: 'pl1', seed_lots: lots }))
    if (opts.method === 'POST' && p === `/api/inventory-items/${LOT.id}/seed-additions`) {
      // The server's own arithmetic: the lot the next read returns is the one this answer describes.
      lots = [{ ...LOT, seed_count: 150 }]
      return Promise.resolve(additionReply({ id: LOT.id, name: LOT.name, seed_count: 150, seed_count_estimated: false, addition: { plant_was_added: false } }))
    }
    if (opts.method === 'POST' && p === '/api/events') return Promise.resolve({ id: 'ev-new' })
    if (p.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
    if (p.startsWith('/api/harvests')) return Promise.resolve({ entries: [] })
    if (p.startsWith('/api/preservation/whats-put-up')) return Promise.resolve({ groups: [] })
    if (p.startsWith('/api/events/harvest-summary')) return Promise.resolve({ rows: [], unattributed: [] })
    if (p.startsWith('/api/events')) return Promise.resolve([])
    return Promise.resolve(null)
  })
})

// `Outer` is the registry that asks before a close, for the case that needs the question asked.
const mount = (Outer = React.Fragment) => render(
  <Outer>
    <ToastProvider>
      <MemoryRouter initialEntries={['/projects/proj1/plantings/pl1']}>
        <Routes>
          <Route path="/projects/:id/plantings/:plantingId" element={<PlantingDetail />} />
          <Route path="*" element={<div data-testid="left-the-page" />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  </Outer>,
)

describe('PlantingDetail — after "Put it in <lot>" (V5-SEEDLOTADDITION-001)', () => {
  it('names the plant\'s one open lot on the link, adds to it, stays on the page, and the row shows the new count', async () => {
    mount()
    await waitFor(() => expect(screen.getByText(/Drying · 120 seeds/)).toBeTruthy())
    expect(lotReads()).toBe(1)
    const eventsBefore = eventReads()

    await act(async () => { fireEvent.click(screen.getByTestId('save-seed-open')) })
    // The page's own read fed the link: named, with no request of the sheet's own.
    expect(screen.getByTestId('save-seed-put-in-lot').textContent).toBe(`Put it in ${LOT.name}Drying · 120 seeds`)
    await act(async () => { fireEvent.click(screen.getByTestId('save-seed-put-in-lot')) })
    fireEvent.change(screen.getByTestId('seed-add-count'), { target: { value: '30' } })
    expect(screen.getByTestId('seed-add-outcome').textContent).toBe('The lot will say 150 seeds (120 now and 30 today).')
    await act(async () => { fireEvent.click(screen.getByTestId('save-seed-submit')) })

    // The sheet is gone and the page is the same page.
    await waitFor(() => expect(screen.queryByTestId('seed-add-form')).toBeNull())
    expect(screen.queryByTestId('left-the-page')).toBeNull()
    expect(screen.getByText(`Added to ${LOT.name}`)).toBeTruthy()
    // A second read of the lots, and its answer is on the row.
    await waitFor(() => expect(lotReads()).toBe(2))
    await waitFor(() => expect(screen.getByText(/Drying · 150 seeds/)).toBeTruthy())
    expect(screen.queryByText(/Drying · 120 seeds/)).toBeNull()
    // The timeline is asked again too: the addition's entry is on it.
    await waitFor(() => expect(eventReads()).toBeGreaterThan(eventsBefore))
    expect(paths((p, o) => o.method === 'POST' && p === '/api/events').length).toBe(1)
    expect(paths((p) => p.startsWith('/api/inventory-items/seed-lots-open')).length).toBe(0)
  })

  it('a second read that fails leaves the rows as they were, never "couldn\'t check"', async () => {
    mount()
    await waitFor(() => expect(screen.getByText(/Drying · 120 seeds/)).toBeTruthy())
    const base = apiFetchSpy.getMockImplementation()
    let reads = 0
    apiFetchSpy.mockImplementation((path, opts) => {
      if (String(path) === SEED_LOTS_PATH) { reads += 1; return Promise.reject(new Error('boom')) }
      return base(path, opts)
    })
    await act(async () => { fireEvent.click(screen.getByTestId('save-seed-open')) })
    await act(async () => { fireEvent.click(screen.getByTestId('save-seed-put-in-lot')) })
    await act(async () => { fireEvent.click(screen.getByTestId('save-seed-submit')) })
    await waitFor(() => expect(reads).toBe(1))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText(/Drying · 120 seeds/)).toBeTruthy()
    expect(screen.queryByText(/Couldn.t check for seed saved/)).toBeNull()
  })

  it('closed while an add had no definite answer: the lots are read again, and the row shows what the lot holds', async () => {
    // The first POST lands on the server and its reply is lost; the automatic second try is lost too.
    const base = apiFetchSpy.getMockImplementation()
    let posts = 0
    apiFetchSpy.mockImplementation((path, opts = {}) => {
      if (opts.method === 'POST' && String(path) === `/api/inventory-items/${LOT.id}/seed-additions`) {
        posts += 1
        if (posts === 1) base(path, opts)
        return Promise.reject(Object.assign(new Error('Request timed out'), { status: 0, timeout: true }))
      }
      return base(path, opts)
    })
    mount(DismissRegistryProvider)
    await waitFor(() => expect(screen.getByText(/Drying · 120 seeds/)).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId('save-seed-open')) })
    await act(async () => { fireEvent.click(screen.getByTestId('save-seed-put-in-lot')) })
    fireEvent.change(screen.getByTestId('seed-add-count'), { target: { value: '30' } })
    await act(async () => { fireEvent.click(screen.getByTestId('save-seed-submit')) })
    await waitFor(() => expect(screen.getByTestId('seed-add-retry')).toBeTruthy())
    expect(posts).toBe(2)
    expect(lotReads()).toBe(1)

    // Asked, and kept open: nothing is read.
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(screen.getByTestId('confirm-sheet-title').textContent).toBe('Close without checking?')
    await act(async () => { fireEvent.click(screen.getByTestId('confirm-sheet-cancel')) })
    expect(screen.getByTestId('seed-add-retry')).toBeTruthy()
    expect(lotReads()).toBe(1)

    // Asked again, and closed: the sheet goes, the page stays, the lots are read a second time.
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    await act(async () => { fireEvent.click(screen.getByTestId('confirm-sheet-confirm')) })
    await waitFor(() => expect(screen.queryByTestId('seed-add-form')).toBeNull())
    expect(screen.queryByTestId('left-the-page')).toBeNull()
    await waitFor(() => expect(lotReads()).toBe(2))
    await waitFor(() => expect(screen.getByText(/Drying · 150 seeds/)).toBeTruthy())
    expect(screen.queryByText(/Drying · 120 seeds/)).toBeNull()
    // Nothing said it was added, and no timeline entry was written for an add nobody saw land.
    expect(screen.queryByText(`Added to ${LOT.name}`)).toBeNull()
    expect(paths((p, o) => o.method === 'POST' && p === '/api/events').length).toBe(0)
    expect(posts).toBe(2)
  })
})
