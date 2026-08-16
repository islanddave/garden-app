// V4-SNAPTOAST-001 (BD-008 + BD0806-09) — Snap's post-save link, per destination.
//
// WHAT THIS PINS AND WHY. The ledger row asked for "parity with Log Event's post-save toaster";
// checking it found the toaster offers only Undo + ×-dismiss and NO link, so parity was not the
// buildable half. Dave's 0813 ruling was — a link to the newly-CREATED planting after add. These
// tests pin that ruling AND its four siblings, because "go to the planting" is meaningless for a
// location capture and the wrong link is worse than none: it would send the user to a planting the
// photo is not a photo of, which is the exact failure V4-SNAPDEST-001 existed to end.
//
// The Link mock forwards {...rest} deliberately, unlike the sibling CaptureFlow suites: the
// accessible name lives on aria-label (WCAG 2.5.3 — visible label + direct object), and a mock that
// drops it would let the name regress silently while every assertion still passed.
// No jest-dom (L-182).
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
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

import CaptureFlow from '../pages/CaptureFlow.jsx'

const PLANTS = [{ id: 'pl-1', name: 'Basil', project_id: 'proj-9', featured_photo_id: 'old-photo' }]
const LOCS = [{ id: 'loc-1', full_path: 'Back garden › Bed 3', level: 2, is_active: true }]

beforeEach(() => {
  fetchSpy.mockReset(); uploadSpy.mockReset(); navigateSpy.mockReset()
  global.URL.createObjectURL = vi.fn(() => 'blob:preview')
  global.URL.revokeObjectURL = vi.fn()
  uploadSpy.mockResolvedValue({ photo: { id: 'photo-1' } })
  fetchSpy.mockImplementation((path, options = {}) => {
    const m = options.method ?? 'GET'
    if (m === 'GET' && path === '/api/plants') return Promise.resolve(PLANTS)
    if (m === 'GET' && path === '/api/locations/with-path') return Promise.resolve(LOCS)
    // Response-sourced ids: the link must be built from these, never from staged client state.
    if (m === 'POST' && path === '/api/plants') return Promise.resolve({ id: 'plant-new', name: 'Charentais' })
    if (m === 'POST' && path === '/api/events') return Promise.resolve({ id: 'ev-new' })
    if (m === 'POST' && path === '/api/inventory-items') return Promise.resolve({ id: 'inv-new', name: 'Pro-Mix HP' })
    return Promise.resolve({ ok: true })
  })
})

async function snapTo(modeTestId) {
  await waitFor(() => expect(screen.getByTestId('capture-input')).toBeDefined())
  const file = new File(['x'], 'snap.jpg', { type: 'image/jpeg' })
  await act(async () => { fireEvent.change(screen.getByTestId('capture-input'), { target: { files: [file] } }) })
  await act(async () => { fireEvent.click(screen.getByTestId(modeTestId)) })
}

// V4-PLANTFORMUNIFY-001: the planting destination is the shared <PlantForm/>, so its name field is
// id'd off idPrefix and its submit is reached by role — the other destinations still use cap-save.
const plantName = () => document.getElementById('cap-plant-name')
const plantSave = () => screen.getByRole('button', { name: 'Save' })

// V4-PLANTPICKER-001: the shared combobox opens on focus; pick by clicking the option row.
async function pickPlanting(testid) {
  await act(async () => { fireEvent.focus(screen.getByTestId(testid)) })
  await act(async () => { fireEvent.click(await screen.findByTestId('ps-opt-pl-1')) })
}

const view = () => screen.getByTestId('cap-view')

async function saveNewPlanting() {
  await snapTo('mode-planting')
  await act(async () => { fireEvent.change(plantName(), { target: { value: 'Charentais' } }) })
  await act(async () => { fireEvent.click(plantSave()) })
  await waitFor(() => expect(screen.getByTestId('cap-result')).toBeDefined())
}

