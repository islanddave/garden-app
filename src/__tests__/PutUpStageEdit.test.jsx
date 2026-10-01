// Put-Up release F — the Log on batch detail (06 §3.7, §3.10, §3.13, §4 items 1, 2, 6): every entry is
// editable (a 48px row → the edit sheet → "Saved · Undo"), the Log reads F's facts as words, "Check on it"
// sits at its head, the kind question is asked inline on open and closed batches, and "Following a
// recipe?" records and points at the tested-recipe advice. Each assertion names the mutation that reds
// it. CI LANE: `npm test` + TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))

import BatchDetailView, { stageRowDetail } from '../components/putup/BatchDetailView.jsx'
import { stagePatch, editableKeys, whenSeed } from '../components/putup/StageEditSheet.jsx'
import { TESTED_RECIPE_LINK, TESTED_RECIPE_NOTE } from '../components/putup/RecipeRefRow.jsx'
import { clearReloadBlocks } from '../lib/reloadGate.js'
// The Lambda's own PATCH rule, imported, never mocked: the Undo body must be one the route takes.
import { stagePatchError } from '../../lambda/preservation/kitchenLines.js'

const NOW = new Date('2026-10-12T15:00:00').getTime()
const local = (s) => new Date(s).toISOString()
const BATCH = {
  id: 'kb-1', user_id: 'user_dave', label: 'Petri Dish', kind: 'ferment', kind_other: null,
  started_at: local('2026-09-25T09:00:00'), start_precision: 'day', first_recorded_at: local('2026-09-25T09:00:00'),
  suspended_at: null, closed_at: null, outcome: null, outcome_note: null, current_stage_kind: 'tended',
  current_stage_entered_at: local('2026-10-01T09:00:00'), input_count: '0', output_count: '0', garden_names: [], recipe_ref: null,
}
const CLOSED = { ...BATCH, closed_at: local('2026-10-08T12:00:00'), outcome: 'put_up', current_stage_kind: 'finished' }
const ST = (o) => ({ batch_id: 'kb-1', label: null, amount: null, amount_unit: null, cue_observed: null, note: null, ph_reading: null,
  ph_read_at: null, voids_id: null, acts: null, mash_in_g: null, edited_at: null, entered_precision: 'exact', storage_location_id: null, ...o })
const TENDED = ST({ id: 'ksl-t', stage_kind: 'tended', entered_at: local('2026-10-01T09:00:00'), acts: ['topped_up', 'skimmed'],
  amount: '250', amount_unit: 'ml', cue_observed: 'All under', note: 'white film, skimmed' })
const PUT_UP = ST({ id: 'ksl-p', stage_kind: 'put_up', entered_at: local('2026-10-08T12:00:00'), entered_precision: 'day', amount: '256', amount_unit: 'g', mash_in_g: '198' })
const STARTED = ST({ id: 'ksl-s', stage_kind: 'started', entered_at: local('2026-09-25T09:00:00'), entered_precision: 'day', amount: '448', amount_unit: 'g' })

const writes = () => fetchMock.mock.calls.filter(([, o]) => o?.method && o.method !== 'GET').map(([p, o]) => [o.method, p, JSON.parse(o.body ?? '{}')])
function renderDetail(o = {}) {
  const onChanged = vi.fn()
  render(<BatchDetailView batch={{ ...BATCH, ...o.batch }} inputs={[]} stages={o.stages ?? [TENDED, STARTED]} outputs={[]}
    loading={false} error={false} nowMs={NOW} onChanged={onChanged} />)
  return { onChanged }
}
beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation((path, o = {}) => {
    if (path === '/api/storage-locations') return Promise.resolve([{ id: 'loc-fridge', label: 'Fridge', kind: 'fridge' }])
    if (o.method) return Promise.resolve({ stage: { id: 'ksl-new' } })
    return Promise.resolve(null)
  })
  localStorage.clear(); clearReloadBlocks()
})
afterEach(() => clearReloadBlocks())

