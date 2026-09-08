// BUG-FROSTALERTNOAPP-001 — the render, and the WIRING.
//
// THE WIRING BLOCK IS THE POINT OF THIS FILE, not a formality on top of the unit tests. The pure
// builder is covered exhaustively in frostAlertLine.test.js; what those cannot catch is the failure
// this feature is most likely to have, which is being mounted with the wrong prop path and rendering
// nothing forever while every test stays green. `alerts_sent` lives on the stored daily_plan.items
// payload, which daily-plan-read returns verbatim as `plan` — so the prop is `plan.alerts_sent`, and
// a test that only ever hands the component an array directly would pass identically if Today read
// `data.items.alerts_sent`, `plan.alertsSent`, or nothing at all.
//
// So the Today-mount cases below feed a PLAN-SHAPED payload and assert on what Today renders. That
// is the assertion that fails if the prop path is wrong.
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

import FrostAlertLine from '../components/today/FrostAlertLine.jsx'
import Today from '../pages/Today.jsx'
import { P } from '../lib/constants.js'

const GEN = '2026-09-07T22:05:00.000Z'
const DAY = '2026-09-07'

// Handler-shaped entry (lambda/daily-plan/handler.js, alertsSent push + frostWeatherFacts).
const ADVISORY = {
  key: 'sp1|2026-09-07|advisory|advisory|d0ew9',
  tier: 'advisory', level: 'advisory',
  at: '2026-09-07T23:27:07.892Z',
  lowF: 38, dayOffset: 1, date: '2026-09-08',
}

beforeEach(() => { fetchMock.mockClear(); planState.current = null })

describe('the render', () => {
  it('states the night and the temperature', () => {
    render(<FrostAlertLine alertsSent={[ADVISORY]} />)
    const el = screen.getByTestId('frost-alert-line')
    expect(el.textContent).toBe('Frost possible tomorrow night — low 38°F. Plan cover for tender plants.')
    expect(el.dataset.frostTier).toBe('advisory')
    expect(el.dataset.frostDayOffset).toBe('1')
  })

  it('renders nothing at all — not an empty strip — when there is no advisory', () => {
    const { container } = render(<FrostAlertLine alertsSent={[]} />)
    expect(container.innerHTML).toBe('')
    expect(screen.queryByTestId('frost-alert-line')).toBeNull()
  })

  // jsdom SERIALISES colours to rgb(), so a hex-only substring check over a style attribute matches
  // nothing and passes on ANY input — the trap WeatherCueLine.test.jsx documents. Compare in both
  // spellings, and prove the guard can reject before trusting that it accepts.
  const rgbOf = (hex) => {
    const [, r, g, b] = /^#(\w\w)(\w\w)(\w\w)$/.exec(hex)
    return `rgb(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)})`
  }
  const usesColour = (css, hex) =>
    css.toLowerCase().includes(hex.toLowerCase()) || css.includes(rgbOf(hex))

  it('stays OUT of the warn family, which its neighbour is guarded against by name', () => {
    render(<FrostAlertLine alertsSent={[ADVISORY]} />)
    const css = screen.getByTestId('frost-alert-line').getAttribute('style') || ''
    // The instrument must be able to SEE a colour before its absence means anything.
    expect(usesColour(`border-left: 3px solid ${P.sage}`, P.sage), 'colour check is blind').toBe(true)
    for (const c of [P.warn, P.warnBorder, P.gold, P.alert, P.alertBorder]) {
      expect(usesColour(css, c), `frost line reached for the warn family (${c})`).toBe(false)
    }
    expect(usesColour(css, P.sage)).toBe(true)
  })
})

describe('the wiring — Today mounts it from plan.alerts_sent', () => {
  const planWith = (alertsSent) => ({
    data: {
      has_plan: true, plan_date: DAY, generated_at: GEN,
      plan: {
        weather: { tonightLow: 55, highToday: 74, code: 3, hot: false },
        hydrology: { recent_precip_in: 0.05, tomorrow_precip_in: 0.0, tomorrow_pop: 0 },
        water_due: [], no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
        ...(alertsSent ? { alerts_sent: alertsSent } : {}),
      },
    },
    loading: false, error: null,
  })

  // THE REGRESSION CASE, and it is a real night. On 2026-09-07 the stored plan carried tonightLow 55
  // and NO callout — so the weather cue rendered nothing — while an advisory had been sent, because
  // a night inside the D1..D3 window was <= 40F. Before this component Today was silent on a night
  // Dave had already been texted about. tonightLow is 55 here for exactly that reason: it proves the
  // line does not depend on the cue, and that the two speak about different nights.
  it('renders the advisory on a night the weather cue is silent', () => {
    planState.current = planWith([ADVISORY])
    render(<Today />)
    expect(screen.getByTestId('frost-alert-line').textContent).toMatch(/low 38°F/)
    // The control: the cue really is silent on this payload, so the line above is not the cue.
    expect(screen.queryByTestId('weather-cue-line')).toBeNull()
  })

  it('renders nothing on Today when the day carries an empty alerts_sent', () => {
    // Both prod rows on 2026-09-08 looked exactly like this.
    planState.current = planWith([])
    render(<Today />)
    expect(screen.queryByTestId('frost-alert-line')).toBeNull()
  })

  it('renders nothing on Today when the key is absent entirely', () => {
    planState.current = planWith(null)
    render(<Today />)
    expect(screen.queryByTestId('frost-alert-line')).toBeNull()
  })

  it('renders nothing when there is no plan at all', () => {
    planState.current = { data: { has_plan: false, plan: null, plan_date: DAY }, loading: false, error: null }
    render(<Today />)
    expect(screen.queryByTestId('frost-alert-line')).toBeNull()
  })
})
