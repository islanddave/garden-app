// V5-SEEDCARDS-001 — what the page does to the SCROLL when a folded crop group is tapped (UX spec §3.3).
// Opening: the header stays put; the page scrolls only when the group's first row would be cut by the
// bottom nav or less than a readable slice of its second row would show, and then by the least distance
// that shows both. Folding from a stuck header re-anchors it at the top bar.
//
// jsdom has no layout, so the geometry is STUBBED: getBoundingClientRect answers for a group's section
// and its rows by attribute, innerHeight is the phone's, and scrollBy is a spy. The first case is the
// gate:seeds-page (e2) geometry at 360x640, measured — the old rule ("row 2's BOTTOM above innerHeight
// - 64") scrolled it 24px and moved the header the thumb had just tapped. Red against that rule: all
// three opening cases (no scroll at (e2); 96px not 138 near the bottom; 44px not 52 for a one-row group).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent, cleanup, within } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
  isFromCache: () => false,
}))
vi.mock('../components/photo/PhotoView.jsx', () => ({
  default: () => <img data-testid="pv-probe" alt="" />,
}))

import { MemoryRouter } from 'react-router-dom'
import MySeeds from '../pages/MySeeds.jsx'
import { useSeedItems } from '../hooks/useSeedItems.js'
import { ToastProvider } from '../context/ToastContext.jsx'
import { BOTTOM_NAV_HEIGHT_PX } from '../lib/constants.js'

const packet = (id, name, crop) => ({
  id, name, variety_name: name, category: 'seeds', type: 'consumable', unit: 'packet', status: 'active',
  quantity_on_hand: 1, crop_slug: crop, seed_stage: null, source_plant_id: null, source_kind: null,
  source_id: null, purchase_date: null, year_harvested: null, created_at: '2026-07-01T12:00:00Z',
})
// Pepper holds three rows, A→Z (p1 first, p2 second); Tomato holds one.
const ROWS = [
  packet('p1', 'Aji Charapita', 'pepper'), packet('p2', 'Biquinho', 'pepper'), packet('p3', 'Carolina Reaper', 'pepper'),
  packet('t1', 'Sungold', 'tomato'),
]

// The stubbed page, in viewport px: where each group's section starts and where each row sits.
let geo
const rect = (top, bottom) => ({ top, bottom, height: bottom - top, left: 16, right: 344, width: 328, x: 16, y: top, toJSON() {} })
const ZERO = rect(0, 0)
let realInnerHeight, realScrollBy, realMatchMedia
let reduced = false
beforeEach(() => {
  fetchSpy.mockReset()
  try { window.sessionStorage.clear() } catch { /* jsdom */ }
  fetchSpy.mockImplementation((path) => {
    const p = String(path)
    if (p.startsWith('/api/inventory-items?category=seeds')) return Promise.resolve(ROWS)
    if (p.startsWith('/api/varieties/crop-types')) return Promise.resolve([{ slug: 'pepper', display_name: 'Pepper' }, { slug: 'tomato', display_name: 'Tomato' }])
    return Promise.resolve([])
  })
  geo = null
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function stub() {
    if (!geo) return ZERO
    const slug = this.getAttribute('data-group-slug')
    if (slug != null && geo.sections[slug] != null) return rect(geo.sections[slug], geo.sections[slug] + 400)
    const lot = this.getAttribute('data-lot-id')
    if (lot && geo.rows[lot]) return rect(...geo.rows[lot])
    return ZERO
  })
  realInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
  Object.defineProperty(window, 'innerHeight', { value: 640, configurable: true, writable: true })
  realScrollBy = window.scrollBy
  window.scrollBy = vi.fn()
  realMatchMedia = window.matchMedia
  reduced = false
  window.matchMedia = (q) => ({ matches: reduced && /prefers-reduced-motion: reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {} })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  if (realInnerHeight) Object.defineProperty(window, 'innerHeight', realInnerHeight)
  window.scrollBy = realScrollBy
  window.matchMedia = realMatchMedia
})

