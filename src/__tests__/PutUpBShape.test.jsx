// Put-Up 1a addendum item 9 — 1a IS THE STALE READER OF B-SHAPED DATA.
//
// Release 1a ships first and alone; releases 1b–4 ship later and write rows 1a has never seen. Until
// the B promote lands — and afterwards, on any phone that has not refreshed its bundle — 1a's batch
// surfaces READ what 1b–4 WRITE. This file renders Going now, batch detail and the closed list against
// rows shaped the way V4 §4.2–§4.5 and Appendix A say those releases will write them:
//   • future stage kinds: put_up · noted · paused · resumed · reopened · void (Appendix A), including
//     a put_up row whose date is "not sure" (entered_at NULL + entered_precision 'unknown');
//   • future input kinds: put_up · garden · pantry with and without a linked pantry item, and a salt
//     line carrying the helper's facts (§4.2, §4.3, §3.7);
//   • a jar in What came out with a NULL quantity pair and a label but no crop (§4.2's label-only jar);
//   • unknown extra keys on every row: entered_precision, voids_id, idempotency_key, recipe_id,
//     salt_pct, role, ordinal, deleted_at — plus the widened start precisions (season, year) and a
//     kind 'other' with no text (1b relaxes chk_kitchen_batch_kind_other).
// REQUIRED (the addendum): no crash; no "null" / "undefined" / "NaN" text; an unknown kind falls back
// to the shipped generic words — "Logged" for a stage row (BatchDetailView stageRowText), "Something
// that went in" for an input row (batchInputs.js describeInputRow), "Something else" for an outcome —
// and never to its raw machine value. Nothing here asserts NEW behaviour for B rows; it pins that the
// shipped fallbacks hold, so a stale 1a phone degrades to plain words rather than to a broken screen.
//
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig()
  return { ...actual, useNavigate: () => vi.fn() }
})
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: null }) }))

import GoingNowView from '../components/putup/GoingNowView.jsx'
import BatchDetailView from '../components/putup/BatchDetailView.jsx'
import ClosedBatchesView from '../components/putup/ClosedBatchesView.jsx'

const NOW = new Date('2026-10-20T09:00:00').getTime()
const local = (s) => new Date(s).toISOString()
const BROKEN_TEXT = /\bnull\b|\bundefined\b|\bNaN\b|\[object Object\]/
// A RAW stored value is a snake_case identifier (put_up, finished_none_kept, hot_sauce…): no word the
// app writes looks like one. Kinds that are ALSO English (noted, paused, void, garden) are pinned by
// exact row text below instead — the closed list's own copy says "One you had paused comes back
// going", and a word sweep for `paused` would red on the app's prose.
const RAW_KINDS = /\b[a-z]+(?:_[a-z]+)+\b/

// Every key a B-release row may carry that 1a has never read. Spread onto every fixture below.
const B_KEYS = {
  entered_precision: 'unknown', voids_id: null, idempotency_key: '0f6e8b2c-3c1d-4a5e-9f7a-2b8c1d4e5f60',
  recipe_id: 'b3c1d2e4-0000-4000-8000-000000000001', salt_pct: '2.5', role: null, ordinal: 3, deleted_at: null,
  current_storage_location_id: null, total_remaining: '3',
}

const base = (o) => ({
  user_id: 'user_dave', kind_other: null, expected_days_min: null, expected_days_max: null,
  suspended_at: null, closed_at: null, outcome: null, outcome_note: null, current_stage_label: null,
  input_count: '5', output_count: '1', last_ph_reading: null, last_ph_read_at: null,
  first_recorded_at: local('2026-09-20T09:00:00'), ...B_KEYS, ...o,
})

