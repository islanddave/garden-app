// V4-PLANTPICKER-001 — PlantingSelect: the shared searchable planting combobox (spec §6.5 union).
// Locks the union behaviors so a call-site migration can't silently drop one: search fields,
// emptyMeaning tri-state, progressive scoping, out-of-scope retention, sown-order sort, wave
// labels, onDerive back-propagation, graceful load failure, disabled hint, visible truncation.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))

import PlantingSelect, { plantingWaveLabel } from '../components/forms/PlantingSelect.jsx'

const PLANTS = [
  { id: 'pl-1', name: 'Jalapeño', quantity: 3, variety_id: 'v-jal', project_name: 'Peppers 2026',
    variety_ref: { id: 'v-jal', name: 'Early Jalapeño', crop_type_slug: 'pepper' }, sown_at: '2026-03-01', succession_order: null },
  { id: 'pl-2', name: 'Zucchini', quantity: 1, variety_id: 'v-zuc', project_name: 'Squash Bed',
    variety_ref: { id: 'v-zuc', name: 'Dark Green', crop_type_slug: 'squash' }, sown_at: '2026-05-10', succession_order: 1 },
  { id: 'pl-3', name: 'Zucchini', quantity: 1, variety_id: 'v-zuc', project_name: 'Squash Bed',
    variety_ref: { id: 'v-zuc', name: 'Dark Green', crop_type_slug: 'squash' }, sown_at: '2026-06-20', succession_order: 2 },
  { id: 'pl-4', name: 'Basil', quantity: 6, variety_id: null, project_name: null,
    variety_ref: null, sown_at: null, succession_order: null },
]

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue([])
})

function openPicker() {
  const input = screen.getByRole('combobox')
  fireEvent.focus(input)
  return input
}

