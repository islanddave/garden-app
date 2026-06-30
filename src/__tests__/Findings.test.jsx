// Slice 8 (V4-THEME-001) — DrG screen composition (reasoning + Health watch + ambient visitors).
// No jest-dom (L-182). Mocks the three data hooks + router Link + FindingsList (kept light).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const { findingsState, planState, critterState } = vi.hoisted(() => ({
  findingsState: { current: { data: { findings: [] }, loading: false, error: null } },
  planState: { current: { data: null } },
  critterState: { current: { collected: new Map(), loading: false } },
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../hooks/useFindings.js', () => ({ useFindings: () => findingsState.current }))
vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => planState.current }))
vi.mock('../hooks/useCritterCollection.js', () => ({ useCritterCollection: () => critterState.current }))

import Findings from '../pages/Findings.jsx'

beforeEach(() => {
  findingsState.current = { data: { findings: [] }, loading: false, error: null }
  planState.current = { data: null, loading: false }
  critterState.current = { collected: new Map(), loading: false }
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
})