// ── Going now: one card per future stage kind heading the row ──────────────────────────────────────
const GOING_B = [
  // A put_up whose date is "not sure": no instant at all on the head row.
  base({ id: 'kb-b-putup', label: 'Megatron mash', kind: 'ferment', started_at: local('2026-10-01T09:00:00'),
    start_precision: 'day', current_stage_kind: 'put_up', current_stage_entered_at: null,
    last_ph_reading: '3.70', last_ph_read_at: local('2026-10-18T09:00:00') }),
  // 1b: "Other" needs no text.
  base({ id: 'kb-b-noted', label: 'Drinking vinegar', kind: 'other', kind_other: null, started_at: local('2026-10-05T09:00:00'),
    start_precision: 'day', current_stage_kind: 'noted', current_stage_entered_at: local('2026-10-19T09:00:00') }),
  // 1b widens start_precision with season and year (V4 §3.6).
  base({ id: 'kb-b-season', label: 'Apple rings', kind: 'dehydrate', started_at: local('2026-07-01T09:00:00'),
    start_precision: 'season', current_stage_kind: 'resumed', current_stage_entered_at: local('2026-10-10T09:00:00'),
    expected_days_min: 1, expected_days_max: 2 }),
  base({ id: 'kb-b-year', label: 'Cured garlic', kind: 'cure', started_at: local('2026-01-01T09:00:00'),
    start_precision: 'year', current_stage_kind: 'void', current_stage_entered_at: local('2026-10-12T09:00:00') }),
  base({ id: 'kb-b-reopened', label: 'Kraut, reopened', kind: null, started_at: null, start_precision: 'unknown',
    current_stage_kind: 'reopened', current_stage_entered_at: local('2026-10-15T09:00:00') }),
  base({ id: 'kb-b-paused', label: 'Candy parent', kind: 'candy', started_at: local('2026-06-14T09:00:00'),
    start_precision: 'day', suspended_at: '2026-10-01T12:00:00.000Z', current_stage_kind: 'paused',
    current_stage_entered_at: '2026-10-01T12:00:00.000Z' }),
]

