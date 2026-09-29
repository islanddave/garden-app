// Put-Up release F (Dave 16:30, binding; 06 §3.5, §4 item 6) — Check on it gains "What you did": Topped
// up brine · Pushed it back under · Skimmed the top. Film, mold, bubbling and taste go in the note ONLY;
// there is no chip for them. Each assertion names the mutation that reds it.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React from 'react'
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
vi.mock('react-router-dom', async (orig) => ({ ...(await orig()), useNavigate: () => vi.fn() }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))

import GoingNowView from '../components/putup/GoingNowView.jsx'
import { checkInBody, CHECK_IN_ACTS, TOP_UP_HINT, SUBMERSION_PROMPT } from '../components/putup/goingNow.js'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const NOW = new Date('2026-10-05T09:00:00').getTime()
const AT = new Date(NOW).toISOString()
const local = (s) => new Date(s).toISOString()
const BASE = {
  user_id: 'user_dave', kind_other: null, started_at: local('2026-10-01T09:00:00'), start_precision: 'day',
  first_recorded_at: local('2026-10-01T09:00:00'), expected_days_min: null, expected_days_max: null,
  suspended_at: null, closed_at: null, current_stage_kind: 'started', current_stage_label: null,
  current_stage_entered_at: local('2026-10-01T09:00:00'), input_count: '0', output_count: '0',
  last_ph_reading: null, last_ph_read_at: null,
}
const FERMENT = { ...BASE, id: 'kb-f', label: 'Petri Dish', kind: 'ferment' }
const DRY = { ...BASE, id: 'kb-d', label: 'Apple rings', kind: 'dehydrate' }
const FRIDGE = { id: 'loc-fridge', label: 'Fridge', kind: 'fridge' }

const stagePosts = () => fetchMock.mock.calls.filter(([p, o]) => /\/stages$/.test(p) && o?.method === 'POST').map(c => JSON.parse(c[1].body))
function renderView(batches) {
  return render(<MemoryRouter><GoingNowView batches={batches} loading={false} error={false} onReload={vi.fn()} now={NOW} /></MemoryRouter>)
}
async function openCheck(batch) {
  renderView([batch])
  await act(async () => { fireEvent.click(screen.getByTestId('going-check')) })
  await waitFor(() => expect(screen.getByTestId('checkin-note')).toBeTruthy())
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation((path, o = {}) => {
    if (path === '/api/storage-locations') return Promise.resolve([FRIDGE])
    if (o.method === 'POST') return Promise.resolve({ stage: { id: 'ksl-new' }, batch: {} })
    return Promise.resolve(null)
  })
  localStorage.clear()
  clearReloadBlocks()
})
afterEach(() => clearReloadBlocks())

describe('checkInBody — what you did rides on the tended row', () => {
  it('the three words, in their order, de-duplicated, with the top-up amount beneath Topped up', () => {
    expect(CHECK_IN_ACTS.map(a => a.label)).toEqual(['Topped up brine', 'Pushed it back under', 'Skimmed the top'])
    expect(checkInBody({ batch: FERMENT, acts: ['skimmed', 'topped_up', 'skimmed'], topUp: '250', atIso: AT }))
      .toEqual({ body: { stage_kind: 'tended', acts: ['topped_up', 'skimmed'], amount: '250', amount_unit: 'ml' } })
  })
  it('an act alone is an observation — the note is not required with it', () => {
    expect(checkInBody({ batch: FERMENT, acts: ['pushed_under'], atIso: AT }).body).toEqual({ stage_kind: 'tended', acts: ['pushed_under'] })
  })
  // MUTATION: keep the amount when Topped up is not pressed -> the first literal gains an amount.
  it('a top-up amount means nothing without Topped up, and a bad one is refused in words', () => {
    expect(checkInBody({ batch: FERMENT, acts: ['skimmed'], topUp: '250', atIso: AT }).body).toEqual({ stage_kind: 'tended', acts: ['skimmed'] })
    expect(checkInBody({ batch: FERMENT, acts: ['topped_up'], topUp: 'lots', atIso: AT })).toEqual({ error: TOP_UP_HINT })
  })
  // chk_ksl_acts_on_tended: acts ride only on a tended row. MUTATION: put the acts on the moved row ->
  // the database refuses it; this literal reds first.
  it('did something AND moved it → the tended row, then the moved row', () => {
    expect(checkInBody({ batch: FERMENT, acts: ['skimmed'], place: FRIDGE, note: 'film', atIso: AT })).toEqual({
      body: { stage_kind: 'tended', acts: ['skimmed'], note: 'film' },
      move: { stage_kind: 'moved', storage_location_id: 'loc-fridge', label: 'Moved to Fridge' },
    })
    // A move with nothing done stays ONE moved row, exactly as before.
    expect(checkInBody({ batch: FERMENT, place: FRIDGE, atIso: AT })).toEqual({ body: { stage_kind: 'moved', storage_location_id: 'loc-fridge', label: 'Moved to Fridge' } })
  })
  it('never on a batch that is not a ferment', () => {
    expect(checkInBody({ batch: DRY, acts: ['skimmed'], note: 'x', atIso: AT }).body).toEqual({ stage_kind: 'tended', note: 'x' })
  })
})

