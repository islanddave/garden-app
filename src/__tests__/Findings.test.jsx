// Slice 8 (V4-THEME-001) — DrG screen composition (reasoning + Health watch + ambient visitors).
// DRG-RESOLVE-001 — resolved findings split into a "Recently resolved" disclosure, out of active.
// No jest-dom (L-182). Mocks the data hooks + api + router Link + light children.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const { findingsState, planState, critterState } = vi.hoisted(() => ({
  findingsState: { current: { data: { findings: [] }, loading: false, error: null, reload: () => {} } },
  planState: { current: { data: null } },
  critterState: { current: { collected: new Map(), loading: false } },
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../hooks/useFindings.js', () => ({ useFindings: () => findingsState.current }))
vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => planState.current }))
vi.mock('../hooks/useCritterCollection.js', () => ({ useCritterCollection: () => critterState.current }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: vi.fn().mockResolvedValue({}) }) }))

import Findings from '../pages/Findings.jsx'

beforeEach(() => {
  findingsState.current = { data: { findings: [] }, loading: false, error: null, reload: () => {} }
  planState.current = { data: null, loading: false }
  critterState.current = { collected: new Map(), loading: false }
})

const f = (id, decay, statement) => ({
  finding_id: id, decay_state: decay, trend: decay === 'resolved' ? 'improving' : 'worsening',
  statement, assertion_mode: 'assert', confidence_band: 'low', confidence_basis: '', urgency_level: 'low',
})

describe('DrG screen (Findings)', () => {
  it('renders the header, honest sketch line, and the three real headings', () => {
    render(<Findings />)
    expect(screen.getByText('Doctor Gardener')).toBeTruthy()
    expect(screen.getByText(/learning your garden/i)).toBeTruthy()
    expect(screen.getByText('Why today looks like this')).toBeTruthy()
    expect(screen.getByText('Health watch')).toBeTruthy()
  })

  it('shows the honest no-plan reasoning state when there is no plan', () => {
    planState.current = { data: { has_plan: false, plan: null }, loading: false }
    render(<Findings />)
    expect(screen.getByText(/No plan yet for today/i)).toBeTruthy()
  })

  it('renders plan-backed reasoning lines when a plan exists', () => {
    planState.current = { data: { has_plan: true, plan: { weather: { highToday: 80, tonightLow: 58, hot: false }, counts: { plantings: 3, water_due: 2 }, rain_skipped: [] } }, loading: false }
    render(<Findings />)
    expect(screen.getByText(/3 plantings — 2 to water/)).toBeTruthy()
  })

  it('omits Garden visitors when the collection is empty', () => {
    render(<Findings />)
    expect(screen.queryByText(/Garden visitors/i)).toBeNull()
  })

  it('shows an ambient Garden visitors link when the collection has species', () => {
    critterState.current = { collected: new Map([['r1', { count: 2 }], ['r2', { count: 1 }]]), loading: false }
    render(<Findings />)
    const link = screen.getByText(/Garden visitors — 2 spotted/i).closest('a')
    expect(link.getAttribute('href')).toBe('/collection')
  })

  it('keeps active findings in Health watch and moves resolved ones into a Recently resolved disclosure', () => {
    findingsState.current = {
      data: { findings: [f('issue:a', 'fresh', 'ACTIVE_ONE'), f('issue:b', 'resolved', 'RESOLVED_ONE')] },
      loading: false, error: null, reload: () => {},
    }
    render(<Findings />)
    expect(screen.getByText('ACTIVE_ONE')).toBeTruthy()
    expect(screen.getByText(/Recently resolved \(1\)/)).toBeTruthy()
    expect(screen.getByText('RESOLVED_ONE')).toBeTruthy()
  })

  it('shows no Recently resolved disclosure when there are no resolved findings', () => {
    findingsState.current = {
      data: { findings: [f('issue:a', 'fresh', 'ACTIVE_ONE')] },
      loading: false, error: null, reload: () => {},
    }
    render(<Findings />)
    expect(screen.queryByText(/Recently resolved/i)).toBeNull()
  })
})
