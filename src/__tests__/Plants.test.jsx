/**
 * src/__tests__/Plants.test.jsx
 * VARIETY-REF S4b — Plants page integration tests.
 *
 * Mocks:
 *   - useApiFetch  -> fetchSpy
 *   - useSearchParams / useNavigate from react-router-dom (we control query params + navigation)
 *   - VarietyPicker -> stub exposing a "Pick Variety" button that fires onChange
 *   - FavoriteToggle -> noop
 *
 * Covers:
 *   - Initial load (plants + projects)
 *   - Adding plant with variety_id + flat variety text (dual-write)
 *   - Add submission carries source_inventory_item_id when present in query params
 *   - Deep-link pre-fill: fetches inventory_item + variety, shows packet banner, sets form.variety
 *   - Clear query-params link
 *   - Submission ignores second click (double-submit guard via disabled button)
 *   - Edit flow: variety_ref pre-fills picker, save submits variety_id + name
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchSpy, navigateSpy, searchParamsRef, setSearchParamsSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  searchParamsRef: { current: new URLSearchParams() },
  setSearchParamsSpy: vi.fn((next) => {
    searchParamsRef.current = next instanceof URLSearchParams ? next : new URLSearchParams(next)
  }),
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useSearchParams: () => [searchParamsRef.current, setSearchParamsSpy],
  useNavigate: () => navigateSpy,
}))

vi.mock('../components/FavoriteToggle.jsx', () => ({
  default: () => <span data-testid="favorite-toggle" />,
}))

vi.mock('../components/VarietyPicker.jsx', () => ({
  default: ({ value, onChange, placeholder }) => (
    <div data-testid="variety-picker">
      <span data-testid="vp-value">{value ? value.name : 'EMPTY'}</span>
      <span data-testid="vp-placeholder">{placeholder}</span>
      <button
        type="button"
        data-testid="vp-pick-black-krim"
        onClick={() => onChange({ id: 'var-1', name: 'Black Krim', species: 'Solanum lycopersicum', genus: 'Solanum' })}
      >
        Pick Variety
      </button>
      <button
        type="button"
        data-testid="vp-clear"
        onClick={() => onChange(null)}
      >
        Clear
      </button>
    </div>
  ),
}))

// V2-PHOTO-F1 S2: stub PhotoUpload so per-plant photo triggers do not pull in
// the full upload hook + presign network mocks. We only need to assert the
// component is mounted with the right keyPrefix/linkage shape.
vi.mock('../components/PhotoUpload.jsx', () => ({
  default: ({ keyPrefix, parentId, linkage }) => (
    <span
      data-testid={`plant-photo-upload-${parentId ?? 'none'}`}
      data-key-prefix={keyPrefix}
      data-linkage={JSON.stringify(linkage ?? {})}
    />
  ),
}))

import Plants from '../pages/Plants.jsx'

const SAMPLE_PROJECT = { id: 'proj-1', name: 'Spring 2026' }

const SAMPLE_PLANT = {
  id: 'plant-1',
  name: 'Cherry Tomato',
  genus: 'Solanum',
  species: 'lycopersicum',
  variety: 'Sun Gold',
  variety_id: null,
  variety_ref: null,
  quantity: 3,
  status: 'seedling',
  project_id: 'proj-1',
  project_name: 'Spring 2026',
  notes: null,
}

const SAMPLE_PLANT_WITH_REF = {
  ...SAMPLE_PLANT,
  id: 'plant-2',
  name: 'Krim Plant',
  variety: 'Black Krim',
  variety_id: 'var-1',
  variety_ref: { id: 'var-1', name: 'Black Krim', species: 'Solanum lycopersicum' },
}

const SAMPLE_PACKET = {
  id: 'item-seed-1',
  name: 'Black Krim seed packet',
  category: 'seeds',
  variety_id: 'var-1',
  quantity_on_hand: 5,
}

const SAMPLE_VARIETY = { id: 'var-1', name: 'Black Krim', species: 'Solanum lycopersicum', genus: 'Solanum' }

beforeEach(() => {
  fetchSpy.mockReset()
  navigateSpy.mockReset()
  setSearchParamsSpy.mockClear()
  searchParamsRef.current = new URLSearchParams()
  try { localStorage.clear() } catch (e) {}
})

// Helper that primes the initial /api/plants + /api/projects mount fetches.
function primeMountFetches({ plants = [], projects = [SAMPLE_PROJECT] } = {}) {
  fetchSpy.mockResolvedValueOnce(plants)   // /api/plants
  fetchSpy.mockResolvedValueOnce(projects) // /api/projects
}

describe('Plants — initial load', () => {
  it('renders header and empty state when no plants', async () => {
    primeMountFetches()
    render(<Plants />)
    await waitFor(() => {
      expect(screen.getByText(/No plantings yet/)).toBeDefined()
    })
    expect(screen.getByText(/🌿 Plantings/)).toBeDefined()
  })

  it('lists plants from /api/plants', async () => {
    primeMountFetches({ plants: [SAMPLE_PLANT] })
    render(<Plants />)
    await waitFor(() => {
      // Text is split by emoji prefix span — use text-content matcher.
      const node = screen.getByText((_c, el) => el?.tagName === 'SPAN' && /Cherry Tomato/.test(el?.textContent || ''))
      expect(node).toBeDefined()
    })
  })

  it('prefers variety_ref.name over flat variety for display', async () => {
    primeMountFetches({ plants: [SAMPLE_PLANT_WITH_REF] })
    render(<Plants />)
    await waitFor(() => {
      expect(screen.getByText('Black Krim')).toBeDefined()
    })
  })
})

describe('Plants — add new plant', () => {
  it('opens add form when "+ New Plant" clicked', async () => {
    primeMountFetches()
    searchParamsRef.current = new URLSearchParams('add=1')  // add form now opens via FAB deep-link (?add=1), not a removed +New Plant button
    render(<Plants />)
    await waitFor(() => screen.getByTestId('variety-picker'))
    // Form header (div) AND submit button (button) both contain "Add plant" — assert both exist.
    expect(screen.getAllByText(/Add plant/i).length).toBeGreaterThan(0)
    expect(screen.getByTestId('variety-picker')).toBeDefined()
  })

  it('submits with variety_id and dual-write variety text when variety picked', async () => {
    primeMountFetches()
    searchParamsRef.current = new URLSearchParams('add=1')
    render(<Plants />)
    await waitFor(() => screen.getByText(/No plantings yet/))

    fireEvent.change(screen.getByLabelText(/Name \*/i), { target: { value: 'New Plant' } })
    fireEvent.click(screen.getByTestId('vp-pick-black-krim'))

    // POST response
    fetchSpy.mockResolvedValueOnce({
      id: 'plant-new',
      name: 'New Plant',
      variety: 'Black Krim',
      variety_id: 'var-1',
      project_id: 'proj-1',
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Add planting$/i }))
    })

    const postCall = fetchSpy.mock.calls.find(c => c[0] === '/api/plants' && c[1]?.method === 'POST')
    expect(postCall).toBeDefined()
    const body = JSON.parse(postCall[1].body)
    expect(body.name).toBe('New Plant')
    expect(body.variety_id).toBe('var-1')
    expect(body.variety).toBe('Black Krim')        // dual-write flat text
    expect(body.genus).toBe('Solanum')             // pulled from variety object
    expect(body.species).toBe('Solanum lycopersicum')
    expect(body.project_id).toBe('proj-1')
  })

  it('submits with variety_id=null when no variety picked', async () => {
    primeMountFetches()
    searchParamsRef.current = new URLSearchParams('add=1')
    render(<Plants />)
    await waitFor(() => screen.getByText(/No plantings yet/))

    fireEvent.change(screen.getByLabelText(/Name \*/i), { target: { value: 'Plain Plant' } })

    fetchSpy.mockResolvedValueOnce({ id: 'plant-new', name: 'Plain Plant', project_id: 'proj-1' })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Add planting$/i }))
    })

    const postCall = fetchSpy.mock.calls.find(c => c[0] === '/api/plants' && c[1]?.method === 'POST')
    const body = JSON.parse(postCall[1].body)
    expect(body.variety_id).toBeNull()
    expect(body.variety).toBeNull()
  })
})

