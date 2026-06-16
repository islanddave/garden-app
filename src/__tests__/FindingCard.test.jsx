import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import FindingCard from '../components/findings/FindingCard.jsx'

const base = {
  finding_id: 'issue:1', statement: 'Manitoba (Tomatoes) likely needs water.',
  confidence_band: 'moderate', confidence_basis: 'one logged issue, no corroboration yet',
  assertion_mode: 'assert', decay_state: 'fresh', trend: 'worsening', urgency_level: 'low',
}

describe('FindingCard', () => {
  it('renders the engine statement as the headline', () => {
    render(<FindingCard finding={base} />)
    expect(screen.getByText(/Manitoba \(Tomatoes\) likely needs water\./)).toBeTruthy()
  })

  it('frames assert mode as a heads-up and ask mode as a question', () => {
    const { rerender } = render(<FindingCard finding={base} />)
    expect(screen.getByText('Heads-up')).toBeTruthy()
    rerender(<FindingCard finding={{ ...base, assertion_mode: 'ask' }} />)
    expect(screen.getByText('Question')).toBeTruthy()
  })

  it('shows confidence band + basis text', () => {
    render(<FindingCard finding={base} />)
    expect(screen.getByText('moderate confidence')).toBeTruthy()
    expect(screen.getByText(/one logged issue/)).toBeTruthy()
  })

  it('renders urgency only as a de-privileged labelled dot, never as text (C7)', () => {
    render(<FindingCard finding={base} />)
    expect(screen.getByLabelText('urgency: low')).toBeTruthy()
    expect(screen.queryByText(/urgency/i)).toBeNull()
  })
})
