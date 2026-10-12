// OPS-STORAGELOCNODOOR-001 — the storage-location rename/delete door, as the WALK meets it.
//
// Put-Up R2b: this file held the tests of the "Log a put-up" form's place manager (rename, re-kind, delete,
// its coded refusals, a place that already exists). The form is gone; the same door is the Places sheet now
// and those tests live, re-homed title by title, in PutUpR2P.places.test.jsx. What stays here is the walk:
// its creator lists an existing place once, and it never grows an editing affordance.
//
// FIXTURES ARE THE REAL DISTRIBUTION: live prod carried exactly THREE rows, all kind='deep_freezer', all
// owned by Dave. They are reproduced verbatim.
//
// CI LANE: `npm test` (vitest run --coverage). Nothing here is date-sensitive, so the blocking TZ
// re-run is a no-op over this file — stated rather than assumed.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))

import PutUp from '../pages/PutUp.jsx'

// The prod three, verbatim: three rows, all deep_freezer, all Dave's.
const PROD_THREE = [
  { id: 'loc-1', user_id: 'user_dave', label: 'Chest Freezer 1', kind: 'deep_freezer' },
  { id: 'loc-2', user_id: 'user_dave', label: 'Chest Freezer 2', kind: 'deep_freezer' },
  { id: 'loc-3', user_id: 'user_dave', label: 'Garage freezr', kind: 'deep_freezer' },  // the typo the door exists for
]

function wire({ locations = PROD_THREE, onPost } = {}) {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (path.startsWith('/api/kitchen-batches')) return Promise.reject(new Error('no such table'))
    if (path === '/api/storage-locations' && method === 'GET') return Promise.resolve(locations)
    if (path === '/api/storage-locations' && method === 'POST' && onPost) return onPost(path, options)
    return Promise.resolve(null)
  })
}

const writeCalls = (m) => fetchMock.mock.calls.filter(([, o]) => o?.method === m)

beforeEach(() => { fetchMock.mockReset(); wire(); localStorage.clear(); sessionStorage.clear() })

// B′ release 2 (V4 §2.2, Appendix B): the freezer walk is Walk a place. Its "＋ Somewhere else" is the
// Appendix B creator (a name + a kind), made by find-or-create when the walk starts — so an answer that
// names a place already there must select THAT place and list it once.
describe('a place that already exists — the walk lists it once', () => {
  it('a walk create answered with an existing place selects its chip and adds no second chip', async () => {
    wire({ onPost: () => Promise.resolve({ ...PROD_THREE[1], existing: true }) })
    render(<MemoryRouter initialEntries={['/put-up?session=putup']}><PutUp /></MemoryRouter>)
    fireEvent.click(await screen.findByTestId('putup-walk-place-new'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Name of the place' }), { target: { value: 'Chest Freezer 2' } })
    fireEvent.click(screen.getByTestId('putup-walk-place-new-kind-deep_freezer'))
    fireEvent.click(screen.getByTestId('putup-walk-place-new-use'))
    fireEvent.click(screen.getByTestId('putup-walk-when-this_month'))
    fireEvent.click(screen.getByTestId('putup-walk-start'))
    await screen.findByTestId('putup-walk-band')
    expect(writeCalls('POST').filter(([p]) => p === '/api/storage-locations')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('putup-walk-change'))
    const chips = within(await screen.findByRole('radiogroup', { name: 'Which place are you at?' })).getAllByRole('radio')
    expect(chips.filter(c => c.textContent === 'Chest Freezer 2')).toHaveLength(1)
    expect(chips.find(c => c.getAttribute('aria-checked') === 'true')?.textContent).toBe('Chest Freezer 2')
    expect(chips.map(c => c.textContent)).toEqual(['Chest Freezer 1', 'Chest Freezer 2', 'Garage freezr', 'Fridge', 'Fridge freezer', 'Pantry shelf', 'Counter'])
  })
})

describe('the walk keeps the creator and does NOT get the manage door', () => {
  it('offers "＋ Somewhere else" (a name + a kind) with no editing affordance', async () => {
    render(<MemoryRouter initialEntries={['/put-up?session=putup']}><PutUp /></MemoryRouter>)
    // Renaming vocabulary is a deliberate, desk-posture act. The walk is a hands-wet sitting whose
    // job is one item at a time, and a Delete button beside a freezer chip there is a hazard.
    fireEvent.click(await screen.findByRole('button', { name: '＋ Somewhere else' }))
    expect(await screen.findByRole('textbox', { name: 'Name of the place' })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: 'What kind of place?' })).toBeTruthy()
    expect(screen.queryByTestId('pu-manage-locations')).toBeNull()
    expect(screen.queryByTestId('pu-location-editor')).toBeNull()
  })
})
