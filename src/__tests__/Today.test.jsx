/**
 * src/__tests__/Today.test.jsx — DRG-TODAY-002 Today surface.
 * Mocks:
 *   - useDailyPlan -> controlled { data, loading, error }
 *   - react-router-dom Link -> plain anchor (PlanBuckets deep-links)
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const { planState } = vi.hoisted(() => ({ planState: { current: null } }))

vi.mock('../hooks/useDailyPlan.js', () => ({
  useDailyPlan: () => planState.current,
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

import Today from '../pages/Today.jsx'

beforeEach(() => { planState.current = null })

describe('Today surface', () => {
  it('shows the loading state', () => {
    planState.current = { data: null, loading: true, error: null }
    render(<Today />)
    expect(screen.getByText(/Loading/i)).toBeTruthy()
  })

  it('surfaces a fetch error', () => {
    planState.current = { data: null, loading: false, error: 'Failed to load your plan' }
    render(<Today />)
    expect(screen.getByText('Failed to load your plan')).toBeTruthy()
  })

  it('renders the honest "on its way" state when no plan exists yet (engine dormant)', () => {
    planState.current = { data: { has_plan: false, plan: null, plan_date: '2026-06-17' }, loading: false, error: null }
    render(<Today />)
    expect(screen.getByText(/on its way/i)).toBeTruthy()
  })

  it('renders weather + collapsed buckets and expands to a deep-link', () => {
    planState.current = {
      data: {
        has_plan: true,
        plan_date: '2026-06-17',
        plan: {
          weather: { tonightLow: 50, highToday: 78, code: 3, hot: false },
          hydrology: { recent_precip_in: 0.05, tomorrow_precip_in: 0.74, tomorrow_pop: 63, rain_coming: true },
          substrate: { msg: 'Feeding on HOLD — fresh MG mix is feeding everything.' },
          water_due: [{ id: 'pl1', name: 'Bhut Jolokia', project: 'Peppers', project_id: 'pr1', overdue_by: 2 }],
          no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
        },
      },
      loading: false, error: null,
    }
    render(<Today />)
    // substrate note + bucket header present; rows hidden until expanded (collapsed by default)
    expect(screen.getByText(/Feeding on HOLD/)).toBeTruthy()
    const waterBtn = screen.getByRole('button', { name: /Water/i })
    expect(screen.queryByText('Bhut Jolokia')).toBeNull()
    fireEvent.click(waterBtn)
    const link = screen.getByText('Bhut Jolokia').closest('a')
    expect(link.getAttribute('href')).toBe('/projects/pr1/plantings/pl1')
    expect(screen.getByText(/2d overdue/)).toBeTruthy()
  })
})
