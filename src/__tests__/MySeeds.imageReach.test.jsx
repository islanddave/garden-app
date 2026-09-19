// V5-SEEDCARDS-001 — a packet thumbnail mounts when ITS ROW comes near the viewport, and not before.
//
// The QA pre-promote review (review/qa-v4140.md, BLOCKING) measured the old window in jsdom with the REAL
// hook: a 60-row pepper group, scrolled to rows ~24-38, still had only the first 24 thumbnails; near the
// document bottom all 60 mounted at once. The old window grew on a DOCUMENT-bottom test, and My seeds' page
// never grows (every row is a fixed box), so it never grew until the bottom — then in one burst.
//
// This is that simulation with its expectations inverted. jsdom has no layout, so the page is imposed:
// window.scrollY, innerHeight and the document height (what the old window read), and every row's box by
// its place in the list (what reach reads). A row is 58px tall on a 66px pitch, the list starting at y400.
// Fails on the old window: rows on screen mid-group get no thumbnail, and the bottom mounts all 60.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, cleanup, waitFor } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
  isFromCache: () => false,
}))
vi.mock('../components/photo/PhotoView.jsx', () => ({
  default: ({ photo }) => <img data-testid="pv-probe" data-photo-id={photo?.id ?? ''} alt="" />,
}))

import { MemoryRouter } from 'react-router-dom'
import MySeeds from '../pages/MySeeds.jsx'
import { useSeedItems } from '../hooks/useSeedItems.js'
import { ToastProvider } from '../context/ToastContext.jsx'
import { IMAGE_WINDOW_PAGE } from '../hooks/useImageWindow.js'
import { REACH_PX } from '../hooks/useNearViewport.js'

const N = 60
const ROW_PX = 66, ROW_H = 58, LIST_TOP = 400, VH = 915
const DOC_H = LIST_TOP + N * ROW_PX + 600
const row = (n) => ({
  id: `r${n}`, name: `Pepper ${n}`, variety_name: `Pepper ${String(n).padStart(3, '0')}`, category: 'seeds', type: 'consumable',
  unit: 'packet', status: 'active', quantity_on_hand: 1, crop_slug: 'pepper', seed_stage: null, source_plant_id: null,
  source_kind: null, source_id: null, purchase_date: null, year_harvested: null, created_at: '2026-07-01T12:00:00Z',
  hero_photo_id: `ph${n}`, featured_photo_view_url: `https://x/${n}.jpg`, featured_photo_thumb_url: `https://x/t${n}.jpg`,
})

let scrollY = 0
const rowsInDom = () => [...document.querySelectorAll('[data-testid="my-seed-row"]')]
// Row i sits at LIST_TOP + i x ROW_PX in the document; everything else has no box.
const boxOf = (el) => {
  const i = el.getAttribute('data-testid') === 'my-seed-row' ? rowsInDom().indexOf(el) : -1
  const top = i < 0 ? 0 : LIST_TOP + i * ROW_PX - scrollY
  const h = i < 0 ? 0 : ROW_H
  return { top, bottom: top + h, height: h, left: 16, right: 344, width: i < 0 ? 0 : 328, x: 16, y: top, toJSON() {} }
}
let saved
beforeEach(() => {
  fetchSpy.mockReset()
  try { window.sessionStorage.clear() } catch { /* jsdom */ }
  fetchSpy.mockImplementation((path) => {
    const p = String(path)
    if (p.startsWith('/api/inventory-items?category=seeds')) return Promise.resolve(Array.from({ length: N }, (_, i) => row(i + 1)))
    if (p.startsWith('/api/varieties/crop-types')) return Promise.resolve([{ slug: 'pepper', display_name: 'Pepper' }])
    return Promise.resolve([])
  })
  scrollY = 0
  saved = {
    innerHeight: Object.getOwnPropertyDescriptor(window, 'innerHeight'),
    scrollY: Object.getOwnPropertyDescriptor(window, 'scrollY'),
    scrollHeight: Object.getOwnPropertyDescriptor(document.documentElement, 'scrollHeight'),
    scrollTo: Object.getOwnPropertyDescriptor(window, 'scrollTo'),
  }
  // Back-restore's tick scrolls to its target (0 on a fresh load); jsdom does not implement scrollTo, and
  // the imposed page must only ever move when the test scrolls it.
  window.scrollTo = () => {}
  Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => VH })
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY })
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: () => DOC_H })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function stub() { return boxOf(this) })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  for (const [k, d] of Object.entries(saved)) {
    const target = k === 'scrollHeight' ? document.documentElement : window
    if (d) Object.defineProperty(target, k, d); else delete target[k]
  }
})

