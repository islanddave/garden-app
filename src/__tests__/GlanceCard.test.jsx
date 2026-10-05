// V5-TODAYREDESIGN-001 S3 — the redesigned Today's glance card (plan-v2 §4 "Glance card", §5.1–5.2; §13 MF2).
// Rendered over the gate's own busyfull payload (the real 2026-09-24 plan plus the real frost-watch, cue, leaf,
// rain and drought fragments, tests/harness/_todaymeasure), so the card is judged on the day it was drawn for.
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render as rtlRender, screen, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn(async () => ({ ok: true })) }))
vi.mock('../lib/api.js', async (orig) => ({ ...(await orig()), useApiFetch: () => ({ fetch: fetchMock }) }))

import GlanceCard from '../components/today/v2/GlanceCard.jsx'
import { agreedTonightLow, agreeCallout } from '../lib/tonightLow.js'
import { currentLows } from '../lib/frostAlertLine.js'
import { glanceRain } from '../lib/todayV2/verdict.js'

const fx = (f) => JSON.parse(readFileSync(resolve(process.cwd(), 'tests/harness/_todaymeasure', f), 'utf8'))
const D = fx('dailyplan.dave.json')
const G = fx('busyfull-grafts.json')
// todaymeasure.jsx's graftBusyfull, the fields the glance reads.
const BUSYFULL = {
  ...D.plan,
  alerts_sent: G.alerts_sent.value,
  weather: { ...D.plan.weather, callout: G.weather_callout.value },
  leaf_wetness: G.leaf_wetness.value,
  rain_skipped: G.rain_skipped.value,
  drought: G.drought.plan_level,
  dormancy_suppressed: D.plan.dormancy_suppressed.map((it) => ({ ...it, drought: G.drought.per_item })),
}
const QUIET = { ...D.plan, water_due: [], no_history: [], fertilize: [], pest: [], cold: [], alerts_sent: [], weather: { ...D.plan.weather, callout: null }, drought: undefined, leaf_wetness: undefined, rain_skipped: [] }

// The live overlay the gate's harness serves (its Open-Meteo stubs): 0.04″ @ 18% today, 0.22″ @ 60% tomorrow.
const LIVE = { today_precip_in: 0.04, today_pop: 18, tomorrow_precip_in: 0.22, tomorrow_pop: 60 }

function Harness({ plan = BUSYFULL, stale = null, initialOpen = false, liveHydrology = null }) {
  const [open, setOpen] = useState(initialOpen)
  const agreed = agreedTonightLow(plan)
  return (
    <GlanceCard plan={plan} generatedAt={D.generated_at} planDate={D.plan_date} liveHydrology={liveHydrology} agreed={agreed} current={currentLows(plan)}
      cueCallout={agreeCallout(plan.weather?.callout, agreed)} stale={stale} open={open} onToggle={() => setOpen((o) => !o)} />
  )
}
// The dry list links each planting, so the card lives under a router, as it does in the app.
const render = (ui) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>)
const glance = () => screen.getByTestId('today-glance')
const toggle = () => glance().querySelector('[aria-expanded]')
const impressions = () => fetchMock.mock.calls.filter(([p]) => String(p).includes('cue-impressions')).length
const bareTemps = (root) => [...root.querySelectorAll('*')].filter((el) => !el.children.length && /^-?\d+°$/.test((el.textContent || '').trim())).map((el) => el.textContent.trim())

beforeEach(() => { fetchMock.mockClear() })
afterEach(cleanup)

