import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import TreatmentDetails from '../components/TreatmentDetails.jsx'

const inv = [
  { id: 'i1', name: 'Deadbug', brand: 'Bonide', category: 'pest_control' },
  { id: 'i2', name: 'FoxFarm Grow Big', brand: 'FoxFarm', category: 'fertilizer' },
  { id: 'i3', name: 'Worm Castings', brand: 'Brut', category: 'amendment' },
]
const empty = { pest_target: '', product_id: '', product_text: '', category: '', amount: '' }

describe('TreatmentDetails (V4-TREATLOG-001)', () => {
  it('renders pest target + amount + the four category chips', () => {
    render(<TreatmentDetails value={empty} onChange={() => {}} inventory={inv} eventType="pest_treatment" />)
    expect(screen.getByLabelText(/Pest \/ disease treated/i)).toBeTruthy()
    expect(screen.getByLabelText(/Amount \/ strength/i)).toBeTruthy()
    for (const c of ['Pest / disease', 'Fertilizer', 'Amendment', 'Other'])
      expect(screen.getByRole('button', { name: c })).toBeTruthy()
  })
  it('lets you free-type a pest past the fixed list', () => {
    const onChange = vi.fn()
    render(<TreatmentDetails value={empty} onChange={onChange} inventory={inv} eventType="pest_treatment" />)
    fireEvent.change(screen.getByLabelText(/Pest \/ disease treated/i), { target: { value: 'Asiatic garden beetle' } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ pest_target: 'Asiatic garden beetle' }))
  })
  it('filters the product picker by the selected category', () => {
    render(<TreatmentDetails value={{ ...empty, category: 'fertilizer' }} onChange={() => {}} inventory={inv} eventType="pest_treatment" />)
    const sel = screen.getByLabelText(/Product \(from inventory\)/i)
    const opts = Array.from(sel.querySelectorAll('option')).map(o => o.textContent).join('|')
    expect(opts).toMatch(/FoxFarm Grow Big/)
    expect(opts).not.toMatch(/Deadbug/)
    expect(opts).not.toMatch(/Worm Castings/)
  })
  it('selecting a category chip reports that category', () => {
    const onChange = vi.fn()
    render(<TreatmentDetails value={empty} onChange={onChange} inventory={inv} eventType="doctored" />)
    fireEvent.click(screen.getByRole('button', { name: 'Amendment' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ category: 'amendment' }))
  })
})
