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
import { P } from '../lib/constants.js'

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

function Harness({ plan = BUSYFULL, stale = null, initialOpen = false, liveHydrology = null, protectShown = false }) {
  const [open, setOpen] = useState(initialOpen)
  const agreed = agreedTonightLow(plan)
  return (
    <GlanceCard plan={plan} generatedAt={D.generated_at} planDate={D.plan_date} liveHydrology={liveHydrology} agreed={agreed} current={currentLows(plan)}
      cueCallout={agreeCallout(plan.weather?.callout, agreed, D.plan_date)} stale={stale} open={open} onToggle={() => setOpen((o) => !o)} protectShown={protectShown} />
  )
}
// The dry list links each planting, so the card lives under a router, as it does in the app.
const render = (ui) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>)
const glance = () => screen.getByTestId('today-glance')
const toggle = () => glance().querySelector('[aria-expanded]')
// The card itself (closed: the white card; open: the frame WeatherWidget is the card of) — the toggle's h2's parent.
const cardEl = () => toggle().closest('h2').parentElement
const impressions = () => fetchMock.mock.calls.filter(([p]) => String(p).includes('cue-impressions')).length
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})` }
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
  it('row C: the short headline + at most one urgent phrase, in ONE visible wrapping element (no ellipsis, no sr-only twin)', () => {
    render(<Harness />)
    const v = screen.getByTestId('today-verdict')
    expect(v.textContent).toBe('Water containers & beds · frost watch tonight') // finish plan §3.2 row C
    expect(v.style.whiteSpace).not.toBe('nowrap')
    expect(v.style.textOverflow).toBe('')
    expect(v.style.overflow).toBe('')
    expect(v.style.minHeight).toBe('1.35em') // one line reserved (finish plan D-8)
    expect(v.querySelectorAll('svg').length).toBe(1)
    // No second copy anywhere (the old card's sr-only + truncated pair).
    expect(screen.queryAllByText((_, el) => el?.textContent === v.textContent && el !== v && !el.contains(v))).toHaveLength(0)
  })
  it('row A: "Details ▾" is a visible part of the one button, a 44px box at the row\'s end', () => {
    render(<Harness />)
    const label = [...toggle().querySelectorAll('span')].find((el) => el.textContent === 'Details▾')
    expect(label).toBeTruthy()
    expect(label.style.minHeight).toBe('44px')
    expect(label.style.marginLeft).toBe('auto')
    expect(label.querySelector('[aria-hidden="true"]').textContent).toBe('▾')
  })
  it('no Protect section (finish plan §3.3): the cue and ONE frost line sit UNDER the card, outside it, cue first', () => {
    render(<Harness />)
    const cue = screen.getByTestId('weather-cue-line')
    const frost = screen.getAllByTestId('frost-alert-line')
    expect(frost).toHaveLength(1)
    for (const el of [cue, frost[0]]) {
      expect(glance().contains(el)).toBe(true)
      expect(cardEl().contains(el)).toBe(false)
    }
    expect(cue.compareDocumentPosition(frost[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Short form, no low (row A states it), the warning mark and the warn rule, normal weight — never a fill.
    expect(frost[0].textContent).toBe('Frost watch tonight — clear and calm.')
    expect(frost[0].querySelectorAll('svg')).toHaveLength(1)
    expect(frost[0].style.borderLeft).toBe(`3px solid ${rgb(P.warnBorder)}`)
    expect(frost[0].style.fontWeight).toBe('400')
    expect(frost[0].style.background).toBe('')
  })
  it('Dave\'s D15: with a Protect section the cold cue and the frost line fold into it — nothing under the card', () => {
    render(<Harness protectShown />)
    expect(screen.queryByTestId('weather-cue-line')).toBeNull()
    expect(screen.queryByTestId('frost-alert-line')).toBeNull()
    expect(screen.getByTestId('today-verdict').textContent).toContain('frost watch tonight') // the verdict carries it
    expect(impressions()).toBe(0)
    fireEvent.click(toggle())
    // The full sentence behind Details, without the low.
    expect(screen.getAllByTestId('frost-alert-line').map((el) => el.textContent)).toEqual(['Frost watch tonight — clear and calm. Plan cover for tender plants.'])
  })
  it('a frost night with Protect: tonight\'s low is stated once, in row A — no other figure for it in the glance', () => {
    render(<Harness protectShown />)
    expect(bareTemps(toggle())).toEqual(['65°', '42°'])
    expect(glance().textContent.replace('42°', '')).not.toMatch(/\b42\b/)
    // (Without Protect the engine's cue line keeps its own verbatim condition half, "Cold night (42°F) — …".)
  })
  it('the button\'s name carries the verdict (2.5.3) and starts "Weather"', () => {
    render(<Harness />)
    expect(toggle().textContent.startsWith('Weather: ')).toBe(true)
    expect(toggle().textContent).toContain('frost watch tonight')
  })
  it('a quiet day: the empty-list guard speaks, and no phrase', () => {
    render(<Harness plan={QUIET} />)
    expect(screen.getByTestId('today-verdict').textContent).toBe('Nothing to water today.')
    expect(screen.queryByTestId('weather-cue-line')).toBeNull()
  })
  it('finish plan D-2: opened, the weather card says the closed card\'s verdict — never "Water both" over an empty list', () => {
    render(<Harness plan={QUIET} />)
    fireEvent.click(toggle())
    const card = screen.getByTestId('today-weather')
    expect(card.textContent).toContain('Nothing to water today.')
    expect(card.textContent).not.toMatch(/Water both|Water containers|Water the beds/)
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
  it('exactly one today-weather, no repeated hi/lo, the toggle reads "Less ▴" where "Details ▾" was', () => {
    render(<Harness />)
    const before = toggle()
    fireEvent.click(toggle())
    expect(toggle()).toBe(before) // the same button: focus stays on it
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByTestId('today-weather')).toHaveLength(1)
    expect(screen.queryByTestId('today-verdict')).toBeNull()
    expect(toggle().textContent).toBe('Weather: Less▴')
    // Laid over WeatherWidget's row A at its border + padding from the top right — the closed card's row A end.
    const h2 = toggle().closest('h2')
    expect([h2.style.position, h2.style.top, h2.style.right]).toEqual(['absolute', '17px', '17px'])
    expect(toggle().style.minHeight).toBe('44px')
    expect(cardEl().style.position).toBe('relative')
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
  it('then the cue, and ONE plain list: frost in full → deep soak with the dry list in it → leaf wetness → rain → basis', () => {
    render(<Harness />)
    fireEvent.click(toggle())
    const order = ['today-weather', 'weather-cue-line', 'frost-alert-line', 'drought-line', 'care-drought-list', 'leaf-wetness-line', 'care-rain-note', 'today-basis-stamp'].map((t) => screen.getByTestId(t))
    for (let i = 1; i < order.length; i++) expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING, order[i].dataset.testid).toBeTruthy()
    for (const el of order) expect(glance().contains(el)).toBe(true)
    // Finish plan §3.2, line by line.
    expect(screen.getAllByTestId('frost-alert-line').map((el) => el.textContent)).toEqual(['Frost watch tonight — clear and calm. Plan cover for tender plants.'])
    const names = D.plan.dormancy_suppressed.map((it) => it.name || it.crop || 'Planting').join(', ')
    expect(screen.getByTestId('drought-line').textContent).toBe(`No deep soak in 21 days — check soil at root depth: ${names}.`)
    expect(screen.getByTestId('drought-line').contains(screen.getByTestId('care-drought-list'))).toBe(true)
    expect(screen.getByTestId('leaf-wetness-line').textContent).toBe('1 day ahead looks likely to bring 8+ modelled hours of wet leaves — water the soil, not the leaves; cut basil before then.')
    expect(screen.getByTestId('rain-covered-line').textContent).toBe('Rain already watered 70 plantings.')
    expect(screen.getByTestId('today-basis-stamp').textContent).toBe('Updated Sep 24 · 10:00 AM · plan from overnight')
    // Plain and normal weight, one advisory rule each; no paragraph of bold left-rule blocks.
    for (const t of ['drought-line', 'leaf-wetness-line', 'rain-covered-line']) {
      const el = screen.getByTestId(t)
      expect(el.style.fontWeight, t).toBe('400')
      expect(el.style.borderLeft, t).toBe(`3px solid ${rgb(P.sage)}`)
    }
    // The old dry list's explainer and per-row reason are gone.
    expect(glance().textContent).not.toMatch(/aren’t on calendar watering|Dry — no deep soak/)
  })
  it('the deep-soak line is read through the validator: a "no rain in N days" note never speaks (Dave\'s ruling)', () => {
    render(<Harness plan={{ ...BUSYFULL, drought: { ...G.drought.plan_level, note: 'No rain in 21 days.' }, dormancy_suppressed: [] }} initialOpen />)
    expect(screen.queryByTestId('drought-line')).toBeNull()
    cleanup()
    // The list alone still says it in the dry list's own words; counts that differ read "at least" the least.
    const items = D.plan.dormancy_suppressed.slice(0, 2).map((it, i) => ({ ...it, drought: { ...G.drought.per_item, dry_days: 21 + i } }))
    render(<Harness plan={{ ...BUSYFULL, drought: undefined, dormancy_suppressed: items }} initialOpen />)
    expect(screen.getByTestId('drought-line').textContent).toMatch(/^No deep soak in at least 21 days — check soil at root depth: /)
    expect(screen.getByTestId('drought-line').textContent).not.toMatch(/rain/i)
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