describe('closed — the first screen (D1)', () => {
  it('is closed by default: one disclosure button in an h2, no weather card mounted', () => {
    render(<Harness />)
    expect(toggle().tagName).toBe('BUTTON')
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(toggle().hasAttribute('aria-controls')).toBe(false)
    expect(toggle().closest('h2')).toBeTruthy()
    expect(screen.queryByTestId('today-weather')).toBeNull()
  })
  it('row A: the high and the ONE low for tonight (the frost line\'s agreed 42, not the plan\'s 47)', () => {
    render(<Harness />)
    expect(bareTemps(toggle())).toEqual(['65°', '42°'])
  })
  it('row B is the card\'s own rain sentences, verbatim — both days on one line', () => {
    render(<Harness liveHydrology={LIVE} />)
    const { rainNote, nextNote } = glanceRain({ hydrology: BUSYFULL.hydrology, liveHydrology: LIVE, generatedAt: D.generated_at, planDate: D.plan_date })
    expect([rainNote, nextNote]).toEqual(['0.04″ today · 18% chance', '0.22″ tomorrow · 60% chance'])
    for (const s of [rainNote, nextNote]) expect(toggle().textContent).toContain(s)
  })
  it('row B keeps its line when the rain line\'s gate is shut (nothing moves when it opens)', () => {
    render(<Harness />)
    expect(glanceRain({ hydrology: BUSYFULL.hydrology, generatedAt: D.generated_at, planDate: D.plan_date }).rainNote).toBeNull()
    expect(toggle().textContent).not.toMatch(/chance/)
  })
  it('row C: headline + at most one urgent phrase, in ONE visible wrapping element (no ellipsis, no sr-only twin)', () => {
    render(<Harness />)
    const v = screen.getByTestId('today-verdict')
    expect(v.textContent).toBe('Water both — containers and beds today. · frost watch tonight')
    expect(v.style.whiteSpace).not.toBe('nowrap')
    expect(v.style.textOverflow).toBe('')
    expect(v.style.overflow).toBe('')
    expect(v.style.minHeight).toBe('2.7em')
    expect(v.querySelectorAll('svg').length).toBe(1)
    // No second copy anywhere (the old card's sr-only + truncated pair).
    expect(screen.queryAllByText((_, el) => el?.textContent === v.textContent && el !== v && !el.contains(v))).toHaveLength(0)
  })
  it('the cue and the frost line sit INSIDE the closed card, in that order, under the button', () => {
    render(<Harness />)
    const cue = screen.getByTestId('weather-cue-line')
    const frost = screen.getByTestId('frost-alert-line')
    expect(glance().contains(cue) && glance().contains(frost)).toBe(true)
    expect(toggle().contains(cue)).toBe(false)
    expect(cue.compareDocumentPosition(frost) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
  it('the button\'s name carries the verdict (2.5.3) and starts "Weather"', () => {
    render(<Harness />)
    expect(toggle().textContent.startsWith('Weather: ')).toBe(true)
    expect(toggle().textContent).toContain('frost watch tonight')
  })
  it('a quiet day: the empty-list guard speaks, and no phrase', () => {
    render(<Harness plan={QUIET} />)
    expect(screen.getByTestId('today-verdict').textContent).toBe('Nothing due for watering today.')
    expect(screen.queryByTestId('weather-cue-line')).toBeNull()
  })
  // A never-watered planting is a "Water" row (no_history), and a plan with no water_due list is unknown:
  // neither may read as "nothing due", closed (the verdict) or open (the weather card's own headline).
  it('a never-watered row: the verdict does not say nothing is due, closed or open', () => {
    render(<Harness plan={{ ...QUIET, no_history: [{ id: 'nh1', name: 'New Basil' }] }} />)
    expect(screen.getByTestId('today-verdict').textContent).not.toBe('Nothing due for watering today.')
    expect(screen.getByTestId('today-verdict').textContent).toMatch(/^Water /)
    fireEvent.click(toggle())
    expect(screen.getByTestId('today-weather').textContent).not.toContain('Nothing due for watering today.')
  })
  it('a plan with no water_due list: unknown is not an all-clear, closed or open', () => {
    const { water_due: _gone, ...NO_LIST } = QUIET
    render(<Harness plan={NO_LIST} />)
    expect(screen.getByTestId('today-verdict').textContent).not.toBe('Nothing due for watering today.')
    expect(screen.getByTestId('today-verdict').textContent).toMatch(/^Water /)
    fireEvent.click(toggle())
    expect(screen.getByTestId('today-weather').textContent).not.toContain('Nothing due for watering today.')
  })
  it('the stale marker only when the page says the plan is not today\'s', () => {
    render(<Harness stale="Yesterday’s plan · as of Sep 23 · 10:00 AM" />)
    const m = glance().querySelector('[data-stale="true"]')
    expect(m?.textContent).toBe('Yesterday’s plan · as of Sep 23 · 10:00 AM')
    cleanup()
    render(<Harness />)
    expect(glance().querySelector('[data-stale]')).toBeNull()
  })
})

describe('open — MF2: the weather card ONCE, in place of rows A–C', () => {
  it('exactly one today-weather, no repeated hi/lo, the toggle shrinks to "Weather"', () => {
    render(<Harness />)
    fireEvent.click(toggle())
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByTestId('today-weather')).toHaveLength(1)
    expect(screen.queryByTestId('today-verdict')).toBeNull()
    expect(toggle().textContent).toBe('Weather▾')
    const temps = bareTemps(glance())
    expect(temps.length).toBeGreaterThan(0)
    expect(new Set(temps).size).toBe(temps.length)
  })
  it('aria-controls names the mounted panels only', () => {
    render(<Harness />)
    fireEvent.click(toggle())
    const ids = toggle().getAttribute('aria-controls').split(' ')
    expect(ids).toHaveLength(2)
    for (const id of ids) expect(document.getElementById(id)).toBeTruthy()
  })
  it('then cue → frost → drought → leaf wetness → dry list → rain note → basis, in reading order', () => {
    render(<Harness />)
    fireEvent.click(toggle())
    const order = ['today-weather', 'weather-cue-line', 'frost-alert-line', 'drought-line', 'leaf-wetness-line', 'care-drought-list', 'care-rain-note', 'today-basis-stamp'].map((t) => screen.getByTestId(t))
    for (let i = 1; i < order.length; i++) expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING, order[i].dataset.testid).toBeTruthy()
    expect(screen.getByTestId('today-basis-stamp').textContent).toBe('Plan from overnight · as of Sep 24 · 10:00 AM')
    for (const el of order) expect(glance().contains(el)).toBe(true)
  })
  it('closing again restores rows A–C and unmounts the details', () => {
    render(<Harness />)
    fireEvent.click(toggle())
    fireEvent.click(toggle())
    expect(screen.queryByTestId('today-weather')).toBeNull()
    expect(screen.queryByTestId('drought-line')).toBeNull()
    expect(screen.getByTestId('today-verdict')).toBeTruthy()
  })
})

describe('the cue beacon (plan-v2 §7 row 17)', () => {
  it('painted = one impression, and toggling the card never sends another (the cue is never remounted)', () => {
    render(<Harness />)
    expect(screen.getByTestId('weather-cue-line')).toBeTruthy()
    expect(impressions()).toBe(1)
    const cue = screen.getByTestId('weather-cue-line')
    fireEvent.click(toggle())
    fireEvent.click(toggle())
    expect(screen.getByTestId('weather-cue-line')).toBe(cue)
    expect(impressions()).toBe(1)
  })
  it('unpainted = none', () => {
    render(<Harness plan={QUIET} />)
    expect(impressions()).toBe(0)
  })
})
