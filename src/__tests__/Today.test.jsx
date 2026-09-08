/**
 * src/__tests__/Today.test.jsx — DRG-TODAY-002 Today surface (Slice 7 CareNeeded child).
 * Mocks: useDailyPlan, react-router Link, useApiFetch, ToastContext (CareNeeded deps).
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const { planState, fetchMock, toastMock, getTokenMock } = vi.hoisted(() => ({
  planState: { current: null },
  fetchMock: vi.fn(async () => ({ id: 'ev' })),
  // V5-TODAYSHAPE-001 — this mock USED TO OMIT getToken while CareNeeded destructures it
  // (`const { fetch, getToken } = useApiFetch()`, CareNeeded.jsx) and hands it to
  // fetchNotificationPrefs.
  //
  // SCOPED DOWN 2026-09-08, because the first version of this comment overclaimed and the
  // overclaim is more interesting than the fix. It said the suite was "GREEN OVER A BROKEN
  // DEPENDENCY". Measured, the defect is LATENT, not active: fetchNotificationPrefs returns at
  // `if (!CRITTER_BASE) return null` (notificationPrefsClient.js:163), and VITE_API_CRITTERS is
  // absent from the env block in vitest.config.ts — so under unit test the function exits before
  // it ever reaches the `typeof getToken === 'function'` check, which is its SECOND branch, not
  // its first. Nothing was silently doing nothing here; nothing ran at all.
  //
  // The repair is still right — the mock should honour the contract its consumer destructures, and
  // the latent defect becomes an active one the moment that env var is set. But "a green suite over
  // a broken dependency" describes a bug this repo did not have, and a comment that overstates its
  // own finding is the thing that gets a real one dismissed later.
  // The durable assertion lives in Today.apiFetchContract.test.jsx; it guards the product contract,
  // NOT this mock. Deleting getToken from THIS object still leaves all four Today files green.
  getTokenMock: vi.fn(async () => 'harness-token'),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
}))

vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => planState.current }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  // V4-HARVESTCENTER-001: Today now composes <PutUpUseSoonBand/>, which reads location/navigate via
  // OverlayContext. The band self-fetches use-soon (mocked useApiFetch returns no items → renders null),
  // so these only need to exist, not carry real routing.
  useLocation: () => ({ pathname: '/today' }),
  useNavigate: () => vi.fn(),
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: getTokenMock }) }))
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

// V4-TODAYBASIS-001 — the care list is computed from the overnight batch but renders directly under
// WeatherWidget's live "Updated …" stamp, which reads as covering the whole screen. These pin the
// basis stamp on the actionable content.
describe('V4-TODAYBASIS-001: care-list basis time', () => {
  const planWith = (extra) => ({
    data: {
      has_plan: true, plan_date: '2026-06-17', ...extra,
      plan: {
        weather: { tonightLow: 50, highToday: 78, code: 3, hot: false },
        hydrology: { recent_precip_in: 0.05, tomorrow_precip_in: 0.1, tomorrow_pop: 10, rain_coming: false },
        water_due: [{ id: 'pl1', name: 'Bhut Jolokia', project: 'Peppers', project_id: 'pr1', overdue_by: 2, in_ground: false }],
        no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
      },
    },
    loading: false, error: null,
  })

  it('stamps the overnight basis time above the care list', () => {
    planState.current = planWith({ generated_at: '2026-06-17T06:00:00Z' })
    render(<Today />)
    expect(screen.getByText(/Plan from overnight/i)).toBeTruthy()
  })

  it('renders no stamp when the plan carries no generated_at (never invents a time)', () => {
    planState.current = planWith({})
    render(<Today />)
    expect(screen.queryByText(/Plan from overnight/i)).toBeNull()
  })

  it('renders no stamp for an unparseable generated_at', () => {
    planState.current = planWith({ generated_at: 'not-a-date' })
    render(<Today />)
    expect(screen.queryByText(/Plan from overnight/i)).toBeNull()
  })
})
