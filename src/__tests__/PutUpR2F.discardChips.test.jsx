// Put-Up R2a, lane F (D5 I3) — Put it up's "Discard by" shows THREE chips, as the door and the Walk do:
// `Work it out` · `From the label` · `No date`, with `Work it out` pressed at open. Before R2a it showed
// two, neither pressed, so the worked-out date — the answer every untouched row already gives — looked like
// no answer at all. The control's shape is the only change: the body is what it was, and an untouched row
// still sends no date key.
// The words-from-DISCARD_LABELS half is the amended pin in PutUpUxE.discardWords.test.jsx.
// MUTATIONS (each run, each red here):
//   F-M4 two discard chips, none pressed (= the base)  -> "three chips, Work it out pressed; an untouched save sends no use_by_target"
//   Work it out sends a date key                        -> the same test, and "back on Work it out…"
//   a second tap on Work it out un-presses it           -> "a second tap…"
// CI LANE: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act, cleanup } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }), apiFetch: (...a) => fetchMock(...a) }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))

import PutItUpSheet, { isPutItUpDraft } from '../components/putup/PutItUpSheet.jsx'
import { DISCARD_LABELS, newRow } from '../components/putup/putItUp.js'
import { SHEET_DRAFT_PREFIX, SHEET_DRAFT_VERSION } from '../components/kitchen/sheetDraft.js'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const NOW = new Date('2026-09-29T15:00:00').getTime()
const BATCH = { id: 'kb-mash', user_id: 'user_dave', label: 'Megatron mash', kind: 'ferment',
  started_at: new Date('2026-09-20T09:00:00').toISOString(), start_precision: 'day', closed_at: null, suspended_at: null, outputs: [] }
const PLACES = [{ id: 'loc-fridge', user_id: 'user_dave', label: 'Fridge', kind: 'fridge' }]
const JAR = { id: 'pl-1', label: 'Megatron mash', preserved_at: '2026-09-29', preserved_at_precision: 'day', use_by_target: '2027-03-29', use_by_basis: 'table' }
const DRAFT_KEY = `${SHEET_DRAFT_PREFIX}user_dave:putup:kb-mash`

const putUps = () => fetchMock.mock.calls.filter(([p, o]) => /\/put-up$/.test(p) && o?.method === 'POST')
const sent = () => putUps()[0][1].body
const tap = (id) => act(async () => { fireEvent.click(screen.getByTestId(id)) })
const chip = (mode) => screen.getByTestId(`putup-row-0-discard-${mode}`)
// [testid, words, pressed] for every chip of the group, in order.
const chips = () => within(screen.getByRole('group', { name: 'Discard by' })).getAllByRole('button')
  .map(c => [c.getAttribute('data-testid'), c.textContent, c.getAttribute('aria-pressed')])
const pressed = () => chips().filter(c => c[2] === 'true').map(c => c[1])

async function open({ fill = true } = {}) {
  render(<PutItUpSheet open batch={BATCH} lines={[]} now={NOW} onClose={() => {}} onDone={() => {}} />)
  await waitFor(() => expect(screen.getByTestId('putup-row-0-place-id:loc-fridge')).toBeTruthy())
  if (fill) {
    await tap('putup-method-hot_sauce')
    await tap('putup-row-0-place-id:loc-fridge')
  }
  await tap('putup-row-0-more')
}
async function finish() {
  await tap('putup-finish')
  await waitFor(() => expect(putUps()).toHaveLength(1))
  return JSON.parse(sent()).rows[0]
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation((path) => {
    if (path === '/api/storage-locations') return Promise.resolve(PLACES)
    if (/\/put-up$/.test(path)) return Promise.resolve({ stage: { id: 'ksl-1' }, jars: [JAR], inputs: [], batch: {} })
    return Promise.resolve(null)
  })
  localStorage.clear(); clearReloadBlocks()
  window.history.replaceState({ __floor: 1 }, '')
})
afterEach(() => { cleanup(); clearReloadBlocks() })

