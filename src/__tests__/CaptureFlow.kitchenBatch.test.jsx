// V5-INFLIGHTBATCH-001 — Snap's fifth destination, "Something in the kitchen".
//
// WHY IT EXISTS: every other destination on this picker is plant-shaped — four demand a planting,
// one demands a place. A pepper mash drawn from thirty plantings plus bought peppers plus salt fits
// none of them, so the first question the app asked had NO CORRECT ANSWER, and the measured result
// was a batch that ran three weeks and produced no record at all.
//
// WHAT THIS FILE IS REALLY GUARDING is a set of NEGATIVES, because the positive (a row is created)
// would stay true under every design the rulings forbid:
//   • a label and a photo, ALONE, is a complete save — no planting, no date, no method, no quantity
//   • no `kind` on the wire and no kind picker on the surface (the shipped put-up picker mis-files
//     40% of its live rows)
//   • the start is DERIVED from which chip was tapped, never asked for as a grade
//   • a hidden salt field never reaches the wire
//   • nothing anywhere says anything about pH, acid, safety or shelf life
// Those are the assertions to keep if this file is ever trimmed.
//
// CLOCK: frozen at a ZONELESS LOCAL literal (Date only, so RTL's real timers still run). The
// photo's taken_at is chosen at 16:00Z, which is the same calendar day in both the default lane and
// CI's blocking TZ=America/New_York re-run, so every literal below holds in both.
// Lands on the `npm test` lane (vitest run --coverage) and on the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

const PLANTS = [{ id: 'pl-1', name: 'Basil', project_id: 'proj-9', featured_photo_id: 'old-hero' }]
// ZONELESS LOCAL, then serialised — the same rule the assertions follow. A hardcoded `...T16:00Z`
// was tried first and is wrong: it is noon in America/New_York and 2 a.m. the NEXT DAY in Sydney, so
// the lid-date literal below held on both CI lanes and failed on a laptop set east of UTC+8. Local
// noon is the same calendar day in every zone.
const TAKEN_AT = new Date(2026, 7, 13, 12, 0, 0, 0).toISOString()
const NOW = new Date(2026, 7, 13, 21, 30, 0, 0)   // 2026-08-13 21:30, local wall clock

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true, now: NOW })
  fetchSpy.mockReset(); uploadSpy.mockReset(); navigateSpy.mockReset()
  try { localStorage.clear() } catch { /* noop */ }
  global.URL.createObjectURL = vi.fn(() => 'blob:preview')
  global.URL.revokeObjectURL = vi.fn()
  // No taken_at by default — that is the LIVE distribution, not the happy path: the column is
  // populated on 127 of 1,396 prod rows, so "the photo knows nothing" is the common case.
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
}

const type = async (testId, value) => {
  await act(async () => { fireEvent.change(screen.getByTestId(testId), { target: { value } }) })
}
const tapChip = async (id) => { await act(async () => { fireEvent.click(screen.getByTestId(`kb-start-${id}`)) }) }
const save = async () => { await act(async () => { fireEvent.click(screen.getByTestId('cap-save')) }) }
const callsTo = (path, method) => fetchSpy.mock.calls.filter(([p, o]) => p === path && (o?.method ?? 'GET') === method)
const kbBody = () => JSON.parse(callsTo('/api/kitchen-batches', 'POST')[0][1].body)