function Host() {
  const store = useSeedItems()
  return <MySeeds store={store} />
}
// Which rows (0-based, list order) carry a thumbnail now.
const mounted = () => rowsInDom().flatMap((r, i) => (r.querySelector('[data-testid="pv-probe"]') ? [i] : []))
// A scroll, then two animation frames' worth of time for the page to read its rows and re-render.
const scrollTo = async (y) => {
  scrollY = y
  await act(async () => {
    window.dispatchEvent(new Event('scroll'))
    await new Promise((r) => setTimeout(r, 60))
  })
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 60)) })
// Rows whose box is within `px` of the viewport at the current scroll.
const within = (px) => Array.from({ length: N }, (_, i) => i).filter((i) => {
  const top = LIST_TOP + i * ROW_PX - scrollY
  return top + ROW_H > -px && top < VH + px
})
const openPepper = async () => {
  await act(async () => { render(<MemoryRouter><ToastProvider><Host /></ToastProvider></MemoryRouter>) })
  await act(async () => { fireEvent.click(await screen.findByTestId('facet-group-header')) })
  await waitFor(() => expect(rowsInDom().length).toBe(N))
  await settle()
}

describe('My seeds — a thumbnail mounts when its row comes near the viewport', () => {
  it('scrolled into the middle of an open group, every row on screen has its thumbnail', async () => {
    await openPepper()
    await scrollTo(1600)   // rows 19-32 on screen; the document ends 2045px below the viewport
    const onScreen = within(0)
    expect(onScreen.some((i) => i >= IMAGE_WINDOW_PAGE)).toBe(true)
    expect(DOC_H - (scrollY + VH)).toBeGreaterThan(800)
    const have = new Set(mounted())
    expect(onScreen.filter((i) => !have.has(i))).toEqual([])
  })

  it('bounded: nothing mounts beyond reach — the first page plus what is within reach, never the whole group', async () => {
    await openPepper()
    await scrollTo(1600)
    const inReach = new Set(within(REACH_PX))
    const m = mounted()
    expect(m.length).toBeLessThanOrEqual(IMAGE_WINDOW_PAGE + inReach.size)
    expect(m.filter((i) => i >= IMAGE_WINDOW_PAGE && !inReach.has(i))).toEqual([])
    expect(m.length).toBeLessThan(N)
  })

  it('reaching the bottom mounts only the rows in reach there — no burst of the whole group', async () => {
    await openPepper()
    await scrollTo(DOC_H - VH - 100)
    const inReach = new Set(within(REACH_PX))
    const m = mounted()
    // Rows past the first page that were never near the viewport stay unmounted.
    const skipped = Array.from({ length: N }, (_, i) => i).filter((i) => i >= IMAGE_WINDOW_PAGE && !inReach.has(i))
    expect(skipped.length).toBeGreaterThan(0)
    expect(m.filter((i) => skipped.includes(i))).toEqual([])
    expect(m.length).toBeLessThan(N)
  })

  it('a row that was in reach keeps its thumbnail when the page scrolls away from it', async () => {
    await openPepper()
    await scrollTo(1600)
    const reached = within(0)
    await scrollTo(0)
    const have = new Set(mounted())
    expect(reached.filter((i) => !have.has(i))).toEqual([])
  })

  it('a filter change starts over from what is in reach now (the kept thumbnails far away go)', async () => {
    await openPepper()
    await scrollTo(1600)
    await scrollTo(0)
    const far = mounted().filter((i) => i >= IMAGE_WINDOW_PAGE && !within(REACH_PX).includes(i))
    expect(far.length).toBeGreaterThan(0)
    // A search every row still matches: the same rows stay, the filter signature changes.
    await act(async () => { fireEvent.change(screen.getByTestId('my-seeds-search'), { target: { value: 'Pepper' } }) })
    await settle()
    expect(rowsInDom().length).toBe(N)
    const now = new Set(mounted())
    expect(far.filter((i) => now.has(i))).toEqual([])
  })

  it('a fold change starts over too: fold the group and open it again, far rows go', async () => {
    await openPepper()
    await scrollTo(1600)
    await scrollTo(0)
    const far = mounted().filter((i) => i >= IMAGE_WINDOW_PAGE && !within(REACH_PX).includes(i))
    expect(far.length).toBeGreaterThan(0)
    const header = screen.getByTestId('facet-group-header')
    await act(async () => { fireEvent.click(header) })
    await act(async () => { fireEvent.click(header) })
    await waitFor(() => expect(rowsInDom().length).toBe(N))
    await settle()
    const now = new Set(mounted())
    expect(far.filter((i) => now.has(i))).toEqual([])
  })
})