describe('the Log reads F\'s facts as words (06 §4 item 6)', () => {
  // MUTATION: drop the acts arm -> "Topped up brine · Skimmed the top" vanishes from the literal.
  it('acts as their words, a top-up as "+250 ml", Made and mash, the start\'s amount — one quiet line', () => {
    expect(stageRowDetail(TENDED)).toBe('All under · Topped up brine · Skimmed the top · +250 ml · white film, skimmed')
    expect(stageRowDetail(PUT_UP)).toBe('made 256 g in all · mash in 198 g')
    expect(stageRowDetail(STARTED)).toBe('about 448 g in it')
    for (const d of [TENDED, PUT_UP, STARTED].map(stageRowDetail)) expect(d).not.toMatch(/✓|✔|☑|\bx\d|\(\d+\)/)
  })
  it('an edited entry says so, in quiet ink', () => {
    renderDetail({ stages: [{ ...TENDED, edited_at: local('2026-10-02T09:00:00') }] })
    expect(screen.getByTestId('batch-detail-stage-detail').textContent).toMatch(/ · edited$/)
  })
})

describe('every entry is editable — only what changed is sent, and Undo sends it back', () => {
  // Amended with the stage-date change (Dave: stage dates editable; contract-F §2.3): a check-in, a move
  // and a noted entry now offer the date pair; a start and a put-up still keep theirs.
  it('the allowlist per kind (06 §3.7): a start and a put-up keep their date; a void is note-only', () => {
    expect(editableKeys({ stage_kind: 'tended' })).toEqual(['note', 'cue_observed', 'acts', 'ph_reading', 'ph_read_at', 'amount', 'amount_unit',
      'entered_at', 'entered_precision'])
    expect(editableKeys({ stage_kind: 'moved' })).toEqual(['note', 'storage_location_id', 'entered_at', 'entered_precision'])
    expect(editableKeys({ stage_kind: 'noted' })).toEqual(['note', 'entered_at', 'entered_precision'])
    expect(editableKeys({ stage_kind: 'put_up' })).toEqual(['note', 'amount', 'mash_in_g'])
    expect(editableKeys({ stage_kind: 'started' })).toEqual(['note', 'amount', 'amount_unit'])
    expect(editableKeys({ stage_kind: 'void' })).toEqual(['note'])
    expect(editableKeys({ stage_kind: 'tended', voided: true })).toEqual(['note'])
  })

  // MUTATION: send the whole row -> unchanged keys appear in the literal.
  it('a check-in: change the note and drop an act → one PATCH of exactly those; "Saved · Undo" puts them back', async () => {
    const { onChanged } = renderDetail({ stages: [TENDED] })
    fireEvent.click(screen.getByTestId('batch-detail-stage-edit'))
    expect(screen.getByTestId('stage-edit').getAttribute('data-kind')).toBe('tended')
    fireEvent.click(screen.getByTestId('stage-edit-act-skimmed'))
    fireEvent.change(screen.getByTestId('stage-edit-note'), { target: { value: 'white film' } })
    await act(async () => { fireEvent.click(screen.getByTestId('stage-edit-save')) })
    expect(writes()).toEqual([['PATCH', '/api/kitchen-batches/kb-1/stages/ksl-t', { note: 'white film', acts: ['topped_up'] }]])
    expect(onChanged).toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByTestId('stage-saved-undo')) })
    expect(writes()[1]).toEqual(['PATCH', '/api/kitchen-batches/kb-1/stages/ksl-t', { note: 'white film, skimmed', acts: ['topped_up', 'skimmed'] }])
  })

  // 06 §3.13 (Dave 15:55: "as we go", including after bottling). MUTATION: hide the row button on a
  // closed batch -> the click finds nothing.
  it('Made and Mash in are editable after the batch is finished', async () => {
    renderDetail({ batch: CLOSED, stages: [PUT_UP] })
    fireEvent.click(screen.getByTestId('batch-detail-stage-edit'))
    fireEvent.change(screen.getByTestId('stage-edit-amount'), { target: { value: '250' } })
    fireEvent.change(screen.getByTestId('stage-edit-mash'), { target: { value: '190' } })
    await act(async () => { fireEvent.click(screen.getByTestId('stage-edit-save')) })
    expect(writes()).toEqual([['PATCH', '/api/kitchen-batches/kb-1/stages/ksl-p', { amount: '250', mash_in_g: '190' }]])
  })

  it('a pH added on edit travels with the time it was read', () => {
    const r = stagePatch({ ...TENDED, ph_reading: null }, { ph_reading: '3.80' }, { nowIso: '2026-10-12T19:00:00.000Z' })
    expect(r.patch).toEqual({ ph_reading: '3.80', ph_read_at: '2026-10-12T19:00:00.000Z' })
    expect(r.undo).toEqual({ ph_reading: null, ph_read_at: null })
    expect(stagePatch(TENDED, { note: TENDED.note }, { nowIso: 'x' }).changed).toBe(false)
  })

  it('the edit sheet requires nothing', () => {
    renderDetail({ stages: [TENDED] })
    fireEvent.click(screen.getByTestId('batch-detail-stage-edit'))
    expect(screen.getByTestId('stage-edit').querySelectorAll('[aria-required="true"]')).toHaveLength(0)
  })
})

