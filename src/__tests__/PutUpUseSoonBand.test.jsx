// V4-HARVESTCENTER-001 (L10) — the Today "use soon" ambient card. Renders items with NEUTRAL framing
// (no loss-aversion, no "X days left" countdown), shows past_use_by as a distinct CALM tag, is hidden
// entirely when empty, and NEVER throws / surfaces an error on a fetch failure (supplementary glance).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const navigateMock = vi.fn()
const locationRef = { pathname: '/today' }
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useLocation: () => locationRef,
  Link: ({ children }) => <a>{children}</a>,
}))
const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }) }))

import PutUpUseSoonBand from '../components/PutUpUseSoonBand.jsx'

const useSoon = (items) => fetchMock.mockImplementation((url) =>
  Promise.resolve(url === '/api/preservation/use-soon' ? { items } : null))

beforeEach(() => { navigateMock.mockReset(); fetchMock.mockReset() })

describe('PutUpUseSoonBand — Today "use soon" ambient card (L10)', () => {
  it('renders items with neutral framing (no loss-aversion, no countdown)', async () => {
    useSoon([
      { id: 'a', crop_display_name: 'Tomato', quantity_value: 14, quantity_unit: 'bags', method: 'whole_freeze', storage_label: 'Garage freezer', use_by_status: 'use_soon' },
    ])
    render(<PutUpUseSoonBand />)
    await screen.findByText('Cook these next')
    expect(screen.getByText('Tomato')).toBeTruthy()
    // Neutral: no loss-aversion or countdown language anywhere in the card.
    const card = screen.getByRole('region', { name: /From your stores/i })
    expect(card.textContent).not.toMatch(/days left|don't let|rot|exp'?ing|hurry/i)
  })

  it('shows a past_use_by row as a distinct CALM "past date" tag (not an alarm)', async () => {
    useSoon([
      { id: 'b', crop_display_name: 'Beans', quantity_value: 4, quantity_unit: 'jars', method: 'can_pressure', storage_label: 'Pantry', use_by_status: 'past_use_by' },
    ])
    render(<PutUpUseSoonBand />)
    await screen.findByText('Beans')
    expect(screen.getByText('past date')).toBeTruthy()
  })

  it('is hidden entirely when there is nothing to use soon', async () => {
    useSoon([])
    const { container } = render(<PutUpUseSoonBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/preservation/use-soon'))
    expect(container.querySelector('section')).toBeNull()
  })

  it('swallows a fetch error — renders nothing, never throws', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    const { container } = render(<PutUpUseSoonBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/preservation/use-soon'))
    expect(container.querySelector('section')).toBeNull()
  })
})
