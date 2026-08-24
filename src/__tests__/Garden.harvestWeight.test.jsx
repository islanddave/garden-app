// V4-GARDENTABNOHARVEST-001 (BD-041) — the Garden tab shows NO harvest data.
//
// This file used to pin the OPPOSITE: V4-HARVWEIGHTSURF-001 put a per-crop season weight on each
// Garden crop-type group, and six cases here held its distinctions (shared CropWeightLine wording,
// absent-vs-zero, season scoping, caretaker-lens suppression). Dave removed the feature on
// 2026-08-24: with every crop collapsed, each row carried three extra stacked lines, and the Garden
// is his browse/drill-down surface — the Harvest tab is where harvest data belongs.
//
// The cases were not deleted quietly. They are replaced by their inverse, because the thing worth
// guarding now is that the block STAYS gone and that its removal did not take the crop groups with
// it. A deleted test file would leave nothing to notice a re-introduction, and the original feature
// was well-argued enough that someone will re-derive it.
//
// The request-scoping case is the one with real teeth: the Garden must no longer CALL /api/harvests
// at all. Removing the render while leaving the fetch would keep paying for a ~household-wide
// aggregate on every Garden mount to display nothing.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'

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
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: true,
}))
vi.mock('../hooks/useMembers.js', () => ({ useMembers: () => ({ members: [
  { id: 'me', display_name: 'Dave' }, { id: 'jen', display_name: 'Jen' },
] }) }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ profile: { id: 'me' } }) }))

import Garden from '../pages/Garden.jsx'

const PROJECTS = [{ id: 'a', name: 'Bed Alpha', status: 'active', parent_project_id: null }]
const PLANTS = [
  { id: 'p1', name: 'Sungold',  project_id: 'a', status: 'growing', variety_ref: { crop_type_slug: 'tomato' } },
  { id: 'p2', name: 'Jalapeño', project_id: 'a', status: 'growing', variety_ref: { crop_type_slug: 'pepper' } },
]

// A harvests response that WOULD have rendered a weight under the old feature. If anything still
// reads it, the assertions below fail — which is the point of answering it at all rather than 404ing.
function mockFetch() {
  fetchMock.mockImplementation((url) => {
    if (url === '/api/projects') return Promise.resolve(PROJECTS)
    if (url === '/api/plants?view=grid') return Promise.resolve(PLANTS)
    if (String(url).startsWith('/api/harvests')) {
      return Promise.resolve({ aggregates: { crops: [
        { crop_type_slug: 'tomato', crop_name: 'Tomato', weight: { grams: 2400, measured_grams: 400, estimated_grams: 2000, measured: 3, estimated: 12, unweighed: 0 } },
      ] } })
    }
    return Promise.resolve([])
  })
}

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset()
})

async function renderGarden() {
  mockFetch()
  await act(async () => { render(<Garden />) })
  await screen.findByText(/Log many/)
}

describe('Garden — harvest data removed (BD-041)', () => {
  it('renders no weight block, no weight, and none of the rejected qualifier wording', async () => {
    await renderGarden()
    expect(screen.queryByTestId('crop-group-weight')).toBeNull()
    expect(screen.queryByTestId('crop-weight')).toBeNull()
    expect(screen.queryByTestId('crop-weight-basis')).toBeNull()
    expect(screen.queryByText(/This season/i)).toBeNull()
    expect(screen.queryByText(/kilograms|2\.4 kg/i)).toBeNull()
    // Dave has now rejected this phrasing on three separate surfaces; treat it as globally unwanted.
    expect(screen.queryByText(/weighed/i)).toBeNull()
    expect(screen.queryByText(/estimated/i)).toBeNull()
  })

  it('does not request /api/harvests at all — the fetch went with the render', async () => {
    await renderGarden()
    const harvestCalls = fetchMock.mock.calls.filter(c => String(c[0]).startsWith('/api/harvests'))
    expect(harvestCalls).toEqual([])
  })

  it('still renders the crop groups themselves — the removal took the weight, not the browse surface', async () => {
    await renderGarden()
    // Assert on the GROUP HEADERS, not the planting names: crop-type groups render collapsed by
    // default, so the plantings are not in the DOM and asserting on them would fail for a reason
    // that has nothing to do with this change. The collapsed headers ARE the browse surface.
    expect(screen.getAllByRole('group').length).toBeGreaterThan(0)
    expect(screen.getByText(/tomato/i)).toBeTruthy()
    expect(screen.getByText(/pepper/i)).toBeTruthy()
  })
})
