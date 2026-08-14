// V4-PHOTOIDARM-001 — <PhotoView resolveById>, the id-only arm.
//
// The gap: GET /api/events/:id and preservation_log both hand the client a photo ID and no URL.
// PhotoView picks a source from photoModel's chain, so a URL-less row rendered `null` — the mandated
// primitive could not express the shape two live surfaces actually have, and both shipped on raw
// <PhotoImg> through the drift guard's allow-list. These tests pin BOTH halves of the fix:
//   (1) the arm resolves through the app's ONE signed-URL path (GET /api/photos/view-url/:id) and
//       has a defined answer for pending / deleted / transient-failure — an async arm that renders
//       nothing on failure would reproduce the exact class the ticket exists to close;
//   (2) NOTHING ELSE MOVED. The flag is opt-in and is a FALLBACK, never an override, so every
//       existing caller renders exactly as before. Those are the first describe block, deliberately
//       first: the regression risk here is larger than the feature.
//
// WHAT THIS CANNOT CATCH: jsdom never loads an image. It proves which URL was requested and which
// element was rendered — not that a picture appeared. Live-browser territory, as ever.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, act, fireEvent } from '@testing-library/react'
import React from 'react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: () => Promise.resolve('t') }),
}))

import PhotoView from '../components/photo/PhotoView.jsx'
import { __resetPhotoImgCache } from '../components/PhotoImg.jsx'
import { TIER } from '../lib/photoModel.js'

beforeEach(() => { fetchSpy.mockReset(); __resetPhotoImgCache() })

const FULL = 'https://s3.example.invalid/plants/P/a.jpg?sig=full'
const THUMB = 'https://s3.example.invalid/thumbs/plants/P/a.jpg?sig=thumb'
const MINTED = 'https://s3.example.invalid/minted.jpg?sig=fresh'
// The literal shape lambda/events/eventPhotos.js returns: id + storage_path + cover_for, no URLs.
const EVENT_ROW = { id: 'ph-1', storage_path: 'events/E/a.jpg', cover_for: [] }
const FULL_ROW = { id: 'p1', storage_path: 'plants/P/a.jpg', plant_id: 'x', view_url: FULL, thumb_url: THUMB }
const img = (c) => c.querySelector('img')

