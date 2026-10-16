// V5-LEAFWETNESS-001 — the foliar infection-window line, component + wiring.
//
// THE MOUNT IS ASSERTED BY RENDERING Today, NOT BY GREPPING IT. The sibling guard for the drought
// line (TodayDroughtMount.test.js) is a static source assertion. By this codebase's own standard a
// source-text assertion is a discipline wearing a test's clothes — it passes against a component that
// is imported, rendered, and handed the wrong prop — so this file mounts the page with a plan-shaped
// payload, and the assertion that fails is the one that matters: the line did not reach the screen.
// (V5-TODAYREDESIGN-001 S8c, L8: the page is the redesigned Today; the old page's mount went with it.)
//
// This is the failure the project keeps hitting — DroughtLine shipped inert with three passing suites
// beneath it, because nothing in a unit suite fails when a component is merely never mounted.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { planState, fetchMock, prefsState, auth } = vi.hoisted(() => ({
  planState: { current: null },
  fetchMock: vi.fn(async () => ({ accepted: 1 })),
  prefsState: { current: { prefs: null, prefsLoaded: true, refreshPrefs: async () => null } },
  auth: { user: { id: 'u' } },
}))
const api = vi.hoisted(() => ({ value: { fetch: (...a) => fetchMock(...a), getToken: async () => 't' } }))

vi.mock('../lib/api.js', async (orig) => ({ ...(await orig()), useApiFetch: () => api.value }))
vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => planState.current }))
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig()),
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../context/PrefsContext.jsx', () => ({ usePrefs: () => prefsState.current }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth }))
vi.mock('../hooks/useCachedFetch.js', () => ({ useCachedFetch: (path) => ({ data: path === '/api/plants' ? [] : { locations: [] }, loading: false, error: null }) }))
vi.mock('../components/today/v2/useTodayBands.js', () => ({
  useTodayBands: () => ({ settled: true, watch: { data: null, failed: false, reload() {} }, compose: { data: null, settled: true, reload() {} }, soon: { data: null, failed: false, reload() {} }, sow: { items: null, settled: true }, harvest: { present: false, summary: null }, putup: { present: false, summary: null } }),
}))

