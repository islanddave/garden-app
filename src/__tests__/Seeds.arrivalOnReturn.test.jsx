// BUG-DETAILPAGESCARRYSCROLL-001 (rimpact-scrollmanager IMPORTANT-5) — the `?lot=` arrival hint must not
// fire on a RETURN the app-level page-scroll manager restores.
//
// A door that names a lot (`/seeds?view=saved&lot=…`) outlines it once and scrolls it into view on
// arrival. On a Back to that entry the view skipped the hint only when its own useScrollRestore had
// restored a position; when the MANAGER is the one restoring — a POP arrival the hook had no value for
// (the first session after a deploy, an entry past the hook's 20-entry store) — the smooth, centred
// scrollIntoView fired on Back and fought the manager's hold. Both Seeds views now also skip it when
// the page tree arrived by POP (usePageScrollReturnAtMount). Pinned here through the REAL Seeds shell,
// which is what turns `?lot=` into the arrival highlight, for both views.
//
// No jest-dom (L-182). Shell mocks as in Seeds.test.jsx.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, cleanup } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
  isFromCache: () => false,
}))
vi.mock('../components/planting/SaveSeedSheet.jsx', () => ({ default: () => null, SeedCountBasis: () => null }))

import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Seeds from '../pages/Seeds.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { PageScrollProvider } from '../hooks/usePageScrollManager.js'

const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString()
const lot = (over = {}) => ({
  id: 'lot-x', name: 'Brandywine — saved 2026', variety_name: 'Brandywine', category: 'seeds',
  type: 'consumable', unit: 'packet', status: 'active', quantity_on_hand: 1, variety_id: 'v-b',
  crop_slug: 'tomato', seed_stage: null, seed_process: null, source_plant_id: null, source_kind: null,
  source_id: null, stage_entered_at: null, seed_count: null, seed_weight_g: null, created_at: '2026-07-01T12:00:00Z',
  ...over,
})
const STORED = lot({ id: 'lot-stored', seed_stage: 'stored', seed_process: 'wet', stage_entered_at: daysAgo(20) })
const OTHER = lot({ id: 'lot-other', name: 'Sungold — saved 2026', variety_name: 'Sungold', seed_stage: 'stored', seed_process: 'wet', stage_entered_at: daysAgo(30) })

let scrolled
beforeEach(() => {
  scrolled = []
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    if (opts?.method) return Promise.resolve({ ok: true })
    if (p.startsWith('/api/inventory-items?category=seeds')) return Promise.resolve([OTHER, STORED])
    if (p.startsWith('/api/inventory-items/sow-candidates')) return Promise.resolve({ items: [] })
    return Promise.resolve([])
  })
  Element.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this.getAttribute('data-lot-id')) }
})
afterEach(() => {
  cleanup()
  delete Element.prototype.scrollIntoView
})

// `popped`: the manager's provider reports the page tree arrived by POP (Back, a reload, a tab restore).
const open = async (url, { popped }) => {
  await act(async () => {
    render(
      <PageScrollProvider value={{ api: null, isReturn: popped }}>
        <MemoryRouter initialEntries={[url]}>
          <ToastProvider>
            <Routes><Route path="/seeds" element={<Seeds />} /></Routes>
          </ToastProvider>
        </MemoryRouter>
      </PageScrollProvider>,
    )
  })
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)) })

describe.each([
  ['Saved seeds', 'saved', 'saved-seeds-view'],
  ['My seeds', 'mine', 'my-seeds-view'],
])('%s — the ?lot= arrival hint', (_name, view, viewTestId) => {
  it('a door (a push) brings the lot into view once', async () => {
    await open(`/seeds?view=${view}&lot=lot-stored`, { popped: false })
    await waitFor(() => expect(screen.getByTestId(viewTestId)).toBeTruthy())
    await waitFor(() => expect(scrolled).toEqual(['lot-stored']))
  })

  it('a return the manager restores (a POP arrival) leaves the page where the manager puts it: no scrollIntoView', async () => {
    await open(`/seeds?view=${view}&lot=lot-stored`, { popped: true })
    await waitFor(() => expect(screen.getByTestId(viewTestId)).toBeTruthy())
    await waitFor(() => expect(document.querySelector('[data-lot-id="lot-stored"]')).toBeTruthy())
    await settle()
    expect(scrolled).toEqual([])
  })
})
