// src/__tests__/plantForm.test.jsx
// Lane D / Phase E (E1) — unit tests for the unified <PlantForm/>. Verifies the union
// renders (core + status + collapsed planting-details), the project picker toggles on
// showProjectSelect, the legacy genus/species inputs are GONE, onChange emits field
// patches, and extraActions render in the button row.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('../components/VarietyPicker.jsx', () => ({
  default: ({ value }) => <div data-testid="variety-picker">{value ? value.name : 'EMPTY'}</div>,
}))

import PlantForm from '../components/forms/PlantForm.jsx'

const EMPTY = {
  name: '', quantity: '1', variety: null, notes: '', status: '',
  sown_at: '', sown_at_approx: false, qty_initial: '',
  source_type: '', source_ref: '', source_generation: '', lineage_note: '',
}

function setup(props = {}) {
  const onChange = vi.fn()
  const onSubmit = vi.fn(e => e.preventDefault())
  const utils = render(
    <PlantForm value={{ ...EMPTY, ...(props.value || {}) }} onChange={onChange} onSubmit={onSubmit}
      submitLabel="Add planting" idPrefix="t" {...props} />
  )
  return { onChange, onSubmit, ...utils }
}

describe('PlantForm (E1 unified)', () => {
  it('renders the core union fields', () => {
    setup()
    expect(document.getElementById('t-name')).toBeTruthy()
    expect(document.getElementById('t-qty')).toBeTruthy()
    expect(document.getElementById('t-status')).toBeTruthy()
    expect(document.getElementById('t-notes')).toBeTruthy()
    expect(screen.getByTestId('variety-picker')).toBeDefined()
  })

  it('has NO legacy genus/species inputs', () => {
    setup()
    expect(document.getElementById('t-genus')).toBeNull()
    expect(document.getElementById('t-species')).toBeNull()
    expect(screen.queryByText('Genus')).toBeNull()
    expect(screen.queryByText('Species')).toBeNull()
  })

  it('renders the collapsed planting-details disclosure with all provenance fields', () => {
    setup()
    expect(screen.getByTestId('planting-details')).toBeDefined()
    expect(document.getElementById('t-sown')).toBeTruthy()
    expect(screen.getByTestId('sown-at-approx')).toBeDefined()
    expect(document.getElementById('t-qtyinit')).toBeTruthy()
    expect(document.getElementById('t-source')).toBeTruthy()
    expect(document.getElementById('t-sref')).toBeTruthy()
    expect(document.getElementById('t-sgen')).toBeTruthy()
    expect(document.getElementById('t-lin')).toBeTruthy()
  })

  it('omits the project picker by default and renders it when showProjectSelect', () => {
    const { unmount } = setup()
    expect(document.getElementById('t-project')).toBeNull()
    unmount()
    setup({ showProjectSelect: true, projects: [{ id: 'p1', name: 'Spring 2026' }] })
    expect(document.getElementById('t-project')).toBeTruthy()
  })

  it('emits a field patch via onChange when a field changes', () => {
    const { onChange } = setup()
    fireEvent.change(document.getElementById('t-name'), { target: { value: 'Tomato' } })
    expect(onChange).toHaveBeenCalledWith({ name: 'Tomato' })
  })

  it('toggles sown_at_approx through onChange', () => {
    const { onChange } = setup()
    fireEvent.click(screen.getByTestId('sown-at-approx'))
    expect(onChange).toHaveBeenCalledWith({ sown_at_approx: true })
  })

  it('renders extraActions in the button row', () => {
    setup({ extraActions: <button type="button">Remove</button> })
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDefined()
  })

  it('exposes the source enum verbatim from the plants Lambda ALLOWED_SOURCE set', () => {
    setup()
    const sel = document.getElementById('t-source')
    const values = Array.from(sel.querySelectorAll('option')).map(o => o.value)
    expect(values).toEqual(['', 'seed_packet', 'nursery_transplant', 'division', 'volunteer', 'gift', 'saved_seed', 'cutting_taken', 'rescued', 'unknown'])
  })
})

describe('PlantForm — V3-PLANTLOC-001 location field', () => {
  it('renders a Location select when active locations are supplied and emits location_id on change', () => {
    const locations = [{ id: 'loc1', full_path: 'Stable Rack A', is_active: true }]
    const { onChange } = setup({ locations, detailsDefaultOpen: true })
    const sel = document.getElementById('t-loc')
    expect(sel).toBeTruthy()
    expect(screen.getByText('Stable Rack A')).toBeTruthy()
    fireEvent.change(sel, { target: { value: 'loc1' } })
    expect(onChange).toHaveBeenCalledWith({ location_id: 'loc1' })
  })
  it('hides the Location field when no locations are supplied', () => {
    setup({ locations: [], detailsDefaultOpen: true })
    expect(document.getElementById('t-loc')).toBeNull()
  })
})

describe('PlantForm — V3-SOLOCUP-001 container autofill', () => {
  it('selecting Solo cup autofills container_size to 0.5 qt when size is blank', () => {
    const { onChange } = setup({ value: { container_type: '', container_size: '' } })
    fireEvent.change(document.getElementById('t-ctype'), { target: { value: 'solo_cup' } })
    expect(onChange).toHaveBeenCalledWith({ container_type: 'solo_cup', container_size: '0.5 qt' })
  })
  it('selecting Solo cup does NOT overwrite an existing size', () => {
    const { onChange } = setup({ value: { container_type: '', container_size: '1 gal' } })
    fireEvent.change(document.getElementById('t-ctype'), { target: { value: 'solo_cup' } })
    expect(onChange).toHaveBeenCalledWith({ container_type: 'solo_cup' })
  })
  it('selecting a non-solo_cup type only patches container_type', () => {
    const { onChange } = setup({ value: { container_type: '', container_size: '' } })
    fireEvent.change(document.getElementById('t-ctype'), { target: { value: 'trough' } })
    expect(onChange).toHaveBeenCalledWith({ container_type: 'trough' })
  })
})