import LeafWetnessLine from '../components/today/LeafWetnessLine.jsx'
import { buildLeafWetnessLine } from '../lib/leafWetnessLine.js'
import TodayV2 from '../pages/TodayV2.jsx'
import GlanceCard from '../components/today/v2/GlanceCard.jsx'

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
    expect(t).toMatch(/water the soil, not the leaves/i)
  })

  // Today finish plan §3.2 (2026-10-14): the forecast half read "1 day ahead look like…". Every count agrees with
  // its verb, and the one wet day being the day after the plan's says "Tomorrow" — only when the date proves it.
  it('agrees with its count: "1 day ahead looks", "2 days ahead look", "1 more day ahead looks"', () => {
    const one = buildLeafWetnessLine({ leaf_wetness: WET({ recent_wet_days: 0, recent_dates: [], ahead_wet_days: 1, ahead_dates: ['2026-09-10'] }) }).text
    expect(one).toMatch(/^1 day ahead looks likely to bring 8\+ modelled hours of wet leaves/)
    expect(one).not.toMatch(/day ahead look /)
    const two = buildLeafWetnessLine({ leaf_wetness: WET({ recent_wet_days: 0, recent_dates: [], ahead_wet_days: 2, ahead_dates: ['2026-09-09', '2026-09-11'] }) }).text
    expect(two).toMatch(/^2 days ahead look likely/)
    const both = buildLeafWetnessLine({ leaf_wetness: WET({ ahead_wet_days: 1, ahead_dates: ['2026-09-09'] }) }).text
    expect(both).toMatch(/and 1 more day ahead looks the same/)
    expect(both).toMatch(/modelled/)
  })
  it('"Tomorrow:" only when the one wet day ahead is the day after the plan date — otherwise it counts', () => {
    const w = WET({ recent_wet_days: 0, recent_dates: [], ahead_wet_days: 1, ahead_dates: ['2026-09-09'] })
    expect(buildLeafWetnessLine({ leaf_wetness: w }, { planDate: DAY }).text)
      .toBe('Tomorrow: 8+ modelled hours of wet leaves likely — water the soil, not the leaves; cut basil today.')
    // Two days out, or no date to prove it: no "Tomorrow" claim.
    expect(buildLeafWetnessLine({ leaf_wetness: { ...w, ahead_dates: ['2026-09-10'] } }, { planDate: DAY }).text).not.toMatch(/Tomorrow/)
    expect(buildLeafWetnessLine({ leaf_wetness: w }).text).not.toMatch(/Tomorrow/)
    render(<LeafWetnessLine plan={{ leaf_wetness: w }} planDate={DAY} />)
    expect(screen.getByTestId('leaf-wetness-line').textContent).toMatch(/^Tomorrow: /)
  })

  it('NEVER claims infection, only wetness — it ships unfalsifiable and must not pretend otherwise', () => {
    // loss_cause is populated on ONE plant in the whole database, so there is no observation record
    // to score this cue against. Language asserting disease would claim an accuracy nobody measured.
    // Each case is scoped to its OWN container. Rendering repeatedly into document.body and calling
    // .remove() between iterations tears the node out from under React and leaves the next
    // screen.getByTestId matching two elements — which is how this test first failed.
    for (const w of [WET(), WET({ recent_wet_days: 0, ahead_wet_days: 3 }), WET({ ahead_wet_days: 2 }), WET({ recent_wet_days: 0, recent_dates: [], ahead_wet_days: 1, ahead_dates: ['2026-09-09'] })]) {
      const { container } = render(<LeafWetnessLine plan={{ leaf_wetness: w }} planDate={DAY} />)
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
    // Every sentence form keeps the word, the forecast ones included.
    for (const w of [WET({ recent_wet_days: 0, recent_dates: [], ahead_wet_days: 1, ahead_dates: ['2026-09-09'] }), WET({ recent_wet_days: 0, recent_dates: [], ahead_wet_days: 2 }), WET({ ahead_wet_days: 1 })]) {
      expect(buildLeafWetnessLine({ leaf_wetness: w }, { planDate: DAY }).text).toMatch(/modelled/)
    }
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

describe('the wiring — Today actually mounts it (behind the glance card\'s Details)', () => {
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
    loading: false, error: null, reload: vi.fn(),
  })
  const mountOpen = () => {
    render(<MemoryRouter><TodayV2 /></MemoryRouter>)
    fireEvent.click(screen.getByTestId('today-glance').querySelector('[aria-expanded]'))
  }

  it('renders the line on Today from plan.leaf_wetness', () => {
    // THE ASSERTION THAT MATTERS. Deleting the <LeafWetnessLine> element from GlanceCard.jsx, or the glance card
    // from TodayV2.jsx, or handing either the wrong prop, reddens this.
    localStorage.clear()
    planState.current = planWith(WET())
    mountOpen()
    expect(screen.getByTestId('leaf-wetness-line').textContent).toMatch(/scout/i)
  })

  it('renders nothing on Today when the key is absent entirely', () => {
    localStorage.clear()
    planState.current = planWith(null)
    mountOpen()
    expect(screen.getByTestId('today-weather')).toBeTruthy()   // the details did open — not vacuous
    expect(screen.queryByTestId('leaf-wetness-line')).toBeNull()
  })
})

// V5-TODAYREDESIGN-001 S3 — the redesigned Today mounts the line too: inside the glance card, behind its tap
// (plan-v2 §4 "Glance details", §13 MF2). The same render-level guard, pointed at the V2 mount (R3).
describe('the wiring — the V2 glance card mounts it, behind its tap', () => {
  const plan = (leafWetness) => ({
    weather: { tonightLow: 55, highToday: 74, code: 3, hot: false },
    hydrology: { recent_precip_in: 0.05, tomorrow_precip_in: 0.0, tomorrow_pop: 0 },
    water_due: [], no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
    ...(leafWetness ? { leaf_wetness: leafWetness } : {}),
  })
  const glance = (p, open) => render(<GlanceCard plan={p} generatedAt={GEN} planDate={DAY} open={open} onToggle={() => {}} />)

  it('renders the line from plan.leaf_wetness once the card is open', () => {
    glance(plan(WET()), true)
    expect(screen.getByTestId('leaf-wetness-line').textContent).toMatch(/scout/i)
  })
  it('not on the closed card (details on demand), and nothing when the key is absent', () => {
    const { unmount } = glance(plan(WET()), false)
    expect(screen.queryByTestId('leaf-wetness-line')).toBeNull()
    unmount()
    glance(plan(null), true)
    expect(screen.queryByTestId('leaf-wetness-line')).toBeNull()
  })
})
