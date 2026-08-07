/**
 * src/__tests__/PhotoLibrary.test.jsx
 * V2-PHOTO-F1 Session 2 — PhotoLibrary refactor regression tests.
 *
 * Scope:
 *   - Page renders header and upload toggle.
 *   - Upload trigger toggles the form open.
 *   - PhotoUpload component receives the canonical props
 *     (keyPrefix='standalone', linkage shape, errorMode='surface').
 *   - The trigger is disabled until project_id is picked (regression-critical
 *     gate from the pre-refactor behavior).
 *   - On successful upload via PhotoUpload, the photo list re-fetches and
 *     the form resets (handleUploadComplete contract).
 *
 * Mocks:
 *   - useApiFetch -> fetchSpy
 *   - PhotoUpload -> capture-style stub that exposes its props + provides a
 *     "complete" button to trigger onUploadComplete and verify cleanup.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchSpy, photoUploadProps } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  photoUploadProps: { current: null },
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
}))

// BUG-PHOTOFIRST-001: PhotoLibrary now drives useUploadPhoto directly (photo staged first, uploaded
// on an explicit press). Mock the HOOK, not api.js — the real hook imports `apiFetch` at module
// load, which this file's api.js mock does not provide, so collection fails before any test runs.
const { uploadSpy, uploadResultRef } = vi.hoisted(() => ({
  uploadSpy: vi.fn(),
  uploadResultRef: { current: { photo: { id: 'new-photo' } } },
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: (...args) => { uploadSpy(...args); return Promise.resolve(uploadResultRef.current) },
    isUploading: false, error: null, photo: null, preview: null, stage: null, progress: null, reset: vi.fn(),
  }),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

vi.mock('../components/PhotoUpload.jsx', () => ({
  default: (props) => {
    photoUploadProps.current = props
    return (
      <div data-testid="photo-upload-stub" data-disabled={props.disabled ? 'true' : 'false'}>
        <button
          type="button"
          data-testid="trigger-complete"
          onClick={() => props.onUploadComplete?.({ id: 'photo-new' })}
        >fake-upload</button>
        <button
          type="button"
          data-testid="trigger-error"
          onClick={() => props.onUploadError?.('mock failure')}
        >fake-error</button>
      </div>
    )
  },
}))

import PhotoLibrary from '../pages/PhotoLibrary.jsx'

const SAMPLE_PROJECT  = { id: 'proj-1', name: 'Spring 2026' }
const SAMPLE_LOCATION = { id: 'loc-1', full_path: 'Garden › Bed A', is_active: true }

beforeEach(() => {
  fetchSpy.mockReset()
  photoUploadProps.current = null
  uploadSpy.mockReset()
  uploadResultRef.current = { photo: { id: 'new-photo' } }
  // jsdom implements neither; the staged preview builds a blob URL on every pick.
  if (typeof URL.createObjectURL !== 'function') URL.createObjectURL = vi.fn(() => 'blob:stub')
  if (typeof URL.revokeObjectURL !== 'function') URL.revokeObjectURL = vi.fn()
})

function primeMount({ projects = [SAMPLE_PROJECT], locations = [SAMPLE_LOCATION], photos = [] } = {}) {
  fetchSpy.mockResolvedValueOnce(projects)   // /api/projects
  fetchSpy.mockResolvedValueOnce(locations)  // /api/locations/with-path
  fetchSpy.mockResolvedValueOnce(photos)     // /api/photos
}

describe('PhotoLibrary — V2-PHOTO-F1 S2 refactor', () => {
  // BUG-PHOTOFIRST-001 (BD-001) — these tests were rewritten wholesale, not adjusted. They used to
  // assert the OLD contract: a <PhotoUpload> stub whose `disabled` prop was true until a target was
  // chosen. That gate IS the bug Dave reported ("I don't know what the photo is until I look at it"),
  // so a test asserting it holds could only have been kept by keeping the defect.
  // The one-of-target rule itself is unchanged and still pinned below — it just governs SENDING now,
  // not PICKING.
  const stageAPhoto = async () => {
    const input = screen.getByTestId('pl-staged-input')
    const file = new File(['x'], 'bed.jpg', { type: 'image/jpeg' })
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }) })
    return file
  }

  it('renders header and toggles the upload form open', async () => {
    primeMount()
    render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/projects'))
    fireEvent.click(screen.getByText('+ Upload'))
    expect(screen.getByTestId('photo-library-upload-form')).toBeDefined()
    expect(screen.getByTestId('pl-stage-take')).toBeDefined()
    expect(screen.getByTestId('pl-stage-choose')).toBeDefined()
  })

  // THE FIX, stated as an invariant: nothing about the target may gate the camera.
  it('never gates the photo picker on a target being chosen', async () => {
    primeMount()
    render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/projects'))
    fireEvent.click(screen.getByText('+ Upload'))
    expect(screen.getByTestId('pl-stage-take').disabled).toBeFalsy()
    expect(screen.getByTestId('pl-stage-choose').disabled).toBeFalsy()
    // ...and the send is what waits.
    expect(screen.getByTestId('pl-staged-upload').disabled).toBe(true)
    expect(screen.getByTestId('pl-staged-upload').textContent).toMatch(/Pick a photo first/i)
  })

  it('previews the staged photo and only then asks where it goes', async () => {
    primeMount()
    render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/projects'))
    fireEvent.click(screen.getByText('+ Upload'))
    // The target hint must not nag before there is anything to place.
    expect(screen.queryByText(/needs at least a project or zone/i)).toBeNull()
    await stageAPhoto()
    expect(screen.getByTestId('pl-staged-preview')).toBeDefined()
    expect(screen.getByText(/Where does this one go\?/i)).toBeDefined()
    expect(screen.getByText(/needs at least a project or zone/i)).toBeDefined()
  })

  it('blocks the upload until a project is selected, then allows it', async () => {
    primeMount()
    render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/projects'))
    fireEvent.click(screen.getByText('+ Upload'))
    await stageAPhoto()
    expect(screen.getByTestId('pl-staged-upload').disabled).toBe(true)
    fetchSpy.mockResolvedValueOnce([])  // plants-for-upload effect
    await act(async () => {
      fireEvent.change(screen.getByDisplayValue(/Select project/i), { target: { value: 'proj-1' } })
    })
    await waitFor(() => expect(screen.getByTestId('pl-staged-upload').disabled).toBe(false))
  })

  // V4-PHOTOLOCFIND-001: one-of target gate — a space alone is a valid home (the meta-photo case);
  // project is no longer singularly required. Unchanged by BUG-PHOTOFIRST-001, re-pinned on the
  // send button instead of the picker.
  it('accepts a space alone as the target (one-of gate)', async () => {
    primeMount()
    render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/projects'))
    fireEvent.click(screen.getByText('+ Upload'))
    await stageAPhoto()
    expect(screen.getByTestId('pl-staged-upload').disabled).toBe(true)
    await act(async () => {
      fireEvent.change(screen.getByDisplayValue('— None —'), { target: { value: 'loc-1' } })
    })
    await waitFor(() => expect(screen.getByTestId('pl-staged-upload').disabled).toBe(false))
  })

  it('space filter chip queries the server with ?location_id= (V4-PHOTOLOCFIND-001)', async () => {
    primeMount()
    render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/photos'))
    fetchSpy.mockResolvedValueOnce([])  // the refetch the filter change triggers
    const spaceFilter = screen.getByDisplayValue('Filter by zone…')
    await act(async () => {
      fireEvent.change(spaceFilter, { target: { value: 'loc-1' } })
    })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/photos?location_id=loc-1'))
  })

  it('untagged filter treats a space-only photo as tagged (V002 E2: not unfinished work)', async () => {
    const spaceOnly = { id: 'p-loc',  event_id: null, project_id: null, location_id: 'loc-1', plant_id: null, view_url: 'https://x/a.jpg', caption: 'space photo' }
    const bare      = { id: 'p-bare', event_id: null, project_id: null, location_id: null,    plant_id: null, view_url: 'https://x/b.jpg', caption: 'bare photo' }
    primeMount({ photos: [spaceOnly, bare] })
    render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/photos'))
    fetchSpy.mockResolvedValueOnce([spaceOnly, bare])  // refetch on mode change
    await act(async () => {
      fireEvent.click(screen.getByText('Untagged'))
    })
    await waitFor(() => expect(screen.getByAltText('bare photo')).toBeDefined())
    expect(screen.queryByAltText('space photo')).toBeNull()
  })

  // V4-SPACEPHOTO-001 Lane C (AC-3). The case above still calls a location_id photo "space-only" —
  // the pre-Lane-C vocabulary. This is the TRUE space tier: a photo whose only parent is space_id.
  // The predicate arm is unconditional, so this holds regardless of SPACE_PHOTOS_ENABLED.
  it('untagged filter treats a space_id-only photo as tagged (V4-SPACEPHOTO-001 AC-3)', async () => {
    const spaceOnly = { id: 'p-space', event_id: null, project_id: null, location_id: null, plant_id: null, space_id: 'space-1', view_url: 'https://x/s.jpg', caption: 'the whole place' }
    const bare      = { id: 'p-bare',  event_id: null, project_id: null, location_id: null, plant_id: null, space_id: null,      view_url: 'https://x/b.jpg', caption: 'bare photo' }
    primeMount({ photos: [spaceOnly, bare] })
    render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/photos'))
    fetchSpy.mockResolvedValueOnce([spaceOnly, bare])
    await act(async () => {
      fireEvent.click(screen.getByText('Untagged'))
    })
    await waitFor(() => expect(screen.getByAltText('bare photo')).toBeDefined())
    expect(screen.queryByAltText('the whole place')).toBeNull()
  })

  // V4-PHOTOMODEL-001. The sixth parent. This predicate was written against four parents, then
  // grown to five (space), and inventory_item_id was never added — so the 6 live inventory photos
  // measured in prod 2026-08-07 were reported as unfinished work on every visit. Those are the same
  // six BUG-PHOTOPARENT-001 recorded as having "no parent link at all": they are fully attached,
  // and only the truncated parent model could not see it.
  it('untagged filter treats an inventory-only photo as tagged (the BUG-PHOTOPARENT-001 six)', async () => {
    const invOnly = { id: 'p-inv',  event_id: null, project_id: null, location_id: null, plant_id: null, space_id: null, inventory_item_id: 'inv-1', view_url: 'https://x/i.jpg', caption: 'seed packet' }
    const bare    = { id: 'p-bare', event_id: null, project_id: null, location_id: null, plant_id: null, space_id: null, inventory_item_id: null,    view_url: 'https://x/b.jpg', caption: 'bare photo' }
    primeMount({ photos: [invOnly, bare] })
    render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/photos'))
    fetchSpy.mockResolvedValueOnce([invOnly, bare])
    await act(async () => {
      fireEvent.click(screen.getByText('Untagged'))
    })
    await waitFor(() => expect(screen.getByAltText('bare photo')).toBeDefined())
    expect(screen.queryByAltText('seed packet')).toBeNull()
  })

  it('sends the staged file with the chosen linkage, then resets and reloads', async () => {
    primeMount()
    render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/projects'))
    fireEvent.click(screen.getByText('+ Upload'))
    const file = await stageAPhoto()
    fetchSpy.mockResolvedValueOnce([])  // plants-for-upload after project change
    await act(async () => {
      fireEvent.change(screen.getByDisplayValue(/Select project/i), { target: { value: 'proj-1' } })
    })
    fetchSpy.mockResolvedValueOnce([{ id: 'photo-new', view_url: 'https://example/photo-new.jpg', project_id: 'proj-1' }])
    await act(async () => { fireEvent.click(screen.getByTestId('pl-staged-upload')) })

    // The staged FILE is what gets sent — the whole point of deferring the upload.
    expect(uploadSpy).toHaveBeenCalledTimes(1)
    const [sentFile, opts] = uploadSpy.mock.calls[0]
    expect(sentFile).toBe(file)
    expect(opts.keyPrefix).toBe('standalone')
    expect(opts.linkage).toEqual({ project_id: 'proj-1', location_id: null, plant_id: null })

    await waitFor(() => {
      const photoCalls = fetchSpy.mock.calls.filter(c => c[0]?.startsWith('/api/photos'))
      expect(photoCalls.length).toBeGreaterThanOrEqual(2)
    })
    // Form closed and staging cleared, so the next open starts from a clean picker.
    await waitFor(() => expect(screen.queryByTestId('photo-library-upload-form')).toBeNull())
  })

  it('surfaces upload errors and keeps the photo staged', async () => {
    primeMount()
    render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/projects'))
    fireEvent.click(screen.getByText('+ Upload'))
    await stageAPhoto()
    fetchSpy.mockResolvedValueOnce([])
    await act(async () => {
      fireEvent.change(screen.getByDisplayValue(/Select project/i), { target: { value: 'proj-1' } })
    })
    uploadResultRef.current = { error: 'mock failure' }
    await act(async () => { fireEvent.click(screen.getByTestId('pl-staged-upload')) })
    await waitFor(() => expect(screen.getByText(/mock failure/)).toBeDefined())
    // Losing the user's photo on a failed send would be the worse bug: it must still be there to retry.
    expect(screen.getByTestId('pl-staged-preview')).toBeDefined()
  })

  // V1.2a-3 Increment A (I1): the tag modal's Save must PUT to /api/photos/:id.
  // Before the photos Lambda PUT route existed this 405'd and the raw
  // "Method not allowed" string surfaced in the modal.
  it('saving tags on a photo PUTs to /api/photos/:id', async () => {
    primeMount({
      photos: [{
        id: 'photo-9', caption: 'tag me',
        view_url: 'https://example/p.jpg',
        project_id: 'proj-1', location_id: null, plant_id: null,
      }],
    })
    render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/projects'))

    // Opening the modal (openModal) seeds tagForm.project_id from the photo,
    // which fires the modal's plants-for-project effect — prime that fetch.
    fetchSpy.mockResolvedValueOnce([])
    await act(async () => {
      fireEvent.click(screen.getByAltText('tag me').closest('button'))
    })
    expect(screen.getByText('Save tags')).toBeDefined()

    // PUT response
    fetchSpy.mockResolvedValueOnce({ id: 'photo-9', project_id: 'proj-1' })
    await act(async () => {
      fireEvent.click(screen.getByText('Save tags'))
    })

    const putCall = fetchSpy.mock.calls.find(
      c => c[0] === '/api/photos/photo-9' && c[1]?.method === 'PUT'
    )
    expect(putCall).toBeDefined()
    const body = JSON.parse(putCall[1].body)
    expect(body.project_id).toBe('proj-1')
  })

  // V4-SPACECLIENTGAP-001 — the one-of gate must name EVERY parent photos_must_have_parent counts.
  // It was written against three of them, and `newPlant` was computed and then never consulted.
  // Both cases below are photos the CHECK considers properly parented, so blocking their save is
  // purely a client-side lie; the plant case is a LIVE PROD BUG independent of the space work.
  async function openAndSave(photo) {
    primeMount({ photos: [photo] })
    render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/projects'))
    fetchSpy.mockResolvedValueOnce([])
    await act(async () => {
      fireEvent.click(screen.getByAltText(photo.caption).closest('button'))
    })
    fetchSpy.mockResolvedValueOnce({ id: photo.id })
    await act(async () => { fireEvent.click(screen.getByText('Save tags')) })
    return fetchSpy.mock.calls.find(c => c[0] === `/api/photos/${photo.id}` && c[1]?.method === 'PUT')
  }

  it('saves a PLANT-only photo instead of refusing it (live prod bug)', async () => {
    // plant_id set, no project, no location, no event. The old guard ignored newPlant entirely, so
    // this photo could not be caption-edited at all. Mutation: drop `!newPlant` and this reds.
    const put = await openAndSave({
      id: 'photo-plant', caption: 'plant only', view_url: 'https://example/p.jpg',
      project_id: null, location_id: null, plant_id: 'plant-1', event_id: null,
    })
    expect(put, 'a plant-parented photo must be editable').toBeDefined()
    expect(screen.queryByText(/A standalone photo needs/)).toBeNull()
  })

  it('saves a SPACE-only photo — space_id is read from the row, which the PUT never clears', async () => {
    // The general PUT neither accepts nor SETs space_id, so the attachment survives this save and
    // the CHECK still passes. Reading modal.space_id is therefore the correct source.
    // Mutation: drop `!modal.space_id` and this reds.
    const put = await openAndSave({
      id: 'photo-space', caption: 'space only', view_url: 'https://example/p.jpg',
      project_id: null, location_id: null, plant_id: null, event_id: null, space_id: 'space-1',
    })
    expect(put, 'a space-parented photo must be editable').toBeDefined()
    expect(screen.queryByText(/A standalone photo needs/)).toBeNull()
  })

  it('still refuses a genuinely parentless photo', async () => {
    // The guard must not become vacuous: a photo with no parent at all would 500 on the CHECK.
    const put = await openAndSave({
      id: 'photo-orphan', caption: 'orphan', view_url: 'https://example/p.jpg',
      project_id: null, location_id: null, plant_id: null, event_id: null, space_id: null,
    })
    expect(put, 'a parentless photo must NOT be PUT').toBeUndefined()
    expect(screen.getByText(/A standalone photo needs at least a project, zone, or plant/)).toBeDefined()
  })
})

describe('PhotoLibrary — V3-PHOTODBG-001 visible load-failure state', () => {
  it('shows a visible error + Retry (not the empty state) when /api/photos fails with a 5xx', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_PROJECT])   // /api/projects
    fetchSpy.mockResolvedValueOnce([SAMPLE_LOCATION])  // /api/locations/with-path
    const e = new Error('HTTP 502'); e.status = 502
    fetchSpy.mockRejectedValueOnce(e)                  // /api/photos -> fail
    render(<PhotoLibrary />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/load your photos/i)
    // must NOT masquerade as the empty state
    expect(screen.queryByText(/No photos yet/i)).toBeNull()
    const retry = screen.getByText('Retry')
    expect(retry).toBeDefined()
    // Card now comes from AsyncRegion: ≥44px tap target + glyph hidden from AT (previously
    // this surface had neither — the tap target computed to ~34px).
    expect(parseInt(retry.style.minHeight, 10)).toBeGreaterThanOrEqual(44)
    expect(alert.firstChild.getAttribute('aria-hidden')).toBe('true')
    // retry calls loadPhotos ONLY (one fetch: /api/photos) — not the projects/locations effects
    fetchSpy.mockResolvedValueOnce([])
    fireEvent.click(retry)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByText(/No photos yet/i)).toBeDefined()
  })

  // V3-PHOTODBG-001 (4/4): a render-time fault in any PhotoCard must be contained by the
  // grid ErrorBoundary (contained retry card) and must NOT white-screen the whole page.
  it('contains a PhotoCard render fault in the grid ErrorBoundary (page header survives)', async () => {
    const poison = { id: 'p-bad', view_url: 'https://example/p.jpg', get project_name() { throw new Error('render boom') } }
    fetchSpy.mockResolvedValueOnce([SAMPLE_PROJECT])   // /api/projects
    fetchSpy.mockResolvedValueOnce([SAMPLE_LOCATION])  // /api/locations/with-path
    fetchSpy.mockResolvedValueOnce([poison])           // /api/photos -> poison row
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<PhotoLibrary />)
    // Fallback copy appears…
    await waitFor(() => expect(screen.getByText(/Couldn.t display your photos/i)).toBeDefined())
    // …with a Retry affordance that clears the tap-target floor…
    const retry = screen.getByRole('button', { name: 'Retry' })
    expect(parseInt(retry.style.minHeight, 10)).toBeGreaterThanOrEqual(44)
    // …and the page chrome (header) is NOT taken down by the fault (boundary contained it).
    expect(screen.getByRole('heading', { name: 'Photos' })).toBeDefined()
    errSpy.mockRestore()
  })
})
