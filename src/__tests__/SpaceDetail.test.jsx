// SpaceDetail.test.jsx — V4-SPACEPHOTO-001 Lane C. The Space's identity surface.
//
// The page component itself is flag-free (App.jsx owns the gate), so these render it directly;
// SpacePhotos.flagOff.test.jsx owns the inertness half. No jest-dom (L-182): assert via roles +
// text + attributes + toBe/toBeTruthy/toBeNull.
//
// The load-bearing assertions here are the ones that pin behavior LocationDetail gets wrong:
// a failed hero read must NOT read as "no photos", the gallery must be an EXACT space_id read
// (never the recursive ?location_id= subtree walk that leaks descendant-zone photos), and the
// gallery must be the canonical PhotosWall renderer rather than a fourth hand-rolled grid.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchSpy, toastSpy, paramsRef, uploadProps, wallThrows } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  toastSpy: { show: vi.fn() },
  paramsRef: { current: { spaceId: 'space-1' } },
  uploadProps: { current: null },
  wallThrows: { current: false },
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: () => Promise.resolve('t') }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig()),
  useParams: () => paramsRef.current,
  useNavigate: () => vi.fn(),
}))
vi.mock('../context/ToastContext.jsx', () => ({
  useOptionalToast: () => toastSpy,
  useToast: () => toastSpy,
}))
vi.mock('../components/PhotoUpload.jsx', () => ({
  default: (props) => {
    uploadProps.current = props
    return <div data-testid="photo-upload-stub" />
  },
}))
// Real PhotosWall by default (the gallery assertions exercise it end to end); a per-test switch
// makes it throw so the surrounding ErrorBoundary can be proven to catch.
vi.mock('../components/PhotosWall.jsx', async (orig) => {
  const actual = await orig()
  return {
    default: (props) => {
      if (wallThrows.current) throw new Error('gallery boom')
      return React.createElement(actual.default, props)
    },
  }
})

import SpaceDetail from '../pages/SpaceDetail.jsx'
import { __resetPhotoImgCache } from '../components/PhotoImg.jsx'

// The shipped hero contract: featured_photo_id is the EFFECTIVE hero, and featured_is_explicit
// (always present, both forms) says whether it came from spaces.featured_photo_id or from the
// server's newest-photo fallback. household_space_count rides along on the id-free form only.
const HERO = {
  space_id: 'space-1',
  name: 'Gardens at Mathews Ridge',
  featured_photo_id: 'ph1',
  featured_is_explicit: true,
  featured_photo_view_url: 'https://s3.test/hero.jpg',
}
// A space whose hero is the server's FALLBACK: the id points at a real photo, but nothing is
// persisted in spaces.featured_photo_id.
const HERO_IMPLICIT = { ...HERO, featured_is_explicit: false }
// A space with no photos at all.
const HERO_EMPTY = { ...HERO, featured_photo_id: null, featured_is_explicit: false, featured_photo_view_url: null }
// The zero-space 200: a body, but nothing in it. NOT a 404 and never rendered as an error.
const HERO_NONE = {
  space_id: null, name: null, featured_photo_id: null,
  featured_is_explicit: false, featured_photo_view_url: null, household_space_count: 0,
}
const PHOTOS = [
  { id: 'ph1', view_url: 'https://s3.test/1.jpg', caption: 'Wide shot', created_at: '2026-06-20T12:00:00Z' },
  { id: 'ph2', view_url: 'https://s3.test/2.jpg', caption: 'Dawn',      created_at: '2026-06-02T08:00:00Z' },
]

// Route the two independent reads (hero + gallery) by path, so neither test depends on call order.
function primeFetch({ hero = HERO, photos = PHOTOS, heroError = null } = {}) {
  fetchSpy.mockImplementation((path) => {
    // Matches BOTH hero forms — the by-id one and the id-free discovery one.
    if (path.startsWith('/api/photos/space-hero')) {
      return heroError ? Promise.reject(heroError) : Promise.resolve(hero)
    }
    if (path.startsWith('/api/photos?space_id=')) return Promise.resolve(photos)
    if (path.startsWith('/api/photos/view-url/')) return Promise.resolve({ view_url: 'https://s3.test/fresh.jpg' })
    return Promise.resolve(null)
  })
}

