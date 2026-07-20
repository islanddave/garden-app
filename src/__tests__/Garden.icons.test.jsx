// V4-ICON-001 (Garden slice) — lock the emoji->Icon finish on the Garden surface.
// The Garden toolbar (Snap / Log many / Favorites) + card chrome (location, project
// placeholder, No-project bucket) + empty state must render registry SVG glyphs, NOT raw
// emoji. Guards against a regression back to the mixed emoji/SVG "reads-unfinished" language.
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

import Garden from '../pages/Garden.jsx'

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}❤♥⚡]/u

const PROJECTS = [
  { id: 'a', name: 'Tomatoes', status: 'active', parent_project_id: null, is_public: true, location_path: 'Greenhouse' },
]
const PLANTS = [
  { id: 'p1', name: 'Sungold', project_id: 'a', status: 'growing', quantity: 2 },
]

function mockData(projects, plants) {
  fetchMock.mockImplementation((url) =>
    Promise.resolve(url === '/api/projects' ? projects : url === '/api/plants' ? plants : []))
}

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset()
  mockData(PROJECTS, PLANTS)
})

async function renderGarden() {
  await act(async () => { render(<Garden />) })
  await screen.findByText(/Log many/)
}

describe('Garden — emoji->Icon finish (V4-ICON-001 Garden slice)', () => {
  it('the Snap toolbar button renders an Icon SVG (not the camera emoji)', async () => {
    await renderGarden()
    const snap = screen.getByTestId('snap-entry-garden')
    expect(snap.querySelector('svg')).not.toBeNull()
    expect(snap.textContent).toMatch(/Snap/)
    expect(snap.textContent).not.toMatch(EMOJI)
  })

  it('the Log many + Favorites toolbar controls render Icon SVGs with their text labels', async () => {
    await renderGarden()
    const logMany = screen.getByText(/Log many/).closest('a')
    expect(logMany.querySelector('svg')).not.toBeNull()
    const favs = screen.getByLabelText('Favorites')
    expect(favs.querySelector('svg')).not.toBeNull()
    expect(favs.textContent).not.toMatch(EMOJI)
  })

  it('the project card location line renders a location Icon SVG (not the pin emoji)', async () => {
    await renderGarden()
    const loc = screen.getByText('Greenhouse').closest('div')
    expect(loc.querySelector('svg')).not.toBeNull()
    expect(loc.textContent).not.toMatch(EMOJI)
  })

  it('a project without a featured photo shows the garden Icon placeholder (not the leaf emoji)', async () => {
    await renderGarden()
    const thumb = screen.getByLabelText('Open Tomatoes')
    expect(thumb.querySelector('svg')).not.toBeNull()
    expect(thumb.textContent).not.toMatch(EMOJI)
  })

  it('the empty state renders an Icon SVG, no emoji', async () => {
    mockData([], [])
    await act(async () => { render(<Garden />) })
    await screen.findByText(/Your garden is empty/)
    const empty = screen.getByText(/Your garden is empty/).closest('div')
    expect(empty.querySelector('svg')).not.toBeNull()
    expect(empty.textContent).not.toMatch(EMOJI)
  })
})
