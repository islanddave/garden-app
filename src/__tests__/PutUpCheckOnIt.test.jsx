// Put-Up 1a item 3 (V4 §2.3 "Check on it", §6.2–§6.6) — the check-in sheet.
//
// WHAT THIS FILE HOLDS, each with the mutation that proves it is not vacuous:
//   • ONE Save writes ONE row through the shipped stages route: `tended`, or `moved` when a place was
//     picked (goingNow.js checkInBody). Never a row per observation.
//   • what is offered depends on the kind only: every kind — Moved it + note; Ferment — the ruled
//     brine pair + the pH field; Dry (not Candy) — the two conditioning answers.
//   • `busy` refuses a second Save; the synchronous ref is what closes the same-frame double tap.
//   • required at open = 1 observation (V4 §6.3), counted through aria-required.
//   • <Sheet armsBack>: Back closes the sheet and the DRAFT SURVIVES; the reload gate is held while
//     dirty or saving; Back mid-write is refused.
//
// Real reloadGate, real DismissRegistryProvider and real window.history where those are the subject —
// a spied gate or a stubbed registry would re-create the blind spot each guard exists to close.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig()
  return { ...actual, useNavigate: () => vi.fn() }
})
const auth = { user: { id: 'user_dave' } }
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth }))

import GoingNowView from '../components/putup/GoingNowView.jsx'
import CheckOnItSheet, { CHECK_IN_HINT } from '../components/putup/CheckOnItSheet.jsx'
import {
  checkInBody, checkInFields, CHECK_IN_EMPTY, SUBMERSION_ANSWERS, CONDITIONING_ANSWERS, PH_SCALE_HINT,
  SUBMERSION_PROMPT,
} from '../components/putup/goingNow.js'
import { SHEET_DRAFT_TTL_MS } from '../components/kitchen/sheetDraft.js'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { readMarker } from '../lib/backNav.js'

const NOW = new Date('2026-09-04T09:00:00').getTime()
const local = (s) => new Date(s).toISOString()
const AT = new Date(NOW).toISOString()
// Review I-N1 (amended with the change): every row a check-in writes carries its date AND its word — the
// visit's instant, 'exact' — so none is stored in the pre-1b NULL-precision shape. MUTATION: drop the
// stamp from checkInBody -> every body literal below reds.
const STAMP = { entered_at: AT, entered_precision: 'exact' }

const BASE = {
  user_id: 'user_dave', kind_other: null, started_at: local('2026-09-01T09:00:00'), start_precision: 'day',
  first_recorded_at: local('2026-09-01T09:00:00'), expected_days_min: null, expected_days_max: null,
  suspended_at: null, closed_at: null, current_stage_kind: 'started', current_stage_label: null,
  current_stage_entered_at: local('2026-09-01T09:00:00'), input_count: '0', output_count: '0',
  last_ph_reading: null, last_ph_read_at: null,
}
const FERMENT = { ...BASE, id: 'kb-ferment', label: 'Jalapeño ferment', kind: 'ferment' }
const DRY = { ...BASE, id: 'kb-dry', label: 'Apple rings', kind: 'dehydrate', started_at: local('2026-09-02T09:00:00') }
const CANDY = { ...BASE, id: 'kb-candy', label: 'Candied ginger', kind: 'candy', started_at: local('2026-08-31T09:00:00') }
const MASH = { ...BASE, id: 'kb-mash', label: 'Pepper mash', kind: null, started_at: local('2026-08-30T09:00:00') }
const PLACES = [
  { id: 'loc-fridge', user_id: 'user_dave', label: 'Fridge', kind: 'fridge' },
  { id: 'loc-cf1', user_id: 'user_dave', label: 'Chest Freezer 1', kind: 'deep_freezer' },
]
const DRAFT_KEY = 'garden:putup-draft:v1:user_dave:checkin:kb-ferment'

