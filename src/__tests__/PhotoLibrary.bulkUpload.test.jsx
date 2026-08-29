// PhotoLibrary.bulkUpload.test.jsx — V4-PHOTOBULK-001, the camera-roll path.
//
// This is the file that answers Dave's actual ask: upload a batch of photos and tag them to
// plantings afterwards. Two destinations out of one form:
//   TARGET CHOSEN  -> every photo attached to it (the shipped behaviour, N times).
//   NO TARGET      -> intake_status='pending_tag', no parent — the inbox — which then surfaces
//                     under this page's existing "Untagged" filter and drains through its tag modal.
//
// THE INBOX ARM IS THE ONE THAT NEEDS PINNING, because it writes a row state nothing else in the
// client writes and it relaxes a rule (`photos_must_have_parent`) that exists for good reasons. The
// relaxation is legal — the CHECK admits a parentless row for exactly this status, and
// POST /api/photos validates and stores it (lambda/photos/index.js:1161-1174, live in prod) — but
// legal is not the same as guarded, so the >1 gate and the flag gate are asserted, not assumed.
//
// Mirrors the sibling PhotoLibrary.test.jsx harness deliberately, including PROJECTS_HIDDEN: false,
// so the two files describe the same UI and a divergence shows up as a conflict rather than as two
// suites quietly testing different pages.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchSpy, uploadSpy, uploadImpl, flagRef } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  uploadSpy: vi.fn(),
  uploadImpl: { current: async () => ({ photo: { id: 'p' } }) },
  flagRef: { current: true },
}))

vi.mock('../lib/featureFlags.js', async (importActual) => {
  const actual = await importActual()
  return {
    ...actual,
    PROJECTS_HIDDEN: false,
    get PHOTO_MULTI_ATTACH_ENABLED() { return flagRef.current },
  }
})
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: (...args) => { uploadSpy(...args); return uploadImpl.current(...args) },
    isUploading: false, error: null, photo: null, preview: null, stage: null, progress: null, reset: vi.fn(),
  }),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <div data-testid="photo-upload-stub" /> }))

import PhotoLibrary from '../pages/PhotoLibrary.jsx'

const SAMPLE_PROJECT = { id: 'proj-1', name: 'Spring 2026' }
const SAMPLE_LOCATION = { id: 'loc-1', full_path: 'Garden › Bed A', is_active: true }

let createdUrls, revokedUrls, origCreate, origRevoke

beforeEach(() => {
  fetchSpy.mockReset()
  uploadSpy.mockReset()
  uploadImpl.current = async () => ({ photo: { id: 'p' } })
  flagRef.current = true
  createdUrls = []; revokedUrls = []
  origCreate = URL.createObjectURL; origRevoke = URL.revokeObjectURL
  let n = 0
  URL.createObjectURL = vi.fn(() => { const u = `blob:pl-${++n}`; createdUrls.push(u); return u })
  URL.revokeObjectURL = vi.fn(u => { revokedUrls.push(u) })
})

afterEach(() => {
  // jsdom ships neither; restoring a literal undefined breaks RTL's auto-unmount, which runs in its
  // own afterEach and may fire after this one.
  URL.createObjectURL = typeof origCreate === 'function' ? origCreate : (() => 'blob:noop')
  URL.revokeObjectURL = typeof origRevoke === 'function' ? origRevoke : (() => {})
})

function primeMount({ projects = [SAMPLE_PROJECT], locations = [SAMPLE_LOCATION], photos = [] } = {}) {
  fetchSpy.mockResolvedValueOnce(projects)
  fetchSpy.mockResolvedValueOnce(locations)
  fetchSpy.mockResolvedValue(photos)
}

async function openForm() {
  primeMount()
  render(<PhotoLibrary />)
  await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/projects'))
  fireEvent.click(screen.getByText('+ Upload'))
}

const jpg = (name) => new File(['x'], name, { type: 'image/jpeg' })

async function stage(names) {
  const input = screen.getByTestId('pl-staged-input')
  await act(async () => { fireEvent.change(input, { target: { files: names.map(jpg) } }) })
}

const upload = async () => { await act(async () => { fireEvent.click(screen.getByTestId('pl-staged-upload')) }) }

