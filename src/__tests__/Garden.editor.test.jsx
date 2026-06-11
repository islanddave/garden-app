// Garden PlantingEditor — V3-IA merge coverage. The add/edit/delete machinery that
// lived in the retired Plants page now opens inside Garden via query params:
//   ?add=1 (FAB create sheet) · ?edit=<id> (PlantingDetail V3-EDIT-001) ·
//   ?source_inventory_item_id/&variety_id (InventoryDetail plant-from-packet).
// Wire-contract assertions (dual-write variety, planting-details union, COALESCE PUT)
// ported from the old Plants.test.jsx.
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
  useNavigate: () => () => {},
  useSearchParams: () => [searchParamsRef.current, setSearchParamsSpy],
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: getTokenSpy }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span data-testid="fav" /> }))
vi.mock('../components/VarietyPicker.jsx', () => ({
  default: ({ value, onChange }) => (
    <div data-testid="variety-picker">
      <span data-testid="vp-value">{value ? value.name : 'EMPTY'}</span>
      <button type="button" data-testid="vp-pick-black-krim"
        onClick={() => onChange({ id: 'var-1', name: 'Black Krim', species: 'Solanum lycopersicum', genus: 'Solanum' })}>
        Pick Variety
      </button>
    </div>
  ),
}))

import Garden from '../pages/Garden.jsx'

const PROJECTS = [{ id: 'proj-1', name: 'Spring 2026', status: 'active', parent_project_id: null, is_public: true }]
const PLANT = {
  id: 'plant-2', name: 'Krim Plant', project_id: 'proj-1', project_name: 'Spring 2026',
  quantity: 3, status: 'seedling', notes: null,
  variety: 'Black Krim', variety_id: 'var-1',
  variety_ref: { id: 'var-1', name: 'Black Krim', species: 'Solanum lycopersicum' },
}
const PACKET = { id: 'item-seed-1', name: 'Black Krim seed packet', category: 'seeds', variety_id: 'var-1', quantity_on_hand: 5 }
const VARIETY = { id: 'var-1', name: 'Black Krim', species: 'Solanum lycopersicum', genus: 'Solanum' }

function primeFetch({ plants = [PLANT] } = {}) {
  fetchSpy.mockImplementation((url, opts = {}) => {
    if (url === '/api/projects') return Promise.resolve(PROJECTS)
    if (url === '/api/plants' && !opts.method) return Promise.resolve(plants)
    if (url === '/api/inventory-items/item-seed-1') return Promise.resolve(PACKET)
    if (url === '/api/varieties/var-1') return Promise.resolve(VARIETY)
    if (url === '/api/plants' && opts.method === 'POST') return Promise.resolve({ id: 'plant-new', name: 'X', project_id: 'proj-1' })
    if (url.startsWith('/api/plants/') && opts.method === 'PUT') return Promise.resolve({ ...PLANT, name: 'Renamed' })
    if (url.startsWith('/api/plants/') && opts.method === 'DELETE') return Promise.resolve({})
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

describe('Garden — ?add=1 opens the Add Planting editor (FAB entry)', () => {
  it('auto-opens the add form and strips the param', async () => {
    searchParamsRef.current = new URLSearchParams('add=1')
    primeFetch()
    await renderGarden()
    expect(screen.getAllByText('Add planting').length).toBeGreaterThan(0)
    expect(setSearchParamsSpy).toHaveBeenCalled()
    expect(searchParamsRef.current.get('add')).toBeNull()
  })

  it('does NOT open the editor without params', async () => {
    primeFetch()
    await renderGarden()
    expect(screen.queryByText('Add planting')).toBeNull()
  })

  it('POST carries dual-write variety + planting-details union + project_id', async () => {
    searchParamsRef.current = new URLSearchParams('add=1')
    primeFetch()
    await renderGarden()
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: 'New Plant' } })
    fireEvent.click(screen.getByTestId('vp-pick-black-krim'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Add planting$/i }))
    })
    const postCall = fetchSpy.mock.calls.find(c => c[0] === '/api/plants' && c[1]?.method === 'POST')
    expect(postCall).toBeDefined()
    const body = JSON.parse(postCall[1].body)
    expect(body.name).toBe('New Plant')
    expect(body.variety_id).toBe('var-1')
    expect(body.variety).toBe('Black Krim')
    expect(body.project_id).toBe('proj-1')
    expect(body.sown_at).toBeNull()
    expect(body.source_type).toBeNull()
    expect(screen.queryAllByText('Add planting').length).toBe(0)
  })

  it('create success refetches /api/plants (V3-GARDEN-001)', async () => {
    // The POST /api/plants response lacks the nested variety_ref join, so the optimistic
    // prepend alone leaves the row variety-less until a tab refresh. onPlantCreated must
    // refetch the full hydrated list. Assert a SECOND bare GET /api/plants fires after Add
    // (mirrors Garden.photoUpload.test.jsx onUploadComplete refetch assertion). The extra
    // GET is satisfied by primeFetch's bare-GET branch returning the plants list.
    searchParamsRef.current = new URLSearchParams('add=1')
    primeFetch()
    await renderGarden()
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: 'New Plant' } })
    fireEvent.click(screen.getByTestId('vp-pick-black-krim'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Add planting$/i }))
    })
    await waitFor(() => {
      const plantGets = fetchSpy.mock.calls.filter(([u, o = {}]) => u === '/api/plants' && !o.method)
      expect(plantGets.length).toBeGreaterThanOrEqual(2)
    })
  })
})

