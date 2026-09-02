// EventNew.photoRemoveTrap.test.jsx — BUG-PHOTOREMOVETRAP-001 (design V101 §3 item 4).
//
// THE CRITERION IS THE DEFERRAL, not the button. The shipped remove called URL.revokeObjectURL in
// the same tick as the removal, which made a mis-tap unrecoverable IN PRINCIPLE: once the blob URL
// is revoked nothing in the app can re-create it, so the only path back was a fresh trip to the
// gallery. Every "undo" assertion below is worthless unless the URL survived, so this file asserts
// the survival directly — a revoke count on the exact url, not just a restored tile.
//
// The mirror criterion is the leak. Deferring a revoke is only a fix if the URL still dies: there
// are four commit points (a newer removal, a fresh pick, the post-save reset, unmount) and each has
// its own case here. A version that never revokes would pass the recovery half and fail this half.
//
// jsdom implements neither createObjectURL nor revokeObjectURL, and has no layout engine — so the
// URLs are counted rather than stubbed (EventNew.multiPhoto.test.jsx:72 makes the same call), and
// the 44px target is asserted as the MECHANISM plus arithmetic, exactly as
// EventNew.micTouchTarget.test.jsx:3-7 says it must be.
//
// RENDER assertions only. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, postCalls, searchParamsRef, uploadSpy } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  searchParamsRef: { current: new URLSearchParams() },
  uploadSpy: vi.fn(),
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }), apiFetch: apiFetchSpy }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: uploadSpy,
    isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null, reset: vi.fn(),
  }),
}))
// Same two flags EventNew.multiPhoto.test.jsx pins, for the same reason — the save leg needs the
// Project select present and the planting gate open. PHOTO_MULTI_ATTACH_ENABLED is deliberately
// left ACTUAL: the strip is the shipped surface this bug is about.
vi.mock('../lib/featureFlags.js', async (importActual) => {
  const actual = await importActual()
  return { ...actual, PROJECTS_HIDDEN: false, PLANTING_REQUIRED_ENABLED: false }
})
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const PROJECT = { id: 'proj-1', name: 'Herb Plants', status: 'growing' }

let createdUrls
let revokedUrls

beforeEach(() => {
  apiFetchSpy.mockReset(); navigateSpy.mockReset(); postCalls.length = 0
  uploadSpy.mockReset()
  uploadSpy.mockResolvedValue({ photo: { id: 'p1' } })
  searchParamsRef.current = new URLSearchParams()
  try { localStorage.clear() } catch { /* noop */ }

  createdUrls = []
  revokedUrls = []
  let n = 0
  globalThis.URL.createObjectURL = vi.fn(() => { const u = `blob:rm-${++n}`; createdUrls.push(u); return u })
  globalThis.URL.revokeObjectURL = vi.fn(u => { revokedUrls.push(u) })

  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') {
      postCalls.push(JSON.parse(options.body))
      return Promise.resolve({ id: 'evt-1', updated_streak: 1, xp_gained: 10, newly_earned_achievements: [] })
    }
    if (path === '/api/projects') return Promise.resolve([PROJECT])
    if (path === '/api/locations/with-path') return Promise.resolve([])
    if (String(path).startsWith('/api/plants')) return Promise.resolve([])
    return Promise.resolve(null)
  })
})

async function openPhotoSection() {
  if (document.querySelector('input[type="file"]')) return
  const toggle = screen.queryByText(/Photo, notes & date|Photo & notes/i)
  if (toggle) await act(async () => { fireEvent.click(toggle) })
}

async function renderForm(query = 'event_type=harvest&project=proj-1') {
  searchParamsRef.current = new URLSearchParams(query)
  const utils = render(<ToastProvider><EventNew /></ToastProvider>)
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
  await openPhotoSection()
  return utils
}

const jpg = (name) => new File(['x'], name, { type: 'image/jpeg' })

async function pickPhotos(names) {
  const input = document.querySelector('input[type="file"]')
  await act(async () => { fireEvent.change(input, { target: { files: names.map(jpg) } }) })
}

