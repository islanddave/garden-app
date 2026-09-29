// Put-Up release 1a — the Today band's destination (design V4 §6.1, §10.2 "Today band"): the band's
// tap lands on the put-up list (`?view=pantry` — renamed "Pantry" only in release 2, so nothing on
// screen is renamed now) narrowed to use soon (`?filter=use-soon`), shown as a removable "Use soon ×"
// chip; clearing it drops the param; Back from the page returns to Today.
//
// Membership is the SERVER's classification (use_by_status 'use_soon' | 'past_use_by' — the same
// set Today's band and each group's "N use soon" pill count), so every fixture below carries a
// status rather than a date: nothing here decides what counts as soon.
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

import PutUp, { onlyUseSoon } from '../pages/PutUp.jsx'
import PutUpUseSoonBand from '../components/PutUpUseSoonBand.jsx'

const row = (id, over = {}) => ({
  id, crop_type_slug: 'tomato', variety_id: null, plant_id: null, harvest_log_id: null,
  preserved_at: '2026-07-01', method: 'whole_freeze', method_other_text: null,
  quantity_value: 2, quantity_unit: 'bags', package_count: 1, storage_location_id: 'loc-1',
  use_by_target: null, remaining_count: 1, consumed_at: null, notes: null, photo_id: null, use_by_status: null,
  source_kind: 'own_garden', source_label: null, ...over,
})
// Two places, the real shape of the problem: one freezer holding a use-soon jar, a past-date jar and
// a plain one; a second holding only plain jars, which the filter must drop entirely.
const SOON = row('r-soon', { notes: 'pesto cubes', package_count: 2, quantity_unit: 'jars', use_by_status: 'use_soon' })
const PAST = row('r-past', { notes: 'old passata', package_count: 3, quantity_unit: 'quarts', use_by_status: 'past_use_by' })
const PLAIN = row('r-plain', { notes: 'frozen corn', package_count: 5 })
const PLAIN2 = row('r-plain2', { notes: 'blueberries', package_count: 4, storage_location_id: 'loc-2' })
const GROUPS = [
  { group_key: 'loc-1', label: 'Chest Freezer 1', total_packages: 10, units: ['jars', 'quarts', 'bags'], use_soon_count: 2, records: [SOON, PAST, PLAIN] },
  { group_key: 'loc-2', label: 'Chest Freezer 2', total_packages: 4, units: ['bags'], use_soon_count: 0, records: [PLAIN2] },
]
// Dave's own open batch — the list that, on a BARE open, promotes the page to Going now.
const DAVES_BATCH = {
  id: 'kb-1', user_id: 'user_dave', label: 'Jalapeño ferment', kind: 'ferment', started_at: null,
  start_precision: null, first_recorded_at: '2026-09-03T12:00:00.000Z', expected_days_min: null,
  expected_days_max: null, suspended_at: null, closed_at: null, current_stage_kind: 'started',
  current_stage_label: null, current_stage_entered_at: '2026-09-03T12:00:00.000Z', input_count: 0, output_count: 0,
}

