// EventNew.multiPhoto.test.jsx — V4-PHOTOBULK-001 S2 (design V100 §3 B1, B4, B5, B6, B7, B8, X1).
//
// B1 IS THE REASON THIS SLICE EXISTS — Braindump#8, the ledger's only literal ASAP: pick three
// photos in ONE picker invocation, save once, get one event carrying all three. Before this, four
// pictures of one plant meant four saves.
//
// The criteria this file pins are mostly NEGATIVE — what multi must not break. B4 (no inbox, no
// pending_tag), B5 (the empty-photo-event guard survives as a count check), B6 (swallow semantics
// intact, failures counted not restated), B7 (the trusted-tap park still lands), B8 (N object URLs
// revoked, not one). Each of those is a shipped behaviour that a naive photoFile -> photoFiles[]
// rewrite drops silently.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, postCalls, searchParamsRef, pendingRef, uploadSpy, flagRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  searchParamsRef: { current: new URLSearchParams() },
  pendingRef: { current: null },
  uploadSpy: vi.fn(),
  flagRef: { current: true },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }), apiFetch: apiFetchSpy }))
// Take-once semantics, mirroring the real module — a mock that returned the park twice would hide
// the B7 miss case entirely.
vi.mock('../lib/pendingCapture.js', () => ({
  setPendingCapture: f => { pendingRef.current = f || null },
  takePendingCapture: () => { const f = pendingRef.current; pendingRef.current = null; return f },
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: uploadSpy,
    isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null, reset: vi.fn(),
  }),
}))
vi.mock('../lib/featureFlags.js', async (importActual) => {
  const actual = await importActual()
  return {
    ...actual,
    PROJECTS_HIDDEN: false,
    PLANTING_REQUIRED_ENABLED: false,
    get PHOTO_MULTI_ATTACH_ENABLED() { return flagRef.current },
  }
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
  pendingRef.current = null
  flagRef.current = true
  searchParamsRef.current = new URLSearchParams()
  try { localStorage.clear() } catch { /* noop */ }

  // jsdom implements neither. Counting rather than merely stubbing, because B8 is a LEAK criterion —
  // "does it revoke N" cannot be asserted against a stub that throws the calls away.
  createdUrls = []
  revokedUrls = []
  let n = 0
  globalThis.URL.createObjectURL = vi.fn(() => { const u = `blob:ev-${++n}`; createdUrls.push(u); return u })
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

// On the HARVEST form the photo block lives inside the "Photo, notes & date" disclosure (EventNew
// hoists it there for that layout only); on watering/photo it is top-level. B1 names the harvest
// form specifically, so the tests exercise that layout rather than routing around it — this opens
// the disclosure when there is one and is a no-op when the picker is already reachable.
async function openPhotoSection() {
  if (document.querySelector('input[type="file"]')) return
  const toggle = screen.queryByText(/Photo, notes & date|Photo & notes/i)
  if (toggle) await act(async () => { fireEvent.click(toggle) })
}

async function renderForm(query) {
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
  await act(async () => {
    fireEvent.change(input, { target: { files: names.map(jpg) } })
  })
}

async function save() {
  fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
  // The harvest form has its own required-quantity gate ahead of the photo leg. Satisfy it rather
  // than moving these tests to a gate-free event type — B1 names the HARVEST form, and a photo
  // criterion asserted on the watering form would not be the criterion.
  const qty = screen.queryByLabelText('Harvest quantity')
  if (qty) fireEvent.change(qty, { target: { value: '5' } })
  await act(async () => { fireEvent.click(screen.getByText('Save')) })
}

describe('EventNew multi-photo — flag ON', () => {
  it('B1: three photos in ONE picker invocation, ONE save, ONE event, three uploads', async () => {
    await renderForm('event_type=harvest&project=proj-1')
    await pickPhotos(['a.jpg', 'b.jpg', 'c.jpg'])
    expect(screen.getAllByTestId('eventnew-photo-item')).toHaveLength(3)

    await save()

    // The event is created EXACTLY once — three photos must not become three events.
    expect(postCalls.length).toBe(1)
    expect(uploadSpy).toHaveBeenCalledTimes(3)
    expect(uploadSpy.mock.calls.map(c => c[0].name)).toEqual(['a.jpg', 'b.jpg', 'c.jpg'])
  })

  it('B4: every photo is parented to the event — no inbox prefix, no intake_status', async () => {
    await renderForm('event_type=harvest&project=proj-1')
    await pickPhotos(['a.jpg', 'b.jpg'])
    await save()

    expect(uploadSpy).toHaveBeenCalledTimes(2)
    for (const [, opts] of uploadSpy.mock.calls) {
      expect(opts.keyPrefix).toBe('events')
      expect(opts.parentId).toBe('evt-1')
      expect(opts.linkage.event_id).toBe('evt-1')
      // The falsifier, stated as a property rather than a count: nothing on the in-context path may
      // mint a pending_tag row or address the Track A drain.
      expect(opts.linkage).not.toHaveProperty('intake_status')
      expect(JSON.stringify(opts)).not.toContain('pending_tag')
      expect(JSON.stringify(opts)).not.toContain('inbox')
    }
  })

  it('B1: has_photo is true for a multi-photo save', async () => {
    await renderForm('event_type=harvest&project=proj-1')
    await pickPhotos(['a.jpg', 'b.jpg'])
    await save()
    expect(postCalls[0].has_photo).toBe(true)
  })

  it('X6: uploads run serially, never concurrently', async () => {
    let live = 0, peak = 0
    uploadSpy.mockImplementation(async () => {
      live += 1; peak = Math.max(peak, live)
      await Promise.resolve()
      live -= 1
      return { photo: { id: 'p' } }
    })
    await renderForm('event_type=harvest&project=proj-1')
    await pickPhotos(['a.jpg', 'b.jpg', 'c.jpg'])
    await save()
    expect(peak).toBe(1)
  })

  it('B5: a photo event with ZERO staged files is still refused', async () => {
    await renderForm('event_type=photo&project=proj-1')
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(0)
    expect(screen.getByText(/Add a photo for a photo event/i)).toBeTruthy()
  })

  it('B5: a photo event with THREE staged files proceeds', async () => {
    await renderForm('event_type=photo&project=proj-1')
    await pickPhotos(['a.jpg', 'b.jpg', 'c.jpg'])
    await save()
    expect(postCalls.length).toBe(1)
    expect(uploadSpy).toHaveBeenCalledTimes(3)
  })

  it('B6: the event still saves when photos fail — swallow semantics survive multi', async () => {
    uploadSpy.mockResolvedValue({ error: 'S3 refused' })
    await renderForm('event_type=harvest&project=proj-1')
    await pickPhotos(['a.jpg', 'b.jpg'])
    await save()
    expect(postCalls.length).toBe(1)   // the event is NOT failed by a photo failure
  })

  it('B6: 2 of 3 failing reports the COUNT, not one failure restated as the whole batch', async () => {
    uploadSpy.mockImplementation(async (f) =>
      (f.name === 'b.jpg' ? { photo: { id: 'p' } } : { error: 'S3 refused' }))
    await renderForm('event_type=harvest&project=proj-1')
    await pickPhotos(['a.jpg', 'b.jpg', 'c.jpg'])
    await save()
    expect(await screen.findByText(/2 of 3 photos didn't upload/i)).toBeTruthy()
  })

  it('B6: ONE photo failing keeps the shipped singular sentence byte-for-byte', async () => {
    uploadSpy.mockResolvedValue({ error: 'S3 refused' })
    await renderForm('event_type=harvest&project=proj-1')
    await pickPhotos(['only.jpg'])
    await save()
    // The pinned oracle in EventNew.test.jsx / EventNewPostSaveFeedback.characterization.test.jsx.
    expect(await screen.findByText(/photo didn't upload/i)).toBeTruthy()
    expect(screen.queryByText(/of 1 photos/i)).toBeNull()
  })

  it('B6: all photos succeeding leaves the plain success message', async () => {
    await renderForm('event_type=harvest&project=proj-1')
    await pickPhotos(['a.jpg', 'b.jpg'])
    await save()
    expect(screen.queryByText(/didn't upload/i)).toBeNull()
  })

  it('B7: the trusted-tap parked File still lands, as one staged item', async () => {
    pendingRef.current = jpg('parked.jpg')
    await renderForm('event_type=photo&project=proj-1&fromquick=1')
    expect(screen.getAllByTestId('eventnew-photo-item')).toHaveLength(1)
    expect(screen.queryByText(/didn’t carry over/i)).toBeNull()
  })

  it('B7: an EMPTY park still emits the "didn\'t carry over" notice', async () => {
    pendingRef.current = null
    await renderForm('event_type=photo&project=proj-1&fromquick=1')
    expect(screen.getByText(/didn’t carry over/i)).toBeTruthy()
    expect(screen.queryAllByTestId('eventnew-photo-item')).toHaveLength(0)
  })

  it('B8: removing one staged photo revokes exactly that URL', async () => {
    await renderForm('event_type=harvest&project=proj-1')
    await pickPhotos(['a.jpg', 'b.jpg', 'c.jpg'])
    expect(createdUrls).toHaveLength(3)

    await act(async () => { fireEvent.click(screen.getByLabelText('Remove photo 2')) })
    expect(screen.getAllByTestId('eventnew-photo-item')).toHaveLength(2)
    expect(revokedUrls).toEqual([createdUrls[1]])
  })

  it('B8: the post-save reset revokes ALL N object URLs, not one', async () => {
    await renderForm('event_type=harvest&project=proj-1')
    await pickPhotos(['a.jpg', 'b.jpg', 'c.jpg'])
    expect(createdUrls).toHaveLength(3)
    expect(revokedUrls).toHaveLength(0)

    await save()

    // resetForNext -> clearPhoto(). Three in, three out; the shipped scalar version could only ever
    // revoke the last one, which is the leak this criterion exists for.
    await waitFor(() => expect(new Set(revokedUrls)).toEqual(new Set(createdUrls)))
    expect(screen.queryAllByTestId('eventnew-photo-item')).toHaveLength(0)
  })

  it('a second trip to the picker appends rather than replacing', async () => {
    await renderForm('event_type=harvest&project=proj-1')
    await pickPhotos(['a.jpg'])
    await pickPhotos(['b.jpg', 'c.jpg'])
    expect(screen.getAllByTestId('eventnew-photo-item')).toHaveLength(3)
  })

  it('the picker input carries `multiple`', async () => {
    await renderForm('event_type=harvest&project=proj-1')
    expect(document.querySelector('input[type="file"]').hasAttribute('multiple')).toBe(true)
  })
})

describe('EventNew multi-photo — flag OFF (X1: byte-identical)', () => {
  beforeEach(() => { flagRef.current = false })

  it('the picker carries NO `multiple` attribute', async () => {
    await renderForm('event_type=harvest&project=proj-1')
    expect(document.querySelector('input[type="file"]').hasAttribute('multiple')).toBe(false)
  })

  it('stages and uploads only the FIRST file, exactly as the shipped scalar did', async () => {
    await renderForm('event_type=harvest&project=proj-1')
    await pickPhotos(['a.jpg', 'b.jpg', 'c.jpg'])
    expect(screen.getAllByTestId('eventnew-photo-item')).toHaveLength(1)
    await save()
    expect(uploadSpy).toHaveBeenCalledTimes(1)
    expect(uploadSpy.mock.calls[0][0].name).toBe('a.jpg')
  })

  it('re-picking REPLACES the staged file and revokes the old URL', async () => {
    await renderForm('event_type=harvest&project=proj-1')
    await pickPhotos(['a.jpg'])
    await pickPhotos(['b.jpg'])
    expect(screen.getAllByTestId('eventnew-photo-item')).toHaveLength(1)
    expect(revokedUrls).toEqual([createdUrls[0]])
  })

  it('renders no "Add more" affordance', async () => {
    await renderForm('event_type=harvest&project=proj-1')
    await pickPhotos(['a.jpg'])
    expect(screen.queryByTestId('eventnew-photo-add-more')).toBeNull()
  })

  it('B5 still holds: a photo event with nothing attached is refused', async () => {
    await renderForm('event_type=photo&project=proj-1')
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(0)
  })
})
