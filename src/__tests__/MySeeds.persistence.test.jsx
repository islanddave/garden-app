// V5-SEEDCARDS-001 — the RESTORE half of My seeds' fold state (UX spec §3.5), which the QA pre-promote
// review found unpinned: the existing test asserts the WRITE of openGroups, and restores under an active
// supplier filter, which opens every group anyway — so openness after remount proved nothing.
//   (a) The groups a user OPENED ride the per-visit filter blob (sessionStorage seeds.mine.filters.v1): a
//       remount with NO filter must reopen exactly those.
//   (b) Explicit CLOSES, the expanded card and the Sowed-previously choice ride the history entry
//       (useScrollRestore's saveState): Back to the page must bring back all three.
//
// HARNESS for (b): a REAL BrowserRouter over jsdom history (Seeds.savedBackNav.test.jsx's convention;
// MemoryRouter never touches window.history, so a Back-restore would pass vacuously), the Seeds shell at
// /seeds?view=mine as Dave reaches it, and "Open details →" as the way out. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup, within } from '@testing-library/react'
import { BrowserRouter, MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'

const flags = { DISMISS_REGISTRY_ENABLED: true, BACKNAV_ENABLED: true }
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  get DISMISS_REGISTRY_ENABLED() { return flags.DISMISS_REGISTRY_ENABLED },
  get BACKNAV_ENABLED() { return flags.BACKNAV_ENABLED },
}))

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
  isFromCache: (v) => !!v && typeof v === 'object' && v[Symbol.for('garden-app.fromCache')] === true,
}))
vi.mock('../components/photo/PhotoView.jsx', () => ({ default: () => <img data-testid="pv-probe" alt="" /> }))

import Seeds from '../pages/Seeds.jsx'
import MySeeds from '../pages/MySeeds.jsx'
import { useSeedItems } from '../hooks/useSeedItems.js'
import { ToastProvider } from '../context/ToastContext.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'

const FILTER_KEY = 'seeds.mine.filters.v1'
const pkt = (over = {}) => ({
  id: 'p', name: 'Sungold', variety_name: 'Sungold', category: 'seeds', type: 'consumable', unit: 'packet',
  status: 'active', quantity_on_hand: 1, variety_id: 'v', crop_slug: 'tomato', seed_stage: null, seed_process: null,
  source_plant_id: null, source_kind: null, source_id: null, source: null, purchase_date: null, year_harvested: null,
  stage_entered_at: null, seed_count: null, seed_weight_g: null, seed_count_estimated: null, sow_archived_season: null,
  created_at: '2026-07-01T12:00:00Z', hero_photo_id: null, featured_photo_id: null, featured_photo_view_url: null,
  featured_photo_thumb_url: null, scoville_min: null, scoville_max: null, scoville_source: null, source_url: null,
  variety_source_url: null,
  ...over,
})
// Two tomatoes (one a used-up packet, filed under Sowed previously) and a pepper. The search "o" matches
// Sungold, Gong Bao and the used-up "Old Packet" — so it opens BOTH crop groups and Sowed previously by
// rule, and every choice asserted below is a choice AGAINST that rule, which only a restore can bring back.
const ROWS = [
  pkt({ id: 't1', name: 'Sungold', variety_name: 'Sungold' }),
  pkt({ id: 't2', name: 'Brandywine', variety_name: 'Brandywine' }),
  pkt({ id: 'p1', name: 'Gong Bao', variety_name: 'Gong Bao', crop_slug: 'pepper' }),
  pkt({ id: 'e1', name: 'Old Packet', variety_name: 'Old Packet', quantity_on_hand: 0 }),
]

beforeEach(() => {
  flags.DISMISS_REGISTRY_ENABLED = true
  flags.BACKNAV_ENABLED = true
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((p, opts) => {
    if (opts?.method) return Promise.resolve({ ok: true })
    const path = String(p)
    if (path.startsWith('/api/inventory-items?category=seeds')) return Promise.resolve(ROWS)
    if (path.startsWith('/api/varieties/crop-types')) return Promise.resolve([{ slug: 'tomato', display_name: 'Tomato' }, { slug: 'pepper', display_name: 'Pepper' }])
    return Promise.resolve([])
  })
  try { window.sessionStorage.clear() } catch { /* jsdom */ }
})
afterEach(() => {
  cleanup()
  document.body.style.overflow = ''
  document.body.style.overscrollBehavior = ''
})

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)) })
const section = (slug) => document.querySelector(`[data-group-slug="${slug}"]`)
const header = (slug) => within(section(slug)).getByTestId('facet-group-header')
const rowFor = (id) => document.querySelector(`[data-lot-id="${id}"]`)

