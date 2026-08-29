// V4-PHOTOCORS-001 — the CLIENT half. PhotoImg asks for a cross-origin photo in CORS mode so the
// service worker gets a response it can actually verify and cache; public/sw.js owns the other half
// and is covered behaviourally in swPhotoCorsCache.test.js.
//
// THE RISK THIS FILE EXISTS FOR. A CORS request the origin refuses does NOT degrade to a no-cors
// fetch — the image does not load AT ALL. So the failure mode of getting this wrong is not "photos
// are slower", it is "every photo is a blank box". Most of what follows is about that fallback, not
// about the attribute.
//
// WHAT jsdom CANNOT DO HERE, stated so a green run is not over-read: it never performs a request, so
// nothing below proves that S3 answers a CORS preflight-free GET with Access-Control-Allow-Origin,
// that the response is non-opaque, or that anything was cached. Those are live-surface facts
// (verified by curl against garden-photos-prod, and by scripts/photo-cors-probe.mjs in a real
// browser). This file proves the CONTROL FLOW: which attribute is set, what happens on error, and
// that a CORS failure never gets mistaken for a missing photo.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, fireEvent } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: () => Promise.resolve('t') }),
}))
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  PHOTO_CORS_CACHE_ENABLED: true,
}))

import PhotoImg, { __resetPhotoImgCache, __photoCorsBroken } from '../components/PhotoImg.jsx'
import PhotoView from '../components/photo/PhotoView.jsx'
import { TIER } from '../lib/photoModel.js'

beforeEach(() => { fetchSpy.mockReset(); __resetPhotoImgCache() })

const S3 = 'https://garden-photos-prod.s3.us-east-1.amazonaws.com'
const MINT_A = `${S3}/thumbs/plants/P/a.jpg?X-Amz-Signature=aaaa`
const MINT_B = `${S3}/thumbs/plants/P/a.jpg?X-Amz-Signature=bbbb`
const img = (c) => c.querySelector('img')
const xo = (c) => img(c)?.getAttribute('crossorigin')

describe('PHOTO_CORS_CACHE_ENABLED — the shipped value', () => {
  it('is TRUE on disk, taken via importActual so no mock can launder it', async () => {
    // The single pin on the flag's shipped value. A future flip fails HERE, as one explicit decision
    // to re-approve, rather than scattering red across suites that merely happen to render a photo.
    // Flipped false -> true 2026-08-29 (V4-PHOTOCORS-001, Dave-approved); the pin flipped WITH it and
    // stays an equality check, not a truthiness one, so the next change to this flag in EITHER
    // direction still stops here exactly once.
    const actual = await vi.importActual('../lib/featureFlags.js')
    expect(actual.PHOTO_CORS_CACHE_ENABLED).toBe(true)
  })
})

describe('the attribute', () => {
  it('a cross-origin photo is requested in CORS mode', () => {
    const { container } = render(<PhotoImg photoId="p1" initialUrl={MINT_A} alt="x" />)
    expect(xo(container)).toBe('anonymous')
  })

  it('a SAME-origin src is left alone — crossOrigin buys nothing there', () => {
    // Mutation: drop the _isCrossOrigin() term → every local asset PhotoImg is ever pointed at
    // starts issuing CORS requests for no benefit.
    const { container } = render(
      <PhotoImg photoId="p2" initialUrl={`${window.location.origin}/critters/c155.png`} alt="x" />
    )
    expect(xo(container)).toBeNull()
  })
})

