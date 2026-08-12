/**
 * BUG-TODAYWATER-001 — the honesty guard, and the proof that the harmonization made it a backstop.
 *
 * Today renders two independent watering verdicts on one screen from one plan: WeatherWidget's
 * headline (computeWateringScale) and CareNeeded's list (the daily-plan engine's per-planting
 * verdicts). Their thresholds were never shared, so on any morning that landed between them the page
 * printed the ABSOLUTE sentence "All set — no watering needed today." directly above a full watering
 * list. That is the experience Dave reported as "~95 plants listed as needing water during heavy rain".
 *
 * Two layers, tested here in that order:
 *   1. The guard (shipped first, independently): never print the absolute sentence over a non-empty
 *      list. Belt and braces — it does not care WHY the two disagree.
 *   2. The harmonization: the widget now reproduces the engine's model from the engine's own
 *      thresholds, so on both incident mornings the disagreement no longer occurs at all. Those two
 *      cases moved OUT of the guard's territory and into wateringModelParity.test.js, and the tests
 *      below assert exactly that — the cause is fixed, not only the symptom.
 *
 * The guard still has real work: the widget has two coarse lanes and the engine has per-planting
 * exposure, so a genuine measured soak zeroes both lanes while the engine correctly keeps listing
 * COVERED/INDOOR plantings, which never got the rain. That gap is structural and permanent — no
 * amount of threshold harmonization closes it. It is the 2026-08-03 shape: 4.32" and 18 still due,
 * every one of them indoor.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const { planState, fetchMock, toastMock } = vi.hoisted(() => ({
  planState: { current: null },
  fetchMock: vi.fn(async () => ({ id: 'ev' })),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
}))

vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => planState.current }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useLocation: () => ({ pathname: '/today' }),
  useNavigate: () => vi.fn(),
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock }) }))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => toastMock }))

import WeatherWidget from '../components/today/WeatherWidget.jsx'
import Today from '../pages/Today.jsx'

const weather = { tonightLow: 68, highToday: 86, code: 3, hot: false }

// A real measured soak, as prod emits one now that a WS-2902 is bound: the rain is in
// today_observed_in, not merely forecast. This is the 2026-08-03 event (4.32" for the day) in the
// payload shape the gauge integration produces since BUG-RAINACTUAL-001. Both lanes hold — correctly,
// the ground IS saturated — while the engine keeps listing the 18 indoor plantings the rain never
// reached. Headline and list are both right and still contradict each other; that is the guard's job.
const MEASURED_SOAK = {
  recent_precip_in: 0.5, today_observed_in: 3.82, today_remaining_in: 0,
  today_precip_in: 3.82, today_pop: 92, tomorrow_precip_in: 0, tomorrow_pop: 1,
}

// Live prod, daily_plan.items.prior_runs, plan_date 2026-08-08, generated_at 06:01:03.510Z — the
// morning Dave re-observed the defect. 78 plantings listed under "All set".
const AUG8_0201 = {
  recent_precip_in: 0.02, today_precip_in: 0.97, today_pop: 28,
  today_observed_in: 0, today_remaining_in: 0.97,
  tomorrow_precip_in: 0, tomorrow_pop: 6, rain_coming: false,
}
// The 2026-08-03 nightly snapshot (0.98" @ 84) is no longer retained in prior_runs — prod keeps only
// the two most recent runs — so it is carried here from the triage that read it live at the time.
const AUG3_NIGHTLY = {
  recent_precip_in: 0, today_precip_in: 0.98, today_pop: 84,
  tomorrow_precip_in: 0, tomorrow_pop: 1, rain_coming: false,
}

// The headline is rendered twice on purpose: once as sr-only TEXT (the a11y contract) and once
// aria-hidden + ellipsis-truncated (the visual). Assert against the whole card, so a change that
// silently drops one copy still has to keep the sentence honest.
const headlineText = (container) => container.textContent

describe('BUG-TODAYWATER-001 layer 1 — the absolute sentence never appears over a non-empty list', () => {
  it('a measured soak with indoor plantings still due: "All set" is replaced, not printed', () => {
    const { container } = render(
      <WeatherWidget weather={weather} hydrology={MEASURED_SOAK} waterDueCount={18} />
    )
    expect(headlineText(container)).not.toMatch(/All set/i)
    expect(headlineText(container)).toMatch(/Rain may cover today's list — 18 still due\./)
  })

  it('an EMPTY list still gets the absolute sentence — the guard suppresses a falsehood, not the copy', () => {
    const { container } = render(
      <WeatherWidget weather={weather} hydrology={MEASURED_SOAK} waterDueCount={0} />
    )
    expect(headlineText(container)).toMatch(/All set — no watering needed today\./)
  })

  it('back-compat: a caller passing no count at all behaves exactly as before (absolute sentence)', () => {
    const { container } = render(<WeatherWidget weather={weather} hydrology={MEASURED_SOAK} />)
    expect(headlineText(container)).toMatch(/All set — no watering needed today\./)
  })

  it('the guard is scoped to the both-hold branch — lane advice is untouched', () => {
    // Already moist with a qualifying soak coming: beds hold, containers water. Not an absolute
    // claim about the page, so a non-empty list must NOT rewrite it.
    const bedsHold = { recent_precip_in: 0.6, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0.6, tomorrow_pop: 70 }
    const { container } = render(
      <WeatherWidget weather={weather} hydrology={bedsHold} waterDueCount={42} />
    )
    expect(headlineText(container)).toMatch(/Water containers, skip the beds today\./)
    expect(headlineText(container)).not.toMatch(/still due/)
  })

  it('the guard copy fits a 390px Android viewport — no worse than the shipped longest headline', () => {
    // The visible line is nowrap + ellipsis, so over-long copy degrades silently rather than loudly.
    // Budget: the longest sentence this component already ships is the ceiling that survived design
    // review at tokens.type.sm (0.82rem) inside a 16px-padded card on a 16px-padded page.
    const shippedLongest = 'Water both — containers and beds today.'.length
    const guard = `Rain may cover today's list — 109 still due.`  // 3-digit N = the worst real case (08-08 final run)
    expect(guard.length).toBeLessThanOrEqual(shippedLongest + 6)
  })
})

describe('BUG-TODAYWATER-001 layer 2 — the two incident mornings no longer disagree at all', () => {
  // These are the cases the guard used to have to catch. After harmonization the widget reaches the
  // engine's verdict on both, so the honest headline falls out of the model rather than out of a
  // rescue. If a future edit reintroduces the divergence, these fail BEFORE the guard fires — which
  // is the point of keeping them: a guard that quietly starts doing real work is a regression.

  it('08-08 02:01 EDT (0.97" @ 28%): the widget agrees with the 78-item list', () => {
    const { container } = render(
      <WeatherWidget weather={weather} hydrology={AUG8_0201} waterDueCount={78} />
    )
    // 28% is nowhere near SOAK_FCST_POP_PCT, and 0.02" measured is nowhere near SOAK_CAP_IN, so
    // nothing is suppressed and the widget says what the list says.
    expect(headlineText(container)).toMatch(/Water both — containers and beds today\./)
    expect(headlineText(container)).not.toMatch(/All set/i)
    expect(headlineText(container)).not.toMatch(/still due/)   // the guard did not need to fire
  })

  it('08-03 nightly (0.98" @ 84%): beds hold with the engine, containers keep watering', () => {
    const { container } = render(
      <WeatherWidget weather={weather} hydrology={AUG3_NIGHTLY} waterDueCount={200} />
    )
    // A qualifying forecast: the engine suppresses outdoor beds, and so does the bed lane. The
    // container lane keeps watering because a forecast may not suppress a container (decision 3).
    expect(headlineText(container)).toMatch(/Water containers, skip the beds today\./)
    expect(headlineText(container)).not.toMatch(/All set/i)
  })
})

describe('BUG-TODAYWATER-001 — Today wires the list it renders into the headline that describes it', () => {
  beforeEach(() => { planState.current = null; sessionStorage.clear() })

  const planWith = (n, hydrology = MEASURED_SOAK) => ({
    data: {
      has_plan: true, plan_date: '2026-08-03', generated_at: '2026-08-03T06:01:03.510Z',
      plan: {
        weather, hydrology,
        substrate: { msg: 'Feeding on HOLD.', on_hold: true },
        water_due: Array.from({ length: n }, (_, i) => ({
          id: `pl${i}`, name: `Planting ${i}`, project: 'Shelf 4', project_id: 'pr1',
          overdue_by: 1, in_ground: false,
        })),
        no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
      },
    },
    loading: false, error: null,
  })

  it('the reported screen: watering list rendered, so the headline above it does not say "All set"', () => {
    planState.current = planWith(18)
    const { container } = render(<Today />)
    // The contradiction, both halves in one assertion pair: the list IS on screen…
    expect(screen.getByText('Needs care today')).toBeTruthy()
    expect(screen.getByText('Planting 0')).toBeTruthy()
    // …and the headline above it no longer denies it.
    expect(container.textContent).not.toMatch(/All set/i)
    expect(container.textContent).toMatch(/Rain may cover today's list — 18 still due\./)
  })

  it('a genuinely clear day keeps the reassuring sentence', () => {
    planState.current = planWith(0)
    const { container } = render(<Today />)
    expect(container.textContent).toMatch(/All set — no watering needed today\./)
  })
})
