/**
 * src/__tests__/PhotoLibrary.photodelete.test.jsx
 * V4-PHOTOREASSIGN-001 / W-PHOTODEL — the standalone photo delete.
 *
 * THE GAP THIS CLOSES. `DELETE /api/photos/:id` has been correct and live since W-DEL — soft delete,
 * hero pointers nulled atomically, restore from Recently deleted forever — but it had exactly TWO
 * call sites in the SPA and both were inside the EVENT-delete flow. A blurry shot or a duplicate
 * could only be removed by deleting the event it hung off, i.e. by destroying a real record of a
 * real thing that happened in the garden. So the assertions below are not "a button exists": they
 * are about which photos the affordance can reach, what it discloses before it fires, and that the
 * thing it fires is the SOFT delete whose recovery surface the copy promises.
 *
 * WHAT IS DELIBERATELY PINNED, and why each would otherwise rot:
 *   • The delete is reachable for an EVENT-ATTACHED photo. That branch of PhotoModal renders no tag
 *     form at all, so a delete placed inside the form arm would look shipped and leave the exact
 *     photo this row exists for unreachable. This is the assertion that would catch that.
 *   • Nothing is written on the first tap. A destructive control with consequences this shape may
 *     not be a bare confirm-free action, and window.confirm cannot hold the disclosure.
 *   • Exactly ONE request, method DELETE, NO body. There is no hard-delete parameter to send and
 *     none may be invented: the route is soft-delete-only and this suite is where a future "purge"
 *     flag would first show up.
 *   • The confirm's cover disclosure is honest in BOTH directions — it names a planting that has
 *     genuinely designated the photo, it does NOT name one whose hero is merely the effective
 *     fallback, and when it knows nothing it says so rather than implying an all-clear.
 *   • A failed delete keeps the sheet up with the reason. Closing over a failure would leave the
 *     photo on screen with no explanation, which reads as "the delete silently did nothing".
 *
 * PROJECTS_HIDDEN is left at its REAL value here (true), unlike the older PhotoLibrary suites which
 * pin it false. That is load-bearing rather than incidental: with the flag on, PhotoLibrary fetches
 * the UNSCOPED planting list, which is the source coverForPhoto derives the disclosure from. Pinning
 * it false would leave the disclosure path covered only in its narrowed form.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

const { fetchSpy, invalidateSpy, toastSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  invalidateSpy: vi.fn(),
  toastSpy: vi.fn(),
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))

vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(), isUploading: false, error: null, photo: null,
    preview: null, stage: null, progress: null, reset: vi.fn(),
  }),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

// Spied, not replaced: every other export of the cache keeps its real behaviour so nothing else in
// the page changes shape. The prefix that gets invalidated is the assertion, not the call count —
// a delete that drops the row locally but leaves the ROUTED surfaces' cache holding it is the
// stale-gallery bug in a different coat.
vi.mock('../lib/dataCache.js', async (importActual) => ({
  ...(await importActual()),
  invalidatePrefix: invalidateSpy,
}))

vi.mock('../context/ToastContext.jsx', async (importActual) => ({
  ...(await importActual()),
  useOptionalToast: () => ({ show: toastSpy, showUndo: vi.fn(), dismiss: vi.fn() }),
}))

import PhotoLibrary, { coverForPhoto } from '../pages/PhotoLibrary.jsx'

const PROJECT  = { id: 'proj-1', name: 'Spring 2026' }
const LOCATION = { id: 'loc-1', full_path: 'Garden › Bed A', is_active: true }

// thumb_url only, never view_url — same reason the sibling suites give: it names the grid card
// without pulling the presign-on-mount path into a test about state.
const STANDALONE = {
  id: 'ph-1', project_id: 'proj-1', project_name: 'Spring 2026',
  caption: 'Blurry thumb', thumb_url: 'blob:thumb-1', event_id: null,
}
const EVENT_PHOTO = {
  id: 'ph-2', project_id: 'proj-1', project_name: 'Spring 2026',
  caption: 'Harvest shot', thumb_url: 'blob:thumb-2', event_id: 'evt-9',
}

// A planting that has DESIGNATED ph-1 (explicit), and one whose hero is merely the effective
// fallback. The second exists to prove the disclosure does not cry wolf: deleting a fallback hero
// simply promotes the next photo and the user sees no loss, so naming it would train them to
// ignore the line that matters.
const PLANT_EXPLICIT = { id: 'pl-1', name: 'Sungold', featured_photo_id: 'ph-1', featured_is_explicit: true }
const PLANT_FALLBACK = { id: 'pl-2', name: 'Cherokee Purple', featured_photo_id: 'ph-1', featured_is_explicit: false }

beforeEach(() => {
  fetchSpy.mockReset()
  invalidateSpy.mockReset()
  toastSpy.mockReset()
  if (typeof URL.createObjectURL !== 'function') URL.createObjectURL = vi.fn(() => 'blob:stub')
  if (typeof URL.revokeObjectURL !== 'function') URL.revokeObjectURL = vi.fn()
})

afterEach(() => { vi.unstubAllEnvs() })

// Routed by PATH rather than by call order. PhotoLibrary fires five reads from four effects and
// their interleaving is an implementation detail; a positional mock chain silently mis-feeds the
// page the moment one is added or reordered.
function routeFetch({ photos, plants = [], deleteResult } = {}) {
  fetchSpy.mockImplementation((path, opts) => {
    if (opts?.method === 'DELETE') {
      return deleteResult instanceof Error ? Promise.reject(deleteResult) : Promise.resolve(deleteResult ?? { id: 'ph-1' })
    }
    if (path === '/api/projects') return Promise.resolve([PROJECT])
    if (path === '/api/locations/with-path') return Promise.resolve([LOCATION])
    if (path.startsWith('/api/plants')) return Promise.resolve(plants)
    if (path.startsWith('/api/photos')) return Promise.resolve(photos)
    return Promise.resolve([])
  })
}

const cardName = caption => new RegExp(`^${caption}\\b`)

async function mount(opts = {}) {
  routeFetch({ photos: [STANDALONE, EVENT_PHOTO], ...opts })
  render(<PhotoLibrary />)
  await screen.findByRole('button', { name: cardName(STANDALONE.caption) })
}

// Open a photo's tag modal, then arm the delete confirm.
async function openModal(photo) {
  fireEvent.click(screen.getByRole('button', { name: cardName(photo.caption) }))
  return screen.findByTestId('pl-modal-body')
}
async function armDelete(photo) {
  await openModal(photo)
  fireEvent.click(screen.getByTestId('pl-photo-delete'))
  return screen.findByTestId('photo-delete-confirm')
}

const deleteCalls = () => fetchSpy.mock.calls.filter(([, o]) => o?.method === 'DELETE')

describe('W-PHOTODEL — the affordance exists and reaches the photos that needed it', () => {
  it('a standalone photo can be deleted on its own from the photo modal', async () => {
    await mount()
    await openModal(STANDALONE)
    expect(screen.getByTestId('pl-photo-delete')).toBeTruthy()
  })

  // THE assertion of this lane. Before this control an event photo could only be removed by
  // deleting its event; this branch renders no tag form, so a delete placed inside the form arm
  // would leave exactly this photo unreachable while looking shipped.
  it('an EVENT-ATTACHED photo can be deleted WITHOUT deleting its event', async () => {
    await mount()
    const body = await openModal(EVENT_PHOTO)
    expect(within(body).getByText(/tags are managed via the event log/i)).toBeTruthy()
    expect(screen.getByTestId('pl-photo-delete')).toBeTruthy()

    fireEvent.click(screen.getByTestId('pl-photo-delete'))
    fireEvent.click(await screen.findByTestId('photo-delete-confirm'))

    await waitFor(() => expect(deleteCalls()).toHaveLength(1))
    expect(deleteCalls()[0][0]).toBe('/api/photos/ph-2')
    // Not one request to any event route. Deleting the photo must not touch the record of the thing
    // that happened in the garden — that inversion is the entire defect this row describes.
    expect(fetchSpy.mock.calls.some(([p]) => String(p).startsWith('/api/events'))).toBe(false)
  })

  it('Recently deleted stays reachable from the Photos header — the delete has a destination', async () => {
    await mount()
    expect(screen.getByRole('link', { name: /recently deleted/i }).getAttribute('href')).toBe('/photos/deleted')
  })
})

describe('W-PHOTODEL — nothing is written without a confirm', () => {
  it('tapping Delete photo opens the confirm and issues NO request', async () => {
    await mount()
    await armDelete(STANDALONE)
    expect(deleteCalls()).toHaveLength(0)
    expect(screen.getByText('Delete this photo?')).toBeTruthy()
  })

  it('Cancel closes the confirm, writes nothing, and leaves the photo modal open behind it', async () => {
    await mount()
    await armDelete(STANDALONE)
    fireEvent.click(screen.getByTestId('photo-delete-cancel'))
    await waitFor(() => expect(screen.queryByTestId('photo-delete-confirm')).toBeNull())
    expect(deleteCalls()).toHaveLength(0)
    // Still on the photo they were looking at — Cancel must not also dump them back to the grid.
    expect(screen.getByTestId('pl-modal-body')).toBeTruthy()
    expect(screen.getByRole('button', { name: cardName(STANDALONE.caption) })).toBeTruthy()
  })
})

describe('W-PHOTODEL — the write is the SOFT delete, and only that', () => {
  it('confirming sends exactly one DELETE to the photo route, with NO body', async () => {
    await mount()
    fireEvent.click(await armDelete(STANDALONE))
    await waitFor(() => expect(deleteCalls()).toHaveLength(1))
    const [path, opts] = deleteCalls()[0]
    expect(path).toBe('/api/photos/ph-1')
    expect(opts.method).toBe('DELETE')
    // No body and no query string: the route soft-deletes unconditionally and there is no
    // permanent/purge parameter to send. A future one would have to break this line first.
    expect(opts.body).toBeUndefined()
    expect(path).not.toMatch(/[?&]/)
  })

  it('on success the photo leaves the grid, the modal closes, and the photo caches are invalidated', async () => {
    await mount()
    fireEvent.click(await armDelete(STANDALONE))

    await waitFor(() => expect(screen.queryByRole('button', { name: cardName(STANDALONE.caption) })).toBeNull())
    expect(screen.queryByTestId('pl-modal-body')).toBeNull()
    expect(screen.queryByTestId('photo-delete-confirm')).toBeNull()
    // The other photo is untouched — the drop is by id, not a blanket refetch or clear.
    expect(screen.getByRole('button', { name: cardName(EVENT_PHOTO.caption) })).toBeTruthy()
    expect(invalidateSpy).toHaveBeenCalledWith('/api/photos')
  })

  it('the confirmation names Recently deleted — the recovery path, not a congratulation', async () => {
    await mount()
    fireEvent.click(await armDelete(STANDALONE))
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(toastSpy.mock.calls[0][0].message).toMatch(/recently deleted/i)
    // Operational confirmation only. An undo toast is NOT the recovery model here (V3-ARCHIVE-001
    // shipped exactly that and made things unrecoverable); Recently deleted is.
    expect(toastSpy.mock.calls[0][0].onUndo).toBeUndefined()
  })

  it('a failed delete keeps the sheet up with the reason, and the photo stays in the grid', async () => {
    await mount({ deleteResult: new Error('Photo not found') })
    fireEvent.click(await armDelete(STANDALONE))

    expect(await screen.findByText('Photo not found')).toBeTruthy()
    expect(screen.getByTestId('photo-delete-confirm')).toBeTruthy()
    expect(screen.getByRole('button', { name: cardName(STANDALONE.caption) })).toBeTruthy()
    expect(invalidateSpy).not.toHaveBeenCalled()
    expect(toastSpy).not.toHaveBeenCalled()
  })
})

describe('W-PHOTODEL — the confirm discloses, and never over-claims', () => {
  it('names a planting that has DESIGNATED this photo as its cover', async () => {
    await mount({ plants: [PLANT_EXPLICIT] })
    await armDelete(STANDALONE)
    const line = screen.getByTestId('cover-disclosure')
    expect(line.textContent).toMatch(/Sungold/)
    expect(line.textContent).toMatch(/cover/i)
    expect(screen.queryByTestId('cover-disclosure-generic')).toBeNull()
  })

  it('does NOT name a planting whose hero is only the effective fallback', async () => {
    await mount({ plants: [PLANT_FALLBACK] })
    await armDelete(STANDALONE)
    expect(screen.queryByTestId('cover-disclosure')).toBeNull()
    expect(screen.queryByText(/Cherokee Purple/)).toBeNull()
  })

  // THE HONESTY CLAUSE. This surface cannot see container/zone/inventory/space cover pointers, so
  // silence would be a false all-clear. The generic line is what stands in that case, and it must
  // never be rewritten into a negative claim.
  it('says nothing it cannot know: no named cover means the generic consequence, not an all-clear', async () => {
    await mount({ plants: [] })
    await armDelete(STANDALONE)
    const generic = screen.getByTestId('cover-disclosure-generic')
    expect(generic.textContent).toMatch(/if this photo is the cover photo anywhere/i)
    expect(generic.textContent).not.toMatch(/not the cover|isn’t the cover|is not the cover/i)
  })

  // Scoped to the SHEET, not the page: "Recently deleted" is also the header link, so an unscoped
  // query passes on the wrong element and would keep passing if the sheet's promise were deleted.
  it('the sheet itself promises the recovery surface by name', async () => {
    await mount()
    await armDelete(STANDALONE)
    const sheet = within(screen.getByTestId('photo-delete-body'))
    expect(sheet.getByText(/Recently deleted/)).toBeTruthy()
    expect(sheet.getByText(/Nothing is removed\s*permanently/)).toBeTruthy()
  })

  it('the share caveat is absent where sharing is not configured', async () => {
    await mount()
    await armDelete(STANDALONE)
    expect(screen.queryByTestId('share-disclosure')).toBeNull()
  })

  it('the share caveat appears once sharing is configured, and does not overstate the delete', async () => {
    vi.stubEnv('VITE_API_FACEBOOK_SHARE', 'https://example.invalid/share')
    await mount()
    await armDelete(STANDALONE)
    // share_log.photo_id is a RETAIN pointer: a soft delete here cannot retract an external post,
    // so the copy must not imply that it does.
    expect(screen.getByTestId('share-disclosure').textContent).toMatch(/does not remove it from anywhere you have already shared/i)
  })
})

describe('coverForPhoto — the derivation, in isolation', () => {
  it('selects only EXPLICIT designations of this exact photo', () => {
    const plants = [
      PLANT_EXPLICIT,
      PLANT_FALLBACK,
      { id: 'pl-3', name: 'Other', featured_photo_id: 'ph-9', featured_is_explicit: true },
    ]
    expect(coverForPhoto('ph-1', plants)).toEqual([{ id: 'pl-1', name: 'Sungold' }])
  })

  it('is empty, never throwing, for a missing id or a missing list', () => {
    expect(coverForPhoto(null, [PLANT_EXPLICIT])).toEqual([])
    expect(coverForPhoto('ph-1', null)).toEqual([])
    expect(coverForPhoto('ph-1', [null, undefined])).toEqual([])
  })
})
