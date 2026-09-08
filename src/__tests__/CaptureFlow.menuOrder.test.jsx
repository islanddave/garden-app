// V5-SNAPMENUORDER-001 (BD0901-02) — the Snap options menu's order.
//
// WHAT THIS FILE OWNS. Three rows appended a destination to MODES and each argued its own way to a
// slot (V4-SNAPDEST-001 'location', V5-INFLIGHTBATCH-001 'kitchen', V4-SNAPPHOTOONLY-001
// 'attachonly'). Dave then dictated all seven positions top to bottom, which supersedes those three
// derivations. The order is no longer derivable from anything in the repo — it is an owner decision
// — so it needs one guard stating it once, rather than three partial order rules spread across the
// rows that happened to append last.
//
// THE HISTORY, because it is the reason for the second describe block. This shipped on 2026-09-08 as
// an order change PLUS a rename of 'replace' to "Update Featured". Both were reverted the same day
// while it was unclear which half Dave objected to. He then said plainly that he wanted the ORDER
// and that only the RENAME bothered him. So the order is back and the label is deliberately NOT
// renamed. **That is a declined change, not a deferred one**, and the assertions below exist so a
// future session cannot helpfully "finish" it.
//
// THE PRE-BUILD DIFF THE ROW MANDATED, recorded because it is the finding and not just a step: the
// row said to diff Dave's seven entries against what the live menu renders and surface any
// difference rather than guessing. Run against dev on 2026-09-08 it came back CLEAN — all seven of
// his entries already existed, no eighth, none missing. The work was a pure reorder. The set-equality
// assertion is what keeps that true: it fails on an added OR removed destination, not only a
// reordered one.
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
]

// Dave's list, verbatim and in his order, as (testid, label) pairs. The ids are the destinations he
// named; the labels are the words the app uses for them — note 'replace' keeps its ORIGINAL label.
const DAVE_ORDER = [
  ['mode-replace',    'Update a photo'],
  ['mode-attachonly', 'Add to a planting'],
  ['mode-planting',   'New planting'],
  ['mode-kitchen',    'Something in the kitchen'],
  ['mode-event',      'Log on a planting'],
  ['mode-location',   'Log on a location'],
  ['mode-inventory',  'Add inventory'],
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

async function showMenu() {
  await waitFor(() => expect(screen.getByTestId('capture-input')).toBeDefined())
  const file = new File(['x'], 'snap.jpg', { type: 'image/jpeg' })
  await act(async () => { fireEvent.change(screen.getByTestId('capture-input'), { target: { files: [file] } }) })
}

const modeIds = () =>
  Array.from(document.querySelectorAll('[data-testid^="mode-"]')).map(b => b.getAttribute('data-testid'))

describe('CaptureFlow — Snap menu order (V5-SNAPMENUORDER-001)', () => {
  it('renders exactly Dave\'s seven destinations, in his order', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await showMenu()
    expect(modeIds()).toEqual(DAVE_ORDER.map(([id]) => id))
    for (const [id, label] of DAVE_ORDER) {
      expect(screen.getByTestId(id).textContent).toContain(label)
    }
  })

  it('has no eighth destination and is missing none of the seven', async () => {
    // Set equality, asserted separately from the ordered literal. The ordered literal already fails
    // on an addition, but it fails identically on a reorder — and those are different defects with
    // different fixes. This one says WHICH: the population changed.
    await act(async () => { render(<CaptureFlow />) })
    await showMenu()
    expect([...modeIds()].sort()).toEqual(DAVE_ORDER.map(([id]) => id).sort())
  })

  it('carries the standing constraints the three prior rows established', async () => {
    // These SURVIVE Dave's order rather than being overridden by it, and each has its own row. Read
    // as: his list did not silently undo three earlier decisions. Asserted by relationship, not by
    // index, so they keep meaning if he ever reorders again.
    await act(async () => { render(<CaptureFlow />) })
    await showMenu()
    const ids = modeIds()
    expect(ids[ids.length - 1]).toBe('mode-inventory')                                    // V4-SNAPDEST-001
    expect(Math.abs(ids.indexOf('mode-replace') - ids.indexOf('mode-attachonly'))).toBe(1) // V4-SNAPPHOTOONLY-001
    expect(Math.abs(ids.indexOf('mode-event') - ids.indexOf('mode-location'))).toBe(1)     // V4-SNAPDEST-001
  })
})

describe('CaptureFlow — the rename Dave DECLINED (V5-SNAPMENUORDER-001)', () => {
  it('still calls the first destination "Update a photo", not "Update Featured"', async () => {
    // NOT a stylistic assertion. "Update Featured" shipped alongside this order on 2026-09-08 and was
    // withdrawn on Dave's explicit word that the rename was the half that bothered him. A future
    // session reading the order half as "restored" could reasonably assume the rename was simply
    // missed and re-apply it as a tidy-up. This is the assertion that stops that, and this comment is
    // the reason it must not be deleted as redundant.
    await act(async () => { render(<CaptureFlow />) })
    await showMenu()
    expect(screen.getByTestId('mode-replace').textContent).toContain('Update a photo')
    for (const id of modeIds()) {
      expect(screen.getByTestId(id).textContent).not.toContain('Update Featured')
    }
  })

  it('and it still sets the featured photo — the label was never what made it work', async () => {
    // 'replace' and its neighbour 'attachonly' are one field and Save apiece and are indistinguishable
    // from the menu once a planting is picked. The featured_photo_id PUT is the only thing that tells
    // them apart, so it is asserted directly rather than inferred from the label. This is the
    // assertion to keep if this file is ever trimmed.
    await act(async () => { render(<CaptureFlow />) })
    await showMenu()
    await act(async () => { fireEvent.click(screen.getByTestId('mode-replace')) })
    await act(async () => { fireEvent.focus(screen.getByTestId('cap-rpplant')) })
    const opt = await screen.findByTestId('ps-opt-pl-1')
    await act(async () => { fireEvent.click(opt) })
    await act(async () => { fireEvent.click(screen.getByText('Save').closest('button')) })

    expect(uploadSpy).toHaveBeenCalledTimes(1)
    expect(uploadSpy.mock.calls[0][1].linkage).toEqual({ plant_id: 'pl-1' })
    const puts = fetchSpy.mock.calls.filter(([p, o]) => p === '/api/plants/pl-1' && o?.method === 'PUT')
    expect(puts.length).toBe(1)
    expect(JSON.parse(puts[0][1].body)).toEqual({ featured_photo_id: 'photo-1' })
  })
})