const click = async (el) => { await act(async () => { fireEvent.click(el) }) }
const remove = (label) => click(screen.getByLabelText(label))
const undo = () => click(screen.getByTestId('eventnew-photo-undo-btn'))
const srcs = () => screen.getAllByTestId('eventnew-photo-item').map(d => d.querySelector('img').getAttribute('src'))
const timesRevoked = (u) => revokedUrls.filter(x => x === u).length

async function save() {
  fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
  const qty = screen.queryByLabelText('Harvest quantity')
  if (qty) fireEvent.change(qty, { target: { value: '5' } })
  await act(async () => { fireEvent.click(screen.getByText('Save')) })
}

describe('BUG-PHOTOREMOVETRAP-001 — removal defers the revoke', () => {
  it('the guard against this whole file going vacuous: three tiles, three object URLs', async () => {
    // Every assertion below counts revokes on urls minted here. If staging ever stops minting them
    // the counts all read zero and the deferral cases would pass for the wrong reason.
    await renderForm()
    await pickPhotos(['a.jpg', 'b.jpg', 'c.jpg'])
    expect(screen.getAllByTestId('eventnew-photo-item')).toHaveLength(3)
    expect(createdUrls).toHaveLength(3)
  })

  it('THE FIX: removing a photo revokes NOTHING — the blob outlives the removal', async () => {
    await renderForm()
    await pickPhotos(['a.jpg', 'b.jpg', 'c.jpg'])
    await remove('Remove photo 2')

    expect(screen.getAllByTestId('eventnew-photo-item')).toHaveLength(2)
    // The shipped code revoked createdUrls[1] right here, and that is what made the mis-tap
    // unrecoverable. Asserting the whole list is empty, not just "not b", so a revoke of the WRONG
    // url cannot pass either.
    expect(revokedUrls).toEqual([])
  })

  it('undo restores the tile at its ORIGINAL index, still pointing at the un-revoked URL', async () => {
    await renderForm()
    await pickPhotos(['a.jpg', 'b.jpg', 'c.jpg'])
    const before = srcs()

    await remove('Remove photo 2')
    await undo()

    // Same three, same order — and the middle one is byte-identical to the URL minted at pick time,
    // which is only possible because it was never released.
    expect(srcs()).toEqual(before)
    expect(timesRevoked(createdUrls[1])).toBe(0)
  })

  it('the undo affordance appears on removal and withdraws on undo', async () => {
    await renderForm()
    await pickPhotos(['a.jpg', 'b.jpg'])
    expect(screen.queryByTestId('eventnew-photo-undo')).toBeNull()

    await remove('Remove photo 1')
    expect(screen.getByTestId('eventnew-photo-undo')).toBeTruthy()

    await undo()
    expect(screen.queryByTestId('eventnew-photo-undo')).toBeNull()
  })

  it('the SOLO photo is as recoverable as one of six', async () => {
    // The solo remove used to call clearPhoto(), which revoked immediately — one staged photo was
    // the LEAST recoverable case, not the most.
    await renderForm()
    await pickPhotos(['only.jpg'])
    await remove('Remove photo')

    expect(screen.queryAllByTestId('eventnew-photo-item')).toHaveLength(0)
    expect(revokedUrls).toEqual([])

    await undo()
    expect(srcs()).toEqual([createdUrls[0]])
  })
})

