/**
 * src/__tests__/VarietyPicker.test.jsx
 * Component tests for VarietyPicker — covers search debounce, selection,
 * create-on-not-found, 409 fuzzy-match disambiguation, keyboard nav,
 * disabled/required states, empty/primer/error UX, allowDuplicate override.
 *
 * Mocks useApiFetch (same pattern as useInventory.test.js) so the
 * embedded useVarieties hook never hits the network.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
}))

import VarietyPicker from '../components/VarietyPicker.jsx'

const V1 = {
  id: 'var-1',
  name: 'Black Krim',
  species: 'Solanum lycopersicum',
  common_name: 'tomato',
  source: 'Baker Creek',
}

const V2 = {
  id: 'var-2',
  name: 'Cherokee Purple',
  species: 'Solanum lycopersicum',
  common_name: 'tomato',
}

beforeEach(() => {
  fetchSpy.mockReset()
})

// Helper: render fresh picker with optional initial value + onChange spy.
// Caller is responsible for queueing fetchSpy mocks BEFORE calling setup —
// the mount issues one /api/varieties GET immediately.
function setup(props = {}) {
  const onChange = vi.fn()
  const utils = render(<VarietyPicker onChange={onChange} {...props} />)
  return { ...utils, onChange }
}

// ── Initial render / primer ─────────────────────────────────────────────────
describe('VarietyPicker — initial render', () => {
  it('renders search input with placeholder', async () => {
    fetchSpy.mockResolvedValueOnce([])
    setup()
    expect(screen.getByRole('combobox')).toBeDefined()
    expect(screen.getByPlaceholderText('Search varieties…')).toBeDefined()
  })

  it('uses custom placeholder when provided', async () => {
    fetchSpy.mockResolvedValueOnce([])
    setup({ placeholder: 'Find seeds…' })
    expect(screen.getByPlaceholderText('Find seeds…')).toBeDefined()
  })

  it('shows primer message in dropdown when focused with no query', async () => {
    fetchSpy.mockResolvedValueOnce([])
    setup()
    fireEvent.focus(screen.getByRole('combobox'))
    await waitFor(() => {
      expect(screen.getByText(/start typing to search/i)).toBeDefined()
    })
  })
})

// ── Disabled state ──────────────────────────────────────────────────────────
describe('VarietyPicker — disabled', () => {
  it('input has disabled attribute and does not open dropdown', async () => {
    fetchSpy.mockResolvedValueOnce([])
    setup({ disabled: true })
    const input = screen.getByRole('combobox')
    expect(input.disabled).toBe(true)
    fireEvent.focus(input)
    // dropdown should not open
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('shows chip without Change button when value set and disabled', async () => {
    fetchSpy.mockResolvedValueOnce([])
    setup({ value: V1, disabled: true })
    expect(screen.getByText('Black Krim')).toBeDefined()
    expect(screen.queryByText('Change')).toBeNull()
  })
})

// ── Selected chip mode ──────────────────────────────────────────────────────
describe('VarietyPicker — selected chip', () => {
  it('renders chip when value provided', async () => {
    fetchSpy.mockResolvedValueOnce([])
    setup({ value: V1 })
    expect(screen.getByText('Black Krim')).toBeDefined()
    expect(screen.getByText('Solanum lycopersicum')).toBeDefined()
  })

  it('Clear button clears selection and returns to search mode', async () => {
    fetchSpy.mockResolvedValueOnce([])
    const { onChange } = setup({ value: V1 })
    fireEvent.click(screen.getByLabelText('Clear variety selection'))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('Change button opens search mode', async () => {
    fetchSpy.mockResolvedValueOnce([])
    setup({ value: V1 })
    fireEvent.click(screen.getByText('Change'))
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeDefined()
    })
  })
})

// ── Search + debounce ───────────────────────────────────────────────────────
describe('VarietyPicker — search', () => {
  it('debounces input and fires search after 250ms', async () => {
    fetchSpy.mockResolvedValueOnce([])
    fetchSpy.mockResolvedValueOnce([V1])
    setup()

    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Kr' } })
    fireEvent.change(input, { target: { value: 'Kri' } })
    fireEvent.change(input, { target: { value: 'Krim' } })

    // Wait for debounce + render
    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(c => c[0] === '/api/varieties?q=Krim')
      expect(call).toBeDefined()
    }, { timeout: 1000 })
  })

  it('renders matching varieties in dropdown', async () => {
    fetchSpy.mockResolvedValueOnce([V1, V2])
    setup()
    fireEvent.focus(screen.getByRole('combobox'))
    await waitFor(() => {
      expect(screen.getByText('Black Krim')).toBeDefined()
      expect(screen.getByText('Cherokee Purple')).toBeDefined()
    })
  })

  it('clicking a variety calls onChange', async () => {
    fetchSpy.mockResolvedValueOnce([V1])
    const { onChange } = setup()
    fireEvent.focus(screen.getByRole('combobox'))
    await waitFor(() => screen.getByText('Black Krim'))
    fireEvent.click(screen.getByText('Black Krim'))
    expect(onChange).toHaveBeenCalledWith(V1)
  })
})

// ── speciesFilter ───────────────────────────────────────────────────────────
describe('VarietyPicker — speciesFilter', () => {
  it('filters out non-matching species client-side', async () => {
    const otherSpecies = { id: 'var-3', name: 'Bean Plant', species: 'Phaseolus vulgaris', common_name: 'bean' }
    fetchSpy.mockResolvedValueOnce([V1, otherSpecies])
    setup({ speciesFilter: 'Solanum lycopersicum' })
    fireEvent.focus(screen.getByRole('combobox'))
    await waitFor(() => {
      expect(screen.getByText('Black Krim')).toBeDefined()
      expect(screen.queryByText('Bean Plant')).toBeNull()
    })
  })
})

// ── Create-on-not-found ─────────────────────────────────────────────────────
describe('VarietyPicker — create flow', () => {
  it('shows "Create \'<query>\'" footer when no exact match', async () => {
    fetchSpy.mockResolvedValueOnce([])
    setup()
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'NewVariety' } })
    await waitFor(() => {
      // Match flexible across spans
      expect(screen.getByText(/Create/)).toBeDefined()
      expect(screen.getByText(/NewVariety/)).toBeDefined()
    })
  })

  it('does not show create footer when allowCreate=false', async () => {
    fetchSpy.mockResolvedValueOnce([])
    setup({ allowCreate: false })
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'NewVariety' } })
    await waitFor(() => {
      // no Create row
      expect(screen.queryByText(/^Create/)).toBeNull()
    })
  })

  it('hides create footer when an exact match exists', async () => {
    fetchSpy.mockResolvedValueOnce([V1])
    setup()
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Black Krim' } })
    await waitFor(() => {
      expect(screen.getByText('Black Krim')).toBeDefined()
    })
    // No "Create 'Black Krim'" row
    const createNodes = screen.queryAllByText((_content, node) =>
      node?.textContent === 'Create "Black Krim"'
    )
    expect(createNodes.length).toBe(0)
  })

  it('clicking create footer posts to /api/varieties and selects result', async () => {
    fetchSpy.mockResolvedValueOnce([]) // mount load
    const { onChange } = setup({ speciesFilter: 'Solanum lycopersicum' })

    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'NewVar' } })

    // Wait for debounce search call
    await waitFor(() => {
      expect(fetchSpy.mock.calls.some(c => c[0] === '/api/varieties?q=NewVar')).toBe(true)
    }, { timeout: 1000 })
    // That search returns nothing (we don't pre-queue, but the create POST will queue next)
    // Resolve any pending search calls — the deferred chain works because fetchSpy returns
    // undefined when out of queued responses; useVarieties treats non-array as []
    await waitFor(() => screen.getByText(/Create/))

    const created = { ...V1, id: 'var-new', name: 'NewVar' }
    fetchSpy.mockResolvedValueOnce(created)

    // Click the create row
    const createRow = screen.getByText(/Create/).closest('li')
    await act(async () => { fireEvent.click(createRow) })

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(created)
    }, { timeout: 1000 })

    const postCall = fetchSpy.mock.calls.find(
      c => c[0] === '/api/varieties' && c[1]?.method === 'POST'
    )
    expect(postCall).toBeDefined()
    const body = JSON.parse(postCall[1].body)
    expect(body.name).toBe('NewVar')
    expect(body.species).toBe('Solanum lycopersicum')
  })
})

// ── 409 conflict modal ──────────────────────────────────────────────────────
describe('VarietyPicker — 409 conflict modal', () => {
  it('opens disambiguation modal on 409 with existing variety', async () => {
    fetchSpy.mockResolvedValueOnce([]) // mount
    fetchSpy.mockResolvedValueOnce([]) // debounce search
    setup()
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Black Krim' } })
    // Wait for debounce search to fire so it doesn't consume the next mock.
    await waitFor(() => {
      expect(fetchSpy.mock.calls.some(c => c[0] === '/api/varieties?q=Black%20Krim')).toBe(true)
    }, { timeout: 1000 })
    await waitFor(() => screen.getByText(/Create/))

    const conflictErr = new Error('Variety already exists')
    conflictErr.status = 409
    conflictErr.body = { existing: V1 }
    fetchSpy.mockRejectedValueOnce(conflictErr)

    const createRow = screen.getByText(/Create/).closest('li')
    await act(async () => { fireEvent.click(createRow) })

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeDefined()
      expect(screen.getByText(/similar variety already exists/i)).toBeDefined()
    }, { timeout: 1500 })
    expect(screen.getByText('Use existing')).toBeDefined()
    expect(screen.getByText(/Create anyway/)).toBeDefined()
    expect(screen.getByText('Cancel')).toBeDefined()
  })

  it('"Use existing" selects the existing variety', async () => {
    fetchSpy.mockResolvedValueOnce([]) // mount
    fetchSpy.mockResolvedValueOnce([]) // debounce search
    const { onChange } = setup()
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Black Krim' } })
    await waitFor(() => {
      expect(fetchSpy.mock.calls.some(c => c[0] === '/api/varieties?q=Black%20Krim')).toBe(true)
    }, { timeout: 1000 })
    await waitFor(() => screen.getByText(/Create/))

    const conflictErr = new Error('Conflict')
    conflictErr.status = 409
    conflictErr.body = { existing: V1 }
    fetchSpy.mockRejectedValueOnce(conflictErr)

    const createRow = screen.getByText(/Create/).closest('li')
    await act(async () => { fireEvent.click(createRow) })
    await waitFor(() => screen.getByRole('dialog'), { timeout: 1500 })

    fireEvent.click(screen.getByText('Use existing'))
    expect(onChange).toHaveBeenCalledWith(V1)
  })

  it('"Create anyway" sends allow_duplicate=true', async () => {
    fetchSpy.mockResolvedValueOnce([]) // mount
    fetchSpy.mockResolvedValueOnce([]) // debounce search
    setup()
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Black Krim' } })
    await waitFor(() => {
      expect(fetchSpy.mock.calls.some(c => c[0] === '/api/varieties?q=Black%20Krim')).toBe(true)
    }, { timeout: 1000 })
    await waitFor(() => screen.getByText(/Create/))

    const conflictErr = new Error('Conflict')
    conflictErr.status = 409
    conflictErr.body = { existing: V1 }
    fetchSpy.mockRejectedValueOnce(conflictErr)

    const createRow = screen.getByText(/Create/).closest('li')
    await act(async () => { fireEvent.click(createRow) })
    await waitFor(() => screen.getByRole('dialog'), { timeout: 1500 })

    const newDup = { ...V1, id: 'var-dup', name: 'Black Krim' }
    fetchSpy.mockResolvedValueOnce(newDup)

    await act(async () => {
      fireEvent.click(screen.getByText(/Create anyway/))
    })

    const dupCall = fetchSpy.mock.calls.find(
      c => c[0] === '/api/varieties' && c[1]?.method === 'POST'
        && JSON.parse(c[1].body).allow_duplicate === true
    )
    expect(dupCall).toBeDefined()
  })

  it('Escape key closes the conflict modal', async () => {
    fetchSpy.mockResolvedValueOnce([]) // mount
    fetchSpy.mockResolvedValueOnce([]) // debounce search
    const { onChange } = setup()
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Black Krim' } })
    await waitFor(() => {
      expect(fetchSpy.mock.calls.some(c => c[0] === '/api/varieties?q=Black%20Krim')).toBe(true)
    }, { timeout: 1000 })
    await waitFor(() => screen.getByText(/Create/))

    const conflictErr = new Error('Conflict')
    conflictErr.status = 409
    conflictErr.body = { existing: V1 }
    fetchSpy.mockRejectedValueOnce(conflictErr)

    const createRow = screen.getByText(/Create/).closest('li')
    await act(async () => { fireEvent.click(createRow) })
    await waitFor(() => screen.getByRole('dialog'), { timeout: 1500 })

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('"Cancel" closes modal without onChange', async () => {
    fetchSpy.mockResolvedValueOnce([]) // mount
    fetchSpy.mockResolvedValueOnce([]) // debounce search
    const { onChange } = setup()
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Black Krim' } })
    await waitFor(() => {
      expect(fetchSpy.mock.calls.some(c => c[0] === '/api/varieties?q=Black%20Krim')).toBe(true)
    }, { timeout: 1000 })
    await waitFor(() => screen.getByText(/Create/))

    const conflictErr = new Error('Conflict')
    conflictErr.status = 409
    conflictErr.body = { existing: V1 }
    fetchSpy.mockRejectedValueOnce(conflictErr)

    const createRow = screen.getByText(/Create/).closest('li')
    await act(async () => { fireEvent.click(createRow) })
    await waitFor(() => screen.getByRole('dialog'), { timeout: 1500 })

    fireEvent.click(screen.getByText('Cancel'))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(onChange).not.toHaveBeenCalled()
  })
})

// ── Required state ──────────────────────────────────────────────────────────
describe('VarietyPicker — required', () => {
  it('sets aria-required on input', async () => {
    fetchSpy.mockResolvedValueOnce([])
    setup({ required: true })
    const input = screen.getByRole('combobox')
    expect(input.getAttribute('aria-required')).toBe('true')
  })

  it('shows blank error banner after blur with no value', async () => {
    fetchSpy.mockResolvedValueOnce([])
    setup({ required: true })
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.blur(input)
    // touched is set inside blur handler; banner shows on next render
    await waitFor(() => {
      expect(screen.getByText(/pick or create a variety/i)).toBeDefined()
    })
  })
})

// ── Keyboard nav ────────────────────────────────────────────────────────────
describe('VarietyPicker — keyboard', () => {
  it('ArrowDown then Enter selects the highlighted variety', async () => {
    fetchSpy.mockResolvedValueOnce([V1, V2])
    const { onChange } = setup()
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    await waitFor(() => screen.getByText('Black Krim'))

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    // highlight starts at 0 (Black Krim) on results render; arrow-down moves to 1
    expect(onChange).toHaveBeenCalledWith(V2)
  })

  it('Escape closes the dropdown', async () => {
    fetchSpy.mockResolvedValueOnce([V1])
    setup()
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    await waitFor(() => screen.getByText('Black Krim'))

    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull()
    })
  })
})

// ── V4-PLANTTYPE-001: crop-type create flow ──────────────────────────────────
describe('VarietyPicker — crop-type create (PLANTTYPE)', () => {
  const CROPS = [
    { slug: 'pepper', display_name: 'Pepper', default_lifecycle: 'tender_perennial', category: 'vegetable', sort_order: 0 },
    { slug: 'tomato', display_name: 'Tomato', default_lifecycle: 'tender_perennial', category: 'vegetable', sort_order: 0 },
  ]

  it('clicking Create opens the crop-type chooser; picking a crop POSTs crop_type_slug + lifecycle', async () => {
    fetchSpy.mockImplementation((path, opts) => {
      if (path === '/api/varieties/crop-types') return Promise.resolve(CROPS)
      if (opts?.method === 'POST') return Promise.resolve({ id: 'var-new', name: 'Mystery Pepper', crop_type_slug: 'pepper' })
      return Promise.resolve([]) // list + debounce search
    })
    const { onChange } = setup()
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Mystery Pepper' } })
    await waitFor(() => screen.getByText(/Create/))

    // Commit to create → crop chooser appears (not an immediate POST).
    await act(async () => { fireEvent.click(screen.getByText(/Create/).closest('li')) })
    await waitFor(() => screen.getByText('Pepper'))
    expect(screen.getByText(/Crop type for/)).toBeDefined()
    expect(fetchSpy.mock.calls.some(c => c[1]?.method === 'POST')).toBe(false) // no POST yet

    // Pick Pepper → POST with crop_type_slug + derived lifecycle.
    await act(async () => { fireEvent.click(screen.getByText('Pepper').closest('li')) })
    await waitFor(() => expect(onChange).toHaveBeenCalled())

    const postCall = fetchSpy.mock.calls.find(c => c[0] === '/api/varieties' && c[1]?.method === 'POST')
    expect(postCall).toBeDefined()
    const body = JSON.parse(postCall[1].body)
    expect(body.name).toBe('Mystery Pepper')
    expect(body.crop_type_slug).toBe('pepper')
    expect(body.lifecycle).toBe('tender_perennial')
  })

  it('"No crop type" creates the variety without a crop_type_slug', async () => {
    fetchSpy.mockImplementation((path, opts) => {
      if (path === '/api/varieties/crop-types') return Promise.resolve(CROPS)
      if (opts?.method === 'POST') return Promise.resolve({ id: 'v2', name: 'Plain' })
      return Promise.resolve([])
    })
    const { onChange } = setup()
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Plain' } })
    await waitFor(() => screen.getByText(/Create/))
    await act(async () => { fireEvent.click(screen.getByText(/Create/).closest('li')) })
    await waitFor(() => screen.getByText(/No crop type/))
    await act(async () => { fireEvent.click(screen.getByText(/No crop type/).closest('li')) })
    await waitFor(() => expect(onChange).toHaveBeenCalled())

    const postCall = fetchSpy.mock.calls.find(c => c[0] === '/api/varieties' && c[1]?.method === 'POST')
    const body = JSON.parse(postCall[1].body)
    expect(body.crop_type_slug).toBeUndefined()
    expect(body.lifecycle).toBeUndefined()
  })

  it('falls back to direct create when the crop vocab is empty (graceful)', async () => {
    // No crop-types mock → vocab loads empty → clicking Create POSTs immediately (legacy path).
    fetchSpy.mockImplementation((path, opts) => {
      if (opts?.method === 'POST') return Promise.resolve({ id: 'v3', name: 'Direct' })
      return Promise.resolve([])
    })
    const { onChange } = setup()
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Direct' } })
    await waitFor(() => screen.getByText(/Create/))
    await act(async () => { fireEvent.click(screen.getByText(/Create/).closest('li')) })
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(screen.queryByText(/Crop type for/)).toBeNull()
  })
})

// ── V4-HARVESTCENTER-001: crop scoping + visible truncation ─────────────────
// The picker used to slice to a hard 50 with no indication, so with 398 live varieties the
// browse list silently died mid-alphabet (Dave, 2026-07-21). These lock in both fixes.
describe('VarietyPicker — cropSlugFilter + truncation notice', () => {
  const PEPPER = { id: 'p-1', name: 'Jalapeño', species: 'Capsicum annuum', crop_type_slug: 'pepper' }
  const PEPPER2 = { id: 'p-2', name: 'Habanero', species: 'Capsicum chinense', crop_type_slug: 'pepper' }
  const TOM = { id: 't-1', name: 'Black Krim', species: 'Solanum lycopersicum', crop_type_slug: 'tomato' }

  it('offers only the matching crop when cropSlugFilter is set', async () => {
    fetchSpy.mockResolvedValueOnce([PEPPER, PEPPER2, TOM])
    setup({ cropSlugFilter: 'pepper' })
    fireEvent.focus(screen.getByRole('combobox'))
    await waitFor(() => expect(screen.getByText('Jalapeño')).toBeDefined())
    expect(screen.getByText('Habanero')).toBeDefined()
    expect(screen.queryByText('Black Krim')).toBeNull()
  })

  it('shows every crop when cropSlugFilter is not set (other consumers unaffected)', async () => {
    fetchSpy.mockResolvedValueOnce([PEPPER, TOM])
    setup()
    fireEvent.focus(screen.getByRole('combobox'))
    await waitFor(() => expect(screen.getByText('Jalapeño')).toBeDefined())
    expect(screen.getByText('Black Krim')).toBeDefined()
  })

  it('tells the user when the list is capped instead of truncating silently', async () => {
    const many = Array.from({ length: 260 }, (_, i) => ({
      id: `v-${i}`, name: `Variety ${String(i).padStart(3, '0')}`, species: 'Capsicum annuum', crop_type_slug: 'pepper',
    }))
    fetchSpy.mockResolvedValueOnce(many)
    setup()
    fireEvent.focus(screen.getByRole('combobox'))
    await waitFor(() => expect(screen.getByText(/Showing 200 of 260/)).toBeDefined())
  })

  it('shows no truncation notice when everything fits', async () => {
    fetchSpy.mockResolvedValueOnce([PEPPER, TOM])
    setup()
    fireEvent.focus(screen.getByRole('combobox'))
    await waitFor(() => expect(screen.getByText('Jalapeño')).toBeDefined())
    expect(screen.queryByText(/Showing \d+ of/)).toBeNull()
  })
})

// ── V4-CROPTYPE-001: mint a crop type inline ────────────────────────────────
// Before this, stage 2 was a CLOSED vocabulary: a plant with no matching crop type could only be
// saved as "No crop type", which drops it out of every type-grouped view. These cover the new
// third stage and the server's steer-to-existing response.
describe('VarietyPicker — inline crop-type creation (CROPTYPE)', () => {
  const CROPS = [
    { slug: 'pepper', display_name: 'Pepper', default_lifecycle: 'tender_perennial', category: 'vegetable', sort_order: 0 },
    { slug: 'tomato', display_name: 'Tomato', default_lifecycle: 'tender_perennial', category: 'vegetable', sort_order: 0 },
  ]

  // Drive the picker to stage 2 (the crop chooser) for a brand-new variety name.
  async function toCropStage(name = 'Mahogany Splendor') {
    const utils = setup()
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: name } })
    await waitFor(() => screen.getByText(/Create/))
    await act(async () => { fireEvent.click(screen.getByText(/Create/).closest('li')) })
    await waitFor(() => screen.getByText('Pepper'))
    return utils
  }

  it('offers a "New crop type" row in the crop chooser', async () => {
    fetchSpy.mockImplementation((path) => {
      if (path === '/api/varieties/crop-types') return Promise.resolve(CROPS)
      return Promise.resolve([])
    })
    await toCropStage()
    expect(screen.getByText(/New crop type/)).toBeDefined()
  })

  it('creates the crop type then continues the variety create with the new slug', async () => {
    fetchSpy.mockImplementation((path, opts) => {
      if (path === '/api/varieties/crop-types' && opts?.method === 'POST') {
        return Promise.resolve({ slug: 'hibiscus', display_name: 'Hibiscus', default_lifecycle: 'tender_perennial', category: 'ornamental', sort_order: 0 })
      }
      if (path === '/api/varieties/crop-types') return Promise.resolve(CROPS)
      if (opts?.method === 'POST') return Promise.resolve({ id: 'var-new', name: 'Mahogany Splendor', crop_type_slug: 'hibiscus' })
      return Promise.resolve([])
    })
    const { onChange } = await toCropStage()

    await act(async () => { fireEvent.click(screen.getByText(/New crop type/).closest('li')) })
    const nameInput = await screen.findByLabelText('Name')
    fireEvent.change(nameInput, { target: { value: 'Hibiscus' } })
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'vegetable' } })
    fireEvent.change(screen.getByLabelText('Lifecycle'), { target: { value: 'tender_perennial' } })
    await act(async () => { fireEvent.click(screen.getByText('Create crop type')) })

    await waitFor(() => expect(onChange).toHaveBeenCalled())

    const cropPost = fetchSpy.mock.calls.find(c => c[0] === '/api/varieties/crop-types' && c[1]?.method === 'POST')
    expect(cropPost).toBeDefined()
    expect(JSON.parse(cropPost[1].body)).toMatchObject({
      display_name: 'Hibiscus', category: 'vegetable', default_lifecycle: 'tender_perennial',
    })

    // The variety create must carry the NEWLY created slug — creating the type but leaving the
    // variety untyped would reproduce the exact bug this feature fixes.
    const varPost = fetchSpy.mock.calls.find(c => c[0] === '/api/varieties' && c[1]?.method === 'POST')
    expect(JSON.parse(varPost[1].body).crop_type_slug).toBe('hibiscus')
  })

  it('does NOT prefill the crop-type name with the variety name', async () => {
    // "Mahogany Splendor" is the VARIETY; its crop type is "Hibiscus". Prefilling would push the
    // vocabulary toward one type per variety, which is the fragmentation the guard exists to stop.
    fetchSpy.mockImplementation((path) => {
      if (path === '/api/varieties/crop-types') return Promise.resolve(CROPS)
      return Promise.resolve([])
    })
    await toCropStage('Mahogany Splendor')
    await act(async () => { fireEvent.click(screen.getByText(/New crop type/).closest('li')) })
    expect((await screen.findByLabelText('Name')).value).toBe('')
  })

  it('surfaces the steer and adopts the existing type on confirm', async () => {
    const err = new Error('"Chili" is another name for the existing "Pepper" crop type')
    err.body = { reason: 'coupled_synonym', existing: { slug: 'pepper', display_name: 'Pepper', default_lifecycle: 'tender_perennial' } }
    fetchSpy.mockImplementation((path, opts) => {
      if (path === '/api/varieties/crop-types' && opts?.method === 'POST') return Promise.reject(err)
      if (path === '/api/varieties/crop-types') return Promise.resolve(CROPS)
      if (opts?.method === 'POST') return Promise.resolve({ id: 'var-new', name: 'Mahogany Splendor', crop_type_slug: 'pepper' })
      return Promise.resolve([])
    })
    const { onChange } = await toCropStage()
    await act(async () => { fireEvent.click(screen.getByText(/New crop type/).closest('li')) })
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Chili' } })
    await act(async () => { fireEvent.click(screen.getByText('Create crop type')) })

    // The steer is shown, and no variety has been created yet.
    await waitFor(() => screen.getByText(/another name for the existing/))
    expect(fetchSpy.mock.calls.some(c => c[0] === '/api/varieties' && c[1]?.method === 'POST')).toBe(false)

    // Adopting it continues the variety create with the EXISTING slug.
    await act(async () => { fireEvent.click(screen.getByText(/Use "Pepper"/)) })
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    const varPost = fetchSpy.mock.calls.find(c => c[0] === '/api/varieties' && c[1]?.method === 'POST')
    expect(JSON.parse(varPost[1].body).crop_type_slug).toBe('pepper')
  })

  it('Back returns to the crop chooser without creating anything', async () => {
    fetchSpy.mockImplementation((path) => {
      if (path === '/api/varieties/crop-types') return Promise.resolve(CROPS)
      return Promise.resolve([])
    })
    await toCropStage()
    await act(async () => { fireEvent.click(screen.getByText(/New crop type/).closest('li')) })
    await screen.findByLabelText('Name')
    await act(async () => { fireEvent.click(screen.getByText('Back')) })
    await waitFor(() => screen.getByText(/Crop type for/))
    expect(fetchSpy.mock.calls.some(c => c[1]?.method === 'POST')).toBe(false)
  })

  it('disables Create crop type until a name is entered', async () => {
    fetchSpy.mockImplementation((path) => {
      if (path === '/api/varieties/crop-types') return Promise.resolve(CROPS)
      return Promise.resolve([])
    })
    await toCropStage()
    await act(async () => { fireEvent.click(screen.getByText(/New crop type/).closest('li')) })
    const btn = await screen.findByText('Create crop type')
    expect(btn.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Hibiscus' } })
    expect(screen.getByText('Create crop type').disabled).toBe(false)
  })

  it('offers only categories already in the vocabulary', async () => {
    // Derived from live data, so the picker can never offer a category the server would reject.
    fetchSpy.mockImplementation((path) => {
      if (path === '/api/varieties/crop-types') {
        return Promise.resolve([...CROPS, { slug: 'rose', display_name: 'Rose', category: 'flower', sort_order: 0 }])
      }
      return Promise.resolve([])
    })
    await toCropStage()
    await act(async () => { fireEvent.click(screen.getByText(/New crop type/).closest('li')) })
    const sel = await screen.findByLabelText('Category')
    const values = Array.from(sel.options).map(o => o.value)
    expect(values).toEqual(['', 'flower', 'vegetable'])
  })
})
