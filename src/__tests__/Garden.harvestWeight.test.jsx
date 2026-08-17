// V4-HARVWEIGHTSURF-001 — the Garden slice. Until now the Garden was the one named surface in the
// row that showed nothing about harvests at all: `rg -i harvest src/pages/Garden.jsx` returned zero
// matches. The crop-type groups it already renders are keyed on crop_type_slug, which is exactly how
// the harvests Lambda buckets its weight aggregate, so each group can now say what that crop has
// produced this season — in the SAME words the Harvests Totals tab uses.
//
// What these pin, and specifically the distinctions a plausible implementation collapses:
//   * the number is rendered by the shared CropWeightLine, so ≈ and the weighed/estimated qualifier
//     read identically here and on Totals
//   * a crop whose picks carry NO weight renders NOTHING — no eyebrow, no '0 g', no placeholder
//   * a harvests Lambda that predates the weight columns renders NOTHING (absent ≠ zero)
//   * the request is season-scoped and aggregates-only, and does not fire for other groupings
//   * a caretaker lens suppresses it — the aggregate is household-wide, the group is not
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, within } from '@testing-library/react'

vi.mock('react-router-dom', () => {
  const sp = new URLSearchParams()
  return {
    Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
    useLocation: () => ({ pathname: '/garden', search: '', state: null }),
    useNavigate: () => () => {},
    useSearchParams: () => [sp, () => {}],
  }
})
const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock }), apiFetch: (...a) => fetchMock(...a) }))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span data-testid="fav" /> }))
// Flag ON — crop-type is the Garden's default grouping under PROJECTS_HIDDEN, which is the only
// grouping this feature attaches to. importActual spread so every other flag keeps its value.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: true,
}))
// Two household members + an identity, so the caretaker lens is a reachable state. Inert for every
// case that leaves `garden.careLens` unset — the lens defaults to Everyone.
vi.mock('../hooks/useMembers.js', () => ({ useMembers: () => ({ members: [
  { id: 'me', display_name: 'Dave' }, { id: 'jen', display_name: 'Jen' },
] }) }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ profile: { id: 'me' } }) }))

import Garden from '../pages/Garden.jsx'
import { currentGrowYear } from '../lib/growYear.js'

const PROJECTS = [{ id: 'a', name: 'Bed Alpha', status: 'active', parent_project_id: null }]
const PLANTS = [
  { id: 'p1', name: 'Sungold',  project_id: 'a', status: 'growing', variety_ref: { crop_type_slug: 'tomato' } },
  { id: 'p2', name: 'Jalapeño', project_id: 'a', status: 'growing', variety_ref: { crop_type_slug: 'pepper' } },
]

// The wire shape lambda/harvests/index.js shapeWeightRow() emits, field for field.
const weight = (o = {}) => ({
  grams: 0, measured_grams: 0, estimated_grams: 0, measured: 0, estimated: 0, unweighed: 0, ...o,
})

// `crops` is the aggregates.crops[] array; pass rows WITHOUT a `weight` key to model an old Lambda.
function mockFetch(crops) {
  fetchMock.mockImplementation((url) => {
    if (url === '/api/projects') return Promise.resolve(PROJECTS)
    if (url === '/api/plants?view=grid') return Promise.resolve(PLANTS)
    if (String(url).startsWith('/api/harvests')) return Promise.resolve({ aggregates: { crops } })
    return Promise.resolve([])
  })
}

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset()
})

async function renderGarden() {
  await act(async () => { render(<Garden />) })
  await screen.findByText(/Log many/)
}