function Host() {
  const store = useSeedItems()
  return <MySeeds store={store} />
}
const mount = async () => {
  await act(async () => { render(<MemoryRouter><ToastProvider><Host /></ToastProvider></MemoryRouter>) })
  await waitFor(() => expect(document.querySelector('[data-group-slug="tomato"]')).toBeTruthy())
}
const header = (slug) => within(document.querySelector(`[data-group-slug="${slug}"]`)).getByTestId('facet-group-header')
const tap = async (slug) => { await act(async () => { fireEvent.click(header(slug)) }) }
const rowIds = (slug) => [...document.querySelectorAll(`[data-group-slug="${slug}"] [data-testid="my-seed-row"]`)].map((r) => r.getAttribute('data-lot-id'))

describe('My seeds — opening a folded group keeps the header still', () => {
  it('the band ends at the bottom nav: 584px of a 640px phone, the number every case below is about', () => {
    expect(640 - BOTTOM_NAV_HEIGHT_PX).toBe(584)
  })

  it('does NOT scroll when row 1 is whole and 24px+ of row 2 shows — gate (e2) at 360x640, measured', async () => {
    await mount()
    // Header y424-468; row 1 y476-534.1, whole above the nav's y584; row 2 from y542.1, 41.9px of it showing.
    geo = { sections: { pepper: 424 }, rows: { p1: [476, 534.1], p2: [542.1, 600.2], p3: [608.2, 666.3] } }
    await tap('pepper')
    expect(header('pepper').getAttribute('aria-expanded')).toBe('true')
    expect(rowIds('pepper')).toEqual(['p1', 'p2', 'p3'])
    expect(window.scrollBy).not.toHaveBeenCalled()
  })

  it('near the bottom it scrolls the LEAST distance that shows row 1 whole and 24px of row 2', async () => {
    await mount()
    // Header y540-584, right on the nav: row 1 y590-648, 64px under it; row 2 from y656.
    geo = { sections: { pepper: 540 }, rows: { p1: [590, 648], p2: [656, 714], p3: [722, 780] } }
    await tap('pepper')
    // Row 2's top + 24 must reach y584: 656 + 24 - 584 = 96, which also clears row 1 (648 - 584 = 64).
    expect(window.scrollBy).toHaveBeenCalledTimes(1)
    expect(window.scrollBy).toHaveBeenCalledWith({ top: 96, behavior: 'smooth' })
  })

  it('a one-row group scrolls only as far as its row being whole', async () => {
    await mount()
    geo = { sections: { tomato: 520 }, rows: { t1: [570, 628] } }
    await tap('tomato')
    expect(rowIds('tomato')).toEqual(['t1'])
    expect(window.scrollBy).toHaveBeenCalledWith({ top: 44, behavior: 'smooth' })
  })

  it('under prefers-reduced-motion the same scroll is instant', async () => {
    reduced = true
    await mount()
    geo = { sections: { pepper: 540 }, rows: { p1: [590, 648], p2: [656, 714], p3: [722, 780] } }
    await tap('pepper')
    expect(window.scrollBy).toHaveBeenCalledWith({ top: 96, behavior: 'auto' })
  })
})

describe('My seeds — folding a group from its stuck header (unchanged)', () => {
  it('re-anchors the header at the top bar, instantly', async () => {
    await mount()
    geo = { sections: { pepper: 424 }, rows: { p1: [476, 534.1], p2: [542.1, 600.2], p3: [608.2, 666.3] } }
    await tap('pepper')
    window.scrollBy.mockClear()
    // Scrolled far down the open group: once folded, the section (now just its header) sits at y-900.
    geo = { sections: { pepper: -900 }, rows: {} }
    await tap('pepper')
    expect(header('pepper').getAttribute('aria-expanded')).toBe('false')
    expect(window.scrollBy).toHaveBeenCalledWith(0, -952)
  })
})
