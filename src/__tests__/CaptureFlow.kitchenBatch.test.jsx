// Snap's fourth destination, "Something in the kitchen".
//
// WHY IT EXISTS (V5-INFLIGHTBATCH-001): every other destination on this picker is plant-shaped — four
// demand a planting, one demands a place. A pepper mash drawn from thirty plantings plus bought
// peppers plus salt fits none of them, so the first question the app asked had NO CORRECT ANSWER, and
// the measured result was a batch that ran three weeks and produced no record at all.
//
// ⚠ AMENDED by Put-Up 1a item 5 (V4 §2.2, §10.2, §8.3), in the same commit as the behaviour change.
// The card no longer carries a form of its own: it opens THE shared Start sheet (the one Going now's
// "Start a batch →" opens), handed the photo Snap already holds, and after "Start it" the app LANDS ON
// THE NEW BATCH (`/put-up?batch=<id>`), replacing /capture so one Back returns to where Snap was
// opened. What the plan changed, each asserted below as the new behaviour rather than deleted:
//   • the start is Today (preselected) · Yesterday · Earlier… · Not sure — the photo's taken_at no
//     longer chooses it (V4 §6.3);
//   • the kind is an optional, COLLAPSED row — no longer absent (it was the only way a batch could ever
//     be classified at birth, and the card's one-tap question now covers the rest);
//   • the pack-time salt/brine note is gone in 1a — the plan puts Salt with What went in (release 3);
//   • there is no done card: no "Write … on the lid", no Undo, no Save & Next for this destination —
//     the batch's own page is the completion (removing a mistaken batch arrives in release 1b).
// What did NOT change, and is still the point of the card: a label and a photo, ALONE, is a complete
// save; the photo is parked in the inbox rather than given an invented parent; nothing on this path
// says anything about pH, acid, safety or shelf life.
//
// CLOCK: Date is frozen at a ZONELESS LOCAL literal (timers stay real, so RTL's waitFor still runs).
// Lands on the `npm test` lane (vitest run --coverage) and on the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

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
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))

import CaptureFlow from '../pages/CaptureFlow.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { readMarker } from '../lib/backNav.js'

const PLANTS = [{ id: 'pl-1', name: 'Basil', project_id: 'proj-9', featured_photo_id: 'old-hero' }]
// ZONELESS LOCAL, then serialised — local noon is the same calendar day in every zone.
const TAKEN_AT = new Date(2026, 7, 10, 12, 0, 0, 0).toISOString()
const NOW = new Date(2026, 7, 13, 21, 30, 0, 0)   // 2026-08-13 21:30, local wall clock

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: false, now: NOW })
  fetchSpy.mockReset(); uploadSpy.mockReset(); navigateSpy.mockReset()
  try { localStorage.clear(); sessionStorage.clear() } catch { /* noop */ }
  window.history.replaceState({ __floor: 1 }, '')
  global.URL.createObjectURL = vi.fn(() => 'blob:preview')
  global.URL.revokeObjectURL = vi.fn()
  // No taken_at by default — the LIVE distribution: the column is populated on 127 of 1,396 rows.
  uploadSpy.mockResolvedValue({ photo: { id: 'photo-1', taken_at: null } })
  fetchSpy.mockImplementation((path, options = {}) => {
    const m = options.method ?? 'GET'
    if (m === 'GET' && path === '/api/plants') return Promise.resolve(PLANTS)
    if (m === 'GET' && path === '/api/locations/with-path') return Promise.resolve([])
    if (m === 'POST' && path === '/api/kitchen-batches') return Promise.resolve({ id: 'kb-1', label: 'Pepper mash' })
    if (m === 'POST' && path === '/api/inventory-items') return Promise.resolve({ id: 'inv-1', name: 'Pro-Mix HP' })
    return Promise.resolve({ ok: true })
  })
})

afterEach(() => { vi.useRealTimers() })

async function snapTo(modeTestId) {
  await waitFor(() => expect(screen.getByTestId('capture-input')).toBeDefined())
  const file = new File(['x'], 'snap.jpg', { type: 'image/jpeg' })
  await act(async () => { fireEvent.change(screen.getByTestId('capture-input'), { target: { files: [file] } }) })
  await act(async () => { fireEvent.click(screen.getByTestId(modeTestId)) })
  return file
}

