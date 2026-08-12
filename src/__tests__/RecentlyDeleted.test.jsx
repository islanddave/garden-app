// W-RESTORE — RecentlyDeleted renders, restores, and empties.
//
// EVERY ASSERTION HERE IS ABOUT OUTPUT. A feature in this repo shipped inert to prod because its
// tests asserted that modules imported each other; the DOM was never checked, so nothing noticed
// that nothing rendered. So: the list is asserted by the text of its rows, restore by the row
// LEAVING the document, and the empty state by its copy — not by call counts alone. The fetch
// assertions that do exist are about the path and method, and those paths come from the shared
// contract module (see deletedPhotos.contract.test.js, which pins them to the real handler).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

const { fetchSpy, invalidateSpy, toastSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  invalidateSpy: vi.fn(),
  toastSpy: vi.fn(),
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('../lib/dataCache.js', () => ({ invalidatePrefix: invalidateSpy }))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => ({ show: toastSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

import RecentlyDeleted from '../pages/RecentlyDeleted.jsx'
import { DELETED_PHOTOS_PATH, restorePhotoPath } from '../lib/deletedPhotos.js'

const photo = (over = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  storage_path: 'events/e/p.jpg',
  caption: 'Celebrity Rescue harvest',
  created_at: '2026-08-10T00:00:00Z',
  deleted_at: '2026-08-12T13:58:44Z',
  project_name: 'Tomatoes 2026',
  thumb_url: 'https://s3.example/thumb.jpg',
  view_url: 'https://s3.example/full.jpg',
  ...over,
})

beforeEach(() => {
  fetchSpy.mockReset()
  invalidateSpy.mockReset()
  toastSpy.mockReset()
})

describe('RecentlyDeleted — the list', () => {
  it('RENDERS a row per soft-deleted photo, with its caption, parent and delete date', async () => {
    fetchSpy.mockResolvedValueOnce([photo(), photo({ id: 'b', caption: 'Second one', project_name: null })])
    render(<RecentlyDeleted />)

    expect(await screen.findByText('Celebrity Rescue harvest')).toBeTruthy()
    expect(screen.getByText('Second one')).toBeTruthy()
    // The subtitle is identification, not decoration: the incident behind this lane involved two
    // byte-identical photos, so the parent name is how a user tells two thumbnails apart.
    expect(screen.getByText('Tomatoes 2026 · Deleted Aug 12, 2026')).toBeTruthy()
    expect(screen.getByText('Deleted Aug 12, 2026')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Restore/ })).toHaveLength(2)
  })

  it('fetches the deleted list from the shared contract path', async () => {
    fetchSpy.mockResolvedValueOnce([])
    render(<RecentlyDeleted />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(DELETED_PHOTOS_PATH))
  })

  it('renders the thumb through PhotoView, degrading to the full image when the thumb 404s', async () => {
    // Asserted at the ROW level, not as a re-test of the primitive: what matters here is that this
    // page passes tier=THUMB to PhotoView instead of hand-rolling `thumb_url || view_url`. It did
    // hand-roll it in the first draft — thumb_url is a presigned string on every row whether or not
    // the object exists, so that `||` can never fall through and the tile stays broken forever.
    fetchSpy.mockResolvedValueOnce([photo()])
    render(<RecentlyDeleted />)
    const img = await screen.findByAltText('Celebrity Rescue harvest')
    expect(img.getAttribute('src')).toBe('https://s3.example/thumb.jpg')
    fireEvent.error(img)
    await waitFor(() => expect(img.getAttribute('src')).toBe('https://s3.example/full.jpg'))
  })

  it('offers NO permanent-delete affordance — the only verb on the page is Restore', async () => {
    // Soft-Delete-Only is binding. This surface can only ever put things back; an "empty trash" here
    // would be the one place in the app where user content could actually be destroyed.
    fetchSpy.mockResolvedValueOnce([photo()])
    render(<RecentlyDeleted />)
    await screen.findByText('Celebrity Rescue harvest')
    for (const btn of screen.getAllByRole('button')) {
      expect(btn.textContent).not.toMatch(/delete|remove|empty|purge|forever|permanent/i)
    }
  })
})

