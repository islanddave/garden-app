/**
 * src/__tests__/Today.test.jsx — DRG-TODAY-002 Today surface (Slice 7 CareNeeded child).
 * Mocks: useDailyPlan, react-router Link, useApiFetch, ToastContext (CareNeeded deps).
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const { planState, fetchMock, toastMock } = vi.hoisted(() => ({
  planState: { current: null },
  fetchMock: vi.fn(async () => ({ id: 'ev' })),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
}))

vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => planState.current }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock }) }))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => toastMock }))

import Today from '../pages/Today.jsx'

beforeEach(() => { planState.current = null; sessionStorage.clear() })

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

  it('renders weather + substrate + the Care-Needed surface with a one-tap Log', () => {
    planState.current = {
      data: {
        has_plan: true, plan_date: '2026-06-17',
        plan: {
          weather: { tonightLow: 50, highToday: 78, code: 3, hot: false },
          hydrology: { recent_precip_in: 0.05, tomorrow_precip_in: 0.74, tomorrow_pop: 63, rain_coming: true },
          // V4-TODAYHOLD-001: an ACTIONABLE substrate note (on_hold=false) DOES render on Today.
          substrate: { msg: '2 planting(s) past the MG feed window — feed per recommendation.', on_hold: false },
          water_due: [{ id: 'pl1', name: 'Bhut Jolokia', project: 'Peppers', project_id: 'pr1', overdue_by: 2, in_ground: false }],
          no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
        },
      },
      loading: false, error: null,
    }
    render(<Today />)
    expect(screen.getByText(/past the MG feed window/)).toBeTruthy()
    expect(screen.getByText('Needs care today')).toBeTruthy()
    expect(screen.getByText('Bhut Jolokia')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Log Water for Bhut Jolokia/i })).toBeTruthy()
  })

  it('V4-TODAYHOLD-001: suppresses the non-actionable "Feeding on HOLD" explainer (on_hold), keeps the care list', () => {
    planState.current = {
      data: {
        has_plan: true, plan_date: '2026-06-17',
        plan: {
          weather: { tonightLow: 50, highToday: 78, code: 3, hot: false },
          hydrology: { recent_precip_in: 0.05, tomorrow_precip_in: 0.1, tomorrow_pop: 10, rain_coming: false },
          substrate: { msg: 'Feeding on HOLD — fresh MG mix is feeding everything.', on_hold: true },
          water_due: [{ id: 'pl1', name: 'Bhut Jolokia', project: 'Peppers', project_id: 'pr1', overdue_by: 2, in_ground: false }],
          no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
        },
      },
      loading: false, error: null,
    }
    render(<Today />)
    expect(screen.queryByText(/Feeding on HOLD/)).toBeNull()
    // the action surface is untouched
    expect(screen.getByText('Needs care today')).toBeTruthy()
    expect(screen.getByText('Bhut Jolokia')).toBeTruthy()
  })

  it('V3-TODAYDONE-001 parity: a done item does not surface', () => {
    planState.current = {
      data: {
        has_plan: true, plan_date: '2026-06-17',
        plan: {
          water_due: [
            { id: 'pl1', name: 'Bhut Jolokia', project: 'Peppers', project_id: 'pr1', overdue_by: 2, done: false },
            { id: 'pl2', name: 'Habanero', project: 'Peppers', project_id: 'pr1', overdue_by: 1, done: true },
          ],
          no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
        },
      },
      loading: false, error: null,
    }
    render(<Today />)
    expect(screen.getByText('Bhut Jolokia')).toBeTruthy()
    expect(screen.queryByText('Habanero')).toBeNull()
  })
})