const type = async (testId, value) => {
  await act(async () => { fireEvent.change(screen.getByTestId(testId), { target: { value } }) })
}
const tap = async (id) => { await act(async () => { fireEvent.click(screen.getByTestId(id)) }) }
const startIt = async () => { await tap('start-submit') }
const callsTo = (path, method) => fetchSpy.mock.calls.filter(([p, o]) => p === path && (o?.method ?? 'GET') === method)
const kbBody = () => JSON.parse(callsTo('/api/kitchen-batches', 'POST')[0][1].body)
const startSheet = () => screen.queryByRole('dialog', { name: 'Start a batch' })

describe('CaptureFlow — Something in the kitchen', () => {
  it('offers the card, keeps all five existing destinations, and inventory stays LAST', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await waitFor(() => expect(screen.getByTestId('capture-input')).toBeDefined())
    const file = new File(['x'], 'snap.jpg', { type: 'image/jpeg' })
    await act(async () => { fireEvent.change(screen.getByTestId('capture-input'), { target: { files: [file] } }) })
    // Full ordered literal. The ORDER is V5-SNAPMENUORDER-001's (Dave, verbatim) and
    // CaptureFlow.menuOrder.test.jsx is its guard; this row asserts its card is present and FOURTH.
    expect(Array.from(document.querySelectorAll('[data-testid^="mode-"]')).map(b => b.getAttribute('data-testid'))).toEqual([
      'mode-replace', 'mode-attachonly', 'mode-planting', 'mode-kitchen', 'mode-event', 'mode-location', 'mode-inventory',
    ])
    expect(screen.getByTestId('mode-kitchen').textContent).toContain('Something in the kitchen')
  })

  // THE SEAM: the same sheet Going now opens, not a Snap-only form. MUTATION: restore a kitchen form
  // on step 'form' -> the dialog is absent and cap-save is present, both red.
  it('opens THE shared Start sheet over the destinations, holding the photo Snap already has', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    expect(startSheet()).toBeTruthy()
    expect(screen.getByTestId('start-photo-preview').getAttribute('src')).toBe('blob:preview')
    expect(screen.queryByTestId('start-photo-add')).toBeNull()
    // No form step of its own: the destination cards are still underneath, and there is no Save.
    expect(screen.getByTestId('mode-kitchen')).toBeTruthy()
    expect(screen.queryByTestId('cap-save')).toBeNull()
  })

  it('closing the sheet returns to the destinations with the photo still chosen', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close' })) })
    expect(startSheet()).toBeNull()
    expect(screen.getByTestId('mode-inventory')).toBeTruthy()
    expect(screen.getByAltText('capture preview').getAttribute('src')).toBe('blob:preview')
  })

  it('saves with a label and a photo alone — no planting, no method, no quantity; Today unless told otherwise', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    await type('start-label', 'Pepper mash')
    await startIt()
    await waitFor(() => expect(callsTo('/api/kitchen-batches', 'POST')).toHaveLength(1))
    // The whole body, as one exact literal: a `kind` key, a quantity or a planting id appearing here
    // later fails this test.
    // Release 1b adds the create's idempotency key (V4 §5.2); it is asserted as a v4 uuid, the rest as
    // the same exact literal.
    const { idempotency_key: key, ...rest } = kbBody()
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(rest).toEqual({
      label: 'Pepper mash',
      started_at: NOW.toISOString(), start_precision: 'exact', start_anchor_kind: 'memory', start_anchor_id: null,
      cover_photo_id: 'photo-1',
    })
    expect(callsTo('/api/plants', 'POST')).toHaveLength(0)
    expect(callsTo('/api/events', 'POST')).toHaveLength(0)
    expect(callsTo('/api/inventory-items', 'POST')).toHaveLength(0)
  })

  it('parks the photo in the inbox rather than inventing a parent for it', async () => {
    await act(async () => { render(<CaptureFlow />) })
    const file = await snapTo('mode-kitchen')
    await type('start-label', 'Pepper mash')
    await startIt()
    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(1))
    const [sent, opts] = uploadSpy.mock.calls[0]
    expect(sent).toBe(file)
    // intake_status='pending_tag' with NO parent is the one shape photos_must_have_parent admits for a
    // parentless row. A plant_id or location_id here would be the "logged against whichever planting
    // happened to be nearby" lie.
    expect(opts.linkage).toEqual({ intake_status: 'pending_tag' })
    expect(opts.keyPrefix).toBe('standalone')
    expect(opts.parentId).toBe(null)
  })

  // ⚠ AMENDED (Put-Up 1a items 1 and 5): the ruling this pinned was "asks for no kind" at a time when
  // nothing could ever classify a batch. The kind is now asked OPTIONALLY and COLLAPSED — never at the
  // moment of lowest attention unless the cook opens it — and the card's one-tap question covers the
  // rest. Untouched, it still sends none.
  it('keeps the kind collapsed and optional, and sends none when it is left alone', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    expect(document.querySelectorAll('select')).toHaveLength(0)
    expect(screen.getByTestId('start-kind-toggle').getAttribute('aria-expanded')).toBe('false')
    for (const k of ['Ferment', 'Dry', 'Candy', 'Cure', 'Infuse']) {
      expect(screen.queryByRole('button', { name: k })).toBeNull()
    }
    await type('start-label', 'Pepper mash')
    await startIt()
    await waitFor(() => expect(callsTo('/api/kitchen-batches', 'POST')).toHaveLength(1))
    expect('kind' in kbBody()).toBe(false)
    expect('kind_other' in kbBody()).toBe(false)
  })

  it('says nothing about pH, acid, safety or shelf life — on the cards and on the open sheet', async () => {
    const FOOD_SAFETY = /\bpH\b|acidif|acidity|botulis|shelf.stable|shelf life|\bsafe(ty)?\b|spoil/i
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    await tap('start-kind-toggle')
    await tap('start-when-earlier')
    expect(screen.getByTestId('start-kind-ferment')).toBeDefined()   // anchor: the whole sheet is open
    expect(document.body.textContent).not.toMatch(FOOD_SAFETY)
  })
})

