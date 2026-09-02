/**
 * src/__tests__/WeatherCueLine.test.jsx — V5-WXCALLOUTRENDER-001 + OPS-CUEINSTRUMENT-001.
 *
 * The three binding conditions of the render, asserted at the component and at the Today mount:
 *   (a) an impression row fires on every rendered cue, and on NO silent day;
 *   (b) heat/rain/wet render in check-form, freeze/cold stay imperative;
 *   (c) the line does not enter the gold/warn visual family.
 *
 * The Today-mount block matters as much as the unit block: (a) is an assertion about WIRING, and a
 * beacon that works in isolation while nothing mounts it is exactly the "test that cannot fail" this
 * instrument exists to prevent.
 */
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

import WeatherCueLine from '../components/today/WeatherCueLine.jsx'
import Today from '../pages/Today.jsx'
import { P } from '../lib/constants.js'
import { CUE_IMPRESSIONS_PATH } from '../lib/weatherCueImpressions.js'
import { WX_CUE_MODEL_VERSION, CHECK_CLAUSE } from '../lib/weatherCue.js'

const GEN = '2026-09-02T06:12:04.000Z'
const DAY = '2026-09-02'

// Engine-shaped callouts (lambda/daily-plan/engine.js computeCallout). weatherCue.test.js is what
// pins these against the REAL engine output; here they are inputs, so they are written literally.
const FREEZE = { icon: 'freeze', text: 'Freeze tonight (34°F) — cover or bring peppers & tomatoes in' }
const HEAT = { icon: 'heat', text: 'Hot day (91°F) — deep-water thirsty crops, shade if wilting' }
const RAIN = { icon: 'rain', text: '0.36" rain tomorrow — water containers today, let in-ground beds wait' }

const impressions = () => fetchMock.mock.calls.filter((c) => c[0] === CUE_IMPRESSIONS_PATH)
const lastBody = () => JSON.parse(impressions().at(-1)[1].body)

beforeEach(() => { fetchMock.mockClear(); planState.current = null; sessionStorage.clear() })

describe('(a) the impression fires on every rendered cue — and only on a rendered one', () => {
  it('writes one impression carrying the cue, the form, the model version and the run that produced it', () => {
    render(<WeatherCueLine callout={HEAT} generatedAt={GEN} planDate={DAY} />)

    expect(screen.getByTestId('weather-cue-line')).toBeTruthy()
    expect(impressions()).toHaveLength(1)
    expect(lastBody()).toEqual({
      cue: 'heat', form: 'check', model_version: WX_CUE_MODEL_VERSION, plan_generated_at: GEN,
    })
    // POST, and keepalive so the beacon survives the first tap after Today paints.
    expect(impressions()[0][1].method).toBe('POST')
    expect(impressions()[0][1].keepalive).toBe(true)
  })

  it('records the FORM it actually rendered in, not a constant', () => {
    render(<WeatherCueLine callout={FREEZE} generatedAt={GEN} planDate={DAY} />)
    expect(lastBody().form).toBe('imperative')
    expect(lastBody().cue).toBe('freeze')
  })

  it('a SILENT day renders nothing and writes NO impression', () => {
    const { container } = render(<WeatherCueLine callout={null} generatedAt={GEN} planDate={DAY} />)
    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('weather-cue-line')).toBeNull()
    expect(impressions()).toHaveLength(0)
  })

  it('a cue the reader DECLINES is also silent and also writes no impression', () => {
    // buildCueLine fails closed on a check-form cue whose engine copy lost the separator. The row
    // must follow the pixels: no line rendered means no exposure to record.
    const { container } = render(
      <WeatherCueLine callout={{ icon: 'heat', text: 'Hot day deep-water thirsty crops' }} planDate={DAY} />,
    )
    expect(container.firstChild).toBeNull()
    expect(impressions()).toHaveLength(0)
  })

  it('a re-render of the same cue does not re-bill it', () => {
    const { rerender } = render(<WeatherCueLine callout={HEAT} generatedAt={GEN} planDate={DAY} />)
    rerender(<WeatherCueLine callout={HEAT} generatedAt={GEN} planDate={DAY} />)
    rerender(<WeatherCueLine callout={{ ...HEAT }} generatedAt={GEN} planDate={DAY} />)
    expect(impressions()).toHaveLength(1)
  })

  it('a cue that CHANGES within the day is billed again — the day grain is the server\'s, not this ref\'s', () => {
    const { rerender } = render(<WeatherCueLine callout={RAIN} generatedAt={GEN} planDate={DAY} />)
    rerender(<WeatherCueLine callout={FREEZE} generatedAt={GEN} planDate={DAY} />)
    expect(impressions().map((c) => JSON.parse(c[1].body).cue)).toEqual(['rain', 'freeze'])
  })

  it('a telemetry failure is invisible to the render', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    render(<WeatherCueLine callout={RAIN} generatedAt={GEN} planDate={DAY} />)
    expect(screen.getByTestId('weather-cue-line')).toBeTruthy()
    await Promise.resolve()
  })
})

