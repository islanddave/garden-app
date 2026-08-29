// V4-PHOTOUI-001 — PlantingTile on the mandated <PhotoView> primitive.
//
// PlantingTile is NOT an id-only surface: /api/plants hands it BOTH featured_photo_id and a
// presigned featured_photo_view_url, and photoModel already treats featured_photo_view_url as a
// FULL source. So this migration needed nothing from the resolveById arm — it is a pure wrapper
// swap, and the contract is that it is BEHAVIOURALLY BYTE-IDENTICAL.
//
// That is why every test in this file is written to pass against the PRE-migration component too
// (verified: green on both sides of the change). A test that only passes after the swap would prove
// the swap happened; these prove nothing MOVED, which is the actual risk on a surface that renders
// 24-at-a-time in a grid.
//
// THE ONE REAL HAZARD, pinned below: PhotoView takes a PHOTO row and reads `raw.id`. A planting's
// `id` is the PLANT id. Handing `photo={planting}` straight through would silently re-point the
// expiry self-heal at /api/photos/view-url/<plantId> — a 404, i.e. a permanent blank on every
// presign expiry, with no jsdom-visible symptom. The call-site adapter exists for exactly that, and
// "mints the FEATURED PHOTO id" is the assertion that kills the naive version.
//
// GRID COST (the live risk on this surface — 187x LEFT JOIN LATERAL, 369MB of originals, a
// per-deploy cache purge are all this codebase's own history): a Garden group renders windowSize=24
// tiles. The mount-network cost is asserted at 0 requests, before and after, because the URL is in
// hand and PhotoImg's fetch-on-mount is guarded on `!initialUrl`.
//
// WHAT THIS CANNOT CATCH: jsdom never loads an image. It proves which URL was requested and which
// element was rendered — never that a picture appeared.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

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
// A cross-origin photo now spends one absorbed CORS attempt before an error reaches the heal.
// failPhotoLoad says "the image failed" and is blind to the flag; PhotoImg.cors.test.jsx owns the retry.
import { failPhotoLoad } from './helpers/photoLoadFailure.js'

beforeEach(() => { fetchSpy.mockReset(); __resetPhotoImgCache() })

const URL_A = 'https://s3.example.invalid/plants/PL9/a.jpg?sig=featured'
const MINTED = 'https://s3.example.invalid/plants/PL9/a.jpg?sig=fresh'

// The literal shape /api/plants returns for a planting with a featured photo. NOTE `id` is the
// PLANT id and `featured_photo_id` is the photo — the two must never be conflated.
const withPhoto = (n = 9) => ({
  id: `pl${n}`, project_id: 'pr3', name: `Bhut Jolokia ${n}`, status: 'growing', quantity: 1,
  featured_photo_id: `ph${n}`, featured_photo_view_url: `${URL_A}&i=${n}`,
})
const noPhoto = { id: 'pl0', project_id: 'pr3', name: 'Naked Planting', status: 'growing', quantity: 1, featured_photo_view_url: null }

const viewUrlCalls = () => fetchSpy.mock.calls.filter(c => String(c[0]).includes('/api/photos/view-url/'))

describe('V4-PHOTOUI-001 — the tile renders its featured photo through the primitive', () => {
  it('renders the in-hand presigned URL', () => {
    const { container } = render(<PlantingTile planting={withPhoto()} />)
    expect(container.querySelector('img').getAttribute('src')).toBe(`${URL_A}&i=9`)
  })

  it('keeps the photo DECORATIVE (alt=""), not the model’s "Garden photo" default', () => {
    // The stretched card Link already carries the accessible name "Open {name}"; a second
    // announcement for the same target is noise on a screen reader.
    const { container } = render(<PlantingTile planting={withPhoto()} />)
    expect(container.querySelector('img').getAttribute('alt')).toBe('')
  })

  it('forwards the tile’s presentation contract to the img (cover fill, async decode, sizes)', () => {
    const { container } = render(<PlantingTile planting={withPhoto()} />)
    const el = container.querySelector('img')
    expect(el.getAttribute('decoding')).toBe('async')
    expect(el.getAttribute('sizes')).toBe('(max-width: 720px) 50vw, 360px')
    expect(el.style.objectFit).toBe('cover')
    expect(el.style.position).toBe('absolute')
  })

  it('NEVER sets loading="lazy" — measured 0 of 120 images ever requested with it', () => {
    const { container } = render(<PlantingTile planting={withPhoto()} />)
    expect(container.querySelector('img').getAttribute('loading')).toBeNull()
  })

  it('a planting with no featured photo renders the seedling CTA and no img', async () => {
    const { container } = render(<PlantingTile planting={noPhoto} />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('Tap to add first photo')).toBeTruthy()
    await act(async () => {})
    expect(viewUrlCalls()).toHaveLength(0)
  })
})

describe('the expiry self-heal stays pointed at the PHOTO id, not the plant id', () => {
  it('re-mints /api/photos/view-url/<featured_photo_id> when the presigned URL expires', async () => {
    fetchSpy.mockResolvedValue({ view_url: MINTED })
    const { container } = render(<PlantingTile planting={withPhoto()} />)
    failPhotoLoad(() => container.querySelector('img'))
    await waitFor(() => expect(container.querySelector('img').getAttribute('src')).toBe(MINTED))
    expect(viewUrlCalls()).toHaveLength(1)
    // pl9 is the PLANT. ph9 is the PHOTO. Minting the plant id 404s -> permanent blank on expiry.
    expect(String(viewUrlCalls()[0][0])).toBe('/api/photos/view-url/ph9')
  })
})

describe('GRID COST — a windowSize=24 Garden group', () => {
  it('makes ZERO view-url requests on mount: the URL is in hand, so nothing resolves by id', async () => {
    const items = Array.from({ length: 24 }, (_, i) => withPhoto(i))
    const { container } = render(<div>{items.map(pl => <PlantingTile key={pl.id} planting={pl} />)}</div>)
    expect(container.querySelectorAll('img')).toHaveLength(24)
    await act(async () => {})
    expect(viewUrlCalls()).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('every tile paints its OWN url — no shared/degraded source across the window', async () => {
    const items = Array.from({ length: 24 }, (_, i) => withPhoto(i))
    const { container } = render(<div>{items.map(pl => <PlantingTile key={pl.id} planting={pl} />)}</div>)
    const srcs = [...container.querySelectorAll('img')].map(el => el.getAttribute('src'))
    expect(new Set(srcs).size).toBe(24)
    expect(srcs[0]).toBe(`${URL_A}&i=0`)
  })
})