describe('PlantingSelect — controlled data mode', () => {
  it('renders all rows sorted by name on focus and never fetches', () => {
    render(<PlantingSelect plants={PLANTS} onChange={() => {}} />)
    openPicker()
    const opts = screen.getAllByRole('option')
    expect(opts.map(o => o.textContent)).toEqual([
      expect.stringContaining('Basil'),
      expect.stringContaining('Jalapeño'),
      expect.stringContaining('Zucchini'),
      expect.stringContaining('Zucchini'),
    ])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('searches by name, variety name, and project name', () => {
    render(<PlantingSelect plants={PLANTS} onChange={() => {}} />)
    const input = openPicker()
    fireEvent.change(input, { target: { value: 'jala' } })          // name
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.change(input, { target: { value: 'dark green' } })    // variety
    expect(screen.getAllByRole('option')).toHaveLength(2)
    fireEvent.change(input, { target: { value: 'squash bed' } })    // project
    expect(screen.getAllByRole('option')).toHaveLength(2)
    fireEvent.change(input, { target: { value: 'zzz-nothing' } })
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText(/No plantings match/)).toBeTruthy()
  })

  it('click select fires onChange(id, row), renders the chip, ✕ clears', () => {
    const onChange = vi.fn()
    const { rerender } = render(<PlantingSelect plants={PLANTS} value="" onChange={onChange} />)
    openPicker()
    fireEvent.click(screen.getByTestId('ps-opt-pl-1'))
    expect(onChange).toHaveBeenCalledWith('pl-1', expect.objectContaining({ id: 'pl-1' }))
    rerender(<PlantingSelect plants={PLANTS} value="pl-1" onChange={onChange} />)
    expect(screen.getByText(/Jalapeño ×3 — Early Jalapeño/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear planting selection' }))
    expect(onChange).toHaveBeenLastCalledWith('', null)
  })

  it('keyboard: highlight starts on row 0; ArrowDown + Enter selects the second row', () => {
    const onChange = vi.fn()
    render(<PlantingSelect plants={PLANTS} value="" onChange={onChange} />)
    const input = openPicker()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    // name-sorted: Basil(0), Jalapeño(1), ...
    expect(onChange).toHaveBeenCalledWith('pl-1', expect.objectContaining({ name: 'Jalapeño' }))
  })
})

describe('emptyMeaning tri-state (spec §6.5 — three incompatible empty states)', () => {
  it("defaults to 'unset' search placeholder", () => {
    render(<PlantingSelect plants={PLANTS} onChange={() => {}} />)
    expect(screen.getByPlaceholderText('Search plantings…')).toBeTruthy()
  })
  it("'none' = deliberately not tied to a planting (PutUp, load-bearing)", () => {
    render(<PlantingSelect plants={PLANTS} onChange={() => {}} emptyMeaning="none" />)
    expect(screen.getByPlaceholderText('— Not tied to a planting —')).toBeTruthy()
  })
  it("'project-level' = deliberate project-level attach (PhotoLibrary)", () => {
    render(<PlantingSelect plants={PLANTS} onChange={() => {}} emptyMeaning="project-level" />)
    expect(screen.getByPlaceholderText('— All plants (project level) —')).toBeTruthy()
  })
})

describe('progressive scoping + retention (PutUp contract)', () => {
  it('varietyId pins the list; cropSlug narrows it', () => {
    const { rerender } = render(<PlantingSelect plants={PLANTS} onChange={() => {}} varietyId="v-jal" />)
    openPicker()
    expect(screen.getAllByRole('option')).toHaveLength(1)
    rerender(<PlantingSelect plants={PLANTS} onChange={() => {}} cropSlug="squash" />)
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })

  it('retainOutOfScopeValue keeps an out-of-scope selection listed and chipped', () => {
    render(<PlantingSelect plants={PLANTS} value="pl-1" onChange={() => {}} cropSlug="squash" retainOutOfScopeValue />)
    // chip mode shows the out-of-scope selection rather than blanking it
    expect(screen.getByText(/Jalapeño/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    const opts = screen.getAllByRole('option')
    expect(opts[0].textContent).toContain('Jalapeño') // prepended, still selectable
    expect(opts).toHaveLength(3)
  })

  it('sort=sown orders by sown date with unsown last; labelFormat=wave labels waves', () => {
    render(<PlantingSelect plants={PLANTS} onChange={() => {}} sort="sown" labelFormat="wave" />)
    openPicker()
    const opts = screen.getAllByRole('option')
    expect(opts[0].textContent).toContain('Jalapeño')                 // Mar 1
    expect(opts[1].textContent).toContain('wave 1')                   // May 10
    expect(opts[2].textContent).toContain('wave 2')                   // Jun 20
    expect(opts[3].textContent).toContain('Basil')                    // no sown_at → last
  })

  it('onDerive back-propagates crop/variety from the selection', () => {
    const onDerive = vi.fn()
    render(<PlantingSelect plants={PLANTS} value="" onChange={() => {}} onDerive={onDerive} />)
    openPicker()
    fireEvent.click(screen.getByTestId('ps-opt-pl-2'))
    expect(onDerive).toHaveBeenCalledWith({
      crop_type_slug: 'squash',
      variety_id: 'v-zuc',
      variety: expect.objectContaining({ name: 'Dark Green' }),
    })
  })
})

describe('self-fetch mode', () => {
  it('fetches unscoped /api/plants by default', async () => {
    fetchMock.mockResolvedValue(PLANTS)
    render(<PlantingSelect onChange={() => {}} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/plants'))
    openPicker()
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(4))
  })

  it('scopeProjectId narrows the fetch', async () => {
    fetchMock.mockResolvedValue([])
    render(<PlantingSelect onChange={() => {}} scopeProjectId="proj-9" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/plants?project_id=proj-9'))
  })

  it('load failure is graceful: inline note + onLoadError, still non-fatal', async () => {
    const boom = new Error('nope')
    fetchMock.mockRejectedValue(boom)
    const onLoadError = vi.fn()
    render(<PlantingSelect onChange={() => {}} onLoadError={onLoadError} />)
    await waitFor(() => expect(onLoadError).toHaveBeenCalledWith(boom))
    openPicker()
    expect(screen.getByText(/Couldn’t load your plantings/)).toBeTruthy()
  })
})

describe('disabled / required / truncation', () => {
  it('disabled shows the WHY hint (P5: no silently disabled field)', () => {
    render(<PlantingSelect plants={PLANTS} onChange={() => {}} disabled disabledHint="— select a project first —" />)
    const input = screen.getByPlaceholderText('— select a project first —')
    expect(input.disabled).toBe(true)
  })

  it('required + touched blank shows an alert', () => {
    render(<PlantingSelect plants={PLANTS} value="" onChange={() => {}} required />)
    const input = openPicker()
    fireEvent.blur(input)
    expect(screen.getByRole('alert').textContent).toContain('Choose a planting')
    expect(input.getAttribute('aria-required')).toBe('true')
  })

  it('caps the listbox visibly, never silently (VarietyPicker precedent)', () => {
    const many = Array.from({ length: 205 }, (_, i) => ({
      id: `m-${i}`, name: `Plant ${String(i).padStart(3, '0')}`, quantity: 1, variety_ref: null, project_name: null,
    }))
    render(<PlantingSelect plants={many} onChange={() => {}} />)
    openPicker()
    expect(screen.getAllByRole('option')).toHaveLength(200)
    expect(screen.getByText(/\+5 more — keep typing to narrow\./)).toBeTruthy()
  })
})

describe('plantingWaveLabel export (PutUp provenance display re-uses it)', () => {
  it('labels waves with ordinal + sown date, falls back to bare name', () => {
    expect(plantingWaveLabel(PLANTS[2])).toMatch(/Zucchini — wave 2, sown/)
    expect(plantingWaveLabel(PLANTS[3])).toBe('Basil')
  })
})
