// V4-GARDENSEGCTRL-001 (BD0806-20) — the Plants|Photos sub-tab SegmentedControl is GONE from Garden.
// Garden is the Plants surface, unconditionally. Photos keep their own route (/photos → PhotoLibrary,
// reachable from the BottomNav "More" menu), so nothing is stranded by the removal.
//
// RENDER assertions only (no import/static checks): the whole point is that the old control does not
// paint and the plants surface does. Flag ON (PROJECTS_HIDDEN=true) — the live shipped config, which
// is what Dave's phone runs. No jest-dom (L-182).
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
// Identifiable stand-in for the photo wall. After the removal Garden never imports it, so this mock is
// inert — which is exactly the assertion: the wall cannot paint on this page any more.
vi.mock('../components/PhotosWall.jsx', () => ({ default: () => <div data-testid="photos-wall" /> }))
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: true,
}))

import Garden from '../pages/Garden.jsx'

const PROJECTS = [{ id: 'a', name: 'Bed Alpha', status: 'active', parent_project_id: null }]
const PLANTS = [
  { id: 'p1', name: 'Sungold',  project_id: 'a', status: 'growing', variety_ref: { crop_type_slug: 'tomato' } },
  { id: 'p2', name: 'Jalapeño', project_id: 'a', status: 'growing', variety_ref: { crop_type_slug: 'pepper' } },
]

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset()
  fetchMock.mockImplementation((url) =>
    Promise.resolve(url === '/api/projects' ? PROJECTS : url === '/api/plants?view=grid' ? PLANTS : []))
})

async function renderGarden() {
  await act(async () => { render(<Garden />) })
  await screen.findByText(/Log many/)
}

describe('Garden — Plants|Photos sub-tab removed (V4-GARDENSEGCTRL-001)', () => {
  it('renders no Plants|Photos view switch', async () => {
    await renderGarden()
    // OLD state must not render.
    expect(screen.queryByRole('radiogroup', { name: 'Plants or Photos' })).toBeNull()
    expect(screen.queryByRole('radio', { name: 'Photos' })).toBeNull()
    expect(screen.queryByRole('radio', { name: 'Plants' })).toBeNull()
  })

  it('never paints the photo wall on the Garden page', async () => {
    await renderGarden()
    expect(screen.queryByTestId('photos-wall')).toBeNull()
  })

  it('renders the plants surface unconditionally (nothing was gated behind the switch)', async () => {
    await renderGarden()
    // NEW state renders: crop-type groups + the Plants-only action row that used to be
    // conditional on subtab === 'plants'.
    expect(screen.getByText('Tomato')).toBeTruthy()
    expect(screen.getByText('Pepper')).toBeTruthy()
    expect(screen.getByText(/Log many/)).toBeTruthy()
    // V4-TOPCHROMEACTIONS-001 removed the Snap slug from this row (it is a TopChrome action now,
    // and TopChrome is not rendered by this test's isolated <Garden /> mount). Log many + Favorites
    // still carry the "the action row paints unconditionally" property this case is about.
    expect(screen.getByText(/Favorites/)).toBeTruthy()
  })
})