async function renderPage(opts) {
  primeFetch(opts)
  let utils
  await act(async () => { utils = render(<SpaceDetail />) })
  return utils
}

beforeEach(() => {
  document.body.innerHTML = ''
  fetchSpy.mockReset()
  toastSpy.show.mockReset()
  paramsRef.current = { spaceId: 'space-1' }
  uploadProps.current = null
  wallThrows.current = false
  __resetPhotoImgCache()
})
afterEach(() => { vi.restoreAllMocks() })

describe('SpaceDetail — hero', () => {
  it('reads the space hero and renders the space NAME as the page h1', async () => {
    await renderPage()
    expect(fetchSpy).toHaveBeenCalledWith('/api/photos/space-hero/space-1', expect.anything())
    const h1 = document.querySelector('h1')
    expect(h1.textContent).toBe('Gardens at Mathews Ridge')
  })

  it('renders the hero image through PhotoImg (self-heal wired), not a bare <img>', async () => {
    const { container } = await renderPage()
    const img = container.querySelector('img')
    expect(img.getAttribute('src')).toBe('https://s3.test/hero.jpg')
    // PhotoImg's re-mint is the proof it is not a bare <img>: an error re-presigns via view-url.
    await act(async () => { fireEvent.error(img) })
    await waitFor(() => expect(container.querySelector('img').getAttribute('src')).toBe('https://s3.test/fresh.jpg'))
    expect(fetchSpy).toHaveBeenCalledWith('/api/photos/view-url/ph1', { cache: 'no-store' })
  })

  it('uses the shared PhotoHero shell — both scrims and the floating Back/Share are present', async () => {
    const { container } = await renderPage()
    const scrims = [...container.querySelectorAll('div')].filter(d =>
      d.style.pointerEvents === 'none' && d.style.background.includes('linear-gradient'))
    expect(scrims.length).toBe(2)
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Share / })).toBeTruthy()
  })

  it('carries NO planting chrome (no status picker, no favorite) — the shell is tier-agnostic', async () => {
    await renderPage()
    expect(screen.queryByTestId('status-picker')).toBeNull()
    expect(screen.queryByRole('button', { name: /favorite/i })).toBeNull()
  })

  it('a hero with no feature photo shows a real prompt, not a blank box', async () => {
    await renderPage({ hero: HERO_EMPTY, photos: [] })
    expect(screen.getByText('No feature photo yet')).toBeTruthy()
    expect(screen.getByText(/Add a wide shot below/)).toBeTruthy()
  })

  it('a FAILED hero read surfaces an error with Retry — never a silent "no photo" state', async () => {
    const err = Object.assign(new Error('boom'), { status: 500 })
    await renderPage({ heroError: err })
    // The anti-LocationDetail assertion: a failed fetch must be distinguishable from empty.
    expect(screen.queryByText('No feature photo yet')).toBeNull()
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Couldn’t load this space')
    const retry = screen.getByRole('button', { name: 'Retry' })
    fetchSpy.mockClear()
    primeFetch()
    await act(async () => { fireEvent.click(retry) })
    await waitFor(() => expect(document.querySelector('h1').textContent).toBe('Gardens at Mathews Ridge'))
  })

  it('a 404 on the by-id form reads as "not there" and fires no gallery/upload surface at it', async () => {
    const err = Object.assign(new Error('Not found'), { status: 404 })
    await renderPage({ heroError: err })
    expect(screen.getByRole('alert').textContent).toContain('That space isn’t there')
    // The id names a space that is unknown or not ours, so the whole acting surface is withheld:
    // no upload control and no wall aimed at it. (The gallery read itself may already be in flight
    // — with a route param it deliberately starts in PARALLEL with the hero rather than waiting on
    // it; it is scoped by created_by server-side, so a doomed one costs a round trip and nothing
    // else.) The error + Retry is the entire surface.
    expect(screen.queryByTestId('photo-upload-stub')).toBeNull()
    expect(screen.queryByTestId('space-photo-wall')).toBeNull()
    expect(screen.queryByTestId('space-gallery-empty')).toBeNull()
  })

  it('passes an AbortSignal and aborts it on unmount (fast navigation cannot clobber the hero)', async () => {
    const { unmount } = await renderPage()
    const call = fetchSpy.mock.calls.find(c => String(c[0]).startsWith('/api/photos/space-hero'))
    const signal = call[1].signal
    expect(typeof signal.aborted).toBe('boolean')
    expect(signal.aborted).toBe(false)
    unmount()
    expect(signal.aborted).toBe(true)
  })
})