describe('CaptureFlow — Something in the kitchen (V5-INFLIGHTBATCH-001)', () => {
  it('offers the card, keeps all five existing destinations, and inventory stays LAST', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await waitFor(() => expect(screen.getByTestId('capture-input')).toBeDefined())
    const file = new File(['x'], 'snap.jpg', { type: 'image/jpeg' })
    await act(async () => { fireEvent.change(screen.getByTestId('capture-input'), { target: { files: [file] } }) })
    // Full ordered literal: ADDITIVE (nothing displaced), the standing "inventory stays LAST" rule
    // survives a third append, and the new card is fourth rather than sixth. Order only — jsdom has
    // no layout engine, so the fold argument in MODES' own comment is not testable here.
    expect(Array.from(document.querySelectorAll('[data-testid^="mode-"]')).map(b => b.getAttribute('data-testid'))).toEqual([
      'mode-planting', 'mode-event', 'mode-location', 'mode-kitchen', 'mode-replace', 'mode-attachonly', 'mode-inventory',
    ])
    expect(screen.getByTestId('mode-kitchen').textContent).toContain('Something in the kitchen')
  })

  it('saves with a label and a photo alone — no planting, no date, no method, no quantity', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    await type('cap-kblabel', 'Pepper mash')
    await save()
    // THE WHOLE POINT OF THE CARD, asserted as one exact body. toEqual (not toMatchObject) is what
    // makes this also a guard on absence: a `kind` key, a quantity, or a planting id appearing here
    // later fails this test.
    expect(kbBody()).toEqual({
      label: 'Pepper mash',
      started_at: null, start_precision: null, start_anchor_kind: null, start_anchor_id: null,
      brine_note: null, cover_photo_id: 'photo-1',
    })
    // Nothing else was written. Each of these is a destination this one must not have become.
    expect(callsTo('/api/plants', 'POST')).toHaveLength(0)
    expect(callsTo('/api/events', 'POST')).toHaveLength(0)
    expect(callsTo('/api/inventory-items', 'POST')).toHaveLength(0)
  })

  it('parks the photo in the inbox rather than inventing a parent for it', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    await type('cap-kblabel', 'Pepper mash')
    await save()
    expect(uploadSpy).toHaveBeenCalledTimes(1)
    const [, opts] = uploadSpy.mock.calls[0]
    // intake_status='pending_tag' with NO parent is the one shape photos_must_have_parent admits
    // for a parentless row. A plant_id or location_id here would be the "logged against whichever
    // planting happened to be nearby" lie.
    expect(opts.linkage).toEqual({ intake_status: 'pending_tag' })
    expect(opts.keyPrefix).toBe('standalone')
    expect(opts.parentId).toBe(null)
  })

  it('asks for no kind, and sends none', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    // No picker of any sort on this form — the put-up method picker mis-files 40% of its live rows,
    // and a kind chosen at the moment of lowest available attention is the decision this card
    // removes. Kind is nullable in the schema on purpose and is assignable later.
    expect(document.querySelectorAll('select')).toHaveLength(0)
    for (const k of ['ferment', 'dehydrate', 'candy', 'cure', 'infuse']) {
      expect(screen.queryByText(new RegExp(k, 'i'))).toBeNull()
    }
    await type('cap-kblabel', 'Pepper mash')
    await save()
    expect('kind' in kbBody()).toBe(false)
    expect('kind_other' in kbBody()).toBe(false)
  })

  it('says nothing about pH, acid, safety or shelf life — no seat has adjudicated food safety', async () => {
    const FOOD_SAFETY = /\bpH\b|acidif|acidity|botulis|shelf.stable|shelf life|\bsafe(ty)?\b|spoil/i
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    await type('cap-kblabel', 'Pepper mash')
    // ASSERTED TWICE, at both steps, because they render DISJOINT text: the form's notes unmount the
    // moment the save lands, so a done-card-only sweep cannot see the form and a form-only sweep
    // cannot see the success copy — and the success copy is exactly where a "keeps for months"
    // reassurance would most naturally be added.
    expect(screen.getByTestId('cap-kblabel')).toBeDefined()   // anchor: this IS the form step
    expect(document.body.textContent).not.toMatch(FOOD_SAFETY)
    await save()
    expect(screen.getByTestId('cap-hint')).toBeDefined()      // anchor: this IS the done step
    expect(document.body.textContent).not.toMatch(FOOD_SAFETY)
  })
})

describe('CaptureFlow — the kitchen start is derived, never asked (V5-INFLIGHTBATCH-001)', () => {
  it('defaults the start to photos.taken_at, graded day and anchored to the photo', async () => {
    uploadSpy.mockResolvedValue({ photo: { id: 'photo-1', taken_at: TAKEN_AT } })
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    await type('cap-kblabel', 'Pepper mash')
    await save()   // NO chip tapped — the user was never asked
    expect(kbBody()).toEqual({
      label: 'Pepper mash',
      started_at: TAKEN_AT, start_precision: 'day', start_anchor_kind: 'photo', start_anchor_id: 'photo-1',
      brine_note: null, cover_photo_id: 'photo-1',
    })
  })

  it('lets a tapped chip beat the photo, and derives the precision from the tap', async () => {
    uploadSpy.mockResolvedValue({ photo: { id: 'photo-1', taken_at: TAKEN_AT } })
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    await type('cap-kblabel', 'Pepper mash')
    await tapChip('yesterday')
    await save()
    expect(kbBody().started_at).toBe(new Date(2026, 7, 12).toISOString())
    expect(kbBody().start_precision).toBe('day')
    expect(kbBody().start_anchor_kind).toBe('memory')
    expect(kbBody().start_anchor_id).toBe(null)
  })

  it('sends "asked, does not know" for Longer / not sure — not the never-asked pair', async () => {
    // chk_kitchen_batch_start_pairing makes these two DIFFERENT CLAIMS and rejects a mismatched
    // pair outright, so this is the difference between a row and an opaque 500.
    uploadSpy.mockResolvedValue({ photo: { id: 'photo-1', taken_at: TAKEN_AT } })
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    await type('cap-kblabel', 'Pepper mash')
    await tapChip('longer')
    await save()
    expect(kbBody().started_at).toBe(null)
    expect(kbBody().start_precision).toBe('unknown')
  })

  it('never renders a precision control — the grade is the chip row and nothing else', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    // The chips ARE the question. Asking "how sure are you?" separately is the second decision the
    // ruling deletes; `exact` and `day` are not humanly distinguishable anyway.
    expect(Array.from(document.querySelectorAll('[data-testid^="kb-start-"]')).map(b => b.textContent)).toEqual([
      'Today', 'Yesterday', 'A few days ago', 'About a week', '2–3 weeks', 'Longer / not sure', 'Pick a date',
    ])
    expect(document.body.textContent).not.toMatch(/precision|how sure|accuracy|approximate\?/i)
    // The date input is behind the last chip, not in the way of everyone else.
    expect(screen.queryByTestId('kb-start-date')).toBeNull()
    await tapChip('pickdate')
    expect(screen.getByTestId('kb-start-date')).toBeDefined()
  })
})

