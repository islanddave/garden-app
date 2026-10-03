// Put-Up UX pass R1, lane E (D12; ARCH F-12) — Put it up's discard chips take their WORDS from
// putItUp.DISCARD_LABELS, the one set the Pantry door and the Walk read too. The control is an optional
// toggle group of THREE chips since Put-Up R2a (I3): `-discard-auto`, pressed at open, then `-discard-date`
// and `-discard-none`, which keep their ids, and the date field `-discard-day`; that last half is pinned
// in PutUpPutItUp.test.jsx and holds unedited.
// The constant is stood in for here, so the test cannot pass on words typed into the sheet.
// CI LANE: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }), apiFetch: (...a) => fetchMock(...a) }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))
vi.mock('../components/putup/putItUp.js', async (orig) => ({
  ...(await orig()),
  DISCARD_LABELS: Object.freeze({ auto: 'AUTO WORDS', date: 'DATE WORDS', none: 'NONE WORDS' }),
}))

import PutItUpSheet from '../components/putup/PutItUpSheet.jsx'

const NOW = new Date('2026-09-29T15:00:00').getTime()
const BATCH = { id: 'kb-mash', user_id: 'user_dave', label: 'Megatron mash', kind: 'ferment',
  started_at: new Date('2026-09-20T09:00:00').toISOString(), start_precision: 'day', closed_at: null, suspended_at: null, outputs: [] }
const PLACES = [{ id: 'loc-fridge', user_id: 'user_dave', label: 'Fridge', kind: 'fridge' }]
const tap = (id) => act(async () => { fireEvent.click(screen.getByTestId(id)) })

beforeEach(() => {
  fetchMock.mockReset(); localStorage.clear()
  fetchMock.mockImplementation((path) => Promise.resolve(path === '/api/storage-locations' ? PLACES : null))
})

describe('Put it up — the discard chips read their words from DISCARD_LABELS', () => {
  // Put-Up R2a (I3) amended this pin: it read two chips, DATE and NONE, both aria-pressed "false".
  // MUTATION: type the three labels into the sheet again -> the chips read "Work it out" / "From the label"
  // / "No date". MUTATION (F-M4): build two chips -> the list is one short and nothing is pressed.
  it('the three chips say DISCARD_LABELS.auto, .date and .none, auto pressed at open; ids, roles and the date field are as they were', async () => {
    render(<PutItUpSheet open batch={BATCH} lines={[]} now={NOW} onClose={() => {}} onDone={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('putup-row-0-place-id:loc-fridge')).toBeTruthy())
    await tap('putup-row-0-more')
    const group = screen.getByRole('group', { name: 'Discard by' })
    const chips = within(group).getAllByRole('button')
    expect(chips.map(c => [c.getAttribute('data-testid'), c.textContent, c.getAttribute('aria-pressed')])).toEqual([
      ['putup-row-0-discard-auto', 'AUTO WORDS', 'true'],
      ['putup-row-0-discard-date', 'DATE WORDS', 'false'],
      ['putup-row-0-discard-none', 'NONE WORDS', 'false'],
    ])
    await tap('putup-row-0-discard-date')
    expect(screen.getByTestId('putup-row-0-discard-date').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('putup-row-0-discard-auto').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('putup-row-0-discard-day').getAttribute('type')).toBe('date')
  })
})