describe('SpaceDetail — gallery', () => {
  it('reads the EXACT space_id gallery, never the recursive ?location_id= subtree', async () => {
    await renderPage()
    await waitFor(() => expect(fetchSpy.mock.calls.some(c => c[0] === '/api/photos?space_id=space-1')).toBe(true))
    expect(fetchSpy.mock.calls.some(c => String(c[0]).includes('location_id='))).toBe(false)
  })

  it('is the canonical PhotosWall renderer (month sections + Lightbox), not a fourth grid', async () => {
    await renderPage()
    await waitFor(() => expect(screen.getByTestId('space-photo-wall')).toBeTruthy())
    expect(screen.getByText('June 2026')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open photo 1' })) })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('an empty gallery renders a real empty state, not a blank area under the heading', async () => {
    await renderPage({ photos: [] })
    await waitFor(() => expect(screen.getByTestId('space-gallery-empty')).toBeTruthy())
    expect(screen.getByText(/No photos of Gardens at Mathews Ridge yet/)).toBeTruthy()
  })

  it('a gallery render fault is caught by its own ErrorBoundary — the hero survives', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    wallThrows.current = true
    await renderPage()
    // Hero still rendered → the boundary is around the gallery, not the page.
    expect(document.querySelector('h1').textContent).toBe('Gardens at Mathews Ridge')
    expect(screen.getByText('Couldn’t show these photos')).toBeTruthy()
  })

  it('the upload control attaches to the SPACE via linkage, with a policy-legal key prefix', async () => {
    await renderPage()
    expect(uploadProps.current.linkage).toEqual({ space_id: 'space-1' })
    // UPLOAD_KEY_PREFIXES has no 'spaces' entry — a spaces/<id>/… key 403s server-side.
    expect(uploadProps.current.keyPrefix).toBe('standalone')
  })
})