describe('Plants — Plant-from-packet deep link', () => {
  it('reads source_inventory_item_id + variety_id from query params and pre-fills form', async () => {
    searchParamsRef.current = new URLSearchParams('source_inventory_item_id=item-seed-1&variety_id=var-1')
    primeMountFetches()
    // After mount fetches, the deep-link effect fires two more fetches:
    fetchSpy.mockResolvedValueOnce(SAMPLE_PACKET)   // /api/inventory-items/item-seed-1
    fetchSpy.mockResolvedValueOnce(SAMPLE_VARIETY)  // /api/varieties/var-1

    render(<Plants />)

    await waitFor(() => {
      expect(screen.getByText(/Planting from/)).toBeDefined()
    })
    expect(screen.getByText(/Black Krim seed packet/)).toBeDefined()

    // VarietyPicker stub should reflect the selected variety
    await waitFor(() => {
      expect(screen.getByTestId('vp-value').textContent).toBe('Black Krim')
    })

    // Name field pre-filled from packet name
    const nameInput = screen.getByLabelText(/Name \*/i)
    expect(nameInput.value).toBe('Black Krim seed packet')

    // Fetch calls include both deep-link URLs
    expect(fetchSpy.mock.calls.some(c => c[0] === '/api/inventory-items/item-seed-1')).toBe(true)
    expect(fetchSpy.mock.calls.some(c => c[0] === '/api/varieties/var-1')).toBe(true)
  })

  it('submission with deep-link source_inventory_item_id includes it in POST body', async () => {
    searchParamsRef.current = new URLSearchParams('source_inventory_item_id=item-seed-1&variety_id=var-1')
    primeMountFetches()
    fetchSpy.mockResolvedValueOnce(SAMPLE_PACKET)
    fetchSpy.mockResolvedValueOnce(SAMPLE_VARIETY)

    render(<Plants />)
    await waitFor(() => screen.getByText(/Planting from/))

    fetchSpy.mockResolvedValueOnce({
      id: 'plant-new', name: 'Black Krim seed packet', variety_id: 'var-1',
      source_inventory_item_id: 'item-seed-1', project_id: 'proj-1',
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Add planting$/i }))
    })

    const postCall = fetchSpy.mock.calls.find(c => c[0] === '/api/plants' && c[1]?.method === 'POST')
    expect(postCall).toBeDefined()
    const body = JSON.parse(postCall[1].body)
    expect(body.source_inventory_item_id).toBe('item-seed-1')
    expect(body.variety_id).toBe('var-1')
    expect(setSearchParamsSpy).toHaveBeenCalled() // clears query params on success
  })

  it('Clear button clears query params and removes packet banner', async () => {
    searchParamsRef.current = new URLSearchParams('source_inventory_item_id=item-seed-1')
    primeMountFetches()
    fetchSpy.mockResolvedValueOnce(SAMPLE_PACKET)

    render(<Plants />)
    await waitFor(() => screen.getByText(/Planting from/))

    // The banner has a button literally labeled "Clear". VarietyPicker stub also has a Clear button —
    // grab the banner clear specifically by closest role+exact name.
    const clears = screen.getAllByRole('button', { name: /^Clear$/i })
    fireEvent.click(clears[0])
    expect(setSearchParamsSpy).toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.queryByText(/Planting from/)).toBeNull()
    })
  })

  it('non-fatal: packet fetch failure does not break form', async () => {
    searchParamsRef.current = new URLSearchParams('source_inventory_item_id=item-seed-1')
    primeMountFetches()
    fetchSpy.mockRejectedValueOnce(new Error('404'))

    render(<Plants />)
    // No banner appears, but Add form still opens for normal use
    await waitFor(() => {
      expect(screen.getAllByText(/Add plant/i).length).toBeGreaterThan(0)
    })
  })
})