// ── Batch detail: every future stage kind in the log, every future input kind, a label-only jar ─────
const STAGE = (o) => ({
  batch_id: 'kb-b-putup', label: null, amount: null, amount_unit: null, cue_observed: null, ph_reading: null,
  ph_read_at: null, storage_location_id: null, photo_id: null, note: null, created_by: 'user_dave', ...B_KEYS, ...o,
})
const STAGES_B = [
  STAGE({ id: 'ksl-void', stage_kind: 'void', voids_id: 'ksl-tended', entered_at: local('2026-10-19T09:00:00'), entered_precision: 'exact' }),
  STAGE({ id: 'ksl-noted', stage_kind: 'noted', note: 'Next time: more carrot', entered_at: local('2026-10-18T09:00:00'), entered_precision: 'exact' }),
  STAGE({ id: 'ksl-reopened', stage_kind: 'reopened', entered_at: local('2026-10-17T09:00:00'), entered_precision: 'exact' }),
  STAGE({ id: 'ksl-resumed', stage_kind: 'resumed', entered_at: local('2026-10-16T09:00:00'), entered_precision: 'exact' }),
  STAGE({ id: 'ksl-paused', stage_kind: 'paused', entered_at: local('2026-10-15T09:00:00'), entered_precision: 'exact' }),
  STAGE({ id: 'ksl-tended', stage_kind: 'tended', ph_reading: '3.70', ph_read_at: local('2026-10-14T09:00:00'),
    entered_at: local('2026-10-14T09:00:00'), entered_precision: 'exact', cue_observed: 'All under' }),
  // "Not sure" put-up: no instant, and the sitting's yield on the row.
  STAGE({ id: 'ksl-put', stage_kind: 'put_up', entered_at: null, entered_precision: 'unknown', amount: '910', amount_unit: 'g' }),
  STAGE({ id: 'ksl-start', stage_kind: 'started', entered_at: local('2026-10-01T09:00:00'), entered_precision: 'day' }),
]
const INPUT = (o) => ({
  batch_id: 'kb-b-putup', harvest_log_id: null, label: null, qty: null, qty_unit: null, is_byproduct: false,
  added_at: local('2026-10-01T09:00:00'), note: null, plant_id: null, preservation_log_id: null, pantry_item_id: null,
  crop_type_slug: null, source_label: null, role: null, salt_pct: null, salt_base: null, base_g: null,
  put_up_stage_id: null, output_id: null, ...B_KEYS, ...o,
})
const INPUTS_B = [
  INPUT({ id: 'kbi-garden', input_kind: 'garden', plant_id: 'pl-megatron', crop_type_slug: 'pepper', qty: '412', qty_unit: 'g', ordinal: 1 }),
  INPUT({ id: 'kbi-jar', input_kind: 'put_up', preservation_log_id: 'pl-reaper', qty: '8', qty_unit: 'g', ordinal: 2 }),
  INPUT({ id: 'kbi-pantry-linked', input_kind: 'pantry', pantry_item_id: 'pi-onions', label: 'Onions', ordinal: 3 }),
  INPUT({ id: 'kbi-pantry-bare', input_kind: 'pantry', label: 'Garlic', qty: '4', qty_unit: 'clove', ordinal: 4 }),
  INPUT({ id: 'kbi-salt', input_kind: 'other', label: 'Salt', qty: '16.25', qty_unit: 'g', role: 'salt', salt_pct: '2.5',
    salt_base: 'peppers', base_g: '650', ordinal: 5 }),
  // A line added at the put-up sitting, with no amount at all.
  INPUT({ id: 'kbi-sitting', input_kind: 'purchased', label: 'Vinegar', put_up_stage_id: 'ksl-put', ordinal: 6 }),
]
// §4.2's label-only jar: NULL quantity pair, a label, no crop — and every 1b column beside it.
const OUTPUTS_B = [{
  id: 'pl-b-1', batch_id: 'kb-b-putup', user_id: 'user_dave', crop_type_slug: null, variety_id: null, plant_id: null,
  harvest_log_id: null, preserved_at: '2026-10-08', preserved_at_approx: true, preserved_at_precision: 'after',
  method: 'hot_sauce', method_other_text: null, quantity_value: null, quantity_unit: null, package_count: 2,
  storage_location_id: 'loc-fridge', remaining_count: 2, consumed_at: null, notes: null, photo_id: null,
  label: 'Megatron reaper', container_label: '8 oz woozy', use_by_basis: 'typed', storage_moved_at: null,
  texture: null, is_raw: null, in_oil: null, ph_reading: '3.7', ph_read_at: local('2026-10-08T09:00:00'),
  put_up_stage_id: 'ksl-put', delta_at: null, idempotency_key: B_KEYS.idempotency_key,
  created_at: '2026-10-08T12:00:00.000Z', updated_at: '2026-10-08T12:00:00.000Z',
}]

// ── Closed: a 1b "Other" batch, and an outcome value this bundle has never seen ─────────────────────
const CLOSED_B = [
  base({ id: 'kb-b-closed', label: 'Hot Ones mash', kind: 'other', kind_other: null, started_at: local('2026-09-01T09:00:00'),
    start_precision: 'season', closed_at: '2026-10-08T12:00:00.000Z', outcome: 'put_up', current_stage_kind: 'finished',
    current_stage_entered_at: '2026-10-08T12:00:00.000Z', output_count: '4' }),
  base({ id: 'kb-b-unknown', label: 'A make with none kept', kind: 'ferment', started_at: local('2026-09-10T09:00:00'),
    start_precision: 'day', closed_at: '2026-10-02T12:00:00.000Z', outcome: 'finished_none_kept', current_stage_kind: 'void',
    current_stage_entered_at: null, output_count: '0' }),
]

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation((path) => Promise.resolve(path === '/api/storage-locations' ? [] : null))
})

