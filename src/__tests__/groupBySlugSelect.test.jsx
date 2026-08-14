// V4-FACETSLUG-001 — the Garden group-by slug selector.
//
// Two things are pinned here and they are different in kind:
//  1. The COMPONENT contract — it is a real native combobox with a real accessible name, because the
//     whole justification for replacing the chip row is that a native <select> gets TalkBack/Chrome-
//     Android operability for free. A visible-face-only control that fakes the pattern would look
//     identical in a screenshot and be unusable on Dave's only device.
//  2. The Garden ORDERING contract — BD0806-21 asked for "type, project, location, lifecycle". The
//     project slot is dead under PROJECTS_HIDDEN, so the head must be exactly Type, Location,
//     Lifecycle with the tag facets after. That is an ordering nobody can see in a unit render of
//     the component alone, so it is asserted against the real page.
// No jest-dom (L-182) — plain expect only.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import GroupBySlugSelect from '../components/GroupBySlugSelect.jsx'

afterEach(() => cleanup())

const OPTS = [
  { value: 'crop_type', label: 'Type' },
  { value: 'location', label: 'Location' },
  { value: 'status', label: 'Lifecycle' },
  { value: 'lifecycle', label: 'Lifespan' },
]

describe('GroupBySlugSelect — component contract', () => {
  it('is a native combobox named "Group by" (the operability claim, not a lookalike)', () => {
    render(<GroupBySlugSelect options={OPTS} value="crop_type" onChange={() => {}} />)
    const sel = screen.getByRole('combobox', { name: /^Group by$/i })
    expect(sel.tagName).toBe('SELECT')
    expect(sel.disabled).toBe(false)
  })

  it('exposes every option to the picker (nothing is chips-only)', () => {
    render(<GroupBySlugSelect options={OPTS} value="crop_type" onChange={() => {}} />)
    const sel = screen.getByRole('combobox', { name: /Group by/i })
    expect([...sel.options].map(o => o.value)).toEqual(['crop_type', 'location', 'status', 'lifecycle'])
    expect([...sel.options].map(o => o.textContent)).toEqual(['Type', 'Location', 'Lifecycle', 'Lifespan'])
  })

  it('reflects the current value on the select AND on the visible face', () => {
    const { container } = render(<GroupBySlugSelect options={OPTS} value="status" onChange={() => {}} />)
    expect(screen.getByRole('combobox', { name: /Group by/i }).value).toBe('status')
    // The face is the sighted user's copy of the same fact.
    expect(container.querySelector('[data-testid="groupby-slug"]').textContent).toContain('Lifecycle')
  })

  it('the visible face is aria-hidden so the value is announced once, not twice (SC 4.1.2)', () => {
    const { container } = render(<GroupBySlugSelect options={OPTS} value="location" onChange={() => {}} />)
    const face = container.querySelector('[data-testid="groupby-slug"] [aria-hidden="true"]')
    expect(face).toBeTruthy()
    expect(face.textContent).toContain('Location')
    // ...and it contains no focusable node of its own that could shadow the select.
    expect(face.querySelector('button, a, input, select')).toBeNull()
  })

  it('emits the chosen facet value on change', () => {
    const onChange = vi.fn()
    render(<GroupBySlugSelect options={OPTS} value="crop_type" onChange={onChange} />)
    fireEvent.change(screen.getByRole('combobox', { name: /Group by/i }), { target: { value: 'lifecycle' } })
    expect(onChange).toHaveBeenCalledWith('lifecycle')
  })

  it('falls back to the first option when the stored value is no longer offered', () => {
    // Mirrors Garden's own stale-facet fallback: a retired facet must not blank the control.
    render(<GroupBySlugSelect options={OPTS} value="none" onChange={() => {}} />)
    expect(screen.getByRole('combobox', { name: /Group by/i }).value).toBe('crop_type')
  })

  it('renders nothing with no options (the Garden guard has a component-side twin)', () => {
    const { container } = render(<GroupBySlugSelect options={[]} onChange={() => {}} />)
    expect(container.firstChild).toBeNull()
  })
})