describe('Check on it — the "What you did" row', () => {
  it('sits after the brine question and before pH, as an optional multi-select group of 48px chips', async () => {
    await openCheck(FERMENT)
    const sheet = screen.getByTestId('checkin-sheet')
    const order = [...sheet.querySelectorAll('[role="group"]')].map(g => g.getAttribute('aria-label'))
    expect(order.slice(0, 2)).toEqual([SUBMERSION_PROMPT, 'What you did'])
    const phField = screen.getByTestId('checkin-ph-input')
    expect(screen.getByTestId('checkin-acts').compareDocumentPosition(phField) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const chips = within(screen.getByRole('group', { name: 'What you did' })).getAllByRole('button')
    expect(chips.map(c => [c.textContent, c.getAttribute('aria-pressed'), c.style.minHeight])).toEqual([
      ['Topped up brine', 'false', '48px'], ['Pushed it back under', 'false', '48px'], ['Skimmed the top', 'false', '48px'],
    ])
    expect(sheet.textContent).not.toMatch(/\bfilm\b|\bmold\b|\bmould\b|\bbubbl|\btaste\b/i)
  })

  it('a pressed act looks different from a chosen brine answer (outline on pale, not filled)', async () => {
    await openCheck(FERMENT)
    fireEvent.click(screen.getByTestId('checkin-submersion-all_under'))
    fireEvent.click(screen.getByTestId('checkin-act-skimmed'))
    const answer = screen.getByTestId('checkin-submersion-all_under')
    const act = screen.getByTestId('checkin-act-skimmed')
    expect(act.getAttribute('aria-pressed')).toBe('true')
    expect(act.style.backgroundColor).not.toBe(answer.style.backgroundColor)
    expect(act.style.color).not.toBe(answer.style.color)
  })

  // 06 §3.5, V101 §5.3: the acts row is never revealed, highlighted or reordered by the brine answer.
  // MUTATION: render the acts only after "Something poking out" -> the first snapshot has no row and this reds.
  it('is in the same place and looks the same whatever the brine answer is', async () => {
    await openCheck(FERMENT)
    const shape = () => {
      const row = screen.getByTestId('checkin-acts')
      const groups = [...screen.getByTestId('checkin-sheet').querySelectorAll('[role="group"]')].map(g => g.getAttribute('aria-label'))
      return { at: groups.indexOf('What you did'), html: row.outerHTML }
    }
    const before = shape()
    fireEvent.click(screen.getByTestId('checkin-submersion-poking_out'))
    expect(shape()).toEqual(before)
    fireEvent.click(screen.getByTestId('checkin-submersion-all_under'))
    expect(shape()).toEqual(before)
  })

  it('the top-up amount opens directly beneath the chips when Topped up is pressed, and rides on the row', async () => {
    await openCheck(FERMENT)
    expect(screen.queryByTestId('checkin-topup-amount')).toBeNull()
    fireEvent.click(screen.getByTestId('checkin-act-topped_up'))
    const row = screen.getByTestId('checkin-acts')
    expect(within(row).getByTestId('checkin-topup-amount')).toBeTruthy()
    fireEvent.change(screen.getByTestId('checkin-topup-amount'), { target: { value: '250' } })
    await act(async () => { fireEvent.click(screen.getByTestId('checkin-save')) })
    await waitFor(() => expect(stagePosts()).toHaveLength(1))
    expect(stagePosts()[0]).toEqual({ stage_kind: 'tended', acts: ['topped_up'], amount: '250', amount_unit: 'ml' })
  })

  it('a check-in that did something AND moved it writes two rows; a failed move keeps only the move to retry', async () => {
    let n = 0
    fetchMock.mockImplementation((path, o = {}) => {
      if (path === '/api/storage-locations') return Promise.resolve([FRIDGE])
      if (o.method === 'POST') return (++n === 2 ? Promise.reject(new Error('502')) : Promise.resolve({ stage: { id: `ksl-${n}` } }))
      return Promise.resolve(null)
    })
    await openCheck(FERMENT)
    await waitFor(() => expect(screen.getByTestId('checkin-place-loc-fridge')).toBeTruthy())
    fireEvent.click(screen.getByTestId('checkin-act-skimmed'))
    fireEvent.click(screen.getByTestId('checkin-place-loc-fridge'))
    await act(async () => { fireEvent.click(screen.getByTestId('checkin-save')) })
    await waitFor(() => expect(screen.getByTestId('checkin-error').textContent).toMatch(/move didn't go through/))
    expect(screen.getByTestId('checkin-act-skimmed').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('checkin-place-loc-fridge').getAttribute('aria-pressed')).toBe('true')
    await act(async () => { fireEvent.click(screen.getByTestId('checkin-save')) })
    await waitFor(() => expect(stagePosts()).toHaveLength(3))
    expect(stagePosts().map(b => b.stage_kind)).toEqual(['tended', 'moved', 'moved'])
  })

  it('is not offered on a Dry batch', async () => {
    await openCheck(DRY)
    expect(screen.queryByTestId('checkin-acts')).toBeNull()
  })
})