describe('CaptureFlow — the kitchen salt note (V5-INFLIGHTBATCH-001)', () => {
  it('is asked at pack time and accepts anything', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    await type('cap-kblabel', 'Pepper mash')
    await type('cap-kbbrine', 'a big pinch per jar')
    await save()
    expect(kbBody().brine_note).toBe('a big pinch per jar')
  })

  it('disappears once the batch is back-dated, and what it still holds never reaches the wire', async () => {
    // The number is worth interrupting for only while the cook is holding it. Once the start moves
    // into the past the field goes — and a value typed before that must not be sent from a control
    // the user can no longer see.
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    await type('cap-kblabel', 'Pepper mash')
    await type('cap-kbbrine', '1 tsp per cup')
    await tapChip('aboutweek')
    expect(screen.queryByTestId('cap-kbbrine')).toBeNull()
    await save()
    expect(kbBody().brine_note).toBe(null)
    expect(kbBody().start_precision).toBe('week')   // anchor: the save really did run, back-dated
  })
})

describe('CaptureFlow — after the kitchen save (V5-INFLIGHTBATCH-001)', () => {
  it('tells you to write the label and the date on the lid', async () => {
    // THE ONLY AMBIENT CUE THAT REACHES THE JAR. Asserted as the ruling's exact string, including
    // both quote marks, the separator and the trailing stop — a substring match on "Aug 13" would
    // pass on a line that had lost the label or the instruction.
    uploadSpy.mockResolvedValue({ photo: { id: 'photo-1', taken_at: TAKEN_AT } })
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    await type('cap-kblabel', 'mash')
    await save()
    expect(screen.getByTestId('cap-hint').textContent).toBe('Write “mash — Aug 13” on the lid.')
    expect(screen.getByTestId('cap-result').textContent).toContain('Kitchen batch “mash” started')
  })

  it('dates the lid from today when the start is unknown, with no gap language', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    await type('cap-kblabel', 'mash')
    await tapChip('longer')
    await save()
    // An unknown start is a permanent, acceptable terminal state: same sentence, same shape, no
    // warning, no "add the start date" affordance.
    expect(screen.getByTestId('cap-hint').textContent).toBe('Write “mash — Aug 13” on the lid.')
    expect(document.body.textContent).not.toMatch(/add a start|set the start|missing|incomplete|unknown start/i)
  })

  it('offers no link, because there is no batch surface to send anyone to yet', async () => {
    // GREEN CONTROL FIRST. `queryByTestId('cap-view')` is VACUOUS in this file — the router mock
    // renders <a>{children}</a> and drops every other prop, so that id never matches for ANY
    // destination and the absence it "proves" is the selector's, not the app's. So the link slot is
    // shown working on a destination that has a target, then shown empty on this one, both through
    // the same query.
    const control = render(<CaptureFlow />)
    await snapTo('mode-inventory')
    await type('cap-invname', 'Pro-Mix HP')
    await save()
    expect(screen.getByText('View item')).toBeDefined()
    expect(document.querySelectorAll('a')).toHaveLength(1)
    control.unmount()

    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    await type('cap-kblabel', 'Pepper mash')
    await save()
    expect(screen.getByTestId('cap-next')).toBeDefined()   // anchor: the done card really rendered
    expect(document.querySelectorAll('a')).toHaveLength(0)
  })

  it('undo soft-deletes the batch and withdraws the lid instruction', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    await type('cap-kblabel', 'Pepper mash')
    await save()
    await act(async () => { fireEvent.click(screen.getByTestId('cap-undo')) })
    expect(callsTo('/api/kitchen-batches/kb-1', 'DELETE')).toHaveLength(1)
    // The jar instruction goes with the record it described — telling someone to label a jar for a
    // row that has just been retracted is worse than silence.
    expect(screen.queryByTestId('cap-hint')).toBeNull()
  })

  it('Save & Next clears the label, so the next capture cannot inherit it', async () => {
    // This destination needs no picker at all, so a carried-over label plus one Save tap creates a
    // SECOND batch named after the previous one. That is a wrong WRITE, not a stale form.
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    await type('cap-kblabel', 'Pepper mash')
    await save()
    await act(async () => { fireEvent.click(screen.getByTestId('cap-next')) })
    await snapTo('mode-kitchen')
    await save()
    expect(callsTo('/api/kitchen-batches', 'POST')).toHaveLength(1)
    expect(await screen.findByText('Give it a name')).toBeDefined()
  })

  it('refuses a blank label without uploading — an abandoned save leaves no orphan photo', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-kitchen')
    await type('cap-kblabel', '   ')
    await save()
    expect(uploadSpy).not.toHaveBeenCalled()
    expect(callsTo('/api/kitchen-batches', 'POST')).toHaveLength(0)
    expect(await screen.findByText('Give it a name')).toBeDefined()
  })
})