describe('SpaceDetail — set as feature photo (PlantingDetail control grammar)', () => {
  async function renderWithGallery(opts) {
    const utils = await renderPage(opts)
    await waitFor(() => expect(screen.getByTestId('space-photo-wall')).toBeTruthy())
    return utils
  }

  it('PUTs the space-featured endpoint with { photo_id } and confirms with an ambient toast', async () => {
    await renderWithGallery({ hero: HERO_EMPTY })
    const buttons = screen.getAllByRole('button', { name: /^Set as feature photo/ })
    expect(buttons.length).toBe(2)
    await act(async () => { fireEvent.click(buttons[0]) })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/photos/space-featured/space-1', {
      method: 'PUT', body: JSON.stringify({ photo_id: 'ph1' }),
    }))
    expect(toastSpy.show).toHaveBeenCalledWith({ message: 'Featured photo updated', tone: 'success' })
  })

  it('no-op guard: an EXPLICIT hero shows ★ Featured and offers no set control', async () => {
    await renderWithGallery()   // HERO: ph1, featured_is_explicit true
    expect(screen.getByText('★ Featured')).toBeTruthy()
    const buttons = screen.getAllByRole('button', { name: /^Set as feature photo/ })
    expect(buttons.length).toBe(1)   // only ph2 is settable
    fetchSpy.mockClear()
    await act(async () => { fireEvent.click(buttons[0]) })
    // ph2 IS a legal change, so exactly one PUT — never a PUT for the already-pinned ph1.
    const puts = fetchSpy.mock.calls.filter(c => String(c[0]).includes('/space-featured/'))
    expect(puts.length).toBe(1)
    expect(puts[0][1].body).toBe(JSON.stringify({ photo_id: 'ph2' }))
  })

  // ─── THE REGRESSION THIS WHOLE CONTRACT CHANGE EXISTS TO PREVENT ────────────────────────────
  // spaces.featured_photo_id is NULL (or points at a soft-deleted / out-of-household photo), so
  // the server returns its newest-photo FALLBACK as featured_photo_id. The ids therefore MATCH
  // while nothing is persisted. A bare `photo.id === featured_photo_id` guard swallows the tap:
  // no PUT, no write, and the hero silently reverts the moment a newer photo is uploaded.
  describe('silently-reverting case — ids match but featured_is_explicit is FALSE', () => {
    it('still shows a live set control on the fallback hero, NOT a static ★ Featured', async () => {
      await renderWithGallery({ hero: HERO_IMPLICIT })   // effective hero is ph1, unpinned
      expect(screen.queryByText('★ Featured')).toBeNull()
      // BOTH photos are settable — including ph1, the one already on display.
      expect(screen.getAllByRole('button', { name: /^Set as feature photo/ }).length).toBe(2)
    })

    it('ISSUES the PUT for the matching id — the designation gets persisted', async () => {
      await renderWithGallery({ hero: HERO_IMPLICIT })
      fetchSpy.mockClear()
      const buttons = screen.getAllByRole('button', { name: /^Set as feature photo/ })
      await act(async () => { fireEvent.click(buttons[0]) })   // ph1 === featured_photo_id
      await waitFor(() => {
        const puts = fetchSpy.mock.calls.filter(c => String(c[0]).includes('/space-featured/'))
        expect(puts.length).toBe(1)
        expect(puts[0][0]).toBe('/api/photos/space-featured/space-1')
        expect(puts[0][1].body).toBe(JSON.stringify({ photo_id: 'ph1' }))
      })
      expect(toastSpy.show).toHaveBeenCalledWith({ message: 'Featured photo updated', tone: 'success' })
    })

    it('the successful PUT makes it EXPLICIT locally, so it no-ops from then on', async () => {
      await renderWithGallery({ hero: HERO_IMPLICIT })
      const buttons = screen.getAllByRole('button', { name: /^Set as feature photo/ })
      await act(async () => { fireEvent.click(buttons[0]) })
      await waitFor(() => expect(screen.getByText('★ Featured')).toBeTruthy())
      fetchSpy.mockClear()
      // Only ph2 remains settable; a second tap on ph1 is now genuinely a no-op.
      const after = screen.getAllByRole('button', { name: /^Set as feature photo/ })
      expect(after.length).toBe(1)
      expect(fetchSpy.mock.calls.filter(c => String(c[0]).includes('/space-featured/')).length).toBe(0)
    })
  })

  it('in-flight lock: every set control is disabled while one request is outstanding', async () => {
    let release
    fetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/photos/space-hero')) return Promise.resolve(HERO_EMPTY)
      if (path.startsWith('/api/photos?space_id=')) return Promise.resolve(PHOTOS)
      if (path.includes('/space-featured/')) return new Promise((res) => { release = res })
      return Promise.resolve(null)
    })
    await act(async () => { render(<SpaceDetail />) })
    await waitFor(() => expect(screen.getByTestId('space-photo-wall')).toBeTruthy())
    const buttons = screen.getAllByRole('button', { name: /^Set as feature photo/ })
    await act(async () => { fireEvent.click(buttons[0]) })
    const during = screen.getAllByRole('button', { name: /^Set as feature photo/ })
    expect(during.every(b => b.disabled)).toBe(true)
    expect(screen.getByText('Setting…')).toBeTruthy()
    await act(async () => { release({ featured_photo_id: 'ph1' }); await Promise.resolve() })
    await waitFor(() => expect(screen.getByText('★ Featured')).toBeTruthy())
  })

  it('a failed set surfaces an error toast and releases the lock', async () => {
    await renderWithGallery({ hero: HERO_EMPTY })
    fetchSpy.mockImplementation((path) => {
      if (path.includes('/space-featured/')) return Promise.reject(Object.assign(new Error('nope'), { status: 400 }))
      return Promise.resolve(null)
    })
    const buttons = screen.getAllByRole('button', { name: /^Set as feature photo/ })
    await act(async () => { fireEvent.click(buttons[0]) })
    await waitFor(() => expect(toastSpy.show).toHaveBeenCalledWith({ message: "Couldn't set featured photo", tone: 'error' }))
    const after = screen.getAllByRole('button', { name: /^Set as feature photo/ })
    expect(after.some(b => b.disabled)).toBe(false)
  })
})

