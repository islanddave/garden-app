// V4-SNAPPHOTOONLY-001 (BD-065) — the "add to a planting" Snap destination.
//
// WHY IT EXISTS, in Dave's words: "I just want the photo attached to the plant. It is not the hero
// shot and it does not need to be an event." Snap's two existing planting destinations each charged
// him for something he had not asked for — 'event' routes through the full event picker, 'replace'
// overwrites the planting's featured picture — so the common case had no home.
//
// WHAT THIS FILE IS REALLY GUARDING is the two NEGATIVES. The positive (a photo lands on the
// planting) is shared with both neighbours and would stay true if this destination silently became
// either of them; what makes it the third option rather than a duplicate is that it writes NOTHING
// ELSE. So "no featured_photo_id PUT" and "no /api/events POST" are asserted directly, and they are
// the assertions to keep if this file is ever trimmed.
//
// ADDITIVE is asserted too, because the row is explicit that both existing destinations stay
// ("I wanna keep the added to a planting and be able to select events if I want to"), and a future
// tidy-up that collapsed 'replace' into this one would satisfy every other test here.
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
  Link: ({ children, to }) => <a href={typeof to === 'string' ? to : '#'}>{children}</a>,
}))

import CaptureFlow from '../pages/CaptureFlow.jsx'

const PLANTS = [
  { id: 'pl-1', name: 'Basil', project_id: 'proj-9', featured_photo_id: 'old-hero', variety_ref: { name: 'Genovese' } },
  { id: 'pl-2', name: 'Sungold', project_id: 'proj-9', featured_photo_id: null, variety_ref: { name: 'Sungold' } },
]

beforeEach(() => {
  fetchSpy.mockReset(); uploadSpy.mockReset(); navigateSpy.mockReset()
  try { localStorage.clear() } catch { /* noop */ }
  global.URL.createObjectURL = vi.fn(() => 'blob:preview')
  global.URL.revokeObjectURL = vi.fn()
  uploadSpy.mockResolvedValue({ photo: { id: 'photo-1' } })
  fetchSpy.mockImplementation((path, options = {}) => {
    const m = options.method ?? 'GET'
    if (m === 'GET' && path === '/api/plants') return Promise.resolve(PLANTS)
    if (m === 'GET' && path === '/api/locations/with-path') return Promise.resolve([])
    return Promise.resolve({ ok: true })
  })
})

async function snapTo(modeTestId) {
  await waitFor(() => expect(screen.getByTestId('capture-input')).toBeDefined())
  const file = new File(['x'], 'snap.jpg', { type: 'image/jpeg' })
  await act(async () => { fireEvent.change(screen.getByTestId('capture-input'), { target: { files: [file] } }) })
  await act(async () => { fireEvent.click(screen.getByTestId(modeTestId)) })
}

async function pickPlanting(id) {
  await act(async () => { fireEvent.focus(screen.getByTestId('cap-atplant')) })
  const opt = await screen.findByTestId(`ps-opt-${id}`)
  await act(async () => { fireEvent.click(opt) })
}

const saveBtn = () => screen.getByText('Save').closest('button')
const callsTo = (path, method) => fetchSpy.mock.calls.filter(([p, o]) => p === path && (o?.method ?? 'GET') === method)

describe('CaptureFlow — add to a planting (V4-SNAPPHOTOONLY-001)', () => {
  it('offers the destination, keeps both existing planting destinations, and inventory stays LAST', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await waitFor(() => expect(screen.getByTestId('capture-input')).toBeDefined())
    const file = new File(['x'], 'snap.jpg', { type: 'image/jpeg' })
    await act(async () => { fireEvent.change(screen.getByTestId('capture-input'), { target: { files: [file] } }) })
    const ids = Array.from(document.querySelectorAll('[data-testid^="mode-"]')).map(b => b.getAttribute('data-testid'))
    expect(ids).toContain('mode-attachonly')
    // ADDITIVE, per the row: neither neighbour is replaced by this.
    expect(ids).toContain('mode-event')
    expect(ids).toContain('mode-replace')
    // V4-SNAPDEST-001's ordering rule survives a second append.
    expect(ids[ids.length - 1]).toBe('mode-inventory')
  })

  it('attaches the photo to the picked planting', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-attachonly')
    await pickPlanting('pl-1')
    await act(async () => { fireEvent.click(saveBtn()) })
    expect(uploadSpy).toHaveBeenCalledTimes(1)
    const [, opts] = uploadSpy.mock.calls[0]
    expect(opts.linkage).toEqual({ plant_id: 'pl-1' })
    expect(opts.keyPrefix).toBe('plants')
    expect(opts.parentId).toBe('pl-1')
  })

  it('does NOT change the planting\'s featured photo — the whole difference from "Update a photo"', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-attachonly')
    await pickPlanting('pl-1')
    await act(async () => { fireEvent.click(saveBtn()) })
    // ANCHOR FIRST. Every assertion in this test is an ABSENCE, and an absence is also what you
    // get from a save that never ran — a broken selector, a disabled button, a thrown error. So
    // prove the save happened before proving what it did not do.
    expect(uploadSpy).toHaveBeenCalledTimes(1)
    // pl-1 seeds featured_photo_id 'old-hero' precisely so a stray PUT would have something to
    // overwrite; asserting against a planting with no hero would prove less.
    expect(callsTo('/api/plants/pl-1', 'PUT')).toHaveLength(0)
  })

  it('does NOT log an event — the whole difference from "Log on a planting"', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-attachonly')
    await pickPlanting('pl-1')
    await act(async () => { fireEvent.click(saveBtn()) })
    expect(uploadSpy).toHaveBeenCalledTimes(1)   // anchor, same reason as the test above
    expect(callsTo('/api/events', 'POST')).toHaveLength(0)
  })

  it('refuses to save without a planting rather than filing the photo nowhere', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-attachonly')
    await act(async () => { fireEvent.click(saveBtn()) })
    expect(uploadSpy).not.toHaveBeenCalled()
    expect(await screen.findByText('Pick a planting')).toBeDefined()
  })

  it('undo deletes the photo, because nothing else was written to put back', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-attachonly')
    await pickPlanting('pl-2')
    await act(async () => { fireEvent.click(saveBtn()) })
    const undo = await screen.findByText(/Undo/)
    await act(async () => { fireEvent.click(undo.closest('button') ?? undo) })
    expect(callsTo('/api/photos/photo-1', 'DELETE')).toHaveLength(1)
  })

  it('Save & Next clears the planting, so the next capture cannot inherit it', async () => {
    // This destination needs no field but the planting, so a carried-over selection plus one Save
    // tap files a photo against a planting the user never chose for it. That is a wrong WRITE, not
    // a stale form — hence its own case rather than trust in resetForNext's sibling list.
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-attachonly')
    await pickPlanting('pl-1')
    await act(async () => { fireEvent.click(saveBtn()) })
    const next = await screen.findByText(/Save & Next|snap another/i)
    await act(async () => { fireEvent.click(next.closest('button') ?? next) })
    await snapTo('mode-attachonly')
    await act(async () => { fireEvent.click(saveBtn()) })
    // One upload total — the first save's. The second refused for want of a planting.
    expect(uploadSpy).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Pick a planting')).toBeDefined()
  })
})
