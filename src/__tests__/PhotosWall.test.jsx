// PhotosWall.test.jsx — V200 Slice 3. The Garden Photos sub-tab browse surface.
// No jest-dom (L-182): assert via roles + text + attributes + toBe/toBeTruthy/toBeNull.
// useApiFetch is mocked to return a small photos array (same shape as /api/photos:
// { id, view_url, caption, created_at, ... }). Lightbox is the REAL component (portals to
// document.body); clicking a tile must surface role=dialog.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: () => Promise.resolve('t') }),
  apiFetch: (...a) => fetchMock(...a),
}))

import PhotosWall from '../components/PhotosWall.jsx'

const PHOTOS = [
  { id: 'ph1', view_url: 'https://s3.test/1.jpg', caption: 'Sungold ripening', created_at: '2026-06-20T12:00:00Z' },
  { id: 'ph2', view_url: 'https://s3.test/2.jpg', caption: 'Bed at dawn',       created_at: '2026-06-02T08:00:00Z' },
  { id: 'ph3', view_url: 'https://s3.test/3.jpg', caption: 'First sprout',      created_at: '2026-05-15T09:00:00Z' },
]

beforeEach(() => {
  document.body.innerHTML = ''
  fetchMock.mockReset()
})

async function renderWall(data = PHOTOS) {
  fetchMock.mockResolvedValue(data)
  await act(async () => { render(<PhotosWall />) })
}

describe('PhotosWall — Garden Photos sub-tab', () => {
  it('fetches /api/photos and renders a grid of photos', async () => {
    await renderWall()
    expect(fetchMock).toHaveBeenCalledWith('/api/photos')
    // One TileGrid per month → each is a role=list; every photo is a role=listitem with an img.
    const imgs = document.querySelectorAll('img[src^="https://s3.test/"]')
    expect(imgs.length).toBe(3)
    // BUG-PHOTOTHUMB-001 — this assertion used to require loading="lazy" and so ENSHRINED the bug.
    // Measured live 2026-07-27: with lazy, 0 of 120 wall images were ever REQUESTED (never fetched,
    // not slow). The wall is now bounded by useImageWindow instead, so lazy MUST be absent — if it
    // comes back, the wall silently renders nothing again.
    expect(imgs[0].getAttribute('loading')).toBeNull()
    expect(imgs[0].getAttribute('decoding')).toBe('async')
  })

  it('groups photos under sticky month headers (newest month first)', async () => {
    await renderWall()
    // June 2026 has two photos, May 2026 one. Both headers present.
    expect(screen.getByText('June 2026')).toBeTruthy()
    expect(screen.getByText('May 2026')).toBeTruthy()
    // Headings are <h2> sections; June must appear before May in DOM order (newest first).
    const heads = Array.from(document.querySelectorAll('h2')).map(h => h.textContent)
    expect(heads.indexOf('June 2026')).toBeLessThan(heads.indexOf('May 2026'))
  })

  it('tapping a photo opens the Lightbox (role=dialog)', async () => {
    await renderWall()
    expect(screen.queryByRole('dialog')).toBeNull()
    const firstTile = screen.getByLabelText('Open photo 1')
    await act(async () => { fireEvent.click(firstTile) })
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeTruthy()
    // The Lightbox shows the full wall as a gallery — its filmstrip exposes one thumb per photo.
    expect(screen.getByTestId('lightbox-thumb-0')).toBeTruthy()
    expect(screen.getByTestId('lightbox-thumb-2')).toBeTruthy()
  })

  it('opens the Lightbox at the tapped photo’s flat index across months', async () => {
    await renderWall()
    // photo 3 = May sprout (flat index 2, newest-first sorted). Its label is "Open photo 3".
    const mayTile = screen.getByLabelText('Open photo 3')
    await act(async () => { fireEvent.click(mayTile) })
    // The current caption rendered in the lightbox should be the May photo's caption.
    expect(screen.getByTestId('lightbox-caption').textContent).toBe('First sprout')
  })

  it('renders the empty state when there are no photos', async () => {
    await renderWall([])
    expect(screen.getByText('No photos yet')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders an error state when the fetch fails', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }))
    await act(async () => { render(<PhotosWall />) })
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText(/Couldn’t load your photos/)).toBeTruthy()
    // Retry control is present and a ≥44px tap target.
    expect(screen.getByText('Retry')).toBeTruthy()
    const retry = screen.getByRole('button', { name: 'Retry' })
    expect(parseInt(retry.style.minHeight, 10)).toBeGreaterThanOrEqual(44)
    // The card comes from the AsyncRegion primitive now — decorative glyph hidden from AT.
    expect(screen.getByRole('alert').firstChild.getAttribute('aria-hidden')).toBe('true')
  })
})

// V4-SPACEPHOTO-001 Lane C — this component is the CANONICAL month-grouped gallery. The Space
// gallery configures it by props instead of becoming a fourth hand-rolled renderer, so these pin
// the config surface AND prove the propless default (the Garden Photos sub-tab) is unchanged.
describe('PhotosWall — prop-config surface (canonical renderer, not a fourth copy)', () => {
  it('scopes the read to `path` and the wrapper to `testId`', async () => {
    fetchMock.mockResolvedValue(PHOTOS)
    await act(async () => { render(<PhotosWall path="/api/photos?space_id=s1" testId="space-photo-wall" />) })
    expect(fetchMock).toHaveBeenCalledWith('/api/photos?space_id=s1')
    expect(screen.getByTestId('space-photo-wall')).toBeTruthy()
    expect(screen.queryByTestId('photos-wall')).toBeNull()
  })

  it('renders a caller-supplied empty state instead of the default', async () => {
    fetchMock.mockResolvedValue([])
    await act(async () => { render(<PhotosWall empty={<p>Nothing here yet</p>} />) })
    expect(screen.getByText('Nothing here yet')).toBeTruthy()
    expect(screen.queryByText('No photos yet')).toBeNull()
  })

  it('renders renderTileFooter OUTSIDE the tile button (nested buttons would be invalid markup)', async () => {
    fetchMock.mockResolvedValue(PHOTOS)
    await act(async () => {
      render(<PhotosWall renderTileFooter={(p) => <button type="button">pick {p.id}</button>} />)
    })
    const footer = screen.getByText('pick ph1')
    expect(footer.closest('button').textContent).toBe('pick ph1')   // it is its own button…
    expect(screen.getByLabelText('Open photo 1').contains(footer)).toBe(false)  // …not inside the tile
  })

  it('with NO props the wrapper, read and markup are the shipped defaults', async () => {
    await renderWall()
    expect(fetchMock).toHaveBeenCalledWith('/api/photos')
    expect(screen.getByTestId('photos-wall')).toBeTruthy()
    // No footer node is introduced when renderTileFooter is absent.
    const tile = screen.getByLabelText('Open photo 1')
    expect(tile.parentElement.childElementCount).toBe(1)
  })
})
