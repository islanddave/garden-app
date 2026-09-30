// Put-Up release 1a — the Today band's destination (design V4 §6.1, §10.2 "Today band"): the band's
// tap lands on the put-up list (`?view=pantry`) narrowed to use soon (`?filter=use-soon`), shown as a
// removable "Use soon ×" chip; clearing it drops the param; Back from the page returns to Today.
//
// Membership is the SERVER's classification, so every fixture below carries a status rather than a
// date: nothing here decides what counts as soon.
//
// AMENDED for B′ release 2 (V4 §2.5): the list is the Pantry — GET /api/pantry rows, whose discard
// status is 'soon' | 'past' | 'ok' (the contract) — and the segment is named "Pantry". The per-group
// "N containers" headline is gone with the old list, so its re-count assertions are retired.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({
  useCropTypes: () => ({ cropTypes: [{ slug: 'tomato', display_name: 'Tomato', category: 'vegetable' }], loading: false }),
}))
// Signed in as Dave, the owner of DAVES_BATCH below: the bare-open promote only moves a viewer whose
// own batch is going (PutUp.landing.test.jsx), so the CONTROL needs the fixture's owner at the wheel.
vi.mock('../context/AuthContext.jsx', async (importActual) => ({
  ...(await importActual()),
  useAuthOptional: () => ({ user: { id: 'user_dave' }, profile: null, loading: false, identity: 'signed-in' }),
}))

import PutUp from '../pages/PutUp.jsx'
import { onlyUseSoon } from '../components/pantry/pantryRows.js'
import { jarRow } from './helpers/pantryFake.js'
import PutUpUseSoonBand from '../components/PutUpUseSoonBand.jsx'

// Two places, the real shape of the problem: one freezer holding a use-soon jar, a past-date jar and
// a plain one; a second holding only plain jars, which the filter must drop entirely.
const CF1 = { id: 'loc-1', label: 'Chest Freezer 1', kind: 'deep_freezer' }
const CF2 = { id: 'loc-2', label: 'Chest Freezer 2', kind: 'deep_freezer' }
const row = (id, name, status, place = CF1) => jarRow({ stock_id: id, name, place, group_key: place.id, group_label: place.label,
  discard: { date: '2026-10-05', basis: 'table', status } })
const SOON = row('r-soon', 'pesto cubes', 'soon')
const PAST = row('r-past', 'old passata', 'past')
const PLAIN = row('r-plain', 'frozen corn', 'ok')
const PLAIN2 = row('r-plain2', 'blueberries', 'ok', CF2)
const ROWS = [SOON, PAST, PLAIN, PLAIN2]
// Dave's own open batch — the list that, on a BARE open, promotes the page to Going now.
const DAVES_BATCH = {
  id: 'kb-1', user_id: 'user_dave', label: 'Jalapeño ferment', kind: 'ferment', started_at: null,
  start_precision: null, first_recorded_at: '2026-09-03T12:00:00.000Z', expected_days_min: null,
  expected_days_max: null, suspended_at: null, closed_at: null, current_stage_kind: 'started',
  current_stage_label: null, current_stage_entered_at: '2026-09-03T12:00:00.000Z', input_count: 0, output_count: 0,
}

function wire({ rows = ROWS, batches = [], useSoonItems = [] } = {}) {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (path.startsWith('/api/kitchen-batches?state=going')) return Promise.resolve({ state: 'going', batches })
    if (path.startsWith('/api/pantry?')) return Promise.resolve({ rows })
    if (path === '/api/preservation/use-soon') return Promise.resolve({ items: useSoonItems })
    if (path === '/api/storage-locations' && method === 'GET') return Promise.resolve([])
    if (path.startsWith('/api/plants')) return Promise.resolve([])
    return Promise.resolve(null)
  })
}

// A location read-out and a Back button, outside the routes, so a test can see where it is and walk
// history the way the phone's Back does.
function Probe() {
  const loc = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <div data-testid="probe-loc">{loc.pathname + loc.search}</div>
      <div data-testid="probe-state">{JSON.stringify(loc.state ?? null)}</div>
      <button type="button" onClick={() => navigate(-1)}>probe-back</button>
    </>
  )
}
function renderAt(entries, index = entries.length - 1) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={index}>
      <Probe />
      <Routes>
        <Route path="/today" element={<PutUpUseSoonBand />} />
        <Route path="/put-up" element={<PutUp />} />
      </Routes>
    </MemoryRouter>,
  )
}
const BAND_DESTINATION = '/put-up?view=pantry&filter=use-soon'
const activeSegment = () => within(screen.getByRole('radiogroup', { name: 'Put-Up view' }))
  .getAllByRole('radio').find(r => r.getAttribute('aria-checked') === 'true')?.textContent
const shownNotes = () => ['pesto cubes', 'old passata', 'frozen corn', 'blueberries'].filter(n => screen.queryByText(n))
const probeLoc = () => screen.getByTestId('probe-loc').textContent

beforeEach(() => { fetchMock.mockReset(); wire(); sessionStorage.clear(); localStorage.clear() })

describe('onlyUseSoon — selects by the server’s status', () => {
  it('keeps soon and past rows and nothing else', () => {
    expect(onlyUseSoon(ROWS).map(r => r.stock_id)).toEqual(['r-soon', 'r-past'])
  })
  it('an absent or empty list is an empty list', () => {
    expect(onlyUseSoon(undefined)).toEqual([])
    expect(onlyUseSoon([PLAIN])).toEqual([])
  })
})

