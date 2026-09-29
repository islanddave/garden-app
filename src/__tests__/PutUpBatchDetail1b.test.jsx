// Put-Up release 1b on batch detail (V4 §2.3, §2.4, Appendix A): What came out by sitting with Undo
// that put-up, the Put it up door, Remove this batch, and the pause history row. Each assertion names
// the mutation that reds it. CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))

import BatchDetailView, { liveStages, outputSittings } from '../components/putup/BatchDetailView.jsx'
import { HAS_JARS_TEXT } from '../lib/putUpErrors.js'

const NOW = new Date('2026-10-20T09:00:00').getTime()
const local = (s) => new Date(s).toISOString()
const BATCH = {
  id: 'kb-1', user_id: 'user_dave', label: 'Megatron mash', kind: 'ferment', kind_other: null,
  started_at: local('2026-10-01T09:00:00'), start_precision: 'day', first_recorded_at: local('2026-10-01T09:00:00'),
  suspended_at: null, closed_at: null, outcome: null, outcome_note: null, current_stage_kind: 'tended',
  current_stage_entered_at: local('2026-10-10T09:00:00'), input_count: '0', output_count: '2',
}
const ST = (o) => ({ batch_id: 'kb-1', label: null, amount: null, amount_unit: null, cue_observed: null, note: null,
  ph_reading: null, ph_read_at: null, voids_id: null, entered_precision: 'day', ...o })
const STAGES = [
  ST({ id: 'ksl-put2', stage_kind: 'put_up', entered_at: local('2026-10-12T09:00:00'), amount: '910', amount_unit: 'g' }),
  ST({ id: 'ksl-void', stage_kind: 'void', voids_id: 'ksl-put1', entered_at: local('2026-10-11T10:00:00'), entered_precision: 'exact' }),
  ST({ id: 'ksl-put1', stage_kind: 'put_up', entered_at: local('2026-10-11T09:00:00') }),
  ST({ id: 'ksl-start', stage_kind: 'started', entered_at: local('2026-10-01T09:00:00') }),
]
const JAR = (o) => ({ batch_id: 'kb-1', preserved_at: '2026-10-12', preserved_at_precision: 'day', package_count: 2,
  quantity_value: null, quantity_unit: null, container_label: '8 oz woozy', is_raw: null, in_oil: null, ph_reading: null, ...o })
const OUTPUTS = [
  JAR({ id: 'pl-plain', label: 'Megatron plain', put_up_stage_id: 'ksl-put2' }),
  JAR({ id: 'pl-reaper', label: 'Megatron reaper', put_up_stage_id: 'ksl-put2', in_oil: true }),
  // A JarPicker-linked jar: no sitting, no Undo, the shipped words.
  { id: 'pl-old', batch_id: 'kb-1', preserved_at: '2026-09-02', package_count: 1, quantity_value: '2.5', quantity_unit: 'qt' },
]

const renderDetail = (o = {}) => render(
  <BatchDetailView batch={{ ...BATCH, ...o.batch }} inputs={[]} stages={o.stages ?? STAGES} outputs={o.outputs ?? OUTPUTS}
    loading={false} error={false} nowMs={NOW} onChanged={o.onChanged ?? vi.fn()} onRemoved={o.onRemoved} />,
)
const calls = (re, method) => fetchMock.mock.calls.filter(([p, opt]) => re.test(p) && (opt?.method ?? 'GET') === method)

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(() => Promise.resolve({ ok: true }))
  localStorage.clear()
})

describe('the Log and What came out read the history as it stands', () => {
  // MUTATION: keep void rows (or the rows they void) -> both literals red.
  it('liveStages drops a void row and the row it voids', () => {
    expect(liveStages(STAGES).map(r => r.id)).toEqual(['ksl-put2', 'ksl-start'])
  })

  it('groups jars under the sitting that made them; a linked jar stays apart', () => {
    const { sittings, linked } = outputSittings(OUTPUTS, STAGES)
    expect(sittings.map(s => [s.stage.id, s.jars.map(j => j.id)])).toEqual([['ksl-put2', ['pl-plain', 'pl-reaper']]])
    expect(linked.map(j => j.id)).toEqual(['pl-old'])
  })

  it('renders each sitting with its date, yield, jars in words and one Undo', () => {
    renderDetail()
    const sitting = screen.getByTestId('batch-detail-sitting')
    // Release F: the sitting's head is a button (it opens the put-up's own Log entry, 06 §3.7).
    expect(screen.getByTestId('batch-detail-sitting-head').firstElementChild.textContent).toBe('Put up · Oct 12')
    expect(screen.getByTestId('batch-detail-sitting-facts').textContent).toBe('made 910 g in all')
    expect(sitting.textContent).toContain('made 910 g in all')
    const jars = screen.getAllByTestId('batch-detail-output-text').map(e => e.textContent)
    expect(jars).toEqual([
      'Megatron plain · 2 × 8 oz woozy · put up Oct 12',
      'Megatron reaper · 2 × 8 oz woozy · put up Oct 12 · in oil',
      '2.5 qt · Sep 2',                       // A3: one container, so the total is just the size
    ])
    expect(screen.getAllByTestId('batch-detail-undo-putup')).toHaveLength(1)
  })
})