describe('Plants — edit flow', () => {
  it('pre-fills VarietyPicker from plant.variety_ref on edit', async () => {
    primeMountFetches({ plants: [SAMPLE_PLANT_WITH_REF] })
    render(<Plants />)
    await waitFor(() => screen.getByText((_c, el) =>
      el?.tagName === 'SPAN' && /Krim Plant/.test(el?.textContent || '')
    ))

    fireEvent.click(screen.getByText('Edit'))
    // Picker stub renders the value name "Black Krim"
    const pickerValues = screen.getAllByTestId('vp-value')
    expect(pickerValues.some(el => el.textContent === 'Black Krim')).toBe(true)
  })

  it('PUT body includes variety_id + flat variety on save', async () => {
    primeMountFetches({ plants: [SAMPLE_PLANT_WITH_REF] })
    render(<Plants />)
    await waitFor(() => screen.getByText((_c, el) =>
      el?.tagName === 'SPAN' && /Krim Plant/.test(el?.textContent || '')
    ))

    fireEvent.click(screen.getByText('Edit'))

    // Mock PUT response
    fetchSpy.mockResolvedValueOnce({ ...SAMPLE_PLANT_WITH_REF, name: 'Renamed' })

    fireEvent.change(screen.getByLabelText(/Name \*/i), { target: { value: 'Renamed' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Save$/i }))
    })

    const putCall = fetchSpy.mock.calls.find(c => c[0] === '/api/plants/plant-2' && c[1]?.method === 'PUT')
    expect(putCall).toBeDefined()
    const body = JSON.parse(putCall[1].body)
    expect(body.name).toBe('Renamed')
    expect(body.variety_id).toBe('var-1')
    expect(body.variety).toBe('Black Krim')
  })

})