// Dave: stage dates are editable. contract-F §2.3's stage PATCH takes entered_at + entered_precision on
// a check-in, a move and a noted entry; the sheet asks with Start a batch's own chips (Today ·
// Yesterday · Earlier… · Not sure, the estimate windows under Earlier…). NOW is Oct 12, 3pm local.
describe('when an entry was — editable on the shared chips, sent only when touched, as a pair', () => {
  const MOVED = ST({ id: 'ksl-m', stage_kind: 'moved', entered_at: local('2026-10-05T18:00:00'), storage_location_id: 'loc-fridge' })
  const NOTED = ST({ id: 'ksl-n', stage_kind: 'noted', entered_at: local('2026-10-08T12:00:00'), note: 'more carrot' })
  // A test that opens two entries renders two details; the entry just rendered is the last one.
  const open = (stage, batch) => { renderDetail({ stages: [stage], batch }); fireEvent.click(screen.getAllByTestId('batch-detail-stage-edit').pop()) }
  const save = () => act(async () => { fireEvent.click(screen.getByTestId('stage-edit-save')) })
  const pressed = (id) => screen.getByTestId(`stage-edit-when-${id}`).getAttribute('aria-pressed')

  // MUTATION: drop the date pair from editableKeys' check-in arm -> the chips are gone and this reds.
  it('a check-in opens on the date it has; Yesterday sends the pair; Undo sends the old pair back', async () => {
    open(TENDED)
    expect(pressed('earlier')).toBe('true')
    expect(screen.getByTestId('stage-edit-when-date').value).toBe('2026-10-01')      // stored: Oct 1, 9am, exact
    fireEvent.click(screen.getByTestId('stage-edit-when-yesterday'))
    await save()
    expect(writes()).toEqual([['PATCH', '/api/kitchen-batches/kb-1/stages/ksl-t',
      { entered_at: local('2026-10-11T00:00:00'), entered_precision: 'day' }]])
    await act(async () => { fireEvent.click(screen.getByTestId('stage-saved-undo')) })
    expect(writes()[1]).toEqual(['PATCH', '/api/kitchen-batches/kb-1/stages/ksl-t', { entered_at: TENDED.entered_at, entered_precision: 'exact' }])
  })

  // MUTATION: send the date on every save -> the note-only literal carries the pair.
  it('an untouched date is never sent — a note edit is just the note', async () => {
    open(TENDED)
    fireEvent.change(screen.getByTestId('stage-edit-note'), { target: { value: 'white film, gone' } })
    await save()
    expect(writes()).toEqual([['PATCH', '/api/kitchen-batches/kb-1/stages/ksl-t', { note: 'white film, gone' }]])
  })

  it('Earlier… → Last month is that month\'s first day at month precision; Not sure is no date at all', async () => {
    open(NOTED)
    fireEvent.click(screen.getByTestId('stage-edit-when-last_month'))
    await save()
    expect(writes()[0][2]).toEqual({ entered_at: local('2026-09-01T00:00:00'), entered_precision: 'month' })
    open(MOVED)
    fireEvent.click(screen.getAllByTestId('stage-edit-when-unsure').pop())
    await save()
    expect(writes()[1]).toEqual(['PATCH', '/api/kitchen-batches/kb-1/stages/ksl-m', { entered_at: null, entered_precision: 'unknown' }])
  })

  // MUTATION: drop the future refusal -> a date that has not happened is written.
  it('a picked date is that local day; a date that has not happened yet is refused and nothing is sent', async () => {
    open(NOTED)                                             // Oct 8, noon, exact: opens on Pick a date, Oct 8
    expect(pressed('pickdate')).toBe('true')
    expect(screen.getByTestId('stage-edit-when-date').value).toBe('2026-10-08')
    fireEvent.change(screen.getByTestId('stage-edit-when-date'), { target: { value: '2026-10-20' } })
    await save()
    expect(screen.getByTestId('stage-edit-error').textContent).toBe("That date hasn't happened yet — pick another.")
    expect(writes()).toEqual([])
    fireEvent.change(screen.getByTestId('stage-edit-when-date'), { target: { value: '2026-10-03' } })
    await save()
    expect(writes()).toEqual([['PATCH', '/api/kitchen-batches/kb-1/stages/ksl-n', { entered_at: local('2026-10-03T00:00:00'), entered_precision: 'day' }]])
  })

  // MUTATION: offer the chips on every kind -> the put-up / start arms find them.
  it('a move and a noted entry offer the date too, after finishing as well; a start and a put-up never do', () => {
    open(MOVED, CLOSED)
    expect(screen.getByTestId('stage-edit-when-today')).toBeTruthy()
    open(PUT_UP, CLOSED)
    open(STARTED)
    const sheets = screen.getAllByTestId('stage-edit')
    for (const s of sheets.filter(x => x.getAttribute('data-kind') !== 'moved')) {
      expect(s.querySelector('[data-testid^="stage-edit-when-"]')).toBeNull()
    }
  })

  it('opens on the chip its stored date reads as', () => {
    const now = new Date(NOW)
    const at = (s, p) => whenSeed({ entered_at: local(s), entered_precision: p }, now)
    expect(at('2026-10-12T08:30:00', 'exact')).toEqual({ chip: 'today', earlier: null, pickedDate: '' })
    expect(at('2026-10-11T00:00:00', 'day')).toEqual({ chip: 'yesterday', earlier: null, pickedDate: '' })
    expect(at('2026-09-01T00:00:00', 'month')).toEqual({ chip: 'earlier', earlier: 'last_month', pickedDate: '' })
    expect(at('2026-10-11T09:00:00', 'exact')).toEqual({ chip: 'earlier', earlier: 'pickdate', pickedDate: '2026-10-11' })
    expect(whenSeed({ entered_at: null, entered_precision: 'unknown' }, now)).toEqual({ chip: 'unsure', earlier: null, pickedDate: '' })
  })
})

