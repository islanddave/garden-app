// BD-008 / V4-HIDEREADYBAND-001 — Today's harvest surface is the WATCH band alone: HarvestReadyBand
// ("Due for a pick") is UNMOUNTED from Today (hidden, not deleted — the component and its unit
// suite survive intact, see the removal-site comment in Today.jsx). The composition pins here are
// re-anchored to HarvestWatchBand, and a dedicated test proves the ready band is genuinely
// unmounted: no region renders AND /api/events/harvest-ready is never fetched from Today — even
// with ready candidates wired, so "absent" can only mean "not mounted", never "empty".
//
// PANEL Q1 (harvest-panel-decisions-20260812.md) — Today's composition: the cultivation lead line
// is pinned ABOVE the harvest watch band (and above the daily-plan block), and it ships NOTHING
// when the engine yields no content — otherwise the demoted region ships as a blank strip on the
// app's highest-traffic route.
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
const WATCH = '/api/harvests/watch?limit=200'

// Would render inside HarvestReadyBand IF it were still mounted — the unmount test wires it on
// purpose so the band's absence is proof of the unmount, not of an empty candidate list.
const readyCand = {
  plant_id: 'p1', project_id: 'proj1', name: 'Wild Wineberry',
  harvest_habit: 'repeat', repeat_interval_days: 3, days_since_last_harvest: 7,
  harvest_season_start_doy: null, harvest_season_end_doy: null,
}

// No variety_ref -> the watch row degrades to basis-stated calendar text (§3.2) and the lazy
// colour-window chunk is never imported, keeping this composition suite fast and deterministic.
const watchCand = {
  plant_id: 'p-w1', project_id: 'proj-w', name: 'Yellow Brandywine',
  location_name: 'Hilltop bed 2', watching_since: '2026-08-04',
  basis: 'sown 118d ago; catalogue 95d from transplant', variety_ref: null,
}

function wire({ sowItems = [], ready = [], watch = [watchCand] } = {}) {
  fetchMock.mockImplementation((url) => {
    if (url === SOW) return Promise.resolve({ items: sowItems })
    if (url === READY) return Promise.resolve({ time_zone: 'America/New_York', et_doy: 202, candidates: ready })
    if (url === WATCH) return Promise.resolve({ candidates: watch, snoozed: [] })
    return Promise.resolve(null)
  })
}

beforeEach(() => {
  fetchMock.mockReset(); sessionStorage.clear()
  engineState.closing = []
  planState.current = { data: { has_plan: false, plan: null, plan_date: '2026-08-12' }, loading: false, error: null }
})

describe('Today composition (panel Q1, re-anchored post-BD-008)', () => {
  it('renders the cultivation lead line ABOVE the watch band and the plan block', async () => {
    engineState.closing = [{ candidate: { variety_name: 'Winter Density' }, action: 'direct_sow', daysLeft: 5 }]
    wire({ sowItems: [{ variety_name: 'Winter Density' }] })
    render(<Today />)

    const lead = await screen.findByTestId('cultivation-lead')
    const watch = await screen.findByRole('region', { name: /Worth checking soon/i })
    // The lead line precedes the watch band in document order — the render-order pin.
    expect(lead.compareDocumentPosition(watch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // ...and precedes the daily-plan block: it is the top of Today, not a band among bands.
    const planBlock = screen.getByText(/on its way/i)
    expect(lead.compareDocumentPosition(planBlock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Unlabelled: an imperative line, not a fourth headed section.
    expect(lead.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull()
    expect(lead.textContent).toMatch(/^Sow Winter Density by /)
  })

  it('ships NOTHING for the lead region when the engine yields no content', async () => {
    engineState.closing = []
    wire({ sowItems: [{ variety_name: 'X' }] })
    render(<Today />)
    await screen.findByRole('region', { name: /Worth checking soon/i })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(SOW))
    expect(screen.queryByTestId('cultivation-lead')).toBeNull()
  })

  it('the watch band keeps its panel heading and no denominator prose', async () => {
    wire()
    render(<Today />)
    const band = await screen.findByRole('region', { name: /Worth checking soon/i })
    expect(band.textContent).toMatch(/Worth checking soon/)
    expect(document.body.textContent).not.toMatch(/Showing \d+ of \d+/i)
  })

  // BD-008 / V4-HIDEREADYBAND-001 — the unmount pin. Ready candidates ARE wired: if the band were
  // still mounted it would fetch and render, so a null region + zero READY fetches is proof of the
  // unmount itself. Both halves matter — a region check alone would pass if the band merely
  // rendered empty while still burning a fetch on every Today load.
  it('mounts no HarvestReadyBand: no "Due for a pick" region and no harvest-ready fetch', async () => {
    wire({ ready: [readyCand] })
    render(<Today />)
    await screen.findByRole('region', { name: /Worth checking soon/i })
    expect(screen.queryByRole('region', { name: /Due for a pick/i })).toBeNull()
    expect(document.body.textContent).not.toMatch(/Due for a pick/i)
    expect(fetchMock.mock.calls.some(([u]) => u === READY)).toBe(false)
  })
})