describe('PhotoLibrary bulk upload — attach a batch to one target', () => {
  it('the picker accepts several photos and stages all of them', async () => {
    await openForm()
    expect(screen.getByTestId('pl-staged-input').hasAttribute('multiple')).toBe(true)
    await stage(['a.jpg', 'b.jpg', 'c.jpg'])
    expect(screen.getAllByTestId('pl-staged-item')).toHaveLength(3)
    // With a target chosen it is a plain batch attach; without one it offers the inbox instead
    // (covered in its own describe below).
    fireEvent.change(screen.getByDisplayValue('— Select project —'), { target: { value: 'proj-1' } })
    expect(screen.getByTestId('pl-staged-upload').textContent).toMatch(/Upload 3 photos/i)
  })

  it('one photo still renders the full-width preview, not a strip', async () => {
    await openForm()
    await stage(['solo.jpg'])
    expect(screen.getByTestId('pl-staged-preview')).toBeTruthy()
    expect(screen.queryByTestId('pl-staged-strip')).toBeNull()
    expect(screen.getByTestId('pl-staged-upload').textContent).toMatch(/Upload photo/i)
  })

  it('uploads every staged photo to the chosen target, serially, with the same linkage', async () => {
    let live = 0, peak = 0
    uploadImpl.current = async () => {
      live += 1; peak = Math.max(peak, live); await Promise.resolve(); live -= 1
      return { photo: { id: 'p' } }
    }
    await openForm()
    await stage(['a.jpg', 'b.jpg', 'c.jpg'])
    fireEvent.change(screen.getByDisplayValue('— Select project —'), { target: { value: 'proj-1' } })
    await upload()

    expect(uploadSpy).toHaveBeenCalledTimes(3)
    expect(peak).toBe(1)                                   // serial, one decode at a time
    for (const [, opts] of uploadSpy.mock.calls) {
      expect(opts.linkage.project_id).toBe('proj-1')
      // A targeted batch is NOT an inbox write, and must never acquire the pending state.
      expect(opts.linkage.intake_status).toBeUndefined()
    }
  })
})

describe('PhotoLibrary bulk upload — the inbox arm (no target)', () => {
  it('offers the untagged route for a BATCH, and says where the photos will go', async () => {
    await openForm()
    await stage(['a.jpg', 'b.jpg'])
    expect(screen.getByTestId('pl-untagged-notice').textContent).toMatch(/go to Untagged/i)
    const btn = screen.getByTestId('pl-staged-upload')
    expect(btn.disabled).toBe(false)
    expect(btn.textContent).toMatch(/Upload 2 to Untagged/i)
  })

  it('writes intake_status=pending_tag and NO parent on every photo in the batch', async () => {
    await openForm()
    await stage(['a.jpg', 'b.jpg'])
    await upload()

    expect(uploadSpy).toHaveBeenCalledTimes(2)
    for (const [, opts] of uploadSpy.mock.calls) {
      expect(opts.linkage).toEqual({ intake_status: 'pending_tag' })
      // Parentless is the POINT here, but only in company with pending_tag — assert the pairing,
      // since a parentless row with any other status violates photos_must_have_parent outright.
      expect(opts.linkage.project_id).toBeUndefined()
      expect(opts.linkage.location_id).toBeUndefined()
      expect(opts.linkage.plant_id).toBeUndefined()
    }
  })

  it('a SINGLE untagged photo is still refused — the shipped slip-catcher is intact', async () => {
    await openForm()
    await stage(['lonely.jpg'])
    expect(screen.queryByTestId('pl-untagged-notice')).toBeNull()
    expect(screen.getByText(/needs at least a project or zone/i)).toBeTruthy()
    const btn = screen.getByTestId('pl-staged-upload')
    expect(btn.disabled).toBe(true)
    await upload()
    expect(uploadSpy).not.toHaveBeenCalled()
  })

  it('choosing a target switches the batch OFF the inbox route', async () => {
    await openForm()
    await stage(['a.jpg', 'b.jpg'])
    expect(screen.getByTestId('pl-staged-upload').textContent).toMatch(/to Untagged/i)
    fireEvent.change(screen.getByDisplayValue('— Select project —'), { target: { value: 'proj-1' } })
    expect(screen.queryByTestId('pl-untagged-notice')).toBeNull()
    expect(screen.getByTestId('pl-staged-upload').textContent).toMatch(/Upload 2 photos/i)
    await upload()
    expect(uploadSpy.mock.calls[0][1].linkage.intake_status).toBeUndefined()
  })
})

