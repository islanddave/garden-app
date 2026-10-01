// Put-Up UX pass R1, lane E (D12; ARCH F-12) — Put it up's discard chips take their WORDS from
// putItUp.DISCARD_LABELS, the one set the Pantry door and the Walk read too. The control itself is
// unchanged: an optional toggle group of two chips (`-discard-date`, `-discard-none`) and the date field
// `-discard-day`; that half is pinned in PutUpPutItUp.test.jsx and holds unedited.
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
  // MUTATION: type the two labels into the sheet again -> the chips read "From the label" / "No date".
  it('the two chips say DISCARD_LABELS.date and .none; ids, roles and the date field are as they were', async () => {
    render(<PutItUpSheet open batch={BATCH} lines={[]} now={NOW} onClose={() => {}} onDone={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('putup-row-0-place-id:loc-fridge')).toBeTruthy())
    await tap('putup-row-0-more')
    const group = screen.getByRole('group', { name: 'Discard by' })
    const chips = within(group).getAllByRole('button')
    expect(chips.map(c => [c.getAttribute('data-testid'), c.textContent, c.getAttribute('aria-pressed')])).toEqual([
      ['putup-row-0-discard-date', 'DATE WORDS', 'false'],
      ['putup-row-0-discard-none', 'NONE WORDS', 'false'],
    ])
    await tap('putup-row-0-discard-date')
    expect(screen.getByTestId('putup-row-0-discard-date').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('putup-row-0-discard-day').getAttribute('type')).toBe('date')
  })
})