const stagesPosts = () => fetchMock.mock.calls.filter(([p, o]) => /\/stages$/.test(p) && o?.method === 'POST')
const bodyOf = (call) => JSON.parse(call[1].body)
function wire({ places = PLACES, stage = () => Promise.resolve({ stage: {}, batch: {} }) } = {}) {
  fetchMock.mockImplementation((path, o = {}) => {
    if (path === '/api/storage-locations') return places instanceof Error ? Promise.reject(places) : Promise.resolve(places)
    if (o.method === 'POST') return stage()
    return Promise.resolve(null)
  })
}
function renderView(batches, extra = {}) {
  return render(
    <MemoryRouter initialEntries={['/put-up']}>
      <GoingNowView batches={batches} loading={false} error={false} onReload={vi.fn()} now={NOW} {...extra} />
    </MemoryRouter>,
  )
}
async function openCheck(batch, extra = {}) {
  const utils = renderView([batch], extra)
  await act(async () => { fireEvent.click(screen.getByTestId('going-check')) })
  return utils
}
const sheet = () => screen.queryByTestId('checkin-sheet')

beforeEach(() => {
  fetchMock.mockReset()
  wire()
  localStorage.clear()
  clearReloadBlocks()
  auth.user = { id: 'user_dave' }
  window.history.replaceState({ __floor: 1 }, '')
})
afterEach(() => { clearReloadBlocks() })

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('checkInBody — ONE row per check-in', () => {
  it('writes a tended row carrying every observation the kind allows', () => {
    expect(checkInBody({ batch: FERMENT, ph: ' 3.80 ', submersion: 'all_under', note: ' weight back on ', atIso: AT }))
      .toEqual({ body: { stage_kind: 'tended', cue_observed: 'All under', ph_reading: '3.80', ph_read_at: AT, note: 'weight back on', ...STAMP } })
  })

  // MUTATION: write the move as a SECOND row (or drop storage_location_id) -> this literal reds.
  it('a picked place makes the ONE row a `moved` row, and the rest rides on it', () => {
    expect(checkInBody({ batch: FERMENT, submersion: 'poking_out', place: PLACES[0], note: 'into the fridge', atIso: AT }))
      .toEqual({ body: {
        stage_kind: 'moved', storage_location_id: 'loc-fridge', label: 'Moved to Fridge',
        cue_observed: 'Something poking out', note: 'into the fridge', ...STAMP,
      } })
  })

  it('Dry gets the conditioning pair; Candy, whatever it is handed, does not', () => {
    expect(checkInBody({ batch: DRY, conditioning: 'back_in_dryer', atIso: AT }))
      .toEqual({ body: { stage_kind: 'tended', cue_observed: 'Condensation → back in the dryer', ...STAMP } })
    expect(checkInBody({ batch: CANDY, conditioning: 'jars', atIso: AT })).toEqual({ error: CHECK_IN_EMPTY })
    // Release F: `acts` (what you did) is a Ferment field, like the brine question (amended in the same commit).
    expect(checkInFields(CANDY)).toEqual({ ph: false, submersion: false, conditioning: false, acts: false })
    expect(checkInFields(DRY)).toEqual({ ph: false, submersion: false, conditioning: true, acts: false })
    expect(checkInFields(FERMENT)).toEqual({ ph: true, submersion: true, conditioning: false, acts: true })
  })

  it('refuses an empty check-in, and a whitespace note is not an observation', () => {
    expect(checkInBody({ batch: FERMENT, atIso: AT })).toEqual({ error: CHECK_IN_EMPTY })
    expect(checkInBody({ batch: MASH, note: '   ', atIso: AT })).toEqual({ error: CHECK_IN_EMPTY })
  })

  it('refuses a reading off the pH scale, and never reads a pH on a non-ferment', () => {
    expect(checkInBody({ batch: FERMENT, ph: '46', atIso: AT })).toEqual({ error: PH_SCALE_HINT })
    expect(checkInBody({ batch: MASH, ph: '3.9', atIso: AT })).toEqual({ error: CHECK_IN_EMPTY })
  })
})

