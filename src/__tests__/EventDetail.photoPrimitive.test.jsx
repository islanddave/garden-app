// V4-PHOTOIDARM-001 — EventDetail's photo block is on <PhotoView>, the mandated primitive.
//
// This surface is WHY the id-only arm exists: GET /api/events/:id serves { id, storage_path,
// cover_for } and no URL, so the block originally shipped on PutUpPhotoThumb — an allow-listed raw
// <PhotoImg> wrapper — because the primitive could not express that shape. Three properties are
// pinned here, all of them decisions rather than incidental behaviour:
//   1. the id resolves through the app's ONE signed-URL path;
//   2. a thumb that has not resolved yet RESERVES its box instead of collapsing — the thumb lives
//      inside a labelled "Open photo N of M" button, and 'none' would leave an invisible tappable
//      hole and a photo count that disagrees with what is on screen;
//   3. the event row is handed to PhotoView UNMODIFIED, so the day the events Lambda starts
//      presigning, the URL wins and NO mint fires — with no change to this call site. That is the
//      fallback-not-override contract, asserted at the surface rather than only at the unit.
//
// No jest-dom (L-182) — plain DOM assertions. Mock shape mirrors EventDetail.rich.test.jsx.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { apiFetchSpy, dataRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  dataRef: { event: null, viewUrl: null },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))

import EventDetail from '../pages/EventDetail.jsx'
import { __resetPhotoImgCache } from '../components/PhotoImg.jsx'

// Exactly what lambda/events/eventPhotos.js SELECTs today — id, storage_path, cover_for. No URLs.
const PHOTOS = [
  { id: 'ph-1', storage_path: 'events/e1/a.jpg', cover_for: [] },
  { id: 'ph-2', storage_path: 'events/e1/b.jpg', cover_for: [] },
]

const EVENT = {
  id: 'e1', project_id: null, plant_id: 'g1', event_type: 'observation',
  event_date: '2026-08-01T12:00:00.000Z', title: 'Morning walk',
  notes: null, private_notes: null, quantity: null, is_public: true,
  metadata: null, flagged_as_issue: false, severity: null, resolved_at: null,
  planting_name: null, harvest: null, photos: PHOTOS,
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  __resetPhotoImgCache()
  dataRef.event = { ...EVENT }
  dataRef.viewUrl = (id) => Promise.resolve({ view_url: `https://example.test/${id}.jpg` })
  apiFetchSpy.mockImplementation((path) => {
    if (path === '/api/events/e1') return Promise.resolve(dataRef.event)
    if (path.startsWith('/api/photos/view-url/')) return dataRef.viewUrl(path.split('/').pop())
    return Promise.resolve(null)
  })
})

async function renderDetail() {
  render(
    <MemoryRouter initialEntries={['/events/e1']}>
      <Routes><Route path="/events/:eventId" element={<EventDetail />} /></Routes>
    </MemoryRouter>,
  )
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/events/e1'))
  await act(async () => { await Promise.resolve() })
}

const thumbButtons = () => screen.getAllByRole('button', { name: /^Open photo/ })

describe('EventDetail photos — the id-only arm on the real surface', () => {
  it('resolves every id-only photo through GET /api/photos/view-url/:id and renders it', async () => {
    await renderDetail()
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/photos/view-url/ph-1', { cache: 'no-store' }))
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/photos/view-url/ph-2', { cache: 'no-store' }))
    await waitFor(() => {
      const srcs = thumbButtons().map(b => b.querySelector('img')?.getAttribute('src'))
      expect(srcs).toEqual(['https://example.test/ph-1.jpg', 'https://example.test/ph-2.jpg'])
    })
  })

  it('RESERVES each thumb box while the mint is in flight — never an empty tappable hole', async () => {
    dataRef.viewUrl = () => new Promise(() => {})          // never resolves: hold the pending state
    await renderDetail()
    const buttons = thumbButtons()
    expect(buttons.length).toBe(2)
    for (const b of buttons) {
      expect(b.querySelector('img')).toBeNull()             // nothing loaded yet
      const box = b.firstElementChild
      expect(box, 'a pending thumb must render a placeholder, not nothing').not.toBeNull()
      expect(box.tagName).toBe('DIV')
      expect(box.style.width).toBe('96px')                  // the consumer's box, so no reflow on land
      expect(box.style.height).toBe('96px')
    }
  })

  it('labels an unresolvable photo instead of vanishing (a silent gap reads as "no photo")', async () => {
    dataRef.viewUrl = () => { const e = new Error('gone'); e.status = 404; return Promise.reject(e) }
    await renderDetail()
    await waitFor(() => {
      const box = thumbButtons()[0].firstElementChild
      expect(box.getAttribute('role')).toBe('img')
    })
    expect(thumbButtons()[0].firstElementChild.getAttribute('aria-label')).toBe('Photo 1 of 2 on this event')
  })

  it('FORWARD-COMPAT: if the events GET ever presigns, the URL wins and NO mint fires', async () => {
    dataRef.event = {
      ...EVENT,
      photos: PHOTOS.map((p, i) => ({ ...p, view_url: `https://s3.test/server-${i + 1}.jpg` })),
    }
    await renderDetail()
    await waitFor(() => expect(thumbButtons()[0].querySelector('img')).not.toBeNull())
    expect(thumbButtons().map(b => b.querySelector('img').getAttribute('src')))
      .toEqual(['https://s3.test/server-1.jpg', 'https://s3.test/server-2.jpg'])
    expect(apiFetchSpy.mock.calls.filter(([p]) => String(p).startsWith('/api/photos/view-url/')).length).toBe(0)
  })
})
