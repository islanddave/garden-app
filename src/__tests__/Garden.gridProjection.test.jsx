// V4-PLANTSPAYLOAD-001 — Garden opts into the `?view=grid` projection, and the one row that still
// needs the wide shape fetches itself.
//
// GET /api/plants measured 1,241,902 B / 5.19 s on Dave's live prod session and Garden fires it on
// every mount. The projection is opt-in server-side, so the saving only exists if this page
// actually asks for it — that is the first half. The second half is the consequence: the edit form
// reads seventeen planting fields, none of which the projection carries, so ?edit= must resolve its
// target with a by-id GET instead of picking it out of the list. Asserted by CONTENT (a value only
// the by-id row has), not by counting calls — a by-id fetch that fired and was then ignored would
// pass a call-count assertion and still render the form blank.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchSpy, getTokenSpy, searchParamsRef, setSearchParamsSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  getTokenSpy: vi.fn(async () => 'tok'),
  searchParamsRef: { current: new URLSearchParams() },
  setSearchParamsSpy: vi.fn((next) => {
    searchParamsRef.current = next instanceof URLSearchParams ? next : new URLSearchParams(next)
  }),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useLocation: () => ({ pathname: '/garden', search: '', state: null }),
  useNavigate: () => () => {},
  useSearchParams: () => [searchParamsRef.current, setSearchParamsSpy],
}))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: getTokenSpy }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span data-testid="fav" /> }))
vi.mock('../components/VarietyPicker.jsx', () => ({
  default: ({ value }) => <span data-testid="vp-value">{value ? value.name : 'EMPTY'}</span>,
}))

import Garden from '../pages/Garden.jsx'

const PROJECTS = [{ id: 'proj-1', name: 'Spring 2026', status: 'active', parent_project_id: null }]

// The projected row, key-for-key what lambda/plants/index.js's ?view=grid branch emits (grid-view
// .test.js pins that set against live prod). Deliberately NOT a trimmed copy of the wide fixture:
// the absences are the point.
const GRID_ROW = {
  id: 'plant-2', name: 'Krim Plant', quantity: 3, status: 'seedling',
  project_id: 'proj-1', location_id: null, assignee_user_id: null,
  featured_photo_id: null, featured_photo_view_url: null, featured_photo_thumb_url: null,
  variety_ref: { name: 'Black Krim', crop_type_slug: 'tomato' },
}
// The wide by-id row. `notes` is the tell: it exists ONLY here, so if the form renders it the
// editor was prefilled from this response and not from the list.
const WIDE_ROW = {
  ...GRID_ROW, notes: 'started under the south light', project_name: 'Spring 2026',
  variety_id: 'var-1', variety_ref: { id: 'var-1', name: 'Black Krim', crop_type_slug: 'tomato' },
  sown_at: '2026-03-02T00:00:00Z', sown_at_approx: false, qty_initial: 6,
  source_type: 'seed_packet', source_ref: "Johnny's Lot 4421", source_generation: null,
  lineage_note: null, parent_plant_id: null, container_type: 'tray_cell', container_size: '4in',
}

function prime() {
  fetchSpy.mockImplementation((url, opts = {}) => {
    if (url === '/api/projects') return Promise.resolve(PROJECTS)
    if (url === '/api/plants?view=grid') return Promise.resolve([GRID_ROW])
    if (url === '/api/plants/plant-2' && !opts.method) return Promise.resolve(WIDE_ROW)
    return Promise.resolve([])
  })
}

beforeEach(() => {
  localStorage.clear()
  fetchSpy.mockReset()
  setSearchParamsSpy.mockClear()
  searchParamsRef.current = new URLSearchParams()
})

async function renderGarden() {
  await act(async () => { render(<Garden />) })
  await screen.findByText(/Log many/)
}

describe('Garden — the plants list is fetched as the grid projection (V4-PLANTSPAYLOAD-001)', () => {
  it('asks for ?view=grid and never for the wide list', async () => {
    prime()
    await renderGarden()
    const listGets = fetchSpy.mock.calls.filter(([u, o = {}]) => !o.method && String(u).startsWith('/api/plants') && !String(u).includes('/api/plants/'))
    expect(listGets.length).toBeGreaterThan(0)
    for (const [u] of listGets) expect(u).toBe('/api/plants?view=grid')
  })

  it('renders the tiles from the projected row alone — no wide field is required to paint', async () => {
    prime()
    await renderGarden()
    // Facet sections ship collapsed by default (Dave 2026-06-26), so open them first.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Expand all sections/i })) })
    // name, ×quantity and the variety line all come off the 11 keys the projection ships.
    expect(await screen.findByText('Krim Plant')).toBeDefined()
    expect(screen.getByText('Black Krim')).toBeDefined()
    expect(screen.getByText('×3')).toBeDefined()
  })
})

describe('Garden — ?edit= resolves its target by id, not from the projected list', () => {
  it('prefills Notes from the by-id GET (a field the projection does not carry)', async () => {
    searchParamsRef.current = new URLSearchParams('edit=plant-2')
    prime()
    await renderGarden()
    await waitFor(() => expect(screen.getByText(/Edit Krim Plant/)).toBeDefined())
    // The assertion that fails if the editor is ever repointed back at the list row.
    expect(screen.getByLabelText(/Notes/i).value).toBe('started under the south light')
    expect(screen.getByLabelText(/Source reference/i).value).toBe("Johnny's Lot 4421")
    expect(fetchSpy.mock.calls.some(([u, o = {}]) => u === '/api/plants/plant-2' && !o.method)).toBe(true)
  })

  it('an unknown id still strips the param and opens nothing', async () => {
    // The by-id GET answers a non-row here; `full?.id` is what keeps an empty array from being
    // mistaken for a planting.
    searchParamsRef.current = new URLSearchParams('edit=nope')
    prime()
    await renderGarden()
    await waitFor(() => expect(searchParamsRef.current.get('edit')).toBeNull())
    expect(screen.queryByText(/^Edit /)).toBeNull()
  })
})
