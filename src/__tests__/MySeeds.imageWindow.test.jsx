// V5-SEEDCARDS-001 — My seeds windows its THUMBNAILS, not its rows. Every card stays in the DOM (search,
// counts, the outline and Back-restore need them), but only the first page of on-screen cards mounts a
// PhotoView: 103 peppers opening at once is the eager-image freeze (BUG-PHOTOTHUMB-001). The first page
// is IMAGE_WINDOW_PAGE, mocked here to 2; jsdom has no layout, so no row is ever within reach of the
// viewport and the page alone decides. What mounts as rows come near the viewport is
// MySeeds.imageReach.test.jsx's. Mutation: render a PhotoView for every row -> red.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent, cleanup } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
  isFromCache: () => false,
}))
vi.mock('../components/photo/PhotoView.jsx', () => ({
  default: ({ photo }) => <img data-testid="pv-probe" data-photo-id={photo?.id ?? ''} alt="" />,
}))
vi.mock('../hooks/useImageWindow.js', () => ({
  default: (total) => ({ shown: 2, showMore: () => {}, hasMore: total > 2, remaining: Math.max(0, total - 2) }),
  IMAGE_WINDOW_PAGE: 2,
}))

import { MemoryRouter } from 'react-router-dom'
import MySeeds from '../pages/MySeeds.jsx'
import { useSeedItems } from '../hooks/useSeedItems.js'
import { ToastProvider } from '../context/ToastContext.jsx'

const row = (n) => ({
  id: `r${n}`, name: `Pepper ${n}`, variety_name: `Pepper ${String(n).padStart(2, '0')}`, category: 'seeds', type: 'consumable',
  unit: 'packet', status: 'active', quantity_on_hand: 1, crop_slug: 'pepper', seed_stage: null, source_plant_id: null,
  source_kind: null, source_id: null, purchase_date: null, year_harvested: null, created_at: '2026-07-01T12:00:00Z',
  hero_photo_id: `ph${n}`, featured_photo_view_url: `https://x/${n}.jpg`, featured_photo_thumb_url: `https://x/t${n}.jpg`,
})

beforeEach(() => {
  fetchSpy.mockReset()
  try { window.sessionStorage.clear() } catch { /* jsdom */ }
  fetchSpy.mockImplementation((path) => {
    const p = String(path)
    if (p.startsWith('/api/inventory-items?category=seeds')) return Promise.resolve([1, 2, 3, 4, 5].map(row))
    if (p.startsWith('/api/varieties/crop-types')) return Promise.resolve([{ slug: 'pepper', display_name: 'Pepper' }])
    return Promise.resolve([])
  })
})
afterEach(() => cleanup())

function Host() {
  const store = useSeedItems()
  return <MySeeds store={store} />
}

describe('My seeds — the image window', () => {
  it('every card renders, but only the first page of on-screen cards mounts a thumbnail', async () => {
    await act(async () => { render(<MemoryRouter><ToastProvider><Host /></ToastProvider></MemoryRouter>) })
    const header = await screen.findByTestId('facet-group-header')
    await act(async () => { fireEvent.click(header) })
    await waitFor(() => expect(screen.getAllByTestId('my-seed-row').length).toBe(5))
    const probes = screen.getAllByTestId('pv-probe').map((p) => p.getAttribute('data-photo-id'))
    expect(probes).toEqual(['ph1', 'ph2'])
    // The rest keep their reserved 40x40 box, waiting on the photo-tile fill.
    const rest = screen.getAllByTestId('my-seed-thumb').slice(2)
    expect(rest).toHaveLength(3)
    for (const box of rest) expect(box.querySelector('img')).toBeNull()
  })
})