// Every text node, joined with a SPACE. textContent concatenates adjacent nodes with nothing between
// them ("All under" + "put_up" + "Started" reads "All underput_upStarted"), which hides a raw value or
// a "null" from any word-bounded pattern — a blind spot measured on this file's own first draft.
function textOf(el) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const parts = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.nodeValue)
  return parts.join(' ')
}

function expectPlainWords(el, what) {
  const text = textOf(el)
  expect(text.length, `${what} rendered no text at all`).toBeGreaterThan(0)
  expect(text, `${what} shows a broken value`).not.toMatch(BROKEN_TEXT)
  expect(text, `${what} shows a raw stored value`).not.toMatch(RAW_KINDS)
}

describe('Going now reads B-shaped batches', () => {
  it('renders every card, in plain words, with the future stage kinds heading their rows', () => {
    render(
      <MemoryRouter initialEntries={['/put-up']}>
        <GoingNowView batches={GOING_B} loading={false} error={false} onReload={vi.fn()} now={NOW} />
      </MemoryRouter>,
    )
    expect(screen.getAllByTestId('going-batch')).toHaveLength(6)
    expectPlainWords(screen.getByTestId('going-now-view'), 'Going now')
    const byId = Object.fromEntries(screen.getAllByTestId('going-batch').map(c => [c.getAttribute('data-batch-id'), c]))
    // A future kind with an unknown instant says nothing about its stage — never a raw kind, never a
    // stray separator.
    expect(within(byId['kb-b-putup']).getByTestId('going-batch-meta').textContent).toBe('19 days')
    // A future kind WITH an instant keeps the shipped "last touched" half, and still no raw kind.
    expect(within(byId['kb-b-noted']).getByTestId('going-batch-meta').textContent).toBe('15 days · last touched 1 day ago')
    // The widened precisions read as approximate, like every coarse grade today.
    expect(within(byId['kb-b-season']).getByTestId('going-batch-meta').textContent).toMatch(/^about /)
    // 1b's text-less "Other" is an answer: the kind question is not asked of it.
    expect(within(byId['kb-b-noted']).queryByTestId('going-kind-question')).toBeNull()
    expect(within(byId['kb-b-reopened']).getByTestId('going-kind-question')).toBeTruthy()
  })

  it('opens Check on it on a B-shaped batch of each kind without a broken word', async () => {
    render(
      <MemoryRouter initialEntries={['/put-up']}>
        <GoingNowView batches={GOING_B} loading={false} error={false} onReload={vi.fn()} now={NOW} />
      </MemoryRouter>,
    )
    for (const card of screen.getAllByTestId('going-batch')) {
      await act(async () => { fireEvent.click(within(card).getByTestId('going-check')) })
      const dialog = screen.getByRole('dialog', { name: 'Check on it' })
      expectPlainWords(dialog, `Check on it for ${card.getAttribute('data-batch-id')}`)
      await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Close' })) })
    }
  })
})

