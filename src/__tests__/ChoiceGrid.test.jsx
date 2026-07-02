import React, { useState } from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ChoiceGrid from '../components/forms/ChoiceGrid.jsx'

const OPTS = [
  { value: 'tool', label: 'Tool', icon: '🔧', description: 'e.g. pruners' },
  { value: 'consumable', label: 'Consumable', icon: '🧪', description: 'e.g. fertilizer' },
]
function Harness({ layout }) {
  const [v, setV] = useState('')
  return <ChoiceGrid layout={layout} ariaLabel="Type" value={v} onChange={setV} options={OPTS} />
}

describe('ChoiceGrid', () => {
  it('renders a radiogroup with a radio per option and selects on click', () => {
    render(<Harness layout="grid" />)
    expect(screen.getByRole('radiogroup', { name: 'Type' })).toBeTruthy()
    const radios = screen.getAllByRole('radio')
    expect(radios.length).toBe(2)
    expect(radios[0].getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByText('Consumable'))
    expect(screen.getByText('Consumable').closest('[role="radio"]').getAttribute('aria-checked')).toBe('true')
  })

  it('surfaces error via aria-invalid', () => {
    const { container } = render(<ChoiceGrid ariaLabel="Type" value="" onChange={() => {}} options={OPTS} error="pick one" />)
    expect(container.querySelector('[role="radiogroup"]').getAttribute('aria-invalid')).toBe('true')
  })

  it('list layout renders descriptions', () => {
    render(<Harness layout="list" />)
    expect(screen.getByText('e.g. pruners')).toBeTruthy()
  })
})