describe('Garden — crop-group season weight', () => {
  it('renders the crop total through the shared CropWeightLine, ≈ and qualifier included', async () => {
    mockFetch([{ crop_type_slug: 'tomato', crop_name: 'Tomato', weight: weight({ grams: 2400, measured_grams: 400, estimated_grams: 2000, measured: 3, estimated: 12 }) }])
    await renderGarden()
    expect(screen.getByTestId('crop-group-weight')).toBeTruthy()
    expect(screen.getByTestId('crop-weight').textContent).toBe('≈ 2.4 kg')
    expect(screen.getByTestId('crop-weight-basis').textContent).toBe('3 weighed · 12 estimated')
  })

  it('labels the timeframe — an unlabelled total would read as all-time', async () => {
    mockFetch([{ crop_type_slug: 'tomato', crop_name: 'Tomato', weight: weight({ grams: 900, measured_grams: 900, measured: 2 }) }])
    await renderGarden()
    expect(screen.getByTestId('crop-group-weight').textContent).toMatch(/This season/)
  })

  it('does not dress a fully MEASURED total as an estimate', async () => {
    mockFetch([{ crop_type_slug: 'tomato', crop_name: 'Tomato', weight: weight({ grams: 900, measured_grams: 900, measured: 2 }) }])
    await renderGarden()
    expect(screen.getByTestId('crop-weight').textContent).toBe('900 g')
    expect(screen.getByTestId('crop-weight').getAttribute('aria-label')).toBe('Total harvest weight: 900 g')
  })

  it('attaches the weight to the RIGHT group when several crops have one', async () => {
    mockFetch([
      { crop_type_slug: 'tomato', crop_name: 'Tomato', weight: weight({ grams: 2400, estimated_grams: 2400, estimated: 8 }) },
      { crop_type_slug: 'pepper', crop_name: 'Pepper', weight: weight({ grams: 300, measured_grams: 300, measured: 1 }) },
    ])
    await renderGarden()
    // Scoped to each group's own subtree — a positional assertion would pass on a render that hung
    // both numbers off one header, which is the failure worth catching here.
    const groupOf = (label) => screen.getByText(label).closest('[role="group"]')
    expect(within(groupOf('Tomato')).getByTestId('crop-weight').textContent).toBe('≈ 2.4 kg')
    expect(within(groupOf('Pepper')).getByTestId('crop-weight').textContent).toBe('300 g')
  })

  // THE no-weight case. Totals prints "no weight yet" for this row; the Garden deliberately prints
  // nothing at all — a browsing grid would carry that line under most groups at once. Asserted three
  // ways because each is a different way to get it wrong: an empty slot (the eyebrow with nothing
  // under it), a fake zero, and the borrowed ratchet copy.
  it('renders NOTHING for a crop whose picks carry no weight — no slot, no 0 g, no placeholder', async () => {
    mockFetch([{ crop_type_slug: 'tomato', crop_name: 'Tomato', weight: weight({ unweighed: 4 }) }])
    await renderGarden()
    expect(screen.queryByTestId('crop-group-weight')).toBeNull()
    expect(screen.queryByTestId('crop-weight')).toBeNull()
    expect(screen.queryByTestId('crop-weight-none')).toBeNull()
    expect(screen.queryByText(/This season/)).toBeNull()
    expect(screen.queryByText(/0 g/)).toBeNull()
  })

  it('renders nothing for a crop the aggregate does not mention at all', async () => {
    mockFetch([{ crop_type_slug: 'pepper', crop_name: 'Pepper', weight: weight({ grams: 300, measured_grams: 300, measured: 1 }) }])
    await renderGarden()
    // Pepper has one; Tomato — present as a group, absent from the aggregate — must not borrow it.
    expect(screen.getAllByTestId('crop-group-weight')).toHaveLength(1)
  })

  // SPLIT-ARTIFACT GUARD: the SPA deploys ahead of the harvests Lambda, and an older one omits
  // `weight` from crops[] entirely. "This API does not compute weight" is not "nothing was weighed".
  it('renders nothing against a harvests Lambda that does not carry weight', async () => {
    mockFetch([{ crop_type_slug: 'tomato', crop_name: 'Tomato', units: [{ unit: 'count', total: 14 }] }])
    await renderGarden()
    expect(screen.queryByTestId('crop-group-weight')).toBeNull()
  })
})

describe('Garden — crop-group season weight, request scoping', () => {
  it('asks for this season and for aggregates only — entries would be capped at one page', async () => {
    mockFetch([])
    await renderGarden()
    const urls = fetchMock.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/api/harvests'))
    expect(urls).toHaveLength(1)
    expect(urls[0]).toBe(`/api/harvests?include=aggregates&timeframe=season:${currentGrowYear(new Date())}`)
    expect(urls[0]).not.toMatch(/entries/)
  })

  it('does not fire at all under a grouping the aggregate cannot be joined on', async () => {
    localStorage.setItem('garden.groupBy.v1', 'status')
    mockFetch([{ crop_type_slug: 'tomato', crop_name: 'Tomato', weight: weight({ grams: 2400, estimated_grams: 2400, estimated: 8 }) }])
    await renderGarden()
    expect(fetchMock.mock.calls.filter(c => String(c[0]).startsWith('/api/harvests'))).toHaveLength(0)
    expect(screen.queryByTestId('crop-group-weight')).toBeNull()
  })

  // The aggregate is household-wide for the crop; a caretaker lens narrows the group's plantings to
  // one person. Printing the household number beside a narrowed list would read as "these plantings
  // produced this" — and with the two users' harvest counts three orders of magnitude apart, that
  // misread would be large. Suppressed, not recomputed: the wire cannot split weight by person.
  it('is suppressed while a caretaker lens narrows the groups', async () => {
    localStorage.setItem('garden.careLens', 'jen')
    mockFetch([{ crop_type_slug: 'tomato', crop_name: 'Tomato', weight: weight({ grams: 2400, estimated_grams: 2400, estimated: 8 }) }])
    await renderGarden()
    expect(fetchMock.mock.calls.filter(c => String(c[0]).startsWith('/api/harvests'))).toHaveLength(0)
    expect(screen.queryByTestId('crop-group-weight')).toBeNull()
  })
})