describe('Put it up — Discard by: Work it out · From the label · No date (I3)', () => {
  it('three chips, Work it out pressed; an untouched save sends no use_by_target', async () => {
    await open()
    expect(chips()).toEqual([
      ['putup-row-0-discard-auto', 'Work it out', 'true'],
      ['putup-row-0-discard-date', 'From the label', 'false'],
      ['putup-row-0-discard-none', 'No date', 'false'],
    ])
    expect(chips().map(c => c[1])).toEqual([DISCARD_LABELS.auto, DISCARD_LABELS.date, DISCARD_LABELS.none])
    expect(screen.queryByTestId('putup-row-0-discard-day')).toBeNull()
    // The body is what it was: the server works the date out, so the row names no date at all. The route's
    // key is `discard_by`; `use_by_target` is the column it lands in, and neither is in the body.
    const row = await finish()
    expect(row).toEqual({ count: 1, place: { id: 'loc-fridge' } })
    expect(sent()).not.toMatch(/discard_by|use_by/)
  })

  it('one chip is pressed at a time; From the label opens the date field, the others take it away', async () => {
    await open()
    await tap('putup-row-0-discard-date')
    expect(pressed()).toEqual(['From the label'])
    expect(screen.getByTestId('putup-row-0-discard-day').getAttribute('type')).toBe('date')
    await tap('putup-row-0-discard-none')
    expect(pressed()).toEqual(['No date'])
    expect(screen.queryByTestId('putup-row-0-discard-day')).toBeNull()
    await tap('putup-row-0-discard-auto')
    expect(pressed()).toEqual(['Work it out'])
    expect(screen.queryByTestId('putup-row-0-discard-day')).toBeNull()
  })

  it('back on Work it out after a typed date, the row sends no date key again', async () => {
    await open()
    await tap('putup-row-0-discard-date')
    fireEvent.change(screen.getByTestId('putup-row-0-discard-day'), { target: { value: '2026-12-08' } })
    await tap('putup-row-0-discard-auto')
    expect(await finish()).toEqual({ count: 1, place: { id: 'loc-fridge' } })
  })

  it('From the label sends the day typed, and No date sends none — as they did', async () => {
    await open()
    await tap('putup-row-0-discard-date')
    fireEvent.change(screen.getByTestId('putup-row-0-discard-day'), { target: { value: '2026-12-08' } })
    expect((await finish()).discard_by).toBe('2026-12-08')
    cleanup(); fetchMock.mockClear(); localStorage.clear()
    await open()
    await tap('putup-row-0-discard-none')
    expect((await finish()).discard_by).toBe('none')
  })

  // The group is still a set of toggles: a pressed chip tapped again lets go, and what is left is the
  // worked-out date. Work it out itself has nothing to let go to.
  it('a second tap on From the label or No date goes back to Work it out; on Work it out it changes nothing', async () => {
    await open()
    await tap('putup-row-0-discard-auto')
    expect(pressed()).toEqual(['Work it out'])
    await tap('putup-row-0-discard-none')
    await tap('putup-row-0-discard-none')
    expect(pressed()).toEqual(['Work it out'])
    await tap('putup-row-0-discard-date')
    await tap('putup-row-0-discard-date')
    expect(pressed()).toEqual(['Work it out'])
    expect(screen.queryByTestId('putup-row-0-discard-day')).toBeNull()
  })

  it('Work it out is 48 px tall like its neighbours, and the preview under the chips follows the choice', async () => {
    await open()
    expect(['auto', 'date', 'none'].map(m => chip(m).style.minHeight)).toEqual(['48px', '48px', '48px'])
    expect(screen.getByTestId('putup-row-0-preview').textContent).toBe('discard by Mar 29, 2027 · general figure: hot sauce, fridge')
    await tap('putup-row-0-discard-none')
    expect(screen.getByTestId('putup-row-0-preview').textContent).toBe('no date · set by hand')
    await tap('putup-row-0-discard-auto')
    expect(screen.getByTestId('putup-row-0-preview').textContent).toBe('discard by Mar 29, 2027 · general figure: hot sauce, fridge')
  })

  // A draft stored by the client before R2a holds the same three modes: it restores onto the chip that
  // says it. The fixture is the stored shape, written out.
  it.each([
    ['auto', '', ['Work it out']], ['date', '2026-12-08', ['From the label']], ['none', '', ['No date']],
  ])('a stored draft with discard mode %s restores with its chip pressed', async (mode, date, want) => {
    const data = { key: 'k-1', chip: 'today', estimate: null, pickedDate: '', method: 'hot_sauce',
      rows: [{ ...newRow(), place: { key: 'id:loc-fridge', id: 'loc-fridge', label: 'Fridge', kind: 'fridge' }, discard: { mode, date } }],
      sitting: { lines: [], madeG: '', mashG: '', nextTime: '' } }
    expect(isPutItUpDraft(data)).toBe(true)
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ v: SHEET_DRAFT_VERSION, sheet: 'putup', savedAt: Date.now(), data }))
    await open({ fill: false })
    expect(pressed()).toEqual(want)
    if (mode === 'date') expect(screen.getByTestId('putup-row-0-discard-day').value).toBe('2026-12-08')
  })
})