describe('SpaceDetail — discovery (no route param)', () => {
  beforeEach(() => { paramsRef.current = {} })

  it('reads the ID-FREE hero form and never constructs /space-hero/undefined', async () => {
    await renderPage()
    expect(fetchSpy).toHaveBeenCalledWith('/api/photos/space-hero', expect.anything())
    expect(fetchSpy.mock.calls.some(c => String(c[0]).includes('undefined'))).toBe(false)
    expect(fetchSpy.mock.calls.some(c => String(c[0]) === '/api/photos/space-hero/undefined')).toBe(false)
  })

  it('feeds the RESOLVED space_id to the gallery, the upload linkage and the featured PUT', async () => {
    await renderPage()
    await waitFor(() => expect(fetchSpy.mock.calls.some(c => c[0] === '/api/photos?space_id=space-1')).toBe(true))
    expect(uploadProps.current.linkage).toEqual({ space_id: 'space-1' })
    const buttons = screen.getAllByRole('button', { name: /^Set as feature photo/ })
    await act(async () => { fireEvent.click(buttons[0]) })
    await waitFor(() => expect(fetchSpy.mock.calls.some(
      c => String(c[0]) === '/api/photos/space-featured/space-1')).toBe(true))
  })

  it('a route param still WINS over discovery (/space/:spaceId keeps working)', async () => {
    paramsRef.current = { spaceId: 'space-9' }
    await renderPage({ hero: { ...HERO, space_id: 'space-9' } })
    expect(fetchSpy).toHaveBeenCalledWith('/api/photos/space-hero/space-9', expect.anything())
    expect(fetchSpy.mock.calls.some(c => c[0] === '/api/photos/space-hero')).toBe(false)
  })
})