describe('Plants — V2-PHOTO-F1 S2 per-plant upload trigger', () => {
  it('renders PhotoUpload on each plant card with plants keyPrefix + plant_id linkage', async () => {
    primeMountFetches({ plants: [SAMPLE_PLANT] })
    render(<Plants />)
    await waitFor(() => screen.getByTestId('plant-photo-upload-plant-1'))
    const node = screen.getByTestId('plant-photo-upload-plant-1')
    expect(node.dataset.keyPrefix).toBe('plants')
    const linkage = JSON.parse(node.dataset.linkage)
    expect(linkage.plant_id).toBe('plant-1')
    expect(linkage.project_id).toBe('proj-1')
  })
})

describe('Plants — V1.2a-3 Increment A (I2a-display)', () => {
  it('renders the featured photo thumbnail when the plant has one', async () => {
    primeMountFetches({
      plants: [{ ...SAMPLE_PLANT, featured_photo_view_url: 'https://example/plant-1.jpg' }],
    })
    render(<Plants />)
    const img = await screen.findByAltText('Cherry Tomato photo')
    expect(img.getAttribute('src')).toBe('https://example/plant-1.jpg')
  })

  it('renders no thumbnail when the plant has no featured photo', async () => {
    primeMountFetches({ plants: [SAMPLE_PLANT] })
    render(<Plants />)
    await waitFor(() => screen.getByText((_c, el) =>
      el?.tagName === 'SPAN' && /Cherry Tomato/.test(el?.textContent || '')))
    expect(screen.queryByAltText('Cherry Tomato photo')).toBeNull()
  })
})

describe('Plants — Plant→Planting rename notice (S5)', () => {
  it('shows the ambient rename notice on first visit, then dismisses persistently', async () => {
    try { localStorage.removeItem('plantings-rename-note-dismissed') } catch (e) {}
    primeMountFetches()
    render(<Plants />)
    await waitFor(() => screen.getByText(/No plantings yet/))
    const note = screen.getByRole('status')
    expect(note).toBeDefined()
    expect(/calling these/i.test(note.textContent || '')).toBe(true)
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(screen.queryByRole('status')).toBeNull()
    expect(localStorage.getItem('plantings-rename-note-dismissed')).toBe('1')
  })

  it('stays hidden once dismissed', async () => {
    try { localStorage.setItem('plantings-rename-note-dismissed', '1') } catch (e) {}
    primeMountFetches()
    render(<Plants />)
    await waitFor(() => screen.getByText(/No plantings yet/))
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('Plants — +LOG FAB ?add=1 entry', () => {
  it('auto-opens the Add Planting form when ?add=1 is present, then strips the param', async () => {
    searchParamsRef.current = new URLSearchParams('add=1')
    primeMountFetches()
    render(<Plants />)
    await waitFor(() => {
      expect(screen.getAllByText(/Add plant/i).length).toBeGreaterThan(0)
    })
    expect(screen.getByTestId('variety-picker')).toBeDefined()
    // Param is stripped via setSearchParams(replace) so a later ?add=1 re-triggers cleanly.
    expect(setSearchParamsSpy).toHaveBeenCalled()
    const lastArg = setSearchParamsSpy.mock.calls.at(-1)[0]
    const usp = lastArg instanceof URLSearchParams ? lastArg : new URLSearchParams(lastArg)
    expect(usp.get('add')).toBeNull()
  })

  it('does NOT auto-open the Add form without ?add=1', async () => {
    primeMountFetches()
    render(<Plants />)
    await waitFor(() => screen.getByText(/No plantings yet/))
    expect(screen.queryByTestId('variety-picker')).toBeNull()
  })
})