describe('CaptureFlow — the kitchen start is chosen by a chip, never asked as a grade', () => {
  // ⚠ AMENDED (Put-Up 1a item 5): this used to pin "defaults the start to photos.taken_at". The shared
  // Start sheet preselects Today (V4 §6.3); the photo's date no longer decides the start.
  it('starts on Today even when the photo carries its own date', async () => {
    uploadSpy.mockResolvedValue({ photo: { id: 'photo-1', taken_at: TAKEN_AT } })
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    await type('start-label', 'Pepper mash')
    await startIt()
    await waitFor(() => expect(callsTo('/api/kitchen-batches', 'POST')).toHaveLength(1))
    expect(kbBody()).toMatchObject({ started_at: NOW.toISOString(), start_precision: 'exact', start_anchor_kind: 'memory', start_anchor_id: null })
  })

  it('a tapped chip decides the start, and derives the precision from the tap', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    await type('start-label', 'Pepper mash')
    await tap('start-when-yesterday')
    await startIt()
    await waitFor(() => expect(callsTo('/api/kitchen-batches', 'POST')).toHaveLength(1))
    expect(kbBody().started_at).toBe(new Date(2026, 7, 12).toISOString())
    expect(kbBody().start_precision).toBe('day')
    expect(kbBody().start_anchor_kind).toBe('memory')
  })

  it('sends "asked, does not know" for Not sure — not the never-asked pair', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    await type('start-label', 'Pepper mash')
    await tap('start-when-unsure')
    await startIt()
    await waitFor(() => expect(callsTo('/api/kitchen-batches', 'POST')).toHaveLength(1))
    expect(kbBody().started_at).toBe(null)
    expect(kbBody().start_precision).toBe('unknown')
  })

  it('never renders a precision control — the grade is the chip row and nothing else', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    expect(Array.from(document.querySelectorAll('[data-testid^="start-when-"]')).map(b => b.textContent))
      .toEqual(['Today', 'Yesterday', 'Earlier…', 'Not sure'])
    expect(document.body.textContent).not.toMatch(/precision|how sure|accuracy|approximate\?/i)
    // The date input is behind Earlier… → Pick a date, not in the way of everyone else.
    expect(screen.queryByTestId('start-when-date')).toBeNull()
    await tap('start-when-earlier')
    await tap('start-when-pickdate')
    expect(screen.getByTestId('start-when-date')).toBeDefined()
  })
})

