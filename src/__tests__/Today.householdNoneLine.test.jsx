// "No one else has care needs today." is a claim about the household's plans, so it may only print once
// the plan read has actually ANSWERED for the household. The read Lambda omits `household_plans` unless
// asked (lambda/daily-plan-read/index.js), so an envelope without the key says nothing about anyone else:
// the toggle was just turned on and the household request is still out, or a cold roster landed while
// the first plan request was in flight and its reload was dropped (BUG-TODAYHOUSEHOLDRELOADDROP-001).
// In either window the line used to print the false "nobody" for a round trip or more.
//
// No jest-dom (L-182): role/attr/text + toBe/toEqual/toBeTruthy/toBeNull only.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'

const { fetchMock, toastMock, getTokenMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
  getTokenMock: vi.fn(async () => 'tok'),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useLocation: () => ({ pathname: '/today' }),
  useNavigate: () => vi.fn(),
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: getTokenMock }) }))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => toastMock }))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({
  ...(await orig()),
  fetchNotificationPrefs: vi.fn(async () => null),
  saveTodaySkipped: vi.fn(async () => null),
}))

import Today from '../pages/Today.jsx'

const NONE = /No one else has care needs today/
const isPlan = (p) => typeof p === 'string' && /^\/api\/daily-plan(\?|$)/.test(p)
const planCalls = () => fetchMock.mock.calls.filter(c => isPlan(c[0])).map(c => c[0])
function envelope(household) {
  return {
    schema_version: 1, plan_date: '2026-09-28', generated_at: '2026-09-28T13:00:00Z', has_plan: true,
    plan: { hydrology: {}, rain_skipped: [], water_due: [], no_history: [], fertilize: [], pest: [], cold: [], dormant: [] },
    ...(household ? { household_plans: household.list } : null),
  }
}
const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve() }) }

let planWaiters, membersWaiters
beforeEach(() => {
  planWaiters = []; membersWaiters = []
  fetchMock.mockReset()
  fetchMock.mockImplementation((path) => {
    if (isPlan(path)) return new Promise(res => planWaiters.push(res))
    if (path === '/api/members') return new Promise(res => membersWaiters.push(res))
    return Promise.resolve([])
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const MEMBERS = { members: [{ id: 'jen', display_name: 'Jen Example' }] }

describe('the household\'s "No one else has care needs today." line', () => {
  it('a cold roster lands while the first plan request is out (its reload dropped): no "nobody" from an answer that never asked', async () => {
    localStorage.setItem('garden.today.showOthers', '1')
    render(<Today />)
    // The first plan request goes out before anyone else is known, so it does not ask for the household.
    await waitFor(() => expect(planCalls().length).toBe(1))
    expect(planCalls()[0]).toBe('/api/daily-plan')
    await waitFor(() => expect(membersWaiters.length > 0).toBe(true))
    await act(async () => { for (const r of membersWaiters.splice(0)) r(MEMBERS) })
    await settle()
    // That plan answers WITHOUT a household_plans key.
    await act(async () => { planWaiters.shift()(envelope(null)) })
    await settle()
    expect(screen.getByTestId('today-household-toggle').getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByText(NONE)).toBeNull()
  })

  it('the toggle turned on: nothing is claimed until the household answer lands, then its empty answer is', async () => {
    render(<Today />)
    await waitFor(() => expect(membersWaiters.length > 0).toBe(true))
    await act(async () => { for (const r of membersWaiters.splice(0)) r(MEMBERS) })
    await act(async () => { planWaiters.shift()(envelope(null)) })
    await settle()
    fireEvent.click(screen.getByTestId('today-household-toggle'))
    await waitFor(() => expect(planCalls().some(p => p.includes('include=household'))).toBe(true))
    await settle()
    expect(screen.queryByText(NONE)).toBeNull()
    // The household answer: nobody else has anything today. NOW the line is true.
    await act(async () => { planWaiters.shift()(envelope({ list: [] })) })
    await settle()
    await waitFor(() => expect(screen.queryByText(NONE)).toBeTruthy())
  })
})