describe('the CORS failure path — a refused request must never look like a missing photo', () => {
  it('retries the SAME url without crossOrigin, and spends no mint doing it', async () => {
    // Mutation: delete the `if (useCors)` branch at the top of handleError → the error falls through
    // to the ordinary heal, burns the one-shot retry budget on a URL that is fine, and (if the fresh
    // mint also fails CORS, which it will) the photo goes terminal blank.
    const { container } = render(<PhotoImg photoId="p3" initialUrl={MINT_A} alt="x" />)
    expect(xo(container)).toBe('anonymous')

    fireEvent.error(img(container))
    await waitFor(() => expect(xo(container)).toBeNull())
    expect(img(container).getAttribute('src')).toBe(MINT_A)   // same url, not a re-mint
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does NOT report the error upward — PhotoView must not advance its tier chain', async () => {
    // The composition requirement, and the expensive one to get wrong: onError is what moves
    // PhotoView's cursor, so reporting a CORS refusal would send a THUMB tile to the ~3 MB original
    // — the exact saving tier=THUMB exists for, spent on a photo that was never broken.
    const onError = vi.fn()
    const { container } = render(<PhotoImg photoId="p4" initialUrl={MINT_A} alt="x" onError={onError} />)
    fireEvent.error(img(container))
    await waitFor(() => expect(xo(container)).toBeNull())
    expect(onError).not.toHaveBeenCalled()
  })

  it('through PhotoView: a CORS refusal on the thumb keeps the thumb', async () => {
    // The same guarantee asserted at the level Dave would actually see it. Mutation: same as above
    // — the src flips to the full original here instead of staying on the thumb.
    const FULL = `${S3}/plants/P/a.jpg?X-Amz-Signature=full`
    const THUMB = `${S3}/thumbs/plants/P/a.jpg?X-Amz-Signature=thumb`
    const row = { id: 'pv1', storage_path: 'plants/P/a.jpg', plant_id: 'x', view_url: FULL, thumb_url: THUMB }
    const { container } = render(<PhotoView photo={row} tier={TIER.THUMB} />)
    expect(img(container).getAttribute('src')).toBe(THUMB)
    expect(xo(container)).toBe('anonymous')

    fireEvent.error(img(container))
    await waitFor(() => expect(xo(container)).toBeNull())
    expect(img(container).getAttribute('src')).toBe(THUMB)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('if the plain retry ALSO fails, the ordinary heal runs exactly as before', async () => {
    // The CORS retry inserts one attempt; it must not consume or duplicate the existing one. A
    // genuinely expired presign fails in BOTH modes and has to reach the re-mint.
    fetchSpy.mockResolvedValue({ view_url: MINT_B })
    const { container } = render(<PhotoImg photoId="p5" initialUrl={MINT_A} alt="x" />)
    fireEvent.error(img(container))                              // CORS attempt
    await waitFor(() => expect(xo(container)).toBeNull())
    fireEvent.error(img(container))                              // plain attempt: really is a 403
    await waitFor(() => expect(img(container).getAttribute('src')).toBe(MINT_B))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(__photoCorsBroken()).toBe(false)                      // an expired presign is not CORS evidence
  })

  it('a fresh mint gets its own CORS attempt', async () => {
    // The fallback is per-URL, held as the failed src rather than as a boolean, so a healed photo is
    // not permanently demoted by one stale predecessor. Mutation: store a boolean → MINT_B renders
    // plain and the feature silently dies on the first expiry of the session.
    fetchSpy.mockResolvedValue({ view_url: MINT_B })
    const { container } = render(<PhotoImg photoId="p6" initialUrl={MINT_A} alt="x" />)
    fireEvent.error(img(container))
    await waitFor(() => expect(xo(container)).toBeNull())
    fireEvent.error(img(container))
    await waitFor(() => expect(img(container).getAttribute('src')).toBe(MINT_B))
    expect(xo(container)).toBe('anonymous')
  })
})

describe('the CORS-broken latch — one photo pays, not the whole grid', () => {
  it('a plain retry that SUCCEEDS latches crossOrigin off for later instances', async () => {
    // Without this, a prod origin that stopped emitting CORS headers would cost every photo an extra
    // failed request forever. Mutation: delete the latch assignment in handleLoad → the second
    // render below asks for CORS again and the whole grid double-requests.
    const { container } = render(<PhotoImg photoId="p7" initialUrl={MINT_A} alt="x" />)
    fireEvent.error(img(container))
    await waitFor(() => expect(xo(container)).toBeNull())
    fireEvent.load(img(container))                               // the plain retry renders fine
    expect(__photoCorsBroken()).toBe(true)

    const later = render(<PhotoImg photoId="p8" initialUrl={MINT_B} alt="y" />)
    expect(xo(later.container)).toBeNull()
  })

  it('a FIRST-attempt load never latches — success is not evidence of breakage', async () => {
    // Guards the inverted latch. Mutation: set _corsBroken on any load → the feature disables itself
    // on the very first photo that works, which is a silently dead feature rather than a visible bug.
    const { container } = render(<PhotoImg photoId="p9" initialUrl={MINT_A} alt="x" />)
    fireEvent.load(img(container))
    expect(__photoCorsBroken()).toBe(false)
    expect(xo(container)).toBe('anonymous')
  })

  it('still forwards onLoad to the consumer', async () => {
    // handleLoad wraps onLoad rather than replacing it. Mutation: drop the onLoad?.(ev) call →
    // consumers that count decodes silently stop counting.
    const onLoad = vi.fn()
    const { container } = render(<PhotoImg photoId="p10" initialUrl={MINT_A} alt="x" onLoad={onLoad} />)
    fireEvent.load(img(container))
    expect(onLoad).toHaveBeenCalledTimes(1)
  })
})