describe('Undo that put-up, on the sitting', () => {
  it('posts the sitting\'s undo route and re-reads', async () => {
    const onChanged = vi.fn()
    renderDetail({ onChanged })
    await act(async () => { fireEvent.click(screen.getByTestId('batch-detail-undo-putup')) })
    expect(calls(/\/undo$/, 'POST').map(c => c[0])).toEqual(['/api/kitchen-batches/kb-1/put-up/ksl-put2/undo'])
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('a refusal says why and the sitting stays', async () => {
    fetchMock.mockImplementation(() => Promise.reject(Object.assign(new Error('409'), { status: 409,
      body: { code: 'put_up_in_use', jar_ids: ['pl-plain'], error: 'One of those jars was already used.' } })))
    renderDetail()
    await act(async () => { fireEvent.click(screen.getByTestId('batch-detail-undo-putup')) })
    await waitFor(() => expect(screen.getByTestId('batch-detail-undo-error').textContent).toBe('One of those jars was already used.'))
    expect(screen.getByTestId('batch-detail-undo-putup')).toBeTruthy()
  })
})

describe('the Put it up door', () => {
  // MUTATION: drop the !closed guard -> the closed arm reds.
  it('opens the sheet on an open batch and is absent on a closed one', async () => {
    fetchMock.mockImplementation((p) => Promise.resolve(p === '/api/storage-locations' ? [] : { ok: true }))
    const { unmount } = renderDetail()
    await act(async () => { fireEvent.click(screen.getByTestId('batch-detail-put-up')) })
    expect(screen.getByTestId('putup-sheet').getAttribute('data-batch-id')).toBe('kb-1')
    unmount()
    renderDetail({ batch: { closed_at: local('2026-10-12T10:00:00'), outcome: 'put_up' } })
    expect(screen.queryByTestId('batch-detail-put-up')).toBeNull()
  })
})

describe('Remove this batch', () => {
  it('is two-step and leaves on success', async () => {
    const onRemoved = vi.fn()
    renderDetail({ outputs: [], stages: [STAGES[3]], onRemoved })
    fireEvent.click(screen.getByTestId('batch-remove'))
    expect(calls(/kitchen-batches\/kb-1$/, 'DELETE')).toHaveLength(0)
    await act(async () => { fireEvent.click(screen.getByTestId('batch-remove-yes')) })
    expect(calls(/kitchen-batches\/kb-1$/, 'DELETE')).toHaveLength(1)
    expect(onRemoved).toHaveBeenCalled()
  })

  it('refused while it has jars, in words that say what to do', async () => {
    fetchMock.mockImplementation(() => Promise.reject(Object.assign(new Error('409'), { status: 409, body: { code: 'has_jars', error: 'x' } })))
    renderDetail()
    fireEvent.click(screen.getByTestId('batch-remove'))
    await act(async () => { fireEvent.click(screen.getByTestId('batch-remove-yes')) })
    await waitFor(() => expect(screen.getByTestId('batch-remove-error').textContent).toBe(HAS_JARS_TEXT))
  })
})

describe('pause history (Appendix A)', () => {
  // MUTATION: go back to the merge PUT of suspended_at -> no stage POST and this reds.
  it('a pause is ONE stages POST (`paused`); picking back up is one `resumed` — the server writes column and row together', async () => {
    renderDetail()
    await act(async () => { fireEvent.click(screen.getByTestId('batch-pause')) })
    expect(calls(/./, 'PUT')).toHaveLength(0)
    expect(calls(/\/stages$/, 'POST').map(c => JSON.parse(c[1].body))).toEqual([{ stage_kind: 'paused' }])
    fetchMock.mockClear()
    renderDetail({ batch: { suspended_at: local('2026-10-15T09:00:00') } })
    await act(async () => { fireEvent.click(screen.getAllByTestId('batch-pause')[1]) })
    expect(calls(/\/stages$/, 'POST').map(c => JSON.parse(c[1].body).stage_kind)).toEqual(['resumed'])
  })
})