describe('"Check on it" on batch detail — in the action row since the Put-Up UX pass R1 (was: at the head of the Log, UX-I1)', () => {
  it('opens the same sheet, writes the same row kind, and says Saved · Undo', async () => {
    renderDetail()
    await act(async () => { fireEvent.click(screen.getByTestId('batch-detail-check')) })
    expect(screen.getByTestId('checkin-sheet').getAttribute('data-batch-id')).toBe('kb-1')
    fireEvent.click(screen.getByTestId('checkin-act-pushed_under'))
    await act(async () => { fireEvent.click(screen.getByTestId('checkin-save')) })
    await waitFor(() => expect(writes()).toHaveLength(1))
    // Review I-N1 (amended with the change): the row carries its date and its word. The date is the
    // instant it was SAVED — never this surface's display instant, NOW (Oct 12), taken when the batch
    // opened. MUTATION: hand the sheet `now={nowMs}` again -> the instant arm reds by days.
    const [method, path, body] = writes()[0]
    expect([method, path]).toEqual(['POST', '/api/kitchen-batches/kb-1/stages'])
    expect(body).toEqual({ stage_kind: 'tended', acts: ['pushed_under'], entered_at: expect.any(String), entered_precision: 'exact' })
    expect(Math.abs(new Date(body.entered_at).getTime() - Date.now())).toBeLessThan(60_000)
    await waitFor(() => expect(screen.getByTestId('going-checkin-saved').textContent).toBe('SavedUndo'))
  })
})