describe('SpaceDetail — zero spaces (200 with a null-valued body, NOT a 404)', () => {
  beforeEach(() => { paramsRef.current = {} })

  it('renders a first-class EMPTY state — status, not alert, and no retry', async () => {
    await renderPage({ hero: HERO_NONE })
    const none = screen.getByTestId('space-none')
    expect(none.getAttribute('role')).toBe('status')
    expect(none.textContent).toContain('No space yet')
    // The load-bearing distinction: an empty result must not read as a failure.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('Couldn’t load this space')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('issues NO downstream request — no gallery read, no upload control, no PUT surface', async () => {
    await renderPage({ hero: HERO_NONE })
    expect(fetchSpy.mock.calls.some(c => String(c[0]).includes('space_id='))).toBe(false)
    expect(fetchSpy.mock.calls.some(c => String(c[0]).includes('/space-featured/'))).toBe(false)
    expect(screen.queryByTestId('photo-upload-stub')).toBeNull()
    expect(screen.queryByTestId('space-photo-wall')).toBeNull()
  })

  it('a literal null body is treated identically (defensive: 204 / empty-JSON shapes)', async () => {
    await renderPage({ hero: null })
    expect(screen.getByTestId('space-none')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('SpaceDetail — more than one space is NOT an error', () => {
  it('renders the deterministically-picked space normally when household_space_count > 1', async () => {
    paramsRef.current = {}
    await renderPage({ hero: { ...HERO, household_space_count: 3 } })
    expect(document.querySelector('h1').textContent).toBe('Gardens at Mathews Ridge')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByTestId('space-none')).toBeNull()
    await waitFor(() => expect(fetchSpy.mock.calls.some(c => c[0] === '/api/photos?space_id=space-1')).toBe(true))
  })
})

// V4-SPACECLIENTGAP-001 Stage 2 — the client flip's page-level wiring.
describe('SpaceDetail — an upload refreshes the HERO, not just the gallery', () => {
  it('re-reads the hero after an upload so an empty space stops showing HeroEmpty', async () => {
    // The first upload to an empty space is the case that matters: the POST path calls
    // autoPromoteFeatured, which fills a NULL spaces.featured_photo_id, so the server has a hero
    // the instant that upload lands. Bumping only galleryTick left the page rendering "No feature
    // photo yet" over a space that HAD one, until a remount.
    // Mutation: drop setHeroTick from onUploadComplete and this reds.
    await renderPage({ hero: HERO_EMPTY, photos: [] })
    expect(screen.getByText('No feature photo yet')).toBeTruthy()

    const heroReadsBefore = fetchSpy.mock.calls.filter(c => String(c[0]).startsWith('/api/photos/space-hero')).length
    // The space now has a hero server-side, as it would immediately after an upload.
    primeFetch({ hero: HERO, photos: PHOTOS })
    await act(async () => { uploadProps.current.onUploadComplete() })

    const heroReadsAfter = fetchSpy.mock.calls.filter(c => String(c[0]).startsWith('/api/photos/space-hero')).length
    expect(heroReadsAfter, 'the hero must be re-read').toBeGreaterThan(heroReadsBefore)
    await waitFor(() => expect(screen.queryByText('No feature photo yet')).toBeNull())
  })
})

describe('SpaceDetail — the batch attach entry point', () => {
  it('offers "Add existing photos" once a space is resolved', async () => {
    // Until this shipped there was no way for an existing photo to acquire a space_id at all —
    // the attach route was live in prod with no client able to invoke it.
    await renderPage()
    expect(screen.getByTestId('space-attach-open')).toBeTruthy()
  })

  it('does NOT offer it when no space resolved — every PUT it makes is keyed on the id', async () => {
    // No route param AND a zero-space body: a route param would legitimately WIN over the null
    // hero (that is resolveSpaceId's contract), so it must be cleared to reach the empty state.
    paramsRef.current = {}
    await renderPage({ hero: HERO_NONE })
    expect(screen.queryByTestId('space-attach-open')).toBeNull()
  })

  it('opens the picker as a labelled modal dialog', async () => {
    await renderPage()
    await act(async () => { fireEvent.click(screen.getByTestId('space-attach-open')) })
    const dlg = await screen.findByRole('dialog')
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    expect(dlg.getAttribute('aria-label')).toContain('Gardens at Mathews Ridge')
  })
})

describe('SpaceDetail — FeaturedControl is a real tap target', () => {
  it('the set-featured button clears the 44px floor', async () => {
    // It was a 0.7rem borderless text button with padding: 0 — a ~14px hit box under a photo tile
    // in a 3-up grid, i.e. exactly the thumb-reach target that most needs the floor. The frozen
    // token is T.buttonMinHeight: 48 (formStyles.js:28).
    await renderPage({ hero: HERO_IMPLICIT, photos: PHOTOS })
    // Every non-featured tile carries one, so assert the floor on ALL of them — a per-tile style
    // regression on one branch would otherwise hide behind a passing first match.
    const btns = await screen.findAllByRole('button', { name: /Set as feature photo/ })
    expect(btns.length).toBeGreaterThan(0)
    for (const btn of btns) expect(parseInt(btn.style.minHeight, 10)).toBeGreaterThanOrEqual(44)
  })
})