// ⚠ AMENDED (Put-Up 1a item 5): the pack-time salt/brine note is NOT on the shared Start sheet — the
// plan puts Salt with What went in, in release 3 (V4 §2.2). Pinned as absent so it cannot reappear on
// one door only.
describe('CaptureFlow — no salt/brine field in 1a', () => {
  it('asks no salt or brine, and sends no brine_note', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    expect(document.body.textContent).not.toMatch(/salt|brine/i)
    await type('start-label', 'Pepper mash')
    await startIt()
    await waitFor(() => expect(callsTo('/api/kitchen-batches', 'POST')).toHaveLength(1))
    expect('brine_note' in kbBody()).toBe(false)
  })
})

describe('CaptureFlow — after Start it, the app lands on the new batch', () => {
  // ⚠ AMENDED (Put-Up 1a item 5): this used to pin "offers no link, because there is no batch surface
  // to send anyone to yet". There is one — the shipped `?batch=` mode — and the app now goes there.
  // MUTATION: navigate with a push, or to /put-up without ?batch= -> this literal reds.
  it('replaces /capture with the batch\'s own page, and shows no done card', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    await type('start-label', 'Pepper mash')
    await startIt()
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledTimes(1))
    expect(navigateSpy).toHaveBeenCalledWith('/put-up?batch=kb-1', { replace: true })
    expect(screen.queryByTestId('cap-result')).toBeNull()
    expect(screen.queryByTestId('cap-undo')).toBeNull()
    expect(callsTo('/api/kitchen-batches/kb-1', 'DELETE')).toHaveLength(0)
    expect(document.body.textContent).not.toMatch(/on the lid/)
  })

  // V4 §10.2: "Back returns to where Snap was opened". The sheet armed its own Back entry; the batch is
  // handed over only once that entry is consumed, so the replace lands on /capture's entry itself —
  // [where Snap was opened, the batch] — and one Back goes home.
  it('lands only after the sheet\'s own Back entry is gone, so one Back returns to where Snap was opened', async () => {
    const markerAtNavigate = []
    navigateSpy.mockImplementation(() => { markerAtNavigate.push(!!readMarker(window.history.state)) })
    await act(async () => { render(<DismissRegistryProvider><CaptureFlow /></DismissRegistryProvider>) })
    await snapTo('mode-kitchen')
    await act(async () => { await new Promise(r => setTimeout(r, 60)) })
    expect(!!readMarker(window.history.state)).toBe(true)          // the sheet armed Back
    await type('start-label', 'Pepper mash')
    await startIt()
    await act(async () => { await new Promise(r => setTimeout(r, 120)) })
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledTimes(1))
    expect(navigateSpy).toHaveBeenCalledWith('/put-up?batch=kb-1', { replace: true })
    expect(markerAtNavigate).toEqual([false])
  })

  it('a second Snap starts clean — the label does not carry into the next batch', async () => {
    const first = render(<CaptureFlow />)
    await snapTo('mode-kitchen')
    await type('start-label', 'Pepper mash')
    await startIt()
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledTimes(1))
    first.unmount()
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    expect(screen.getByTestId('start-label').value).toBe('')
  })

  it('a half-typed label survives closing the sheet, and is there when it is reopened', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    await type('start-label', 'Kraut')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close' })) })
    await tap('mode-kitchen')
    expect(screen.getByTestId('start-label').value).toBe('Kraut')
  })

  it('refuses a blank label without uploading — an abandoned save leaves no orphan photo', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    await type('start-label', '   ')
    await startIt()
    expect(uploadSpy).not.toHaveBeenCalled()
    expect(callsTo('/api/kitchen-batches', 'POST')).toHaveLength(0)
    expect(screen.getByTestId('start-error').textContent).toBe('Give it a name first.')
  })
})
