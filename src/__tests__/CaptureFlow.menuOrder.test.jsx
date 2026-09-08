// V5-SNAPMENUORDER-001 (BD0901-02) — the Snap options menu's order and its first entry's label.
//
// WHAT THIS FILE OWNS. Three rows appended a destination to MODES and each argued its own way to a
// slot (V4-SNAPDEST-001 'location', V5-INFLIGHTBATCH-001 'kitchen', V4-SNAPPHOTOONLY-001
// 'attachonly'). Dave then dictated all seven positions top to bottom, which supersedes those three
// derivations. The order is therefore no longer derivable from anything in the repo — it is an owner
// decision — so it needs a guard that states it once, in one place, rather than three partial
// order rules spread across the rows that happened to append last.
//
// THE PRE-BUILD DIFF THE ROW MANDATED, recorded here because it is the finding and not just a step:
// the row says to diff Dave's seven entries against what the live menu renders and surface any
// difference rather than guessing. Run against dev 16855cfc on 2026-09-08, it came back CLEAN — all
// seven of his entries already existed, with no eighth. The work was a pure reorder plus a rename,
// which is why nothing here builds a destination. The set-equality assertion below is what keeps
// that finding true: it fails on an added OR removed destination, not only on a reordered one.
//
// WHY THE RENAME NEEDS A BEHAVIOUR TEST AND NOT JUST A STRING TEST. The row is explicit that
// "Update Featured" is a LABEL CHANGE ONLY — same destination, same behaviour — because Dave has
// repeatedly called update-the-featured-photo the UX benchmark for Snap. A rename that also quietly
// became 'attachonly' (its neighbour, one field and Save, indistinguishable once a planting is
// picked — see CaptureFlow.jsx's own note on that pair) would pass every string assertion in this
// file. So the featured_photo_id PUT is asserted directly. That is the assertion to keep if this
// file is ever trimmed.
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

// Dave's list, verbatim and in his order, as (testid, label) pairs. Both halves are his: the ids are
// the destinations he named, the labels are the words he used for them.
const DAVE_ORDER = [
  ['mode-replace',    'Update Featured'],
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

const callsTo = (path, method) => fetchSpy.mock.calls.filter(([p, o]) => p === path && (o?.method ?? 'GET') === method)

describe('CaptureFlow — Snap menu order and label (V5-SNAPMENUORDER-001)', () => {
  it('renders exactly Dave\'s seven destinations, in his order, with his labels', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await showMenu()
    expect(modeIds()).toEqual(DAVE_ORDER.map(([id]) => id))
    for (const [id, label] of DAVE_ORDER) {
      expect(screen.getByTestId(id).textContent).toContain(label)
    }
  })

  it('has no eighth destination and is missing none of the seven', async () => {
    // Set equality, asserted separately from the ordered literal above. The ordered literal already
    // fails on an addition, but it fails identically on a reorder — and the two are different
    // defects with different fixes. This one says WHICH: the population changed.
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

  it('renamed the label only — "Update Featured" still sets the featured photo', async () => {
    // THE ROW'S ACTUAL RISK. A rename is safe; a rename that lands on the neighbouring destination
    // is not, and both look identical from the menu. The PUT is the difference.
    await act(async () => { render(<CaptureFlow />) })
    await showMenu()
    await act(async () => { fireEvent.click(screen.getByTestId('mode-replace')) })
    await act(async () => { fireEvent.focus(screen.getByTestId('cap-rpplant')) })
    const opt = await screen.findByTestId('ps-opt-pl-1')
    await act(async () => { fireEvent.click(opt) })
    await act(async () => { fireEvent.click(screen.getByText('Save').closest('button')) })

    expect(uploadSpy).toHaveBeenCalledTimes(1)
    expect(uploadSpy.mock.calls[0][1].linkage).toEqual({ plant_id: 'pl-1' })
    const puts = callsTo('/api/plants/pl-1', 'PUT')
    expect(puts.length).toBe(1)
    expect(JSON.parse(puts[0][1].body)).toEqual({ featured_photo_id: 'photo-1' })
  })

  it('no longer renders the old "Update a photo" wording anywhere in the menu', async () => {
    // The rename's other half. Without this, adding the new label beside the old one — two cards, or
    // one card whose hint still says the old words — passes every assertion above.
    await act(async () => { render(<CaptureFlow />) })
    await showMenu()
    for (const id of modeIds()) {
      expect(screen.getByTestId(id).textContent).not.toContain('Update a photo')
    }
  })
})
