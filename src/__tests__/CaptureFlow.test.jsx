// V3-CAPTURE-001 — photo-first universal create. Focused flow test (CI-authoritative).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { fetchSpy, uploadSpy, navigateSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(), uploadSpy: vi.fn(), navigateSpy: vi.fn(),
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: uploadSpy, isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateSpy,
  Link: ({ children, to }) => <a href={typeof to === 'string' ? to : '#'}>{children}</a>,
}))

import CaptureFlow from '../pages/CaptureFlow.jsx'

beforeEach(() => {
  fetchSpy.mockReset(); uploadSpy.mockReset(); navigateSpy.mockReset()
  global.URL.createObjectURL = vi.fn(() => 'blob:preview')
  global.URL.revokeObjectURL = vi.fn()
  uploadSpy.mockResolvedValue({ photo: { id: 'photo-1' } })
})

function wireLists() {
  fetchSpy.mockImplementation((path, options = {}) => {
    const m = options.method ?? 'GET'
    if (m === 'GET' && path === '/api/plants') return Promise.resolve([{ id: 'pl-1', name: 'Basil', project_id: 'proj-9', featured_photo_id: null }])
    if (m === 'GET' && path === '/api/varieties') return Promise.resolve([{ id: 'v-1', display_name: 'Genovese' }])
    if (m === 'POST' && path === '/api/plants') return Promise.resolve({ id: 'plant-new', name: 'Charentais' })
    if (m === 'POST' && path === '/api/events') return Promise.resolve({ id: 'ev-new' })
    if (m === 'POST' && path === '/api/photos') return Promise.resolve({ id: 'photo-1' })
    return Promise.resolve({ ok: true })
  })
}

async function snapTo(modeTestId) {
  await waitFor(() => expect(screen.getByTestId('capture-input')).toBeDefined())
  const file = new File(['x'], 'snap.jpg', { type: 'image/jpeg' })
  await act(async () => { fireEvent.change(screen.getByTestId('capture-input'), { target: { files: [file] } }) })
  await act(async () => { fireEvent.click(screen.getByTestId(modeTestId)) })
}

describe('CaptureFlow — V3-CAPTURE-001', () => {
  it('new planting from a snap POSTs a project-less planting and attaches the photo', async () => {
    wireLists()
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-planting')
    await act(async () => { fireEvent.change(screen.getByTestId('cap-pname'), { target: { value: 'Charentais' } }) })
    await act(async () => { fireEvent.click(screen.getByTestId('cap-save')) })
    await waitFor(() => expect(screen.getByTestId('cap-result')).toBeDefined())
    const post = fetchSpy.mock.calls.find(c => c[0] === '/api/plants' && c[1]?.method === 'POST')
    expect(post).toBeTruthy()
    const body = JSON.parse(post[1].body)
    expect(body.name).toBe('Charentais')
    expect(body.project_id).toBeNull()             // V3-CAPTURE: no project required
    expect(uploadSpy).toHaveBeenCalled()
    const linkage = uploadSpy.mock.calls[0][1].linkage
    expect(linkage.plant_id).toBe('plant-new')
  })

  it('shows Undo on the just-created row and Save & Next resets the flow', async () => {
    wireLists()
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-planting')
    await act(async () => { fireEvent.change(screen.getByTestId('cap-pname'), { target: { value: 'Charentais' } }) })
    await act(async () => { fireEvent.click(screen.getByTestId('cap-save')) })
    await waitFor(() => expect(screen.getByTestId('cap-undo')).toBeDefined())
    await act(async () => { fireEvent.click(screen.getByTestId('cap-next')) })
    // BUG-SNAPRETAKE-001: this used to assert on `capture-input`, which is now mounted in EVERY
    // step, so that assertion could no longer fail and stopped meaning "back to photo step".
    // cap-take is photo-step-only, so it still pins the reset the test is named for.
    await waitFor(() => expect(screen.getByTestId('cap-take')).toBeDefined()) // back to photo step
  })

  it('log-event mode derives project_id + plant_id from the picked planting', async () => {
    wireLists()
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-event')
    // V4-PLANTPICKER-001: pick via the shared combobox — focus opens the listbox, click the row.
    await act(async () => { fireEvent.focus(screen.getByTestId('cap-evplant')) })
    await act(async () => { fireEvent.click(await screen.findByTestId('ps-opt-pl-1')) })
    await act(async () => { fireEvent.click(screen.getByTestId('cap-save')) })
    await waitFor(() => expect(screen.getByTestId('cap-result')).toBeDefined())
    const post = fetchSpy.mock.calls.find(c => c[0] === '/api/events' && c[1]?.method === 'POST')
    const body = JSON.parse(post[1].body)
    expect(body.plant_id).toBe('pl-1')
    expect(body.project_id).toBe('proj-9')
    expect(body.event_type).toBe('watering')
  })

  it('SNAP picker carries no hardcoded capture and exposes both Take and Choose controls (V4-SNAPPICK-001)', async () => {
    wireLists()
    await act(async () => { render(<CaptureFlow />) })
    const input = await screen.findByTestId('capture-input')
    // V4-SNAPPICK-001: input must NOT force the live camera — no hardcoded capture attr at render.
    expect(input.getAttribute('capture')).toBeNull()
    expect(input.getAttribute('type')).toBe('file')
    const take = screen.getByTestId('cap-take')
    const choose = screen.getByTestId('cap-choose')
    expect(take).toBeTruthy()
    expect(choose).toBeTruthy()
    expect(take.textContent).toContain('Take photo')
    expect(choose.textContent).toContain('Choose photo')
  })
})

// BUG-SNAPRETAKE-001 — "Retake / choose photo" was dead once a photo had been selected.
// The control lives in step 'mode', which is only reachable AFTER onPick() advances the step —
// and the file input used to render only in step 'photo', so by the time the button existed its
// ref was null and openPicker() hit `if (!el) return`. No picker, no camera, no clear, no error.
// These pin the two halves: the input survives the step change, and the button actually drives it.
describe('BUG-SNAPRETAKE-001 — retake stays alive after a photo is chosen', () => {
  it('the file input is still mounted once the flow has advanced past the photo step', async () => {
    wireLists()
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-planting')                      // now in step 'form', well past 'photo'
    expect(screen.queryByTestId('cap-take')).toBeNull() // proves we really left the photo step
    expect(screen.getByTestId('capture-input')).toBeDefined()
  })

  it('clicking Retake / choose photo opens the picker instead of silently no-opping', async () => {
    wireLists()
    await act(async () => { render(<CaptureFlow />) })
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' })
    await waitFor(() => expect(screen.getByTestId('capture-input')).toBeDefined())
    await act(async () => { fireEvent.change(screen.getByTestId('capture-input'), { target: { files: [file] } }) })
    // step 'mode' — where the Retake control lives and where the bug bit
    const retake = await screen.findByText('Retake / choose photo')
    const input = screen.getByTestId('capture-input')
    const clickSpy = vi.spyOn(input, 'click').mockImplementation(() => {})
    await act(async () => { fireEvent.click(retake) })
    expect(clickSpy).toHaveBeenCalledTimes(1)
    // and it must ask for the library, not force the camera (V4-SNAPPICK-001 semantics preserved)
    expect(input.getAttribute('capture')).toBeNull()
    clickSpy.mockRestore()
  })
})
