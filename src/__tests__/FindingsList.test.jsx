import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import FindingsList from '../components/findings/FindingsList.jsx'

const f = (id, trend, decay, statement) => ({
  finding_id: id, trend, decay_state: decay, statement,
  confidence_band: 'low', confidence_basis: '', assertion_mode: 'ask', urgency_level: 'low',
})

describe('FindingsList', () => {
  it('shows an honest cold-start empty state when there are no findings', () => {
    render(<FindingsList findings={[]} />)
    expect(screen.getByTestId('findings-empty')).toBeTruthy()
    expect(screen.getByText(/Nothing needs attention/i)).toBeTruthy()
  })

  it('renders findings sorted by trend then decay (worsening+fresh first)', () => {
    render(<FindingsList findings={[
      f('a', 'improving', 'fresh', 'IMPROVING_ONE'),
      f('b', 'worsening', 'fresh', 'WORSENING_ONE'),
      f('c', 'steady', 'fresh', 'STEADY_ONE'),
    ]} />)
    const cards = screen.getAllByTestId('finding-card')
    expect(cards).toHaveLength(3)
    expect(cards[0].textContent).toContain('WORSENING_ONE')
    expect(cards[1].textContent).toContain('STEADY_ONE')
    expect(cards[2].textContent).toContain('IMPROVING_ONE')
  })
})