describe('(b) check-form for the imperative rules, imperative for freeze', () => {
  it('heat renders as a check, not a command', () => {
    render(<WeatherCueLine callout={HEAT} planDate={DAY} />)
    const el = screen.getByTestId('weather-cue-line')
    expect(el.dataset.cueForm).toBe('check')
    expect(el.textContent).toBe(`Hot day (91°F) — ${CHECK_CLAUSE.heat}`)
    expect(el.textContent).not.toMatch(/deep-water thirsty crops/)
  })

  it('rain renders as a check and keeps the engine\'s probability-weighted figure', () => {
    render(<WeatherCueLine callout={RAIN} planDate={DAY} />)
    const el = screen.getByTestId('weather-cue-line')
    expect(el.dataset.cueForm).toBe('check')
    expect(el.textContent).toBe(`0.36" rain tomorrow — ${CHECK_CLAUSE.rain}`)
  })

  it('freeze does NOT become a check — it keeps the engine sentence verbatim', () => {
    render(<WeatherCueLine callout={FREEZE} planDate={DAY} />)
    const el = screen.getByTestId('weather-cue-line')
    expect(el.dataset.cueForm).toBe('imperative')
    expect(el.textContent).toBe(FREEZE.text)
  })
})

describe('(c) it stays out of the gold/warn visual family', () => {
  const warnFamily = [P.warn, P.warnBorder, P.gold, P.statusInkGold, P.severityStaleBorder, P.alert, P.alertBorder]

  // jsdom SERIALISES every colour to rgb(), so a hex-only substring check over a style attribute
  // matches nothing and passes on any input whatsoever. Compare in both spellings — a guard on a
  // visual family that cannot see the family is worse than no guard, because it gets cited.
  const rgbOf = (hex) => {
    const [, r, g, b] = /^#(\w\w)(\w\w)(\w\w)$/.exec(hex)
    return `rgb(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)})`
  }
  const usesAnyWarnColour = (css) =>
    warnFamily.some((c) => css.toLowerCase().includes(c.toLowerCase()) || css.includes(rgbOf(c)))

  it('the colour guard can actually reject — a warn-family box trips it', () => {
    // Anti-vacuity: the assertions below are only meaningful if this predicate fires on the shape it
    // exists to forbid. StorageDeadlineAlert's own chrome, verbatim.
    const { container } = render(
      <div style={{ background: P.warn, border: `1px solid ${P.warnBorder}`, borderRadius: 10 }} />,
    )
    expect(usesAnyWarnColour(container.firstChild.getAttribute('style'))).toBe(true)
  })

  it.each([['freeze', FREEZE], ['heat', HEAT]])('%s carries no warn-family colour and no boxed card', (_n, callout) => {
    render(<WeatherCueLine callout={callout} planDate={DAY} />)
    const el = screen.getByTestId('weather-cue-line')
    expect(usesAnyWarnColour(el.getAttribute('style'))).toBe(false)
    // StorageDeadlineAlert's shape is background + full border + radius + a severity glyph. This is
    // a left rule and nothing else — see the component header for why a third warn item is the
    // failure mode on this screen.
    expect(el.style.background).toBe('')
    expect(el.style.border).toBe('')
    expect(el.style.borderRadius).toBe('')
    expect(el.style.borderLeft).toBe(`3px solid ${rgbOf(P.sage)}`)
    expect(el.querySelector('svg')).toBeNull()
  })

  it('is not an interrupt: no live region, no dialog, no alert role', () => {
    const { container } = render(<WeatherCueLine callout={FREEZE} planDate={DAY} />)
    expect(container.querySelector('[role="alert"],[role="dialog"],[role="status"],[aria-live]')).toBeNull()
  })
})

describe('the wiring — Today actually mounts it', () => {
  const planWith = (callout) => ({
    data: {
      has_plan: true, plan_date: DAY, generated_at: GEN,
      plan: {
        weather: { tonightLow: 34, highToday: 70, code: 3, hot: false, ...(callout ? { callout } : {}) },
        hydrology: { recent_precip_in: 0.05, tomorrow_precip_in: 0.0, tomorrow_pop: 0 },
        water_due: [], no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
      },
    },
    loading: false, error: null,
  })

  it('renders the cue on Today and bills the impression', () => {
    planState.current = planWith(FREEZE)
    render(<Today />)
    expect(screen.getByTestId('weather-cue-line').textContent).toBe(FREEZE.text)
    expect(impressions()).toHaveLength(1)
    expect(lastBody()).toEqual({
      cue: 'freeze', form: 'imperative', model_version: WX_CUE_MODEL_VERSION, plan_generated_at: GEN,
    })
  })

  it('renders nothing on Today, and bills nothing, when the engine was silent', () => {
    planState.current = planWith(null)
    render(<Today />)
    expect(screen.queryByTestId('weather-cue-line')).toBeNull()
    expect(impressions()).toHaveLength(0)
  })

  it('bills nothing when there is no plan at all', () => {
    planState.current = { data: { has_plan: false, plan: null, plan_date: DAY }, loading: false, error: null }
    render(<Today />)
    expect(screen.queryByTestId('weather-cue-line')).toBeNull()
    expect(impressions()).toHaveLength(0)
  })
})