function wire({ groups = GROUPS, batches = [], useSoonItems = [] } = {}) {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (path.startsWith('/api/kitchen-batches?state=going')) return Promise.resolve({ state: 'going', batches })
    if (path.startsWith('/api/preservation/whats-put-up')) return Promise.resolve({ group_by: 'storage', groups })
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

describe('onlyUseSoon — selects by the server’s status and re-counts what it shows', () => {
  it('keeps use_soon and past_use_by rows, drops a group left empty, and re-counts the headline', () => {
    const out = onlyUseSoon(GROUPS)
    expect(out.map(g => g.group_key)).toEqual(['loc-1'])
    expect(out[0].records.map(r => r.id)).toEqual(['r-soon', 'r-past'])
    expect(out[0].total_packages).toBe(5)
    expect(out[0].units).toEqual(['jars', 'quarts'])
    expect(out[0].use_soon_count).toBe(2)
  })
  it('an absent or empty list is an empty list', () => {
    expect(onlyUseSoon(undefined)).toEqual([])
    expect(onlyUseSoon([{ group_key: 'x', records: [PLAIN] }])).toEqual([])
  })
})

describe('the page honours the band’s URL', () => {
  it('lands on the put-up list with the chip, showing only what is due soon', async () => {
    renderAt([BAND_DESTINATION])
    await screen.findByText('Chest Freezer 1')
    expect(activeSegment()).toBe("What's put up")
    expect(screen.getByRole('button', { name: /^Use soon/ }).textContent).toBe('Use soon ×')
    expect(shownNotes()).toEqual(['pesto cubes', 'old passata'])
    expect(screen.queryByText('Chest Freezer 2')).toBeNull()
    // The headline speaks for the rows on screen, not for the whole freezer.
    expect(screen.getByText(/5 containers/)).toBeTruthy()
    expect(screen.queryByText(/10 containers/)).toBeNull()
  })

  it('CONTROL: the same data without the filter shows everything and no chip', async () => {
    renderAt(['/put-up?view=pantry'])
    await screen.findByText('Chest Freezer 2')
    expect(shownNotes()).toEqual(['pesto cubes', 'old passata', 'frozen corn', 'blueberries'])
    expect(screen.queryByTestId('putup-use-soon-chip')).toBeNull()
  })

  it('the chip clears the filter and the param, and keeps view=pantry', async () => {
    renderAt(['/today', BAND_DESTINATION])
    await screen.findByText('Chest Freezer 1')
    fireEvent.click(screen.getByTestId('putup-use-soon-chip'))
    await screen.findByText('Chest Freezer 2')
    expect(shownNotes()).toEqual(['pesto cubes', 'old passata', 'frozen corn', 'blueberries'])
    expect(screen.queryByTestId('putup-use-soon-chip')).toBeNull()
    expect(probeLoc()).toBe('/put-up?view=pantry')
  })

  it('clearing REPLACES the entry, so Back still returns to Today', async () => {
    renderAt(['/today', BAND_DESTINATION])
    await screen.findByText('Chest Freezer 1')
    fireEvent.click(screen.getByTestId('putup-use-soon-chip'))
    await waitFor(() => expect(probeLoc()).toBe('/put-up?view=pantry'))
    fireEvent.click(screen.getByRole('button', { name: 'probe-back' }))
    expect(probeLoc()).toBe('/today')
  })

  it('clearing carries the overlay’s background along, so the flyover does not fall to a full page', async () => {
    const background = { pathname: '/today', search: '', hash: '', key: 'bg' }
    renderAt(['/today', { pathname: '/put-up', search: '?view=pantry&filter=use-soon', state: { background } }])
    await screen.findByText('Chest Freezer 1')
    fireEvent.click(screen.getByTestId('putup-use-soon-chip'))
    await waitFor(() => expect(probeLoc()).toBe('/put-up?view=pantry'))
    expect(JSON.parse(screen.getByTestId('probe-state').textContent)).toEqual({ background })
  })

  it('nothing due soon: says so, keeps the chip, and does not claim nothing is put up', async () => {
    wire({ groups: [{ ...GROUPS[1] }] })
    renderAt([BAND_DESTINATION])
    expect((await screen.findByTestId('putup-use-soon-empty')).textContent).toBe('Nothing to use soon right now.')
    expect(screen.getByTestId('putup-use-soon-chip')).toBeTruthy()
    expect(screen.queryByText('Nothing put up yet.')).toBeNull()
  })

  it('an empty household still reads "Nothing put up yet." under the filter — that is the truer sentence', async () => {
    wire({ groups: [] })
    renderAt([BAND_DESTINATION])
    expect(await screen.findByText('Nothing put up yet.')).toBeTruthy()
    expect(screen.queryByTestId('putup-use-soon-empty')).toBeNull()
  })
})

describe('?view=pantry is a destination, not a default the batch promote may override', () => {
  it('an open batch does not move someone who was sent to the list', async () => {
    wire({ batches: [DAVES_BATCH] })
    renderAt([BAND_DESTINATION])
    await screen.findByText('Chest Freezer 1')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/kitchen-batches?state=going'))
    // Let the going list land; the promote runs on its first answer.
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Going now' })).toBeTruthy())
    await new Promise(r => setTimeout(r, 0))
    expect(activeSegment()).toBe("What's put up")
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
    await screen.findByText('Chest Freezer 1')
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
    wire({ groups: [{ ...GROUPS[1] }] })
    renderAt([BAND_DESTINATION])
    const empty = await screen.findByTestId('putup-use-soon-empty')
    const chip = screen.getByTestId('putup-use-soon-chip')
    for (const text of [empty.textContent, chip.textContent, chip.getAttribute('aria-label')]) {
      expect(text).not.toMatch(BANNED)
    }
    expect('Nothing is ready.').toMatch(BANNED)   // instrument: the pattern does fire
  })
})