describe('RecentlyDeleted — restore', () => {
  it('POSTs to the restore path and REMOVES the row from the document', async () => {
    fetchSpy.mockResolvedValueOnce([photo(), photo({ id: 'b', caption: 'Second one' })])
    render(<RecentlyDeleted />)
    await screen.findByText('Celebrity Rescue harvest')

    fetchSpy.mockResolvedValueOnce({ id: photo().id, deleted_at: null })
    fireEvent.click(screen.getByRole('button', { name: 'Restore Celebrity Rescue harvest' }))

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(restorePhotoPath(photo().id), { method: 'POST' }),
    )
    // The load-bearing half: the row is GONE. A restore that leaves the row sitting there reads as a
    // no-op and invites the user to tap again.
    await waitFor(() => expect(screen.queryByText('Celebrity Rescue harvest')).toBeNull())
    expect(screen.getByText('Second one')).toBeTruthy()
  })

  it('invalidates the cached photo lists so the restored photo reappears where it belongs', async () => {
    fetchSpy.mockResolvedValueOnce([photo()])
    render(<RecentlyDeleted />)
    await screen.findByText('Celebrity Rescue harvest')

    fetchSpy.mockResolvedValueOnce({ id: photo().id, deleted_at: null })
    fireEvent.click(screen.getByRole('button', { name: /^Restore/ }))
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith('/api/photos'))
  })

  it('confirms ambiently and operationally — no celebration (Reward-UX)', async () => {
    fetchSpy.mockResolvedValueOnce([photo()])
    render(<RecentlyDeleted />)
    await screen.findByText('Celebrity Rescue harvest')

    fetchSpy.mockResolvedValueOnce({ id: photo().id, deleted_at: null })
    fireEvent.click(screen.getByRole('button', { name: /^Restore/ }))
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ message: 'Photo restored' }))
    const msg = toastSpy.mock.calls[0][0].message
    expect(msg).not.toMatch(/nice|great|well done|🎉|congrat|streak|points|badge/i)
  })

  it('shows the last soft-deleted photo restoring straight into the empty state', async () => {
    // This is prod's real day-one shape: exactly ONE soft-deleted photo exists (verified live
    // 2026-08-12 — the §0 incident photo 4bf9dcd4, hand-remediated). Restoring it is the first thing
    // this page will ever be asked to do, and it must land somewhere coherent.
    fetchSpy.mockResolvedValueOnce([photo()])
    render(<RecentlyDeleted />)
    await screen.findByText('Celebrity Rescue harvest')

    fetchSpy.mockResolvedValueOnce({ id: photo().id, deleted_at: null })
    fireEvent.click(screen.getByRole('button', { name: /^Restore/ }))
    expect(await screen.findByText('Nothing deleted')).toBeTruthy()
  })

  it('keeps the list intact and surfaces the reason when a restore FAILS', async () => {
    fetchSpy.mockResolvedValueOnce([photo()])
    render(<RecentlyDeleted />)
    await screen.findByText('Celebrity Rescue harvest')

    // The typed 409: the same bytes were re-uploaded while this one sat deleted. Its message is
    // actionable, so it is shown rather than flattened to a generic failure.
    fetchSpy.mockRejectedValueOnce(new Error('A copy of this photo has since been re-uploaded'))
    fireEvent.click(screen.getByRole('button', { name: /^Restore/ }))

    expect(await screen.findByText('A copy of this photo has since been re-uploaded')).toBeTruthy()
    // A per-row failure must NOT blank the surface: the row stays, and it stays restorable.
    expect(screen.getByText('Celebrity Rescue harvest')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Restore/ })).toBeTruthy()
  })
})

describe('RecentlyDeleted — the empty state (the DEFAULT state)', () => {
  it('RENDERS the explanation, not just a count of zero', async () => {
    // Nothing is ever deleted automatically, so a household that has deleted nothing sees only this.
    // It must answer "where do deleted photos go?" — the question that brought the user here from
    // the delete confirm's "recoverable from Recently deleted".
    fetchSpy.mockResolvedValueOnce([])
    render(<RecentlyDeleted />)

    expect(await screen.findByText('Nothing deleted')).toBeTruthy()
    expect(screen.getByText(/land here and stay until you put them back/i)).toBeTruthy()
    expect(screen.getByText(/is ever removed permanently/i)).toBeTruthy()
    expect(screen.getByText('Back to Photos').getAttribute('href')).toBe('/photos')
  })

  it('states the durability promise the delete confirm makes — no expiry, no timer', async () => {
    fetchSpy.mockResolvedValueOnce([])
    render(<RecentlyDeleted />)
    await screen.findByText('Nothing deleted')
    // V3-ARCHIVE-001 shipped a 6s undo and no restore path. The copy here must not reintroduce a
    // window: "kept for 30 days" would be a promise this code does not implement.
    expect(screen.getByText(/nothing expires/i)).toBeTruthy()
    // The guard targets a RETENTION WINDOW specifically, not the word "expire" — the page's own copy
    // is "nothing expires", which is the promise, and a blunter pattern would forbid stating it.
    expect(document.body.textContent).not.toMatch(
      /\d+\s*(day|week|month)s?|expires? (in|after)|deleted after|kept for/i,
    )
  })

  it('gives its only escape link a real tap target', async () => {
    // jsdom has no layout engine, so this pins the STYLE that produces the geometry rather than the
    // geometry itself — the measurement was taken in the layout harness at 390px, where the link was
    // 104x17 before this and 128x44 after. On an otherwise blank page it is the only way out, so a
    // 17px target is not a rounding error.
    fetchSpy.mockResolvedValueOnce([])
    render(<RecentlyDeleted />)
    const link = await screen.findByText('Back to Photos')
    expect(link.style.minHeight).toBe('44px')
    expect(link.style.display).toBe('inline-flex')
  })

  it('shows the empty state, NOT an error, when the list is legitimately empty', async () => {
    fetchSpy.mockResolvedValueOnce([])
    render(<RecentlyDeleted />)
    await screen.findByText('Nothing deleted')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('RecentlyDeleted — load failure', () => {
  it('shows a retryable error card and recovers on retry', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('Service temporarily unavailable'))
    render(<RecentlyDeleted />)

    expect(await screen.findByText('Service temporarily unavailable')).toBeTruthy()
    expect(screen.getByText('Couldn’t load Recently deleted')).toBeTruthy()

    fetchSpy.mockResolvedValueOnce([photo()])
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Celebrity Rescue harvest')).toBeTruthy()
  })
})