describe('Garden — plant-from-packet deep link (InventoryDetail entry)', () => {
  it('prefills name + variety from packet params and shows the packet banner', async () => {
    searchParamsRef.current = new URLSearchParams('source_inventory_item_id=item-seed-1&variety_id=var-1')
    primeFetch()
    await renderGarden()
    await waitFor(() => expect(screen.getByText(/Planting from/)).toBeDefined())
    expect(screen.getByText(/Black Krim seed packet/)).toBeDefined()
    await waitFor(() => expect(screen.getByTestId('vp-value').textContent).toBe('Black Krim'))
    expect(screen.getByLabelText(/Name/i).value).toBe('Black Krim seed packet')
  })

  it('POST includes source_inventory_item_id', async () => {
    searchParamsRef.current = new URLSearchParams('source_inventory_item_id=item-seed-1&variety_id=var-1')
    primeFetch()
    await renderGarden()
    await waitFor(() => expect(screen.getByText(/Planting from/)).toBeDefined())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Add planting$/i }))
    })
    const postCall = fetchSpy.mock.calls.find(c => c[0] === '/api/plants' && c[1]?.method === 'POST')
    expect(postCall).toBeDefined()
    const body = JSON.parse(postCall[1].body)
    expect(body.source_inventory_item_id).toBe('item-seed-1')
    expect(body.variety_id).toBe('var-1')
  })
})

describe('Garden — ?edit=<id> opens the edit editor (V3-EDIT-001 target)', () => {
  it('opens the edit form prefilled, strips the param', async () => {
    searchParamsRef.current = new URLSearchParams('edit=plant-2')
    primeFetch()
    await renderGarden()
    await waitFor(() => expect(screen.getByText(/Edit Krim Plant/)).toBeDefined())
    expect(screen.getByLabelText(/Name/i).value).toBe('Krim Plant')
    expect(screen.getByTestId('vp-value').textContent).toBe('Black Krim')
    expect(searchParamsRef.current.get('edit')).toBeNull()
  })

  it('PUT body includes variety_id + flat variety (dual-write) on save', async () => {
    searchParamsRef.current = new URLSearchParams('edit=plant-2')
    primeFetch()
    await renderGarden()
    await waitFor(() => expect(screen.getByText(/Edit Krim Plant/)).toBeDefined())
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: 'Renamed' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Save$/i }))
    })
    const putCall = fetchSpy.mock.calls.find(c => c[0] === '/api/plants/plant-2' && c[1]?.method === 'PUT')
    expect(putCall).toBeDefined()
    const body = JSON.parse(putCall[1].body)
    expect(body.name).toBe('Renamed')
    expect(body.variety_id).toBe('var-1')
    expect(body.variety).toBe('Black Krim')
    expect(screen.queryByText(/Edit Krim Plant/)).toBeNull()
  })

  it('Remove deletes the planting and closes the editor', async () => {
    searchParamsRef.current = new URLSearchParams('edit=plant-2')
    primeFetch()
    await renderGarden()
    await waitFor(() => expect(screen.getByText(/Edit Krim Plant/)).toBeDefined())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Remove$/i }))
    })
    const delCall = fetchSpy.mock.calls.find(c => c[0] === '/api/plants/plant-2' && c[1]?.method === 'DELETE')
    expect(delCall).toBeDefined()
    expect(screen.queryByText(/Edit Krim Plant/)).toBeNull()
  })

  it('unknown edit id strips the param without opening an editor', async () => {
    searchParamsRef.current = new URLSearchParams('edit=nope')
    primeFetch()
    await renderGarden()
    expect(screen.queryByText(/^Edit /)).toBeNull()
    expect(searchParamsRef.current.get('edit')).toBeNull()
  })
})