describe('PhotoLibrary bulk upload — partial failure', () => {
  it('keeps the failures staged, drops the ones that landed, and reports the count', async () => {
    uploadImpl.current = async (f) => (f.name === 'b.jpg' ? { error: 'S3 refused' } : { photo: { id: f.name } })
    await openForm()
    await stage(['a.jpg', 'b.jpg', 'c.jpg'])
    fireEvent.change(screen.getByDisplayValue('— Select project —'), { target: { value: 'proj-1' } })
    await upload()

    // The survivors' rows exist server-side; re-uploading them would duplicate. Only the failure
    // stays staged, so the retry is one tap rather than a re-pick of all three. One left means the
    // strip collapses back to the shipped full-width preview, asserted below.
    await waitFor(() => expect(screen.getByTestId('pl-batch-summary')).toBeTruthy())
    expect(screen.queryAllByTestId('pl-staged-item')).toHaveLength(0)
    expect(screen.getByTestId('pl-staged-upload').textContent).toMatch(/Upload photo/i)
    expect(screen.getByTestId('pl-batch-summary').textContent).toMatch(/2 of 3 uploaded/i)
    // The form stays OPEN — closing it would strand the retry.
    expect(screen.getByTestId('photo-library-upload-form')).toBeTruthy()
    // And the failure still SAYS what went wrong. With one photo left the strip collapses to the
    // shipped full-width preview, which has nowhere to put a per-row error — so the reason has to
    // ride the summary line. Losing it here was a real defect a mutation run surfaced.
    expect(screen.getByTestId('pl-batch-summary').textContent).toMatch(/S3 refused/)
    expect(screen.getByTestId('pl-staged-preview')).toBeTruthy()
  })

  it('with TWO failures left, each row names its own reason', async () => {
    uploadImpl.current = async (f) =>
      (f.name === 'a.jpg' ? { photo: { id: 'a' } } : { error: `refused ${f.name}` })
    await openForm()
    await stage(['a.jpg', 'b.jpg', 'c.jpg'])
    fireEvent.change(screen.getByDisplayValue('— Select project —'), { target: { value: 'proj-1' } })
    await upload()

    await waitFor(() => expect(screen.getAllByTestId('pl-staged-item')).toHaveLength(2))
    const errs = screen.getAllByTestId('pl-staged-error').map(e => e.textContent)
    expect(errs).toEqual(['refused b.jpg', 'refused c.jpg'])
  })

  it('a whole-batch failure surfaces the real error text, not a generic one', async () => {
    uploadImpl.current = async () => ({ error: 'Upload stalled — check your signal' })
    await openForm()
    await stage(['a.jpg', 'b.jpg'])
    fireEvent.change(screen.getByDisplayValue('— Select project —'), { target: { value: 'proj-1' } })
    await upload()
    // SCOPED TO THE BANNER, deliberately. The per-row errors carry this same text, so a loose
    // findAllByText passes even when the banner degrades to a generic "Upload failed." — the
    // mutation harness caught exactly that and reported the guard vacuous. The rows are a redundant
    // channel here; assert the one under test and let the rows be asserted where they are the
    // subject (the partial-failure case above).
    const banner = await screen.findByTestId('pl-err-banner')
    expect(banner.textContent).toMatch(/Upload stalled — check your signal/)
    expect(screen.getAllByTestId('pl-staged-item')).toHaveLength(2)   // nothing dropped
  })

  it('a whole-batch failure of ONE photo keeps the shipped bare error, with no batch preamble', async () => {
    uploadImpl.current = async () => ({ error: 'mock failure' })
    await openForm()
    await stage(['solo.jpg'])
    fireEvent.change(screen.getByDisplayValue('— Select project —'), { target: { value: 'proj-1' } })
    await upload()
    const banner = await screen.findByTestId('pl-err-banner')
    expect(banner.textContent).toBe('mock failure')      // exact: no "None of the 1 photos" wrapper
  })
})

describe('PhotoLibrary bulk upload — object URLs', () => {
  it('removing one staged photo revokes exactly that URL', async () => {
    await openForm()
    await stage(['a.jpg', 'b.jpg', 'c.jpg'])
    await act(async () => { fireEvent.click(screen.getAllByTestId('pl-staged-remove')[1]) })
    expect(screen.getAllByTestId('pl-staged-item')).toHaveLength(2)
    expect(revokedUrls).toEqual([createdUrls[1]])
  })

  it('"Remove all" revokes every staged URL', async () => {
    await openForm()
    await stage(['a.jpg', 'b.jpg', 'c.jpg'])
    await act(async () => { fireEvent.click(screen.getByTestId('pl-stage-clear')) })
    expect(new Set(revokedUrls)).toEqual(new Set(createdUrls))
    expect(screen.queryAllByTestId('pl-staged-item')).toHaveLength(0)
  })
})

describe('PhotoLibrary bulk upload — flag OFF is byte-identical', () => {
  beforeEach(() => { flagRef.current = false })

  it('the picker takes one file and the inbox route does not exist', async () => {
    await openForm()
    expect(screen.getByTestId('pl-staged-input').hasAttribute('multiple')).toBe(false)
    await stage(['a.jpg', 'b.jpg', 'c.jpg'])
    expect(screen.getByTestId('pl-staged-preview')).toBeTruthy()
    expect(screen.queryByTestId('pl-staged-strip')).toBeNull()
    // No target, one photo: the shipped rule, unchanged.
    expect(screen.queryByTestId('pl-untagged-notice')).toBeNull()
    expect(screen.getByTestId('pl-staged-upload').disabled).toBe(true)
  })

  it('re-picking REPLACES the staged photo and revokes the old URL', async () => {
    await openForm()
    await stage(['a.jpg'])
    await stage(['b.jpg'])
    expect(revokedUrls).toEqual([createdUrls[0]])
    expect(screen.getByTestId('pl-stage-replace').textContent).toMatch(/Change photo/i)
  })
})