describe('the page honours the band’s URL', () => {
  it('lands on the put-up list with the chip, showing only what is due soon', async () => {
    renderAt([BAND_DESTINATION])
    await screen.findByText('pesto cubes')
    expect(activeSegment()).toBe('Pantry')
    expect(screen.getByRole('button', { name: /^Use soon/ }).textContent).toBe('Use soon ×')
    expect(shownNotes()).toEqual(['pesto cubes', 'old passata'])
    expect(screen.queryByRole('heading', { name: 'Chest Freezer 2' })).toBeNull()
  })

  it('CONTROL: the same data without the filter shows everything and no chip', async () => {
    renderAt(['/put-up?view=pantry'])
    await screen.findByRole('heading', { name: 'Chest Freezer 2' })
    expect(shownNotes()).toEqual(['pesto cubes', 'old passata', 'frozen corn', 'blueberries'])
    expect(screen.queryByTestId('putup-use-soon-chip')).toBeNull()
  })

  it('the chip clears the filter and the param, and keeps view=pantry', async () => {
    renderAt(['/today', BAND_DESTINATION])
    await screen.findByText('pesto cubes')
    fireEvent.click(screen.getByTestId('putup-use-soon-chip'))
    await screen.findByRole('heading', { name: 'Chest Freezer 2' })
    expect(shownNotes()).toEqual(['pesto cubes', 'old passata', 'frozen corn', 'blueberries'])
    expect(screen.queryByTestId('putup-use-soon-chip')).toBeNull()
    expect(probeLoc()).toBe('/put-up?view=pantry')
  })

  it('clearing REPLACES the entry, so Back still returns to Today', async () => {
    renderAt(['/today', BAND_DESTINATION])
    await screen.findByText('pesto cubes')
    fireEvent.click(screen.getByTestId('putup-use-soon-chip'))
    await waitFor(() => expect(probeLoc()).toBe('/put-up?view=pantry'))
    fireEvent.click(screen.getByRole('button', { name: 'probe-back' }))
    expect(probeLoc()).toBe('/today')
  })

  it('clearing carries the overlay’s background along, so the flyover does not fall to a full page', async () => {
    const background = { pathname: '/today', search: '', hash: '', key: 'bg' }
    renderAt(['/today', { pathname: '/put-up', search: '?view=pantry&filter=use-soon', state: { background } }])
    await screen.findByText('pesto cubes')
    fireEvent.click(screen.getByTestId('putup-use-soon-chip'))
    await waitFor(() => expect(probeLoc()).toBe('/put-up?view=pantry'))
    expect(JSON.parse(screen.getByTestId('probe-state').textContent)).toEqual({ background })
  })

  it('nothing due soon: says so, keeps the chip, and does not claim nothing is put up', async () => {
    wire({ rows: [PLAIN2] })
    renderAt([BAND_DESTINATION])
    expect((await screen.findByTestId('putup-use-soon-empty')).textContent).toBe('Nothing to use soon right now.')
    expect(screen.getByTestId('putup-use-soon-chip')).toBeTruthy()
    expect(screen.queryByText('Nothing in the pantry yet.')).toBeNull()
  })

  it('an empty household still reads "Nothing in the pantry yet." under the filter — that is the truer sentence', async () => {
    wire({ rows: [] })
    renderAt([BAND_DESTINATION])
    expect(await screen.findByText('Nothing in the pantry yet.')).toBeTruthy()
    expect(screen.queryByTestId('putup-use-soon-empty')).toBeNull()
  })
})

describe('?view=pantry is a destination, not a default the batch promote may override', () => {
  it('an open batch does not move someone who was sent to the list', async () => {
    wire({ batches: [DAVES_BATCH] })
    renderAt([BAND_DESTINATION])
    await screen.findByText('pesto cubes')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/kitchen-batches?state=going'))
    // Let the going list land; the promote runs on its first answer.
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Going now' })).toBeTruthy())
    await new Promise(r => setTimeout(r, 0))
    expect(activeSegment()).toBe('Pantry')
  })

  it('CONTROL: the same open batch DOES promote a bare open', async () => {
    wire({ batches: [DAVES_BATCH] })
    renderAt(['/put-up'])
    await waitFor(() => expect(activeSegment()).toBe('Going now'))
  })
})

describe('end to end: Today’s band → the filtered list → Back to Today', () => {
  it('walks the whole door', async () => {
    wire({ useSoonItems: [{ id: 'r-soon', crop_display_name: 'Tomato', quantity_value: 2, quantity_unit: 'jars', method: 'pesto', storage_label: 'Chest Freezer 1', use_by_status: 'use_soon' }] })
    renderAt(['/today'])
    fireEvent.click(await screen.findByRole('button', { name: 'Open Put-Up' }))
    await screen.findByText('pesto cubes')
    expect(probeLoc()).toBe(BAND_DESTINATION)
    expect(screen.getByTestId('putup-use-soon-chip')).toBeTruthy()
    expect(shownNotes()).toEqual(['pesto cubes', 'old passata'])
    fireEvent.click(screen.getByRole('button', { name: 'probe-back' }))
    expect(probeLoc()).toBe('/today')
  })
})

describe('words — the chip and its empty line use no banned word (V4 §3.2)', () => {
  const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
  it('chip, its accessible name, and the empty line', async () => {
    wire({ rows: [PLAIN2] })
    renderAt([BAND_DESTINATION])
    const empty = await screen.findByTestId('putup-use-soon-empty')
    const chip = screen.getByTestId('putup-use-soon-chip')
    for (const text of [empty.textContent, chip.textContent, chip.getAttribute('aria-label')]) {
      expect(text).not.toMatch(BANNED)
    }
    expect('Nothing is ready.').toMatch(BANNED)   // instrument: the pattern does fire
  })
})