describe('batch detail reads a B-shaped batch', () => {
  const renderDetail = (batch = GOING_B[0]) => render(
    <BatchDetailView batch={batch} inputs={INPUTS_B} stages={STAGES_B} outputs={OUTPUTS_B}
      loading={false} error={false} nowMs={NOW} onChanged={vi.fn()} />,
  )

  it('renders the whole surface in plain words, inputs revealed', () => {
    renderDetail()
    fireEvent.click(screen.getByTestId('batch-inputs-reveal'))
    expectPlainWords(screen.getByTestId('batch-detail-view'), 'batch detail')
  })

  // Put-Up release 1b amends this in the same commit that teaches the Log its new kinds (V4 §8.3): the
  // 1b kinds read in words, a void row and the check-in it voids are both gone from the Log (as from
  // every stage LATERAL), and an undated "Not sure" put-up is its bare label.
  it('the 1b stage kinds read in words; a void row and the row it voids are left out', () => {
    renderDetail()
    const rows = screen.getAllByTestId('batch-detail-stage').map(r => r.firstElementChild.textContent)
    expect(rows).toEqual([
      'Next time · Oct 18', 'Reopened · Oct 17', 'Picked back up · Oct 16', 'Paused · Oct 15',
      'Put up', 'Started · Oct 1',
    ])
    // The noted row's note is still read back, under its row.
    expect(screen.getAllByTestId('batch-detail-stage-detail').map(d => d.textContent)).toContain('Next time: more carrot')
  })

  it('every future input kind falls back to the shipped generic words, with its amount', () => {
    renderDetail()
    fireEvent.click(screen.getByTestId('batch-inputs-reveal'))
    const lines = within(screen.getByTestId('batch-inputs-list')).getAllByRole('listitem').map(li => li.firstElementChild.textContent)
    expect(lines).toEqual([
      'Something that went in — 412 g',
      'Something that went in — 8 g',
      'Onions — the whole pick',
      'Garlic — 4 clove',
      'Salt — 16.25 g',
      'Vinegar — the whole pick',
    ])
    expect(screen.getByTestId('batch-inputs-count').textContent).toBe('6 things written down.')
  })

  // Amended with 1b's jar words (V4 §7 "jars show their name, no-size form and date words everywhere"):
  // a sitting's jar reads as its name, count × container and its date at its precision, under the
  // sitting it came from.
  it('a label-only jar with no quantity pair renders as its name, count × container and date words — no blank, no null', () => {
    renderDetail()
    expect(screen.getByTestId('batch-detail-output').textContent)
      .toBe('Megatron reaper · 2 × 8 oz woozy · put up sometime after Oct 8 · pH 3.7')
    expect(screen.getByTestId('batch-detail-sitting').getAttribute('data-stage-id')).toBe('ksl-put')
  })

  it('reads a closed B batch back through the label table, never the raw outcome', () => {
    renderDetail({ ...CLOSED_B[1], inputs: [], stages: [], outputs: [] })
    // batchClose.js OUTCOME_FALLBACK_LABEL — this surface's shipped word for an outcome it does not know.
    expect(screen.getByTestId('batch-detail-outcome').textContent).toBe('Closed · closed Oct 2')
    expectPlainWords(screen.getByTestId('batch-detail-view'), 'closed batch detail')
  })
})

describe('the closed list reads B-shaped batches', () => {
  it('renders both rows in plain words, an unknown outcome as "Something else"', () => {
    render(<ClosedBatchesView batches={CLOSED_B} loading={false} error={false} onReload={vi.fn()} now={NOW} />)
    expect(screen.getAllByTestId('closed-batch')).toHaveLength(2)
    expectPlainWords(screen.getByTestId('closed-batches-view'), 'closed list')
    const metas = screen.getAllByTestId('closed-batch-meta').map(m => m.textContent)
    expect(metas.some(m => m.includes('Something else'))).toBe(true)
    expect(metas.some(m => m.includes('4 put-ups'))).toBe(true)
  })
})

describe('the plain-words check is an instrument, not a formality', () => {
  it('catches each broken value and each raw kind it claims to', () => {
    for (const bad of ['pH null', 'undefined days', 'NaN put-ups', '[object Object]']) {
      expect(`${bad}: ${BROKEN_TEXT.test(bad)}`).toBe(`${bad}: true`)
    }
    for (const raw of ['put_up · Oct 1', 'finished_none_kept', 'Hot sauce (hot_sauce)']) {
      expect(`${raw}: ${RAW_KINDS.test(raw)}`).toBe(`${raw}: true`)
    }
    // …and does not trip on the words the app writes.
    expect(RAW_KINDS.test('Paused since Oct 1. One you had paused comes back going, not paused.')).toBe(false)
    expect(RAW_KINDS.test('Something that went in — 8 g')).toBe(false)
    expect(BROKEN_TEXT.test('Nothing logged yet.')).toBe(false)
  })
})