describe('no-regression — the flag is opt-in and is a fallback, never an override', () => {
  it('a URL-less row WITHOUT the flag still renders nothing, and makes ZERO network calls', async () => {
    const { container } = render(<PhotoView photo={EVENT_ROW} tier={TIER.THUMB} />)
    expect(container.firstChild).toBeNull()
    await act(async () => {})
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a row that HAS a url renders from it and never mints, even with the flag on', async () => {
    const { container } = render(<PhotoView photo={FULL_ROW} tier={TIER.FULL} resolveById />)
    expect(img(container).getAttribute('src')).toBe(FULL)
    await act(async () => {})
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('tier selection and the in-hand degrade are untouched by the flag', async () => {
    const { container } = render(<PhotoView photo={FULL_ROW} tier={TIER.THUMB} resolveById />)
    expect(img(container).getAttribute('src')).toBe(THUMB)
    fireEvent.error(img(container))
    await waitFor(() => expect(img(container).getAttribute('src')).toBe(FULL))
    expect(fetchSpy).not.toHaveBeenCalled()   // the degrade target was already in hand
  })

  it('a null photo renders nothing with the flag on, rather than resolving something', async () => {
    const { container } = render(<PhotoView photo={null} resolveById />)
    expect(container.firstChild).toBeNull()
    await act(async () => {})
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a row with neither a url NOR an id renders nothing and never fetches undefined', async () => {
    const { container } = render(<PhotoView photo={{ storage_path: 'events/E/a.jpg' }} resolveById />)
    expect(container.firstChild).toBeNull()
    await act(async () => {})
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('the arm resolves through the app’s one signed-URL path', () => {
  it('mints on mount and renders the photo an id-only row could not render before', async () => {
    fetchSpy.mockResolvedValue({ view_url: MINTED })
    const { container } = render(<PhotoView photo={EVENT_ROW} resolveById />)
    await waitFor(() => expect(img(container)?.getAttribute('src')).toBe(MINTED))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    // The household-scoped route, no-store — NOT a second URL mechanism and not an unsigned path.
    expect(fetchSpy).toHaveBeenCalledWith('/api/photos/view-url/ph-1', { cache: 'no-store' })
  })

  it('is TIER-BLIND: a thumb request resolves the same original, with one call not two', async () => {
    fetchSpy.mockResolvedValue({ view_url: MINTED })
    const { container } = render(<PhotoView photo={EVENT_ROW} tier={TIER.THUMB} resolveById />)
    await waitFor(() => expect(img(container)?.getAttribute('src')).toBe(MINTED))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('two co-visible thumbs of the same id share ONE mint (PhotoImg’s storm dedup)', async () => {
    fetchSpy.mockResolvedValue({ view_url: MINTED })
    const { container } = render(
      <>
        <PhotoView photo={EVENT_ROW} resolveById />
        <PhotoView photo={{ ...EVENT_ROW }} resolveById />
      </>
    )
    await waitFor(() => expect(container.querySelectorAll('img').length).toBe(2))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('forwards presentation props and the model’s alt through to the rendered img', async () => {
    fetchSpy.mockResolvedValue({ view_url: MINTED })
    const { container } = render(
      <PhotoView photo={EVENT_ROW} resolveById decoding="async" data-testid="t" />
    )
    await waitFor(() => expect(img(container)).not.toBeNull())
    expect(img(container).getAttribute('alt')).toBe('Garden photo')   // photoModel's derived alt
    expect(img(container).getAttribute('decoding')).toBe('async')
    expect(img(container).getAttribute('data-testid')).toBe('t')
    expect(img(container).getAttribute('loading')).toBeNull()          // lazy stays banned on this arm too
  })

  it('honours a consumer alt and wraps in a tappable button when onOpen is given', async () => {
    fetchSpy.mockResolvedValue({ view_url: MINTED })
    const onOpen = vi.fn()
    const { container } = render(<PhotoView photo={EVENT_ROW} resolveById alt="Photo 1 of 2" onOpen={onOpen} />)
    await waitFor(() => expect(img(container)).not.toBeNull())
    expect(img(container).getAttribute('alt')).toBe('Photo 1 of 2')
    fireEvent.click(container.querySelector('button'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})

// An async arm has THREE render states, not two. A photo that silently renders nothing on failure is
// the bug class this ticket closes, so each state is pinned rather than left to chance.
describe('loading and failure states', () => {
  it('PENDING reserves the consumer’s box and never emits <img src=null>', async () => {
    let resolve
    fetchSpy.mockReturnValue(new Promise((r) => { resolve = r }))
    const { container } = render(
      <PhotoView photo={EVENT_ROW} resolveById style={{ width: 96, height: 96 }} />
    )
    const box = container.firstChild
    expect(box).not.toBeNull()
    expect(box.tagName).toBe('DIV')                    // placeholder, not an img
    expect(box.style.width).toBe('96px')               // inherits the consumer's box → no reflow on land
    expect(img(container)).toBeNull()
    await act(async () => { resolve({ view_url: MINTED }) })
    await waitFor(() => expect(img(container)?.getAttribute('src')).toBe(MINTED))
    expect(container.querySelector('div')).toBeNull()  // placeholder gave way to the real image
  })

  it('PENDING with fallback="none" collapses silently (PutUpPhotoThumb’s contract)', async () => {
    fetchSpy.mockReturnValue(new Promise(() => {}))
    const { container } = render(<PhotoView photo={EVENT_ROW} resolveById fallback="none" />)
    expect(container.firstChild).toBeNull()
    await act(async () => {})
  })

  it('an UNRESOLVABLE id (404 — deleted) renders a labelled placeholder, not a broken glyph', async () => {
    const err = new Error('gone'); err.status = 404; fetchSpy.mockRejectedValue(err)
    const { container } = render(<PhotoView photo={EVENT_ROW} resolveById alt="Photo 1 of 2" />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(container.firstChild?.getAttribute('role')).toBe('img'))
    // It ANNOUNCES rather than vanishing: a silent nothing is indistinguishable from "no photos".
    expect(container.firstChild.getAttribute('aria-label')).toBe('Photo 1 of 2')
    expect(img(container)).toBeNull()
  })

  it('a decorative (alt="") unresolvable id stays aria-hidden — no spurious announcement', async () => {
    const err = new Error('forbidden'); err.status = 403; fetchSpy.mockRejectedValue(err)
    const { container } = render(<PhotoView photo={EVENT_ROW} resolveById alt="" />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(container.firstChild?.getAttribute('aria-hidden')).toBe('true'))
    expect(container.firstChild.getAttribute('role')).toBeNull()
  })

  it('an unresolvable id with fallback="none" collapses, and does NOT retry in a loop', async () => {
    const err = new Error('gone'); err.status = 404; fetchSpy.mockRejectedValue(err)
    const { container } = render(<PhotoView photo={EVENT_ROW} resolveById fallback="none" />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(container.firstChild).toBeNull()
    expect(fetchSpy).toHaveBeenCalledTimes(1)          // one mint per id per mount, never a storm
  })

  it('a TRANSIENT failure (5xx) stays pending — documented, not terminal', async () => {
    const err = new Error('boom'); err.status = 503; fetchSpy.mockRejectedValue(err)
    const { container } = render(<PhotoView photo={EVENT_ROW} resolveById style={{ width: 96 }} />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    await act(async () => {})
    // Still the placeholder, NOT the terminal role=img state: the id is not known to be bad, and
    // the box is held so a later remount can fill it. Recovery is on remount — PhotoImg's proactive
    // re-mint is viewport-gated on a rendered <img>, which a pending instance does not have.
    expect(container.firstChild?.tagName).toBe('DIV')
    expect(container.firstChild.getAttribute('role')).toBeNull()
    expect(img(container)).toBeNull()
  })
})