describe('CaptureFlow post-save link — V4-SNAPTOAST-001', () => {
  // ── Dave's 0813 ruling, literally: the NEWLY-CREATED planting ──
  it('new planting: links the just-created planting, by its response-sourced id', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await saveNewPlanting()
    // plant-new is the POST response's id. 'pl-1' is the only planting in staged client state, so a
    // link built from staged state instead would resolve and look correct — hence the exact href.
    expect(view().getAttribute('href')).toBe('/plantings/plant-new')
    expect(view().textContent).toBe('View planting')
  })

  it('new planting: the accessible name names the planting, not just the action', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await saveNewPlanting()
    // WCAG 2.5.3 — the accessible name CONTAINS the visible label and adds the direct object. Two
    // captures in one session are otherwise indistinguishable to a screen reader.
    expect(screen.getByRole('link', { name: 'View planting — Charentais' })).toBeDefined()
  })

  // ── the planting LOGGED TO — the phrase in the row's own title ──
  it('event on a planting: links the planting logged to, not the event', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-event')
    await pickPlanting('cap-evplant')
    await act(async () => { fireEvent.click(screen.getByTestId('cap-save')) })
    await waitFor(() => expect(screen.getByTestId('cap-result')).toBeDefined())
    expect(view().getAttribute('href')).toBe('/plantings/pl-1')
    // NOT /events/ev-new: one exit per destination, and the planting is the durable end of the pair.
    expect(view().getAttribute('href')).not.toContain('/events/')
    expect(screen.getByRole('link', { name: 'View planting — Basil' })).toBeDefined()
  })

  // ── the destination where "go to the planting" is unbuildable ──
  it('event on a location: links the LOCATION, and never a planting', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-location')
    await act(async () => { fireEvent.change(screen.getByTestId('cap-locplace'), { target: { value: 'loc-1' } }) })
    await act(async () => { fireEvent.click(screen.getByTestId('cap-save')) })
    await waitFor(() => expect(screen.getByTestId('cap-result')).toBeDefined())
    // This event carries plant_id null by design (V4-SNAPDEST-001), so a planting link is not merely
    // wrong copy — there is no planting to point at. The place is the subject.
    expect(view().getAttribute('href')).toBe('/locations/loc-1')
    expect(view().textContent).toBe('View location')
    expect(view().getAttribute('href')).not.toContain('/plantings/')
    expect(screen.getByRole('link', { name: 'View location — Back garden › Bed 3' })).toBeDefined()
  })

  it('photo replace: links the planting whose featured photo just changed', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-replace')
    await pickPlanting('cap-rpplant')
    await act(async () => { fireEvent.click(screen.getByTestId('cap-save')) })
    await waitFor(() => expect(screen.getByTestId('cap-result')).toBeDefined())
    // Confirming a swap is precisely the case where the user wants to go and look at it.
    expect(view().getAttribute('href')).toBe('/plantings/pl-1')
    expect(view().textContent).toBe('View planting')
  })

  it('inventory: links the created item, with item vocabulary not planting vocabulary', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-inventory')
    await act(async () => { fireEvent.change(screen.getByTestId('cap-invname'), { target: { value: 'Pro-Mix HP' } }) })
    await act(async () => { fireEvent.click(screen.getByTestId('cap-save')) })
    await waitFor(() => expect(screen.getByTestId('cap-result')).toBeDefined())
    expect(view().getAttribute('href')).toBe('/inventory/inv-new')
    expect(view().textContent).toBe('View item')
  })

  // ── withdrawal, and the reset that keeps the withdrawal from becoming permanent ──
  it('withdraws the link once the save is undone', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await saveNewPlanting()
    expect(screen.getByTestId('cap-view')).toBeDefined()
    await act(async () => { fireEvent.click(screen.getByTestId('cap-undo')) })
    // The undo ARCHIVES the planting, so the link would be a dead end. Same posture Undo itself takes.
    await waitFor(() => expect(document.querySelector('[data-testid="cap-view"]')).toBeNull())
  })

  it('restores the link on the next capture after an undo (Save & Next clears `undone`)', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await saveNewPlanting()
    await act(async () => { fireEvent.click(screen.getByTestId('cap-undo')) })
    await waitFor(() => expect(document.querySelector('[data-testid="cap-view"]')).toBeNull())
    await act(async () => { fireEvent.click(screen.getByTestId('cap-next')) })
    await waitFor(() => expect(screen.getByTestId('cap-take')).toBeDefined())   // back to photo step
    // Pre-existing bug this feature surfaced: `undone` outlived the capture it described, so every
    // subsequent done card opened struck through with both Undo and the link withdrawn.
    await saveNewPlanting()
    expect(view().getAttribute('href')).toBe('/plantings/plant-new')
    expect(screen.getByTestId('cap-undo')).toBeDefined()
  })

  // ── the boundary the row exists to protect: ONE confirmation surface, not two ──
  it('adds no second confirmation surface — the done card stays the only one', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await saveNewPlanting()
    // Snap keeps its own persistent card and does NOT fire the global toast: V4-LOGCONF-001 found
    // that toast to be "a 5s race the user always loses", and two confirmations of one save is the
    // divergent-second-surface defect this row was filed to close, not to introduce.
    expect(document.querySelectorAll('[data-testid="cap-result"]').length).toBe(1)
    expect(document.querySelector('[data-testid="post-save-strip"]')).toBeNull()
    // Exactly one link on the card — a second exit costs a decision on every capture.
    expect(screen.getAllByRole('link').length).toBe(1)
  })
})
