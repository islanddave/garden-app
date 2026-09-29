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
import { stagePatch, editableKeys } from '../components/putup/StageEditSheet.jsx'
import { TESTED_RECIPE_LINK, TESTED_RECIPE_NOTE } from '../components/putup/RecipeRefRow.jsx'
import { clearReloadBlocks } from '../lib/reloadGate.js'

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
  it('the allowlist per kind (06 §3.7): a start and a put-up keep their date; a void is note-only', () => {
    expect(editableKeys({ stage_kind: 'tended' })).toEqual(['note', 'cue_observed', 'acts', 'ph_reading', 'ph_read_at', 'amount', 'amount_unit'])
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

describe('"Check on it" at the head of the Log (UX-I1)', () => {
  it('opens the same sheet, writes the same row kind, and says Saved · Undo', async () => {
    renderDetail()
    await act(async () => { fireEvent.click(screen.getByTestId('batch-detail-check')) })
    expect(screen.getByTestId('checkin-sheet').getAttribute('data-batch-id')).toBe('kb-1')
    fireEvent.click(screen.getByTestId('checkin-act-pushed_under'))
    await act(async () => { fireEvent.click(screen.getByTestId('checkin-save')) })
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]).toEqual(['POST', '/api/kitchen-batches/kb-1/stages', { stage_kind: 'tended', acts: ['pushed_under'] }])
    await waitFor(() => expect(screen.getByTestId('going-checkin-saved').textContent).toBe('SavedUndo'))
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
