// BUG-TIERLESSPHOTOS-001 — the growth milestone strip serves THUMBNAILS; the compare stage does not.
//
// Two decisions are pinned here, and they point in opposite directions on purpose:
//
//   MILESTONE STRIP (tier=THUMB). 64 x 64 CSS = 168 device px at dpr 2.625, rendered ONCE PER
//   PHOTO, so a 24-photo planting drew 24 full originals into postage stamps. /api/photos already
//   signs thumb_url on every one of these rows and it was never read.
//
//   COMPARE STAGE + PLAYBACK FRAME (tier=FULL, deliberately). Measured 320 x 239.5 CSS = 840 x 629
//   device px. The thumb derivative is 800px on its LONGEST edge, so a portrait thumb is 600 wide
//   and objectFit:cover would upscale it 1.4x — on the one surface whose whole job is looking
//   closely at how a plant changed. Two elements is not a payload argument. This file asserts they
//   stay on view_url so a later "finish the migration" pass has to argue with the measurement
//   rather than silently flip them.
//
// jsdom never loads an image, so these prove which URL was requested and how the chain advanced —
// never that a picture appeared, and never how many bytes moved.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, act, fireEvent, cleanup } from '@testing-library/react'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: () => Promise.resolve('tok') }),
}))

import GrowthStrip from '../components/planting/GrowthStrip.jsx'
import { __resetPhotoImgCache } from '../components/PhotoImg.jsx'

const full = (n) => `https://s3.example.invalid/plants/ph${n}/a.jpg?sig=full`
const thumb = (n) => `https://s3.example.invalid/thumbs/plants/ph${n}/a.jpg?sig=thumb`
const MINTED = 'https://s3.example.invalid/plants/ph1/a.jpg?sig=fresh'

// The row shape GET /api/photos?attachedTo= returns: view_url AND its thumbs/ companion, both
// presigned, on every row (lambda/photos, BUG-PHOTOBLANK-001).
const photo = (n) => ({ id: `ph${n}`, view_url: full(n), thumb_url: thumb(n), caption: null, created_at: `2026-0${n}-01` })
const photos = (count) => Array.from({ length: count }, (_, i) => photo(i + 1))
const noThumbField = (n) => { const { thumb_url: _drop, ...rest } = photo(n); return rest }

const srcs = (c) => [...c.querySelectorAll('img')].map(el => el.getAttribute('src'))
// The stage renders first (after, then the clipped before), so the milestone strip is everything
// past the first two <img> elements.
const stageSrcs = (c) => srcs(c).slice(0, 2)
const stripImgs = (c) => [...c.querySelectorAll('img')].slice(2)
const viewUrlCalls = () => fetchMock.mock.calls.filter(c => String(c[0]).includes('/api/photos/view-url/'))

beforeEach(() => { fetchMock.mockReset(); fetchMock.mockResolvedValue({}); __resetPhotoImgCache(); cleanup() })

describe('the milestone strip paints thumbnails', () => {
  it('a 24-photo planting draws 24 DISTINCT thumbs and makes zero network calls', async () => {
    const { container } = render(<GrowthStrip photos={photos(24)} />)
    const strip = stripImgs(container).map(el => el.getAttribute('src'))
    expect(strip).toHaveLength(24)
    expect(new Set(strip).size).toBe(24)
    expect(strip.every(u => u.includes('/thumbs/'))).toBe(true)
    await act(async () => {})
    expect(viewUrlCalls()).toHaveLength(0)
  })

  it('a milestone photo with no thumb FIELD renders its original, never a blank', async () => {
    const { container } = render(<GrowthStrip photos={[noThumbField(1), photo(2)]} />)
    const strip = stripImgs(container).map(el => el.getAttribute('src'))
    expect(strip[0]).toBe(full(1))
    expect(strip[1]).toBe(thumb(2))
  })
})

describe('a 404-ing milestone thumb degrades instead of blanking (16.5% of live rows)', () => {
  // thumb_url is a non-empty presigned string on 100% of live rows regardless of whether the
  // thumbs/ object exists (BUG-PHOTONEWTHUMB-001), so the ONLY signal is the load error. If this
  // did not swap, 16.5% of every growth strip would be broken-image glyphs.
  it('the first load error swaps in view_url with NO network round-trip', async () => {
    const { container } = render(<GrowthStrip photos={photos(2)} />)
    const target = stripImgs(container)[0]
    expect(target.getAttribute('src')).toBe(thumb(1))
    fireEvent.error(target)
    await waitFor(() => expect(stripImgs(container)[0].getAttribute('src')).toBe(full(1)))
    expect(stripImgs(container)[0].tagName).toBe('IMG')   // an image, not a terminal placeholder
    expect(viewUrlCalls()).toHaveLength(0)
  })

  it('once degraded, the strip thumb still self-heals its presign on the photo id', async () => {
    const { container } = render(<GrowthStrip photos={photos(2)} />)
    fireEvent.error(stripImgs(container)[0])
    await waitFor(() => expect(stripImgs(container)[0].getAttribute('src')).toBe(full(1)))
    fetchMock.mockResolvedValue({ view_url: MINTED })
    fireEvent.error(stripImgs(container)[0])
    await waitFor(() => expect(stripImgs(container)[0].getAttribute('src')).toBe(MINTED))
    expect(String(viewUrlCalls()[0][0])).toBe('/api/photos/view-url/ph1')
  })
})

describe('the compare stage stays on the ORIGINAL — measured, not overlooked', () => {
  it('before and after both render view_url, not the 800px derivative', () => {
    const { container } = render(<GrowthStrip photos={photos(3)} />)
    // list is oldest-first: before = photo 1, after = photo 3. The AFTER layer paints first.
    expect(stageSrcs(container)).toEqual([full(3), full(1)])
  })

  it('the playback frame is the same 840-device-px box, so it is full-tier too', async () => {
    const { container, getByRole } = render(<GrowthStrip photos={photos(3)} />)
    fireEvent.click(getByRole('button', { name: /Play time-lapse/i }))
    await waitFor(() => expect(container.querySelectorAll('img').length).toBe(4))   // 1 stage + 3 strip
    expect(srcs(container)[0]).toBe(full(1))
  })
})