describe('Check on it — what each kind is offered', () => {
  const offered = () => ({
    submersion: !!screen.queryByTestId('checkin-submersion-all_under'),
    ph: !!screen.queryByTestId('checkin-ph-input'),
    conditioning: !!screen.queryByTestId('checkin-conditioning-jars'),
    moved: !!screen.queryByTestId('checkin-place-loc-fridge'),
    note: !!screen.queryByTestId('checkin-note'),
  })

  it.each([
    ['ferment', FERMENT, { submersion: true, ph: true, conditioning: false, moved: true, note: true }],
    ['dry', DRY, { submersion: false, ph: false, conditioning: true, moved: true, note: true }],
    ['candy', CANDY, { submersion: false, ph: false, conditioning: false, moved: true, note: true }],
    ['unclassified', MASH, { submersion: false, ph: false, conditioning: false, moved: true, note: true }],
  ])('%s', async (_name, batch, expected) => {
    await openCheck(batch)
    await waitFor(() => expect(screen.getByTestId('checkin-place-loc-fridge')).toBeTruthy())
    expect(offered()).toEqual(expected)
    expect(screen.getByTestId('checkin-batch').textContent).toBe(batch.label)
    expect(screen.getByTestId('checkin-hint').textContent).toBe(CHECK_IN_HINT)
  })

  it('asks the ruled brine question in both directions and nothing else, as an optional group', async () => {
    await openCheck(FERMENT)
    const group = screen.getByRole('group', { name: SUBMERSION_PROMPT })
    const chips = within(group).getAllByRole('button')
    expect(chips.map(c => c.textContent)).toEqual(['All under', 'Something poking out'])
    expect(SUBMERSION_ANSWERS.map(a => a.label)).toEqual(['All under', 'Something poking out'])
    expect(chips.every(c => c.getAttribute('aria-pressed') === 'false' && c.style.minHeight === '48px')).toBe(true)
    expect(group.style.gap).toBe('8px')
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('names the Dry pair exactly as ruled', async () => {
    await openCheck(DRY)
    expect(CONDITIONING_ANSWERS.map(a => a.label)).toEqual(['In jars to condition', 'Condensation → back in the dryer'])
    expect(screen.getByTestId('checkin-conditioning-back_in_dryer').textContent).toBe('Condensation → back in the dryer')
  })

  it('offers the household\'s places by label, and says so plainly when there are none', async () => {
    await openCheck(FERMENT)
    await waitFor(() => expect(screen.getByTestId('checkin-place-loc-cf1')).toBeTruthy())
    const group = screen.getByRole('group', { name: 'Moved it' })
    expect(within(group).getAllByRole('button').map(b => b.textContent)).toEqual(['Chest Freezer 1', 'Fridge'])
  })

  it('with no places saved, Moved it says so rather than showing an empty row', async () => {
    wire({ places: [] })
    await openCheck(FERMENT)
    await waitFor(() => expect(screen.getByTestId('checkin-no-places').textContent).toBe('No places saved yet.'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('Check on it — the Save', () => {
  it('ONE Save sends ONE POST to the shipped stages route, then closes and re-reads the list', async () => {
    const onReload = vi.fn()
    await openCheck(FERMENT, { onReload })
    fireEvent.click(screen.getByTestId('checkin-submersion-all_under'))
    fireEvent.change(screen.getByTestId('checkin-ph-input'), { target: { value: '3.80' } })
    fireEvent.change(screen.getByTestId('checkin-note'), { target: { value: 'weight back on' } })
    await act(async () => { fireEvent.click(screen.getByTestId('checkin-save')) })
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1))
    expect(stagesPosts()).toHaveLength(1)
    expect(stagesPosts()[0][0]).toBe('/api/kitchen-batches/kb-ferment/stages')
    expect(bodyOf(stagesPosts()[0])).toEqual({
      stage_kind: 'tended', cue_observed: 'All under', ph_reading: '3.80', ph_read_at: AT, note: 'weight back on', ...STAMP,
    })
    expect(sheet()).toBeNull()
  })

  it('Moved it writes the one row as `moved`, to the place tapped', async () => {
    await openCheck(CANDY)
    await waitFor(() => expect(screen.getByTestId('checkin-place-loc-cf1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('checkin-place-loc-cf1'))
    await act(async () => { fireEvent.click(screen.getByTestId('checkin-save')) })
    await waitFor(() => expect(stagesPosts()).toHaveLength(1))
    expect(bodyOf(stagesPosts()[0])).toEqual({
      stage_kind: 'moved', storage_location_id: 'loc-cf1', label: 'Moved to Chest Freezer 1', ...STAMP,
    })
  })

  it('refuses an empty Save with one line, and sends nothing', async () => {
    await openCheck(FERMENT)
    await act(async () => { fireEvent.click(screen.getByTestId('checkin-save')) })
    expect(screen.getByTestId('checkin-error').textContent).toBe(CHECK_IN_EMPTY)
    expect(screen.getByTestId('checkin-error').getAttribute('role')).toBe('alert')
    expect(stagesPosts()).toHaveLength(0)
  })

  // MUTATION: remove the writingRef early-return in CheckOnItOpen.save -> two POSTs. Both taps land in
  // ONE act(), so `saving` has not committed and the disabled attribute cannot be what refuses the
  // second; only the synchronous ref can.
  it('busy refuses a second Save — two taps inside one frame write ONE row', async () => {
    let settle
    wire({ stage: () => new Promise(r => { settle = r }) })
    await openCheck(FERMENT)
    fireEvent.change(screen.getByTestId('checkin-note'), { target: { value: 'looked fine' } })
    const save = screen.getByTestId('checkin-save')
    act(() => { save.click(); save.click() })
    expect(stagesPosts()).toHaveLength(1)
    // While in flight the button says so and is disabled — the paint half of busy.
    expect(save.textContent).toBe('Saving…')
    expect(save.disabled).toBe(true)
    await act(async () => { settle({}) })
  })

  it('keeps everything on a failed write and can be tried again', async () => {
    wire({ stage: () => Promise.reject(new Error('offline')) })
    await openCheck(FERMENT)
    fireEvent.change(screen.getByTestId('checkin-note'), { target: { value: 'looked fine' } })
    await act(async () => { fireEvent.click(screen.getByTestId('checkin-save')) })
    await waitFor(() => expect(screen.getByTestId('checkin-error')).toBeTruthy())
    expect(screen.getByTestId('checkin-note').value).toBe('looked fine')
    expect(screen.getByTestId('checkin-save').disabled).toBe(false)
  })
})

describe('Check on it — required at open: 1 observation (V4 §6.3)', () => {
  const requiredCount = () => screen.getByTestId('checkin-sheet').querySelectorAll('[aria-required="true"]').length

  // Census: fails on ANY increase. MUTATION: mark the pH field (or a chip group) aria-required too -> 2.
  it.each([['ferment', FERMENT], ['dry', DRY], ['candy', CANDY], ['unclassified', MASH]])('%s opens with exactly one', async (_n, batch) => {
    await openCheck(batch)
    expect(requiredCount()).toBe(1)
    expect(screen.getByTestId('checkin-note').getAttribute('aria-required')).toBe('true')
  })

  it('the requirement is met by any one observation, not only by a note', async () => {
    await openCheck(FERMENT)
    fireEvent.click(screen.getByTestId('checkin-submersion-all_under'))
    expect(requiredCount()).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('Check on it — the draft survives a dismiss (V4 §6.5)', () => {
  const stored = () => JSON.parse(localStorage.getItem(DRAFT_KEY))

  it('keeps what was typed under the person + sheet + batch key, versioned and dated', async () => {
    await openCheck(FERMENT)
    fireEvent.change(screen.getByTestId('checkin-ph-input'), { target: { value: '3.9' } })
    const rec = stored()
    expect(rec.v).toBe(1)
    expect(rec.sheet).toBe('checkin')
    expect(typeof rec.savedAt).toBe('number')
    // Release F adds the three "what you did" keys to the draft (amended in the same commit).
    expect(rec.data).toEqual({ ph: '3.9', submersion: null, conditioning: null, placeId: null, note: '', acts: [], topUp: '', topUpUnit: 'ml' })
  })

  it('restores it on the next open after a close, and a successful Save clears it', async () => {
    await openCheck(FERMENT)
    fireEvent.click(screen.getByTestId('checkin-submersion-poking_out'))
    fireEvent.change(screen.getByTestId('checkin-note'), { target: { value: 'pushed it down' } })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(sheet()).toBeNull()
    await act(async () => { fireEvent.click(screen.getByTestId('going-check')) })
    expect(screen.getByTestId('checkin-submersion-poking_out').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('checkin-note').value).toBe('pushed it down')
    await act(async () => { fireEvent.click(screen.getByTestId('checkin-save')) })
    await waitFor(() => expect(stagesPosts()).toHaveLength(1))
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
  })

  // MUTATION: drop the TTL test in isLive -> the day-old note is restored and this reds.
  it('does not restore a draft older than 24 hours, and sweeps it', async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ v: 1, sheet: 'checkin', savedAt: Date.now() - SHEET_DRAFT_TTL_MS - 1000,
      data: { ph: '', submersion: null, conditioning: null, placeId: null, note: 'yesterday' } }))
    await openCheck(FERMENT)
    expect(screen.getByTestId('checkin-note').value).toBe('')
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
  })

  it('drops a record of the wrong shape or version rather than half-restoring it', async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ v: 1, sheet: 'checkin', savedAt: Date.now(),
      data: { ph: 3.9, submersion: 'maybe', conditioning: null, placeId: null, note: 'x' } }))
    await openCheck(FERMENT)
    expect(screen.getByTestId('checkin-note').value).toBe('')
    expect(screen.getByTestId('checkin-ph-input').value).toBe('')
  })

  it('never restores one crock\'s draft onto another, nor one person\'s onto another', async () => {
    localStorage.setItem('garden:putup-draft:v1:user_dave:checkin:kb-other', JSON.stringify({ v: 1, sheet: 'checkin',
      savedAt: Date.now(), data: { ph: '', submersion: null, conditioning: null, placeId: null, note: 'other crock' } }))
    localStorage.setItem('garden:putup-draft:v1:user_jen:checkin:kb-ferment', JSON.stringify({ v: 1, sheet: 'checkin',
      savedAt: Date.now(), data: { ph: '', submersion: null, conditioning: null, placeId: null, note: 'jen' } }))
    await openCheck(FERMENT)
    expect(screen.getByTestId('checkin-note').value).toBe('')
  })

  it('keeps no draft at all when nobody is signed in', async () => {
    auth.user = null
    await openCheck(FERMENT)
    fireEvent.change(screen.getByTestId('checkin-note'), { target: { value: 'anon' } })
    expect(Object.keys(localStorage).filter(k => k.startsWith('garden:putup-draft:'))).toEqual([])
    // GREEN CONTROL: the same edit with a person signed in DOES write.
    auth.user = { id: 'user_dave' }
  })
})

describe('Check on it — the reload gate (reloadGateWire)', () => {
  it('is free while pristine, held while typed-in, released on close', async () => {
    await openCheck(FERMENT)
    expect(isReloadBlocked()).toBe(false)
    fireEvent.change(screen.getByTestId('checkin-note'), { target: { value: 'x' } })
    expect(isReloadBlocked()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(isReloadBlocked()).toBe(false)
  })

  it('is held while the write is in flight and released when it lands', async () => {
    let settle
    wire({ stage: () => new Promise(r => { settle = r }) })
    await openCheck(FERMENT)
    fireEvent.change(screen.getByTestId('checkin-note'), { target: { value: 'x' } })
    await act(async () => { fireEvent.click(screen.getByTestId('checkin-save')) })
    expect(isReloadBlocked()).toBe(true)
    await act(async () => { settle({}) })
    await waitFor(() => expect(sheet()).toBeNull())
    expect(isReloadBlocked()).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ANDROID BACK. Real provider, real history. The host owns `open`, so "closed" is an unmount, not a
// spy call. A floor entry keeps back() off history index 0, where jsdom makes it a silent no-op.
describe('Check on it — Android Back (popstate)', () => {
  const settle = () => act(async () => { await new Promise(r => setTimeout(r, 60)) })
  const back = async () => { act(() => { window.history.back() }); await settle() }
  const armed = () => !!readMarker(window.history.state)

  function Host({ onSaved }) {
    const [open, setOpen] = useState(true)
    return (
      <DismissRegistryProvider>
        <CheckOnItSheet open={open} batch={FERMENT} now={NOW} onClose={() => setOpen(false)}
          onSaved={() => { onSaved?.(); setOpen(false) }} />
        {!open && <button type="button" onClick={() => setOpen(true)}>reopen</button>}
      </DismissRegistryProvider>
    )
  }

  it('Back closes the sheet — not the page under it — and the draft survives', async () => {
    await act(async () => { render(<Host />) })
    await waitFor(() => expect(armed()).toBe(true))
    expect(armed()).toBe(true)                       // the sheet armed its own Back entry
    fireEvent.change(screen.getByTestId('checkin-note'), { target: { value: 'skimmed the top' } })
    await back()
    await waitFor(() => expect(sheet()).toBeNull())
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY)).data.note).toBe('skimmed the top')
    await act(async () => { fireEvent.click(screen.getByText('reopen')) })
    expect(screen.getByTestId('checkin-note').value).toBe('skimmed the top')
  })

  it('Back mid-write is refused — the sheet stays up over its in-flight write', async () => {
    let settleWrite
    wire({ stage: () => new Promise(r => { settleWrite = r }) })
    await act(async () => { render(<Host />) })
    await settle()
    fireEvent.change(screen.getByTestId('checkin-note'), { target: { value: 'x' } })
    await act(async () => { fireEvent.click(screen.getByTestId('checkin-save')) })
    const seq0 = readMarker(window.history.state).seq
    await back()
    // The Back WAS processed and refused: the registry pushes a FRESH marker (a higher seq) on a
    // BLOCKED Back. Waiting on the new seq — not on `armed()`, which is also true before the
    // traversal lands — is what makes the assertion below about a refused Back, not an early look.
    await waitFor(() => expect(readMarker(window.history.state)?.seq).toBeGreaterThan(seq0))
    expect(sheet()).toBeTruthy()
    await act(async () => { settleWrite({}) })
    await waitFor(() => expect(sheet()).toBeNull())
  })
})

// Put-Up 1a item 7 — the rest of the sheet contract: confirmOnDirty OFF (the draft is what protects
// the input, so Back asks nothing), and the BACKDROP is refused mid-write exactly as Back is.
describe('Check on it — the Sheet contract (item 7)', () => {
  const settle = () => act(async () => { await new Promise(r => setTimeout(r, 60)) })
  const backdrop = () => screen.getByRole('dialog').previousElementSibling

  function Host() {
    const [open, setOpen] = useState(true)
    return (
      <DismissRegistryProvider>
        <CheckOnItSheet open={open} batch={FERMENT} now={NOW} onClose={() => setOpen(false)} onSaved={() => setOpen(false)} />
      </DismissRegistryProvider>
    )
  }

  // MUTATION: pass confirmOnDirty to the Sheet -> Back raises the ConfirmSheet and this reds.
  it('Back on a typed-in sheet asks nothing — it closes, and the draft keeps the words', async () => {
    await act(async () => { render(<Host />) })
    await settle()
    fireEvent.change(screen.getByTestId('checkin-note'), { target: { value: 'looked fine' } })
    act(() => { window.history.back() }); await settle()
    expect(screen.queryByTestId('confirm-sheet')).toBeNull()
    await waitFor(() => expect(sheet()).toBeNull())
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY)).data.note).toBe('looked fine')
  })

  it('a backdrop tap closes an idle sheet, and is refused while the write is in flight', async () => {
    let settleWrite
    wire({ stage: () => new Promise(r => { settleWrite = r }) })
    await act(async () => { render(<Host />) })
    fireEvent.change(screen.getByTestId('checkin-note'), { target: { value: 'x' } })
    await act(async () => { fireEvent.click(screen.getByTestId('checkin-save')) })
    fireEvent.click(backdrop())
    expect(sheet()).toBeTruthy()                          // refused mid-write
    await act(async () => { settleWrite({}) })
    await waitFor(() => expect(sheet()).toBeNull())
    // …and when nothing is in flight, the same tap closes it.
    cleanupAndRender()
  })

  function cleanupAndRender() {
    // A fresh, idle sheet: the backdrop is a way out, not a trap.
    const utils = render(<Host />)
    fireEvent.click(within(utils.container).getByRole('dialog').previousElementSibling)
    expect(within(utils.container).queryByTestId('checkin-sheet')).toBeNull()
  }
})

describe('Check on it — no banned word on the sheet (V4 §3.2)', () => {
  const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
  it.each([['ferment', FERMENT], ['dry', DRY], ['candy', CANDY]])('%s', async (_n, batch) => {
    await openCheck(batch)
    await waitFor(() => expect(screen.getByTestId('checkin-place-loc-fridge')).toBeTruthy())
    const text = screen.getByTestId('checkin-sheet').closest('[role="dialog"]').textContent
    expect(text).toContain('Check on it')                    // green control: the whole sheet is read
    expect(text).not.toMatch(BANNED)
  })
})
