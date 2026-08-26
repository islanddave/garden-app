// BUG-TIERLESSPHOTOS-001 — Today's care rows serve the THUMBNAIL, not the original.
//
// CareNeeded's enrichment used to read `thumb: pl.featured_photo_view_url` — a field named thumb
// holding the full ORIGINAL, painted into a 30 CSS-px box (79 device px at dpr 2.625) on the
// post-login landing route, on a list that runs to ~200 rows. /api/plants signs the thumbs/
// companion on the SAME row and it was never read.
//
// THE THUMB IS A HINT, which is why the degrade is the load-bearing half of this file. The server
// derives thumbs/<storage_path> by CONVENTION and presigning never touches S3, so thumb_url is a
// non-empty string whether or not the object exists (BUG-PHOTONEWTHUMB-001): 181 of 1094 live rows
// (16.5%) 404 it. A naive swap would hand those rows a BROKEN IMAGE where they previously had a
// large-but-working one — strictly worse. Correctness therefore lives in the fallback: the row must
// land on featured_photo_view_url, which came down in the SAME list response, so recovery costs one
// 404 and zero extra round-trips.
//
// WHAT THIS CANNOT CATCH: jsdom never loads an image. These tests prove which URL was requested and
// how the chain advanced — never that a picture appeared, and never how many bytes moved. The byte
// measurement is a real-Chrome run, reported in _perfdesign_20260826/phototier-report.md.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, act, fireEvent, cleanup } from '@testing-library/react'

const { fetchMock, toastMock, getTokenMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
  getTokenMock: vi.fn(async () => 'tok'),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: getTokenMock }) }))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => toastMock }))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({
  ...(await orig()),
  fetchNotificationPrefs: vi.fn(async () => null),
  saveTodaySkipped: vi.fn(async () => null),
}))

import CareNeeded from '../components/today/CareNeeded.jsx'
import { __resetPhotoImgCache } from '../components/PhotoImg.jsx'

const FULL = 'https://s3.example.invalid/plants/p1/a.jpg?sig=full'
const THUMB = 'https://s3.example.invalid/thumbs/plants/p1/a.jpg?sig=thumb'
const MINTED = 'https://s3.example.invalid/plants/p1/a.jpg?sig=fresh'

const plan = () => ({
  hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10 },
  rain_skipped: [],
  water_due: [{ id: 'p1', name: 'Bhut Jolokia', crop: 'pepper', project: 'Peppers', project_id: 'prP', overdue_by: 3, in_ground: false }],
  no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
})

// The shape /api/plants actually returns (lambda/plants featuredPhotoUrls signs both, additively).
const withThumb = () => ({
  id: 'p1', location_id: null, container_type: 'pot',
  featured_photo_id: 'ph1', featured_photo_view_url: FULL, featured_photo_thumb_url: THUMB,
})
// The shape it returns when the thumbs/ object is absent is IDENTICAL — that is the bug this file
// guards. The only pre-deploy state where the FIELD itself is missing is an older Lambda; the SPA
// ships independently of the 26-Lambda matrix, so that is a real production state too.
const noThumbField = () => { const { featured_photo_thumb_url: _drop, ...rest } = withThumb(); return rest }

const plantsReturning = (rows) => fetchMock.mockImplementation((path) => {
  if (path === '/api/plants') return Promise.resolve(rows)
  if (path === '/api/locations/with-path') return Promise.resolve([])
  return Promise.resolve({ id: 'ev-new' })
})

// The row thumb is the only <img> CareNeeded renders.
const rowImg = (c) => c.querySelector('img')
const src = (c) => rowImg(c)?.getAttribute('src') ?? null
const viewUrlCalls = () => fetchMock.mock.calls.filter(c => String(c[0]).includes('/api/photos/view-url/'))

// Enrichment lands only after BOTH /api/plants and /api/locations/with-path settle, so every case
// has to wait for the thumb rather than assert on the first paint.
async function renderWithPhoto(rows) {
  plantsReturning(rows)
  const view = render(<CareNeeded plan={plan()} />)
  await waitFor(() => expect(rowImg(view.container)).toBeTruthy())
  return view
}

beforeEach(() => {
  fetchMock.mockReset(); toastMock.show.mockReset(); toastMock.showUndo.mockReset()
  __resetPhotoImgCache()
  localStorage.clear(); sessionStorage.clear()
  cleanup()
})

describe('the Today care row paints the thumbnail', () => {
  it('renders featured_photo_thumb_url, not the featured ORIGINAL', async () => {
    const { container } = await renderWithPhoto([withThumb()])
    expect(src(container)).toBe(THUMB)
  })

  it('costs no extra network: the thumb came down on the same /api/plants row', async () => {
    const { container } = await renderWithPhoto([withThumb()])
    expect(src(container)).toBe(THUMB)
    await act(async () => {})
    expect(viewUrlCalls()).toHaveLength(0)
  })
})

describe('a 404-ing thumb still shows a photo (16.5% of live rows)', () => {
  // THE test of this lane. A blank photo is a far worse outcome than a slow one, so the failure
  // mode a naive `thumb_url ||` swap would ship — terminal blank on 181 live rows — must be
  // impossible here. Asserting the src SWAPPED (not merely that no error escaped) is what makes
  // this non-vacuous: a component that rendered nothing would also throw nothing.
  it('the first load error swaps in featured_photo_view_url with NO network round-trip', async () => {
    const { container } = await renderWithPhoto([withThumb()])
    expect(src(container)).toBe(THUMB)
    fireEvent.error(rowImg(container))
    await waitFor(() => expect(src(container)).toBe(FULL))
    expect(rowImg(container)).toBeTruthy()          // an <img>, not PhotoImg's terminal placeholder
    expect(viewUrlCalls()).toHaveLength(0)          // the degrade target was already in hand
  })

  it('after degrading, the row still self-heals — on the PHOTO id, never the planting id', async () => {
    const { container } = await renderWithPhoto([withThumb()])
    fireEvent.error(rowImg(container))              // thumb 404 → degrade, no mint
    await waitFor(() => expect(src(container)).toBe(FULL))
    expect(viewUrlCalls()).toHaveLength(0)
    fetchMock.mockImplementation((path) =>
      String(path).includes('/api/photos/view-url/') ? Promise.resolve({ view_url: MINTED }) : Promise.resolve([]))
    fireEvent.error(rowImg(container))              // original presign expired → reactive heal
    await waitFor(() => expect(src(container)).toBe(MINTED))
    // p1 is the PLANTING, ph1 is the PHOTO. Minting the planting id 404s → permanent blank on expiry.
    expect(String(viewUrlCalls()[0][0])).toBe('/api/photos/view-url/ph1')
  })

  it('a row from a pre-deploy Lambda (no thumb FIELD) renders the original directly', async () => {
    const { container } = await renderWithPhoto([noThumbField()])
    expect(src(container)).toBe(FULL)
    await act(async () => {})
    expect(viewUrlCalls()).toHaveLength(0)
  })

  it('a planting with no featured photo renders no <img> at all, not a broken one', async () => {
    plantsReturning([{ id: 'p1', location_id: null, container_type: 'pot', featured_photo_view_url: null }])
    const { container, findByText } = render(<CareNeeded plan={plan()} />)
    await findByText('Bhut Jolokia')
    await act(async () => {})
    expect(container.querySelector('img')).toBeNull()
  })
})
