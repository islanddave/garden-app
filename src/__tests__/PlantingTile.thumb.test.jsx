// V4-PERFTHEMEA-001 — the Garden tile serves the THUMBNAIL, not the original.
//
// /api/plants presigned only the raw storage_path, so a ~180 CSS-px 4:3 tile painted a
// full-resolution original. Measured 2026-08-16 across the 230 live featured heroes (S3
// list-objects joined to the Neon hero derivation): originals average 3,110,652 B, their thumbs/
// derivatives 166,756 B — 18.7x — so one windowSize=24 Garden group pulled ~71 MB of image bytes.
//
// THE THUMB IS A HINT, and that is the whole reason this file exists rather than a one-line diff.
// The server derives thumbs/<storage_path> by CONVENTION and presigning never touches S3, so a
// thumb URL is a non-empty string whether or not the object is there (BUG-PHOTONEWTHUMB-001).
// 6 of the 230 live heroes have no thumb. Correctness therefore lives entirely in the DEGRADE:
// the tile must fall back onto featured_photo_view_url — which came down in the SAME list
// response, so recovery costs one 404 and zero extra round-trips.
//
// WHAT THIS CANNOT CATCH: jsdom never loads an image. These tests prove which URL was requested
// and how the chain advanced — never that a picture appeared, and never how many bytes moved.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: () => Promise.resolve('t') }),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <button type="button">fav</button> }))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <button type="button">up</button> }))
vi.mock('../components/CritterSprite.jsx', () => ({ default: () => <span>sprite</span> }))
vi.mock('../components/PlantStatusBadge.jsx', () => ({ default: ({ status }) => <span>{status}</span> }))
vi.mock('../components/CaretakerBadge.jsx', () => ({ default: ({ caretaker }) => <span>badge:{caretaker?.initial}</span> }))

import PlantingTile from '../components/PlantingTile.jsx'
import { __resetPhotoImgCache } from '../components/PhotoImg.jsx'

beforeEach(() => { fetchSpy.mockReset(); __resetPhotoImgCache() })

const FULL = 'https://s3.example.invalid/plants/PL9/a.jpg?sig=full'
const THUMB = 'https://s3.example.invalid/thumbs/plants/PL9/a.jpg?sig=thumb'
const MINTED = 'https://s3.example.invalid/plants/PL9/a.jpg?sig=fresh'

// The shape /api/plants returns AFTER this lane: both presigned fields, additive.
const withThumb = (n = 9) => ({
  id: `pl${n}`, project_id: 'pr3', name: `Bhut Jolokia ${n}`, status: 'growing', quantity: 1,
  featured_photo_id: `ph${n}`,
  featured_photo_view_url: `${FULL}&i=${n}`,
  featured_photo_thumb_url: `${THUMB}&i=${n}`,
})
// The shape it returns BEFORE the Lambda deploys — the SPA ships independently of the 26-Lambda
// matrix, so this is a real production state, not a hypothetical.
const noThumbField = (n = 9) => {
  const { featured_photo_thumb_url: _drop, ...rest } = withThumb(n)
  return rest
}

const src = (c) => c.querySelector('img')?.getAttribute('src') ?? null
const viewUrlCalls = () => fetchSpy.mock.calls.filter(c => String(c[0]).includes('/api/photos/view-url/'))

describe('the tile prefers the thumbnail', () => {
  it('paints featured_photo_thumb_url, not the 3 MB original', () => {
    const { container } = render(<PlantingTile planting={withThumb()} />)
    expect(src(container)).toBe(`${THUMB}&i=9`)
  })

  it('a windowSize=24 group paints 24 DISTINCT thumbs and makes zero network calls', async () => {
    const items = Array.from({ length: 24 }, (_, i) => withThumb(i))
    const { container } = render(<div>{items.map(pl => <PlantingTile key={pl.id} planting={pl} />)}</div>)
    const srcs = [...container.querySelectorAll('img')].map(el => el.getAttribute('src'))
    expect(srcs).toHaveLength(24)
    expect(new Set(srcs).size).toBe(24)
    expect(srcs.every(u => u.startsWith(THUMB))).toBe(true)
    await act(async () => {})
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('a missing thumb degrades to the in-hand original (6 of 230 live heroes)', () => {
  it('the first error swaps in featured_photo_view_url with NO network round-trip', async () => {
    const { container } = render(<PlantingTile planting={withThumb()} />)
    expect(src(container)).toBe(`${THUMB}&i=9`)
    fireEvent.error(container.querySelector('img'))
    await waitFor(() => expect(src(container)).toBe(`${FULL}&i=9`))
    expect(fetchSpy).not.toHaveBeenCalled()   // the degrade target came down in the same list response
  })

  it('only the FINAL source hands the photo id over, and it mints the PHOTO id not the plant id', async () => {
    fetchSpy.mockResolvedValue({ view_url: MINTED })
    const { container } = render(<PlantingTile planting={withThumb()} />)
    fireEvent.error(container.querySelector('img'))                 // thumb 404 → degrade, no mint
    await waitFor(() => expect(src(container)).toBe(`${FULL}&i=9`))
    expect(viewUrlCalls()).toHaveLength(0)
    fireEvent.error(container.querySelector('img'))                 // original expired → self-heal
    await waitFor(() => expect(src(container)).toBe(MINTED))
    expect(viewUrlCalls()).toHaveLength(1)
    // pl9 is the PLANT, ph9 is the PHOTO. Minting the plant id 404s → permanent blank on expiry.
    expect(String(viewUrlCalls()[0][0])).toBe('/api/photos/view-url/ph9')
  })

  it('a row from the PRE-deploy Lambda (no thumb field at all) renders the original directly', async () => {
    const { container } = render(<PlantingTile planting={noThumbField()} />)
    expect(src(container)).toBe(`${FULL}&i=9`)
    await act(async () => {})
    expect(fetchSpy).not.toHaveBeenCalled()
    // One-entry chain → the id is handed over immediately, exactly as it was before this lane.
    fetchSpy.mockResolvedValue({ view_url: MINTED })
    fireEvent.error(container.querySelector('img'))
    await waitFor(() => expect(src(container)).toBe(MINTED))
    expect(viewUrlCalls()).toHaveLength(1)
  })

  it('a planting with no featured photo still renders the CTA, never a thumb-shaped blank', () => {
    const bare = { id: 'pl0', project_id: 'pr3', name: 'Naked', status: 'growing', quantity: 1, featured_photo_view_url: null }
    const { container, getByText } = render(<PlantingTile planting={bare} />)
    expect(container.querySelector('img')).toBeNull()
    expect(getByText('Tap to add first photo')).toBeTruthy()
  })
})
