// V5-LEAFWETNESS-001 — the foliar infection-window line, component + wiring.
//
// THE MOUNT IS ASSERTED BY RENDERING Today, NOT BY GREPPING IT. The sibling guard for the drought
// line (TodayDroughtMount.test.js) is a static source assertion, and says why: Today.jsx was owned by
// a concurrent session at the time. That constraint does not apply here, and by this codebase's own
// standard a source-text assertion is a discipline wearing a test's clothes — it passes against a
// component that is imported, rendered, and handed the wrong prop. FrostAlertLine.test.jsx already
// mounts Today with a plan-shaped payload; this file follows that, so the assertion that fails is the
// one that matters: the line did not reach the screen.
//
// This is the failure the project keeps hitting — DroughtLine shipped inert with three passing suites
// beneath it, because nothing in a unit suite fails when a component is merely never mounted.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const { planState, fetchMock, toastMock } = vi.hoisted(() => ({
  planState: { current: null },
  fetchMock: vi.fn(async () => ({ accepted: 1 })),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock }) }))
vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => planState.current }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useLocation: () => ({ pathname: '/today' }),
  useNavigate: () => vi.fn(),
}))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => toastMock }))

import LeafWetnessLine from '../components/today/LeafWetnessLine.jsx'
import { buildLeafWetnessLine } from '../lib/leafWetnessLine.js'
import Today from '../pages/Today.jsx'

const DAY = '2026-09-08'
const GEN = '2026-09-08T22:05:00.000Z'

// Engine-shaped payload (lambda/daily-plan/engine.js `leaf_wetness`).
const WET = (o = {}) => ({
  recent_wet_days: 2, ahead_wet_days: 0, recent_dates: ['2026-09-06', DAY], ahead_dates: [],
  wet_hours_min: 8, band_f: [59, 80], basis: 'modelled_precip_hours', ...o,
})

beforeEach(() => { planState.current = null })

describe('the sentence', () => {
  it('says how many days were wet and tells him to go and look', () => {
    render(<LeafWetnessLine plan={{ leaf_wetness: WET() }} />)
    const t = screen.getByTestId('leaf-wetness-line').textContent
    expect(t).toMatch(/2 days/)
    expect(t).toMatch(/8\+ modelled hours/)
    expect(t).toMatch(/scout/i)
  })

  it('speaks about the FORECAST when the wet days are ahead', () => {
    // The half no weather_daily-sourced cue could produce — that table has no future rows.
    render(<LeafWetnessLine plan={{ leaf_wetness: WET({ recent_wet_days: 0, recent_dates: [], ahead_wet_days: 2, ahead_dates: ['2026-09-09', '2026-09-11'] }) }} />)
    const t = screen.getByTestId('leaf-wetness-line').textContent
    expect(t).toMatch(/ahead/)
    expect(t).toMatch(/keep water off the foliage/i)
  })

  it('NEVER claims infection, only wetness — it ships unfalsifiable and must not pretend otherwise', () => {
    // loss_cause is populated on ONE plant in the whole database, so there is no observation record
    // to score this cue against. Language asserting disease would claim an accuracy nobody measured.
    // Each case is scoped to its OWN container. Rendering repeatedly into document.body and calling
    // .remove() between iterations tears the node out from under React and leaves the next
    // screen.getByTestId matching two elements — which is how this test first failed.
    for (const w of [WET(), WET({ recent_wet_days: 0, ahead_wet_days: 3 }), WET({ ahead_wet_days: 2 })]) {
      const { container } = render(<LeafWetnessLine plan={{ leaf_wetness: w }} />)
      const t = container.querySelector('[data-testid="leaf-wetness-line"]').textContent
      expect(t).not.toMatch(/blight|infect|disease|septoria|mildew|risk/i)
    }
  })

  it('says "modelled", because the count is a floor that misses dew entirely', () => {
    // precip_hours is Open-Meteo grid, not the on-site gauge, and dew dominates September leaf
    // wetness here — a clear cool night that is peak Septoria weather scores bone dry.
    const { container } = render(<LeafWetnessLine plan={{ leaf_wetness: WET() }} />)
    const el = container.querySelector('[data-testid="leaf-wetness-line"]')
    expect(el.textContent).toMatch(/modelled/)
    expect(el.getAttribute('data-wet-basis')).toBe('modelled_precip_hours')
  })

  it('never puts an hours count beside a rainfall depth', () => {
    // The two instruments contradict on real days (2026-09-02: gauge 1.12 in over 0 modelled hours).
    const { container } = render(<LeafWetnessLine plan={{ leaf_wetness: WET(), hydrology: { recent_precip_in: 1.12 } }} />)
    expect(container.querySelector('[data-testid="leaf-wetness-line"]').textContent).not.toMatch(/\bin\b of rain|inches/i)
  })
})

describe('silence', () => {
  it('renders nothing when the key is absent — 77% of days', () => {
    const { container } = render(<LeafWetnessLine plan={{}} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when the engine emitted an empty shape', () => {
    const { container } = render(<LeafWetnessLine plan={{ leaf_wetness: WET({ recent_wet_days: 0, ahead_wet_days: 0 }) }} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing on a null plan, rather than throwing', () => {
    const { container } = render(<LeafWetnessLine plan={null} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('the builder rejects payloads it cannot honestly render', () => {
  it('returns null for a non-object', () => {
    expect(buildLeafWetnessLine(null)).toBeNull()
    expect(buildLeafWetnessLine({ leaf_wetness: 'wet' })).toBeNull()
  })

  it('ignores negative or non-numeric counts rather than printing them', () => {
    expect(buildLeafWetnessLine({ leaf_wetness: WET({ recent_wet_days: -3, ahead_wet_days: 0 }) })).toBeNull()
    expect(buildLeafWetnessLine({ leaf_wetness: WET({ recent_wet_days: 'two', ahead_wet_days: 0 }) })).toBeNull()
  })
})

describe('the wiring — Today actually mounts it', () => {
  const planWith = (leafWetness) => ({
    data: {
      has_plan: true, plan_date: DAY, generated_at: GEN,
      plan: {
        weather: { tonightLow: 55, highToday: 74, code: 3, hot: false },
        hydrology: { recent_precip_in: 0.05, tomorrow_precip_in: 0.0, tomorrow_pop: 0 },
        water_due: [], no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
        ...(leafWetness ? { leaf_wetness: leafWetness } : {}),
      },
    },
    loading: false, error: null,
  })

  it('renders the line on Today from plan.leaf_wetness', () => {
    // THE ASSERTION THAT MATTERS. Deleting the <LeafWetnessLine> element from Today.jsx, or handing
    // it the wrong prop, reddens this and nothing else in the suite.
    planState.current = planWith(WET())
    render(<Today />)
    expect(screen.getByTestId('leaf-wetness-line').textContent).toMatch(/scout/i)
  })

  it('renders nothing on Today when the key is absent entirely', () => {
    planState.current = planWith(null)
    render(<Today />)
    expect(screen.queryByTestId('leaf-wetness-line')).toBeNull()
  })
})
