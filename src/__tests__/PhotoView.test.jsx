// V4-PHOTOMODEL-001 — the photo primitive. Verifies tier selection and the degrade chain without a
// real network (useApiFetch is mocked, as in PhotoImg.test.jsx).
//
// WHAT THESE TESTS CANNOT CATCH: jsdom never loads an image and does no layout, so none of this
// proves the thumb is actually smaller, that it decoded, or that the wall got faster. It proves the
// STRUCTURAL facts — which URL was chosen, that the degrade fires on failure, that the id is
// withheld until the last source. Byte-weight remains a live-browser measurement.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, fireEvent } from '@testing-library/react'
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
const row = { id: 'p1', storage_path: 'plants/P/a.jpg', plant_id: 'x', view_url: FULL, thumb_url: THUMB }
const img = (c) => c.querySelector('img')

describe('tier selection', () => {
  it('tier=THUMB renders the derivative, NOT the 4080x3072 original (BUG-PHOTOTHUMB-001)', () => {
    const { container } = render(<PhotoView photo={row} tier={TIER.THUMB} />)
    expect(img(container).getAttribute('src')).toBe(THUMB)
  })

  it('tier=FULL renders the original and never silently downgrades to the thumb', () => {
    const { container } = render(<PhotoView photo={row} tier={TIER.FULL} />)
    expect(img(container).getAttribute('src')).toBe(FULL)
  })

  it('accepts a raw API row and forwards presentation props to the img', () => {
    const { container } = render(
      <PhotoView photo={row} tier={TIER.THUMB} alt="tomato" decoding="async" data-testid="t" />
    )
    expect(img(container).getAttribute('alt')).toBe('tomato')
    expect(img(container).getAttribute('decoding')).toBe('async')
    expect(img(container).getAttribute('data-testid')).toBe('t')
  })

  it('derives alt from the model when the consumer passes none (caption is NULL on 1092/1094 rows)', () => {
    const { container } = render(<PhotoView photo={row} tier={TIER.THUMB} />)
    expect(img(container).getAttribute('alt')).toBe('Garden photo')
  })

  it('NEVER sets loading="lazy" — it was measured not to fire (0 of 120 requested)', () => {
    const { container } = render(<PhotoView photo={row} tier={TIER.THUMB} />)
    expect(img(container).getAttribute('loading')).toBeNull()
  })
})

describe('degrade chain — the missing-thumb case', () => {
  it('a failed thumb degrades to the in-hand original with ZERO network calls', async () => {
    const { container } = render(<PhotoView photo={row} tier={TIER.THUMB} />)
    expect(img(container).getAttribute('src')).toBe(THUMB)
    fireEvent.error(img(container))
    await waitFor(() => expect(img(container).getAttribute('src')).toBe(FULL))
    // This is the whole point: the degrade target already came down in the list response, so
    // recovering from a missing thumb must not cost a view-url mint.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('once on the FINAL source, a failure hands over to PhotoImg’s presign self-heal', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3.example.invalid/fresh.jpg' })
    const { container } = render(<PhotoView photo={row} tier={TIER.THUMB} />)
    fireEvent.error(img(container))                       // thumb -> full, no network
    await waitFor(() => expect(img(container).getAttribute('src')).toBe(FULL))
    fireEvent.error(img(container))                       // full expired -> mint
    await waitFor(() => expect(img(container).getAttribute('src')).toBe('https://s3.example.invalid/fresh.jpg'))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledWith('/api/photos/view-url/p1', { cache: 'no-store' })
  })

  it('a FULL-tier failure mints immediately — there is no cheaper source to try first', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3.example.invalid/fresh.jpg' })
    const { container } = render(<PhotoView photo={row} tier={TIER.FULL} />)
    fireEvent.error(img(container))
    await waitFor(() => expect(img(container).getAttribute('src')).toBe('https://s3.example.invalid/fresh.jpg'))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('a thumb-less row (featured_photo_view_url) starts on the original and mints on failure', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3.example.invalid/fresh.jpg' })
    const { container } = render(
      <PhotoView photo={{ id: 'f1', storage_path: 'plants/P/a.jpg', plant_id: 'x', featured_photo_view_url: FULL }} tier={TIER.THUMB} />
    )
    expect(img(container).getAttribute('src')).toBe(FULL)
    fireEvent.error(img(container))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
  })

  it('swapping to a different photo resets the degrade cursor (windowed grids reuse instances)', async () => {
    const { container, rerender } = render(<PhotoView photo={row} tier={TIER.THUMB} />)
    fireEvent.error(img(container))
    await waitFor(() => expect(img(container).getAttribute('src')).toBe(FULL))
    const row2 = { ...row, id: 'p2', view_url: FULL + '2', thumb_url: THUMB + '2' }
    rerender(<PhotoView photo={row2} tier={TIER.THUMB} />)
    // Must be back on the THUMB for the new photo, not stuck on the previous one's degraded tier.
    expect(img(container).getAttribute('src')).toBe(THUMB + '2')
  })
})

describe('empty states', () => {
  it('renders nothing when the row has no renderable source', () => {
    const { container } = render(<PhotoView photo={{ id: 'n1', storage_path: 's/a.jpg', plant_id: 'x' }} tier={TIER.THUMB} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for a null photo instead of throwing into the grid', () => {
    const { container } = render(<PhotoView photo={null} tier={TIER.THUMB} />)
    expect(container.firstChild).toBeNull()
  })
})
