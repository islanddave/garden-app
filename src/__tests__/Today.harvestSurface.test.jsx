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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
const PLANTS = '/api/plants'

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

// V4-STORAGEDEADLINE-001 — a live sweet potato planting. The dataset's only sourced deadline opens
// 09-28, so this fixture is what makes "silent on 08-12" a real silence rather than an empty garden.
const sweetPotato = {
  id: 'p-sp1', name: 'Beauregard', status: 'vegetative',
  variety_ref: { id: 'v-sp', name: 'Beauregard', crop_type_slug: 'sweet_potato' },
}

function wire({ sowItems = [], ready = [], watch = [watchCand], plants = [] } = {}) {
  fetchMock.mockImplementation((url) => {
    if (url === SOW) return Promise.resolve({ items: sowItems })
    if (url === READY) return Promise.resolve({ time_zone: 'America/New_York', et_doy: 202, candidates: ready })
    if (url === WATCH) return Promise.resolve({ candidates: watch, snoozed: [] })
    if (url === PLANTS) return Promise.resolve(plants)
    return Promise.resolve(null)
  })
}

beforeEach(() => {
  fetchMock.mockReset(); sessionStorage.clear()
  engineState.closing = []
  planState.current = { data: { has_plan: false, plan: null, plan_date: '2026-08-12' }, loading: false, error: null }
})

describe('Today composition (panel Q1, re-anchored post-BD-008)', () => {
  // V4-SOWMOREMENU-001 (BD-067) — BOTH assertions in this pair are INVERTED from what they pinned
  // before, on Dave's own directive, and the inversion is the point of the row rather than a side
  // effect of it. He reported he could not find Sow Now at all; the two panel Q1 properties these
  // guarded — top-of-page placement, and rendering nothing when empty — are precisely what made
  // Today's only sow affordance both prime-real-estate AND absent on most days. Kept as inverted
  // pins rather than deleted so the reversal stays visible and cannot silently revert.
  it('renders the cultivation lead line BELOW the watch band and the plan block', async () => {
    engineState.closing = [{ candidate: { variety_name: 'Winter Density' }, action: 'direct_sow', daysLeft: 5 }]
    wire({ sowItems: [{ variety_name: 'Winter Density' }] })
    render(<Today />)

    const lead = await screen.findByTestId('cultivation-lead')
    const watch = await screen.findByRole('region', { name: /Worth checking soon/i })
    // The watch band now precedes the lead — Dave: "that doesn't need to be up there."
    expect(watch.compareDocumentPosition(lead) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // ...and so does the daily-plan block: it is a band among bands now, not the top of Today.
    const planBlock = screen.getByText(/on its way/i)
    expect(planBlock.compareDocumentPosition(lead) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Unlabelled: an imperative line, not a fourth headed section. UNCHANGED by the move.
    expect(lead.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull()
    expect(lead.textContent).toMatch(/^Sow Winter Density by /)
  })

  it('keeps a /sow door in the lead region when the engine yields no content', async () => {
    engineState.closing = []
    wire({ sowItems: [{ variety_name: 'X' }] })
    render(<Today />)
    await screen.findByRole('region', { name: /Worth checking soon/i })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(SOW))
    const lead = screen.getByTestId('cultivation-lead')
    expect(lead.getAttribute('href')).toBe('/sow')
    // Still invents no cue — the engine said nothing, so the row says only where it goes.
    expect(lead.textContent).toBe('Sow now')
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

// V4-STORAGEDEADLINE-001 — the storage-crop lift deadline, mounted as an OPERATIONAL ALERT rather
// than a band (Dave 2026-08-14, after unmounting HarvestReadyBand the day before for being a
// standing list he correctly ignored). Both halves are pinned here because both are the decision:
// it renders NOTHING when nothing is at risk, and when something IS at risk it sits at the very top
// of Today — above the cultivation lead, because a crop about to be lost outranks a sow window
// about to close.
//
// The system clock is pinned rather than the prop injected: Today mounts the component with no
// todayISO, so only a pinned clock proves what the USER's path renders. `shouldAdvanceTime` keeps
// findBy*/waitFor working under fake timers.
describe('Today composition — storage-deadline operational alert (V4-STORAGEDEADLINE-001)', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
  afterEach(() => { vi.useRealTimers() })

  it('renders NOTHING in August even with a live sweet potato planting wired', async () => {
    // Silence with the data present. If this ever goes non-null without the dataset changing,
    // someone widened the criteria to make the surface show something — which is the failure mode
    // the whole design exists to avoid.
    vi.setSystemTime(new Date(2026, 7, 12, 9, 0, 0))
    wire({ plants: [sweetPotato] })
    render(<Today />)
    await screen.findByRole('region', { name: /Worth checking soon/i })
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === PLANTS)).toBe(true))
    expect(screen.queryByTestId('storage-deadline-alert')).toBeNull()
  })

  it('speaks once the check window opens, ABOVE the cultivation lead line', async () => {
    vi.setSystemTime(new Date(2026, 9, 1, 9, 0, 0)) // 2026-10-01, inside the 09-28..10-10 window
    engineState.closing = [{ candidate: { variety_name: 'Winter Density' }, action: 'direct_sow', daysLeft: 5 }]
    wire({ plants: [sweetPotato], sowItems: [{ variety_name: 'Winter Density' }] })
    render(<Today />)

    const alert = await screen.findByTestId('storage-deadline-alert')
    expect(alert.textContent).toMatch(/Start checking sweet potatoes for lifting/)
    expect(alert.textContent).toMatch(/Beauregard/)

    const lead = await screen.findByTestId('cultivation-lead')
    expect(alert.compareDocumentPosition(lead) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // Ambient, not an interrupt: an in-flow note, never a dialog/alert overlay.
    expect(document.querySelector('[role="dialog"],[role="alertdialog"],[role="alert"]')).toBeNull()
  })

  it('says nothing about a crop the dataset deliberately left dateless (carrot)', async () => {
    vi.setSystemTime(new Date(2026, 9, 2, 9, 0, 0))
    wire({
      plants: [{
        id: 'p-c1', name: 'Napoli', status: 'vegetative',
        variety_ref: { id: 'v-c', name: 'Napoli', crop_type_slug: 'carrot' },
      }],
    })
    render(<Today />)
    await screen.findByRole('region', { name: /Worth checking soon/i })
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === PLANTS)).toBe(true))
    expect(screen.queryByTestId('storage-deadline-alert')).toBeNull()
  })
})