// ---- Garden ordering contract (flag ON, i.e. how prod actually renders) --------------------------

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
// Two tag facets present on the cultivars, so the head-vs-tail split is observable.
vi.mock('../hooks/useTags.js', async (importActual) => ({
  ...(await importActual()),
  useEntityTagsBulk: () => ({
    entities: {
      p1: { direct: [], projected: [{ facet: 'lifecycle', slug: 'annual', label: 'Annual' }] },
      p2: { direct: [], projected: [{ facet: 'heat', slug: 'hot', label: 'Hot' }] },
    },
    loading: false,
  }),
}))

const Garden = (await import('../pages/Garden.jsx')).default

const PROJECTS = [{ id: 'a', name: 'Bed Alpha', status: 'active', parent_project_id: null, is_public: true }]
const PLANTS = [
  { id: 'p1', name: 'Sungold', project_id: 'a', status: 'growing', quantity: 2, variety_ref: { crop_type_slug: 'tomato' } },
  { id: 'p2', name: 'Jalapeño', project_id: 'a', status: 'growing', quantity: 3, variety_ref: { crop_type_slug: 'pepper' } },
]

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset()
  fetchMock.mockImplementation((url) =>
    Promise.resolve(url === '/api/projects' ? PROJECTS : url === '/api/plants' ? PLANTS : []))
})

describe('Garden group-by — V4-FACETSLUG-001 ordering (PROJECTS_HIDDEN)', () => {
  async function renderGarden() {
    await act(async () => { render(<Garden />) })
    await screen.findByText(/Log many/)
    return screen.getByRole('combobox', { name: /Group by/i })
  }

  it('renders ONE selector, not a chip row (the whole point of the row)', async () => {
    await renderGarden()
    expect(screen.getAllByRole('combobox', { name: /Group by/i }).length).toBe(1)
    // The retired chip row asserted aria-pressed on every facet; none should remain on this page.
    expect(screen.queryAllByRole('button', { pressed: true }).length).toBe(0)
    expect(screen.queryAllByRole('button', { pressed: false }).length).toBe(0)
  })

  it('leads with Type, Location, Lifecycle — the row order minus the dead project slot', async () => {
    const sel = await renderGarden()
    const labels = [...sel.options].map(o => o.textContent)
    expect(labels.slice(0, 3)).toEqual(['Type', 'Location', 'Lifecycle'])
  })

  it('does not resurrect a Projects option (PROJECTS_HIDDEN since 2026-08-10)', async () => {
    const sel = await renderGarden()
    expect([...sel.options].map(o => o.value)).not.toContain('none')
    expect([...sel.options].map(o => o.textContent)).not.toContain('Projects')
  })

  it('sorts the tag facets after the structural head — "Lifespan" is NOT "Lifecycle"', async () => {
    const sel = await renderGarden()
    const labels = [...sel.options].map(o => o.textContent)
    // The live label inversion: `status` is "Lifecycle" (head), the `lifecycle` tag facet is
    // "Lifespan" (tail). Getting these backwards silently changes which facet the page groups on.
    expect(labels).toEqual(['Type', 'Location', 'Lifecycle', 'Lifespan', 'Heat'])
    expect([...sel.options].map(o => o.value))
      .toEqual(['crop_type', 'location', 'status', 'lifecycle', 'heat'])
  })

  it('choosing a facet regroups the page', async () => {
    const sel = await renderGarden()
    // Default is crop_type -> Tomato/Pepper headers.
    expect(screen.getByText('Tomato')).toBeTruthy()
    await act(async () => { fireEvent.change(sel, { target: { value: 'status' } }) })
    expect(screen.queryByText('Tomato')).toBeNull()
    expect(screen.getByRole('combobox', { name: /Group by/i }).value).toBe('status')
  })
})
