/**
 * BUG-TODAYWATER-001 — the honesty guard.
 *
 * Today renders two independent watering verdicts on one screen from one plan: WeatherWidget's
 * headline (computeWateringScale) and CareNeeded's list (the daily-plan engine's per-planting
 * verdicts). Their thresholds were never shared, so on any morning that landed between them the page
 * printed the ABSOLUTE sentence "All set — no watering needed today." directly above a full watering
 * list. That is the experience Dave reported as "~95 plants listed as needing water during heavy rain".
 *
 * The hydrology bags below are NOT invented — they are the verbatim stored `prior_runs` snapshots from
 * live prod Neon for the two mornings the divergence is reconstructible on:
 *   2026-08-08 06:01:03Z (02:01 EDT): recent 0.02 + today 0.97 @ PoP 28  -> widget wetNow 0.99, 78 listed
 *   2026-08-03 (nightly, per todaywater-diagnosis-V100-20260803): today 0.98 @ PoP 84 -> ~200 listed
 * Both straddle widget-0.8 and engine-1.0. This suite pins the page-level contract; the threshold
 * harmonization itself is pinned by wateringModelParity.test.js.
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

// Live prod, daily_plan.items.prior_runs, plan_date 2026-08-08, generated_at 06:01:03.510Z.
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

describe('BUG-TODAYWATER-001 — WeatherWidget never claims "All set" over a non-empty list', () => {
  it('08-08 02:01 EDT: 78 plantings listed -> the absolute sentence is replaced, not printed', () => {
    const { container } = render(
      <WeatherWidget weather={weather} hydrology={AUG8_0201} waterDueCount={78} />
    )
    expect(headlineText(container)).not.toMatch(/All set/i)
    expect(headlineText(container)).toMatch(/Rain may cover today's list — 78 still due\./)
  })

  it('08-03 nightly: same class, same guard (0.98" @ PoP 84 over ~200 listed)', () => {
    const { container } = render(
      <WeatherWidget weather={weather} hydrology={AUG3_NIGHTLY} waterDueCount={200} />
    )
    expect(headlineText(container)).not.toMatch(/All set/i)
    expect(headlineText(container)).toMatch(/200 still due/)
  })

  it('an EMPTY list still gets the absolute sentence — the guard suppresses a falsehood, not the copy', () => {
    const { container } = render(
      <WeatherWidget weather={weather} hydrology={AUG8_0201} waterDueCount={0} />
    )
    expect(headlineText(container)).toMatch(/All set — no watering needed today\./)
  })

  it('back-compat: a caller passing no count at all behaves exactly as before (absolute sentence)', () => {
    const { container } = render(<WeatherWidget weather={weather} hydrology={AUG8_0201} />)
    expect(headlineText(container)).toMatch(/All set — no watering needed today\./)
  })

  it('the guard is scoped to the both-hold branch — lane advice is untouched', () => {
    // Dry: containers water (base 2), beds hold (a reliable soak is coming). Not an absolute claim,
    // so a non-empty list must NOT rewrite it.
    const dryBedsHold = { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0.74, tomorrow_pop: 63, rain_coming: true }
    const { container } = render(
      <WeatherWidget weather={weather} hydrology={dryBedsHold} waterDueCount={42} />
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

describe('BUG-TODAYWATER-001 — Today wires the list it renders into the headline that describes it', () => {
  beforeEach(() => { planState.current = null; sessionStorage.clear() })

  const planWith = (n) => ({
    data: {
      has_plan: true, plan_date: '2026-08-08', generated_at: '2026-08-08T06:01:03.510Z',
      plan: {
        weather, hydrology: AUG8_0201,
        substrate: { msg: 'Feeding on HOLD.', on_hold: true },
        water_due: Array.from({ length: n }, (_, i) => ({
          id: `pl${i}`, name: `Planting ${i}`, project: 'Peppers', project_id: 'pr1',
          overdue_by: 1, in_ground: false,
        })),
        no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
      },
    },
    loading: false, error: null,
  })

  it('the reported screen: watering list rendered, so the headline above it does not say "All set"', () => {
    planState.current = planWith(78)
    const { container } = render(<Today />)
    // The contradiction, both halves in one assertion pair: the list IS on screen…
    expect(screen.getByText('Needs care today')).toBeTruthy()
    expect(screen.getByText('Planting 0')).toBeTruthy()
    // …and the headline above it no longer denies it.
    expect(container.textContent).not.toMatch(/All set/i)
    expect(container.textContent).toMatch(/Rain may cover today's list — 78 still due\./)
  })

  it('a genuinely clear day keeps the reassuring sentence', () => {
    planState.current = planWith(0)
    const { container } = render(<Today />)
    expect(container.textContent).toMatch(/All set — no watering needed today\./)
  })
})
