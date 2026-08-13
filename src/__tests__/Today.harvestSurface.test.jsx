// PANEL Q1 (harvest-panel-decisions-20260812.md) — Today's composition: the cultivation lead line
// is pinned ABOVE HarvestReadyBand (and above the daily-plan block), and it ships NOTHING when the
// engine yields no content — otherwise the demoted region ships as a blank strip on the app's
// highest-traffic route.
//
// The sow ENGINE is mocked here (a fixed window_closing bucket) so the composition pin cannot flake
// with the real calendar; the engine's own math is covered by CultivationLead.test.jsx and
// sowEngine.test.js against fixed dates.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const { planState, fetchMock, toastMock, engineState } = vi.hoisted(() => ({
  planState: { current: null },
  fetchMock: vi.fn(),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
  engineState: { closing: [] },
}))

vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => planState.current }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useLocation: () => ({ pathname: '/today' }),
  useNavigate: () => vi.fn(),
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock }) }))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => toastMock }))
vi.mock('../lib/sowEngine.js', () => ({ bucketize: () => ({ window_closing: engineState.closing }) }))

import Today from '../pages/Today.jsx'

const READY = '/api/events/harvest-ready'
const SOW = '/api/inventory-items/sow-candidates'

const readyCand = {
  plant_id: 'p1', project_id: 'proj1', name: 'Wild Wineberry',
  harvest_habit: 'repeat', repeat_interval_days: 3, days_since_last_harvest: 7,
  harvest_season_start_doy: null, harvest_season_end_doy: null,
}

function wire({ sowItems = [], ready = [] } = {}) {
  fetchMock.mockImplementation((url) => {
    if (url === SOW) return Promise.resolve({ items: sowItems })
    if (url === READY) return Promise.resolve({ time_zone: 'America/New_York', et_doy: 202, candidates: ready })
    return Promise.resolve(null)
  })
}

beforeEach(() => {
  fetchMock.mockReset(); sessionStorage.clear()
  engineState.closing = []
  planState.current = { data: { has_plan: false, plan: null, plan_date: '2026-08-12' }, loading: false, error: null }
})

describe('Today composition (panel Q1)', () => {
  it('renders the cultivation lead line ABOVE the shipped ready band and the plan block', async () => {
    engineState.closing = [{ candidate: { variety_name: 'Winter Density' }, action: 'direct_sow', daysLeft: 5 }]
    wire({ sowItems: [{ variety_name: 'Winter Density' }], ready: [readyCand] })
    render(<Today />)

    const lead = await screen.findByTestId('cultivation-lead')
    const ready = await screen.findByRole('region', { name: /Due for a pick/i })
    // The lead line precedes the ready band in document order — the render-order pin.
    expect(lead.compareDocumentPosition(ready) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // ...and precedes the daily-plan block: it is the top of Today, not a band among bands.
    const planBlock = screen.getByText(/on its way/i)
    expect(lead.compareDocumentPosition(planBlock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Unlabelled: an imperative line, not a fourth headed section.
    expect(lead.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull()
    expect(lead.textContent).toMatch(/^Sow Winter Density by /)
  })

  it('ships NOTHING for the lead region when the engine yields no content', async () => {
    engineState.closing = []
    wire({ sowItems: [{ variety_name: 'X' }], ready: [readyCand] })
    render(<Today />)
    await screen.findByRole('region', { name: /Due for a pick/i })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(SOW))
    expect(screen.queryByTestId('cultivation-lead')).toBeNull()
  })

  it('the two harvest sections keep their panel headings and no denominator prose', async () => {
    wire({ ready: [readyCand] })
    render(<Today />)
    const band = await screen.findByRole('region', { name: /Due for a pick/i })
    expect(band.textContent).toMatch(/Due for a pick/)
    expect(document.body.textContent).not.toMatch(/Showing \d+ of \d+/i)
  })
})