describe('BUG-PHOTOREMOVETRAP-001 — the deferred URL still dies (no leak traded in)', () => {
  it('a SECOND removal commits the first: exactly the older url is revoked', async () => {
    await renderForm()
    await pickPhotos(['a.jpg', 'b.jpg', 'c.jpg'])

    await remove('Remove photo 1')
    expect(revokedUrls).toEqual([])
    await remove('Remove photo 1')   // 'b' is now first

    // One undo slot: parking b is what makes a un-undoable, so a is released at that instant and
    // not before. b must NOT be — it is the one still recoverable.
    expect(revokedUrls).toEqual([createdUrls[0]])
    expect(timesRevoked(createdUrls[1])).toBe(0)
  })

  it('a fresh pick commits the parked removal', async () => {
    await renderForm()
    await pickPhotos(['a.jpg'])
    await remove('Remove photo')
    expect(revokedUrls).toEqual([])

    await pickPhotos(['b.jpg'])

    expect(timesRevoked(createdUrls[0])).toBe(1)
    expect(screen.queryByTestId('eventnew-photo-undo')).toBeNull()
  })

  it('the post-save reset commits it, and the removed file is never uploaded', async () => {
    await renderForm()
    await pickPhotos(['a.jpg', 'b.jpg'])
    await remove('Remove photo 1')
    expect(revokedUrls).toEqual([])

    await save()

    await waitFor(() => expect(timesRevoked(createdUrls[0])).toBe(1))
    // The recovery window does not resurrect the file into the save — one photo staged, one upload.
    expect(uploadSpy).toHaveBeenCalledTimes(1)
    expect(uploadSpy.mock.calls[0][0].name).toBe('b.jpg')
  })

  it('unmount commits it — the parked blob does not outlive the form', async () => {
    const { unmount } = await renderForm()
    await pickPhotos(['a.jpg', 'b.jpg'])
    await remove('Remove photo 1')
    expect(revokedUrls).toEqual([])

    await act(async () => { unmount() })

    // Once, not twice: a cleanup that also ran on every re-render would double-revoke.
    expect(timesRevoked(createdUrls[0])).toBe(1)
  })

  it('remove → undo → remove → commit revokes the url ONCE, not twice', async () => {
    // The ordering that could leak in the other direction. Undo empties the slot without revoking,
    // so a naive "commit whatever was parked" on the second removal would have nothing to release —
    // and a naive "revoke on undo too" would double-release the url the tile is still using.
    const { unmount } = await renderForm()
    await pickPhotos(['a.jpg'])
    await remove('Remove photo')
    await undo()
    expect(revokedUrls).toEqual([])

    await remove('Remove photo')
    expect(revokedUrls).toEqual([])

    await act(async () => { unmount() })
    expect(timesRevoked(createdUrls[0])).toBe(1)
  })
})

describe('BUG-PHOTOREMOVETRAP-001 — the 44px hit target (WCAG 2.5.5)', () => {
  // jsdom has no layout, so this pins the MECHANISM and leaves 22+4+18 = 44 as arithmetic.
  it('every remove control in the strip carries a hit area reaching the tile corner', async () => {
    await renderForm()
    await pickPhotos(['a.jpg', 'b.jpg', 'c.jpg'])
    const btns = screen.getAllByLabelText(/^Remove photo \d+$/)
    expect(btns).toHaveLength(3)
    for (const b of btns) {
      const pad = b.querySelector('span[aria-hidden="true"]')
      expect(pad).toBeTruthy()
      expect(pad.style.position).toBe('absolute')
      // The button sits at top:4 right:4, so -4/-4 reaches the tile's corner exactly and the
      // growth is inward. All four sides asserted: one missed side is a short edge.
      expect(pad.style.top).toBe('-4px')
      expect(pad.style.right).toBe('-4px')
      expect(pad.style.bottom).toBe('-18px')
      expect(pad.style.left).toBe('-18px')
    }
  })

  it('the solo remove grows 8 on every side of its 28px circle', async () => {
    await renderForm()
    await pickPhotos(['only.jpg'])
    const pad = screen.getByLabelText('Remove photo').querySelector('span[aria-hidden="true"]')
    for (const side of ['top', 'right', 'bottom', 'left']) expect(pad.style[side]).toBe('-8px')
  })

  it('the VISIBLE circle is unchanged — the expansion must not move or grow the button', async () => {
    // The anti-regression half. Growing the button instead would slide it off the corner it is
    // pinned to and overlap the neighbouring tile in the six-across strip.
    await renderForm()
    await pickPhotos(['a.jpg', 'b.jpg'])
    for (const b of screen.getAllByLabelText(/^Remove photo \d+$/)) {
      expect(b.style.width).toBe('22px')
      expect(b.style.height).toBe('22px')
      expect(b.style.top).toBe('4px')
      expect(b.style.right).toBe('4px')
    }
  })

  it('the hit area is aria-hidden and empty, so it adds no accessible name', async () => {
    await renderForm()
    await pickPhotos(['a.jpg'])
    const b = screen.getByLabelText('Remove photo')
    expect(b.querySelector('span[aria-hidden="true"]').textContent).toBe('')
    expect(b.getAttribute('aria-label')).toBe('Remove photo')
  })
})
