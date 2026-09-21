// BUG-SEEDLISTSIGNING-001 — the seed list carries each lot's packet photo as an ID, and My seeds mints a
// thumb URL for the rows it actually draws, with the REAL PhotoView and PhotoImg (MySeeds.test.jsx
// replaces PhotoView with a probe, so it can say what a card ASKS for but not what goes over the wire).
//
// v4.140.0 had the Lambda sign a view and a thumb URL for all ~330 rows on every load, and the list got
// several times slower. The saving only holds if the phone does not quietly spend it back: a folded
// group mints nothing, an open one mints one THUMB per drawn row (never the multi-MB original), and a
// lot with no photo mints nothing and keeps its sprout box.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent, cleanup, within } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
  isFromCache: () => false,
}))

import { MemoryRouter } from 'react-router-dom'
import MySeeds from '../pages/MySeeds.jsx'
import { useSeedItems } from '../hooks/useSeedItems.js'
import { ToastProvider } from '../context/ToastContext.jsx'
import { __resetPhotoImgCache } from '../components/PhotoImg.jsx'

const pepper = (id, hero) => ({
  id, name: `Pepper ${id}`, variety_name: `Pepper ${id}`, category: 'seeds', type: 'consumable', unit: 'packet',
  status: 'active', quantity_on_hand: 1, variety_id: `v-${id}`, crop_slug: 'pepper', seed_stage: null,
  seed_process: null, source_plant_id: null, source_kind: null, source_id: null, source: null,
  purchase_date: null, year_harvested: null, stage_entered_at: null, created_at: '2026-07-01T12:00:00Z',
  // The list's shape: the derived hero's id, no URL keys.
  hero_photo_id: hero, featured_photo_id: null,
  scoville_min: null, scoville_max: null, scoville_source: null, variety_source_url: null,
})
const ROWS = [pepper('a', 'ph-a'), pepper('b', 'ph-b'), pepper('c', null)]
const minted = (id, tier) => `https://photos.test/${tier === 'thumb' ? 'thumbs/' : ''}${id}.jpg?X-Amz-Signature=s`

const mintCalls = () => fetchSpy.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith('/api/photos/view-url/'))

beforeEach(() => {
  __resetPhotoImgCache()
  fetchSpy.mockReset()
  try { window.sessionStorage.clear() } catch { /* jsdom */ }
  fetchSpy.mockImplementation((path) => {
    const p = String(path)
    const m = p.match(/^\/api\/photos\/view-url\/([^?]+)(?:\?tier=(\w+))?$/)
    if (m) return Promise.resolve({ view_url: minted(m[1], m[2] ?? 'full'), expires_in: 900 })
    if (p.startsWith('/api/inventory-items?category=seeds')) return Promise.resolve(ROWS)
    if (p.startsWith('/api/varieties/crop-types')) return Promise.resolve([{ slug: 'pepper', display_name: 'Pepper' }])
    return Promise.resolve([])
  })
})
afterEach(() => cleanup())

function Host() {
  const store = useSeedItems()
  return <MySeeds store={store} />
}
const mount = async () => {
  await act(async () => { render(<MemoryRouter><ToastProvider><Host /></ToastProvider></MemoryRouter>) })
  await waitFor(() => expect(screen.getAllByTestId('facet-group-header').length).toBe(1))
}
const rowFor = (id) => document.querySelector(`[data-lot-id="${id}"]`)

describe('My seeds — packet thumbs are minted by id, for drawn rows only', () => {
  it('a folded group mints nothing', async () => {
    await mount()
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    expect(fetchSpy.mock.calls.some(([p]) => String(p).startsWith('/api/inventory-items?category=seeds'))).toBe(true)
    expect(mintCalls()).toEqual([])
  })

  it('an open group mints ONE thumb per drawn photo and renders it; a lot with no photo mints nothing', async () => {
    await mount()
    await act(async () => { fireEvent.click(screen.getByTestId('facet-group-header')) })
    await waitFor(() => {
      for (const id of ['a', 'b']) {
        const img = within(rowFor(id)).getByTestId('my-seed-photo')
        expect(img.tagName).toBe('IMG')
        expect(img.getAttribute('src')).toBe(minted(`ph-${id}`, 'thumb'))
      }
    })
    // The thumb tier by the PHOTO id, once each — never the original, never the lot id.
    expect(mintCalls().sort()).toEqual(['/api/photos/view-url/ph-a?tier=thumb', '/api/photos/view-url/ph-b?tier=thumb'])
    expect(within(rowFor('c')).queryByTestId('my-seed-photo')).toBeNull()
    expect(within(rowFor('c')).getByTestId('my-seed-thumb').querySelector('svg')).toBeTruthy()
  })
})
