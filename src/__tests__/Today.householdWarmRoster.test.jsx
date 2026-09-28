// BUG-GARDENSPOTCREEP-001 — useMembers serves the household from the SWR store, and Today reads it: with the
// household toggle saved ON, Today asks /api/daily-plan to include the household only once it can see someone
// else in the roster (includeHousehold = showOthers && canShowOthers). A WARM store means the roster is there on
// Today's first render, so its FIRST plan request already asks for the household. That is what keeps a warm open
// clear of BUG-TODAYHOUSEHOLDRELOADDROP-001 (a cold roster landing while the first plan request is in flight flips
// includeHousehold, and useDailyPlan's in-flight guard drops the reload) — the cold race itself is Today's to fix
// and is not pinned here. A revalidate returning the same household must not flip it either: one plan request.
//
// The identity mock supplies a Clerk sub (`user`), which is what puts useCachedFetch in CACHED mode; without it the
// hook plain-fetches and nothing is ever warm. Mocks otherwise follow MAIN's QA probe for the race.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, act } from '@testing-library/react'

const { fetchMock, toastMock, getTokenMock, identity } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
  getTokenMock: vi.fn(async () => 'tok'),
  identity: { current: { user: { id: 'sub-A' }, profile: { id: 'sub-A' }, loading: false } },
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useLocation: () => ({ pathname: '/today' }),
  useNavigate: () => vi.fn(),
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: getTokenMock }) }))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => toastMock }))
vi.mock('../context/AuthContext.jsx', async (orig) => ({ ...(await orig()), useAuthOptional: () => identity.current }))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({
  ...(await orig()),
  fetchNotificationPrefs: vi.fn(async () => null),
  saveTodaySkipped: vi.fn(async () => null),
}))

import Today from '../pages/Today.jsx'
import * as cache from '../lib/dataCache.js'
import { IMAGE_LIST_CACHE_ENABLED } from '../lib/featureFlags.js'

const HOUSEHOLD = () => ({ members: [{ id: 'sub-A', display_name: 'Dave N' }, { id: 'jen', display_name: 'Jen Example' }] })
const planCalls = () => fetchMock.mock.calls.map((c) => c[0]).filter((p) => typeof p === 'string' && p.startsWith('/api/daily-plan'))
// What a plan request asked for, by its query — not by its exact string, so a harmless extra param (a date, a frost
// option) cannot turn this red; only `include=household` is the question here (rimpact-gardencreep #3).
const includesHousehold = (path) => new URL(path, 'http://x').searchParams.getAll('include').includes('household')

beforeEach(() => {
  cache.__resetDataCache()
  fetchMock.mockReset()
  // Plan requests stay open: the question is only what Today ASKED for.
  fetchMock.mockImplementation((path) => {
    if (typeof path === 'string' && path.startsWith('/api/daily-plan')) return new Promise(() => {})
    if (path === '/api/members') return Promise.resolve(HOUSEHOLD())
    return Promise.resolve([])
  })
  localStorage.clear()
  localStorage.setItem('garden.today.showOthers', '1')
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Today with the household already in the store (a warm open), toggle saved ON', () => {
  it('the flag under test is on, or the store is never warm and this pins nothing', () => {
    expect(IMAGE_LIST_CACHE_ENABLED).toBe(true)
  })

  it('its FIRST /api/daily-plan request asks for the household, and the roster\'s revalidate adds no second one', async () => {
    const key = cache.keyFor('sub-A', '/api/members')
    await cache.warm(key, () => Promise.resolve(HOUSEHOLD()))
    // Settled, not just answered: an entry still marked in flight would swallow the mount's revalidate.
    await waitFor(() => expect(cache.peek(key)).toMatchObject({ status: 'value', isValidating: false }))
    render(<Today />)
    await waitFor(() => expect(planCalls().length).toBeGreaterThan(0))
    expect(new URL(planCalls()[0], 'http://x').pathname).toBe('/api/daily-plan')
    expect(includesHousehold(planCalls()[0])).toBe(true)
    // The mount's revalidate of the roster lands (the same household): nothing flips, nothing is re-asked.
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === '/api/members')).toBe(true))
    await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
    expect(planCalls()).toHaveLength(1)
    expect(screen.getByTestId('today-page')).toBeTruthy()
  })
})