describe('My seeds — a remount reopens the groups the user opened (sessionStorage)', () => {
  function Host() {
    const store = useSeedItems()
    return <MySeeds store={store} />
  }
  it('with NO filter, the remembered Tomato is open and Pepper is folded', async () => {
    window.sessionStorage.setItem(FILTER_KEY, JSON.stringify({ q: '', crops: [], suppliers: [], sort: 'name', openGroups: ['tomato'] }))
    await act(async () => { render(<MemoryRouter><ToastProvider><Host /></ToastProvider></MemoryRouter>) })
    await waitFor(() => expect(section('pepper')).toBeTruthy())
    expect(screen.getByTestId('my-seeds-search').value).toBe('')
    expect(header('tomato').getAttribute('aria-expanded')).toBe('true')
    expect(header('pepper').getAttribute('aria-expanded')).toBe('false')
    expect(rowFor('t1')).toBeTruthy()
    expect(rowFor('p1')).toBeNull()
  })
})

describe('My seeds — Back restores the expanded card, a hand fold, and the Sowed-previously choice', () => {
  function Probe() {
    const loc = useLocation()
    return <span data-testid="path">{loc.pathname}</span>
  }
  function renderApp() {
    return render(
      <BrowserRouter>
        <DismissRegistryProvider>
          <ToastProvider>
            <Routes>
              <Route path="/seeds" element={<Seeds />} />
              <Route path="/inventory/:id" element={<div data-testid="detail" />} />
            </Routes>
            <Probe />
          </ToastProvider>
        </DismissRegistryProvider>
      </BrowserRouter>,
    )
  }
  // useScrollRestore hands back view state only with a scroll offset to restore (`armed`: y > 0), so the
  // page is scrolled — as it is when a thumb has gone down to a card. jsdom has no scrolling: the offset
  // is a variable the page reads through window.scrollY and moves through window.scrollTo.
  let y = 0, saved
  beforeEach(() => {
    y = 0
    saved = { scrollY: Object.getOwnPropertyDescriptor(window, 'scrollY'), scrollTo: Object.getOwnPropertyDescriptor(window, 'scrollTo') }
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y })
    Object.defineProperty(window, 'scrollTo', { configurable: true, writable: true, value: (a, b) => { y = typeof a === 'object' ? a.top ?? y : b } })
  })
  afterEach(() => {
    for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(window, k, d); else delete window[k] }
  })

  it('leave through "Open details →", come Back: all three are as the user left them', async () => {
    window.history.replaceState({}, '', '/seeds?view=mine')
    renderApp()
    await waitFor(() => expect(section('pepper')).toBeTruthy())
    // The search opens every group it matches, and Sowed previously, by rule.
    await act(async () => { fireEvent.change(screen.getByTestId('my-seeds-search'), { target: { value: 'o' } }) })
    await waitFor(() => expect(header('tomato').getAttribute('aria-expanded')).toBe('true'))
    const sowedHeader = () => within(screen.getByTestId('my-seeds-sowed')).getByTestId('facet-group-header')
    expect(sowedHeader().getAttribute('aria-expanded')).toBe('true')
    // Down the page a way, then three choices against the rule: fold Tomato, fold Sowed previously,
    // expand Gong Bao's card.
    await act(async () => { y = 300; window.dispatchEvent(new Event('scroll')) })
    await act(async () => { fireEvent.click(header('tomato')) })
    await act(async () => { fireEvent.click(sowedHeader()) })
    await act(async () => { fireEvent.click(within(rowFor('p1')).getByRole('button', { expanded: false })) })
    expect(header('tomato').getAttribute('aria-expanded')).toBe('false')
    expect(sowedHeader().getAttribute('aria-expanded')).toBe('false')
    expect(within(rowFor('p1')).getByTestId('my-seed-expanded')).toBeTruthy()
    await settle()
    // Away, through the expanded card's own link, then Back.
    await act(async () => { fireEvent.click(within(rowFor('p1')).getByTestId('my-seed-details')) })
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/inventory/p1'))
    expect(screen.queryByTestId('my-seeds-view')).toBeNull()
    act(() => { window.history.back() })
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/seeds'))
    await waitFor(() => expect(section('pepper')).toBeTruthy())
    await settle()
    // The search came back with the visit (sessionStorage), so the rule would open all of it again —
    expect(screen.getByTestId('my-seeds-search').value).toBe('o')
    expect(header('pepper').getAttribute('aria-expanded')).toBe('true')
    // — and each choice the user made against it is restored from the history entry.
    expect(header('tomato').getAttribute('aria-expanded')).toBe('false')
    expect(rowFor('t1')).toBeNull()
    expect(sowedHeader().getAttribute('aria-expanded')).toBe('false')
    expect(rowFor('e1')).toBeNull()
    expect(within(rowFor('p1')).getByTestId('my-seed-expanded')).toBeTruthy()
  })
})