// Review I-N1. Every 1a-era row, and every check-in or move written without a precision, stores
// entered_precision NULL; the stage PATCH refuses a date without its word. So "Saved · Undo" of a date
// edit on those rows sent {entered_at, null} and got a 400. Each PATCH here is judged by the Lambda's
// REAL stagePatchError, not a copy. MUTATION: send `stored.entered_precision ?? null` again -> both
// Undo arms red ("entered_precision is required with entered_at").
describe('Undo of a date edit on a row stored with NO precision is one the Lambda takes', () => {
  const LEGACY_TENDED = { ...TENDED, id: 'ksl-lt', entered_precision: null }
  const LEGACY_MOVED = ST({ id: 'ksl-lm', stage_kind: 'moved', entered_at: local('2026-10-05T18:00:00'), entered_precision: null,
    storage_location_id: 'loc-fridge' })
  it.each([['a check-in', LEGACY_TENDED], ['a move', LEGACY_MOVED]])('%s: Yesterday, then Undo — both PATCHes pass stagePatchError', async (_what, row) => {
    renderDetail({ stages: [row] })
    fireEvent.click(screen.getAllByTestId('batch-detail-stage-edit').pop())
    fireEvent.click(screen.getByTestId('stage-edit-when-yesterday'))
    await act(async () => { fireEvent.click(screen.getByTestId('stage-edit-save')) })
    await act(async () => { fireEvent.click(screen.getByTestId('stage-saved-undo')) })
    const [forward, back] = writes().map(([, , b]) => b)
    expect(forward).toEqual({ entered_at: local('2026-10-11T00:00:00'), entered_precision: 'day' })
    expect(back).toEqual({ entered_at: row.entered_at, entered_precision: 'exact' })     // a stored date with no word was stamped: exact
    for (const b of [forward, back]) expect(stagePatchError(b, { stage_kind: row.stage_kind, voided: false })).toBeNull()
    expect(screen.queryByTestId('stage-saved')).toBeNull()                                 // the Undo landed
  })
  it('a row with no date undoes to "not sure" — the only legal undated word (chk_ksl_entered_pairing)', () => {
    const r = stagePatch({ ...TENDED, entered_at: null, entered_precision: null },
      { entered_at: local('2026-10-11T00:00:00'), entered_precision: 'day' }, { nowIso: 'x' })
    expect(r.undo).toEqual({ entered_at: null, entered_precision: 'unknown' })
    expect(stagePatchError(r.undo, { stage_kind: 'tended', voided: false })).toBeNull()
  })
})

describe('the kind question, inline on batch detail (06 §3.10)', () => {
  // MUTATION: gate it on an open batch -> the closed arm reds.
  it('is asked on an open AND a closed batch whose kind is unanswered, and not once it is', async () => {
    renderDetail({ batch: { kind: null } })
    renderDetail({ batch: { ...CLOSED, kind: null } })
    expect(screen.getAllByTestId('batch-kind-question')).toHaveLength(2)
    renderDetail()
    expect(screen.getAllByTestId('batch-kind-question')).toHaveLength(2)
    fireEvent.click(screen.getAllByTestId('batch-kind-question')[0])
    await act(async () => { fireEvent.click(screen.getByTestId('batch-kind-ferment')) })
    expect(writes()[0]).toEqual(['PUT', '/api/kitchen-batches/kb-1', { kind: 'ferment' }])
  })
})

describe('"Following a recipe?" — record and point, never assess (FOODSAFETY-RULING-V101 §3)', () => {
  it('records a name or a link through the merge PUT, with the tested-recipe advice linked', async () => {
    renderDetail()
    expect(screen.getByTestId('recipe-ref-tested-link').getAttribute('href')).toBe(TESTED_RECIPE_LINK)
    fireEvent.click(screen.getByTestId('recipe-ref-open'))
    expect(screen.getByTestId('recipe-ref-note').textContent).toContain(TESTED_RECIPE_NOTE)
    expect(screen.getByTestId('recipe-ref-editor').querySelectorAll('[aria-required="true"]')).toHaveLength(0)
    fireEvent.change(screen.getByTestId('recipe-ref-input'), { target: { value: 'https://example.org/kraut' } })
    await act(async () => { fireEvent.click(screen.getByTestId('recipe-ref-save')) })
    expect(writes()[0]).toEqual(['PUT', '/api/kitchen-batches/kb-1', { recipe_ref: 'https://example.org/kraut' }])
    expect(screen.getByTestId('recipe-ref').textContent).not.toMatch(/\bsafe\b|\bsafety\b|\bshelf\b|\bkeeps\b|\bgood\b/i)
  })
  it('shows what is being followed, as a link when it is one', () => {
    renderDetail({ batch: { recipe_ref: 'https://example.org/kraut' } })
    expect(screen.getByTestId('recipe-ref-current').querySelector('a').getAttribute('href')).toBe('https://example.org/kraut')
  })
})
