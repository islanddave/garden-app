// V5-TODAYREDESIGN-001 S3 — the glance card's data (src/lib/todayV2/verdict.js) and the jump chips
// (src/lib/todayV2/chips.js), cell by cell. The rain half is pinned to WeatherWidget by the ARGUMENTS each hands
// rainSentences: one sentence builder, and the glance must derive the four regime flags exactly as the card does.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('../lib/rainSentences.js', async (orig) => {
  const m = await orig()
  return { ...m, rainSentences: vi.fn(m.rainSentences) }
})

import { rainSentences } from '../lib/rainSentences.js'
import WeatherWidget, { headlineFor } from '../components/today/WeatherWidget.jsx'
import { glanceHeadline, urgentPhrase, glanceRain, staleMarker, NOTHING_DUE } from '../lib/todayV2/verdict.js'
import { CHIPS, CHIP_ORDER, taskCounts, liveChips, shownChips, chipText } from '../lib/todayV2/chips.js'

const WX = { tonightLow: 55, highToday: 72, code: 3, hot: false }
const DRY = { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0, tomorrow_pop: 0, upcoming_precip_in: 0 }
const SOAK = { recent_precip_in: 0.5, today_observed_in: 3.82, today_remaining_in: 0, today_precip_in: 3.82, today_pop: 92, tomorrow_precip_in: 0, tomorrow_pop: 1 }
const BEDS_WAIT = { recent_precip_in: 0.05, today_precip_in: 0, today_pop: 5, tomorrow_precip_in: 0.74, tomorrow_pop: 63 }
const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `w${i}` }))

describe('glanceHeadline — headlineFor verbatim behind the empty-list guard (§13 SF9 update)', () => {
  it('a list and lanes that say water: the card\'s own sentence', () => {
    expect(glanceHeadline({ weather: WX, hydrology: DRY, water_due: rows(3) })).toBe('Water both — containers and beds today.')
    expect(glanceHeadline({ weather: WX, hydrology: BEDS_WAIT, water_due: rows(40) })).toBe('Water containers, skip the beds today.')
  })
  it('a KNOWN empty list under lanes that say water: "Nothing due for watering today." (never an imperative)', () => {
    expect(glanceHeadline({ weather: WX, hydrology: DRY, water_due: [] })).toBe(NOTHING_DUE)
    expect(glanceHeadline({ weather: WX, hydrology: BEDS_WAIT, water_due: [] })).toBe(NOTHING_DUE)
    expect(NOTHING_DUE).toBe('Nothing due for watering today.')
    expect(glanceHeadline({ weather: WX, hydrology: DRY, water_due: [], no_history: [] })).toBe(NOTHING_DUE)
  })
  it('a never-watered row is a Water row, and a missing list is unknown: neither reads as nothing due', () => {
    expect(glanceHeadline({ weather: WX, hydrology: DRY, water_due: [], no_history: rows(1) })).toBe('Water both — containers and beds today.')
    expect(glanceHeadline({ weather: WX, hydrology: BEDS_WAIT, water_due: [], no_history: rows(1) })).toBe('Water containers, skip the beds today.')
    expect(glanceHeadline({ weather: WX, hydrology: DRY })).toBe('Water both — containers and beds today.')
    expect(glanceHeadline({ weather: WX, hydrology: DRY, no_history: [] })).toBe('Water both — containers and beds today.')
    expect(glanceHeadline({ weather: WX, hydrology: SOAK, water_due: [], no_history: rows(1) })).toBe("Rain may cover today's list — 1 still due.")
    expect(glanceHeadline({ weather: WX, hydrology: SOAK })).toBe('All set — no watering needed today.')
  })
  it('both lanes hold: the both-hold branch is headlineFor\'s, list or none (the guard only speaks over "water")', () => {
    expect(glanceHeadline({ weather: WX, hydrology: SOAK, water_due: [] })).toBe('All set — no watering needed today.')
    expect(glanceHeadline({ weather: WX, hydrology: SOAK, water_due: rows(18) })).toBe("Rain may cover today's list — 18 still due.")
  })
  it('equals headlineFor on every lane pair once the list is non-empty, and never an ellipsis-budget copy', () => {
    for (const h of [DRY, SOAK, BEDS_WAIT]) {
      const { container } = render(<WeatherWidget weather={WX} hydrology={h} waterDueCount={7} />)
      expect(container.textContent).toContain(glanceHeadline({ weather: WX, hydrology: h, water_due: rows(7) }))
      cleanup()
    }
    expect(headlineFor(true, true, 7)).toBe(glanceHeadline({ weather: WX, hydrology: DRY, water_due: rows(7) }))
  })
})

describe('urgentPhrase — one at most: freeze > frost > hot', () => {
  const watch = { at: '2026-09-23T18:00:25.841Z', run: 'intraday-pm', date: '2026-09-24', lowF: 41.8, tier: 'advisory', trip: 'radiative', dayOffset: 0, nightOffset: 0 }
  const plan = (weather, alerts = []) => ({ weather: { ...WX, ...weather }, alerts_sent: alerts })
  it('nothing on a mild, calm day', () => { expect(urgentPhrase(plan({}))).toBeNull() })
  it('hot day alone', () => { expect(urgentPhrase(plan({ hot: true, highToday: 91 }))).toEqual({ kind: 'hot', text: 'hot today' }) })
  it('a frost line naming tonight beats hot, in the line\'s own word (watch for a radiative trip)', () => {
    const p = urgentPhrase(plan({ hot: true, tonightLow: 47 }, [watch]))
    expect(p).toEqual({ kind: 'frost', text: 'frost watch tonight' })
  })
  it('an advisory without a radiative trip is "frost possible"', () => {
    const { trip, ...adv } = watch // eslint-disable-line no-unused-vars
    expect(urgentPhrase(plan({ tonightLow: 47 }, [adv]))?.text).toBe('frost possible tonight')
  })
  it('a rehearsal (run "forced") never speaks — the frost line\'s own selection', () => {
    expect(urgentPhrase(plan({ tonightLow: 47 }, [{ ...watch, run: 'forced' }]))).toBeNull()
  })
  it('an advisory whose night has since warmed is retired, as the frost line retires it (current lows)', () => {
    const { trip, ...adv } = watch // eslint-disable-line no-unused-vars
    // At the advisory trip itself (40°F), so the one agreed low stays out of the freeze bar in both cells.
    const advisory = { ...adv, date: '2026-09-25', lowF: 40, dayOffset: 1, nightOffset: 0 }
    const warmed = { ...plan({ tonightLow: 47 }, [advisory]), hydrology: { forecast_lows: [46], forecast_dates: ['2026-09-25'] } }
    const cold = { ...plan({ tonightLow: 47 }, [advisory]), hydrology: { forecast_lows: [39], forecast_dates: ['2026-09-25'] } }
    expect(urgentPhrase(cold)?.text).toBe('frost possible tonight')
    expect(urgentPhrase(warmed)).toBeNull()
  })
  it('freeze (tonight under 40°F) beats a frost line and heat', () => {
    expect(urgentPhrase(plan({ tonightLow: 36, hot: true }, [watch]))).toEqual({ kind: 'freeze', text: 'freeze tonight' })
    expect(urgentPhrase(plan({ tonightLow: 39.9 }))?.kind).toBe('freeze')
    expect(urgentPhrase(plan({ tonightLow: 40 }))).toBeNull()
  })
  it('reads the AGREED low when one is given (one low per night)', () => {
    expect(urgentPhrase(plan({ tonightLow: 44 }), { lowF: 38, lowRaw: 38.2 })?.kind).toBe('freeze')
    expect(urgentPhrase(plan({ tonightLow: 36 }), { lowF: 41, lowRaw: 41 })).toBeNull()
  })
  it('no plan, no phrase', () => { expect(urgentPhrase(null)).toBeNull() })
})

describe('glanceRain — the card\'s sentences from the card\'s flags', () => {
  beforeEach(() => { rainSentences.mockClear() })
  const LIVE = { today_precip_in: 0.04, today_pop: 18, tomorrow_precip_in: 0.22, tomorrow_pop: 61 }
  const cases = [
    ['dry, same-day', DRY, null, '2026-09-24T10:00:00Z', '2026-09-24'],
    ['showery', { ...BEDS_WAIT, status: { ok: true, uncertainty: { flag: true } } }, null, '2026-09-24T10:00:00Z', '2026-09-24'],
    ['showery on a stale snapshot', { ...BEDS_WAIT, status: { ok: true, uncertainty: { flag: true } } }, null, '2026-09-23T10:00:00Z', '2026-09-24'],
    ['incomplete (partial outage, recent rain kept)', { recent_precip_in: 0.1, status: { ok: false, uncertainty: { flag: true } } }, null, '2026-09-24T10:00:00Z', '2026-09-24'],
    ['incomplete (the forecast came back empty)', { status: { ok: false, uncertainty: { flag: true } } }, null, '2026-09-24T10:00:00Z', '2026-09-24'],
    ['live overlay', BEDS_WAIT, LIVE, '2026-09-24T10:00:00Z', '2026-09-24'],
    ['live overlay over a measured gauge', SOAK, LIVE, '2026-09-24T10:00:00Z', '2026-09-24'],
    ['overlay with no figures is not live', BEDS_WAIT, { today_precip_in: null, tomorrow_precip_in: null }, '2026-09-24T10:00:00Z', '2026-09-24'],
  ]
  it.each(cases)('%s: glanceRain hands rainSentences exactly what WeatherWidget hands it', (_n, hydrology, liveHydrology, generatedAt, planDate) => {
    render(<WeatherWidget weather={WX} hydrology={hydrology} liveHydrology={liveHydrology} generatedAt={generatedAt} planDate={planDate} waterDueCount={3} />)
    const card = rainSentences.mock.calls.at(-1)[0]
    const out = glanceRain({ hydrology, liveHydrology, generatedAt, planDate })
    const mine = rainSentences.mock.calls.at(-1)[0]
    expect(mine).toEqual(card)
    expect(out).toEqual(rainSentences(card))
    cleanup()
  })
  it('anti-vacuity: the grid reaches every flag both ways', () => {
    const seen = { live: new Set(), uncertain: new Set(), showery: new Set(), noForecast: new Set() }
    for (const [, hydrology, liveHydrology, generatedAt, planDate] of cases) {
      glanceRain({ hydrology, liveHydrology, generatedAt, planDate })
      const a = rainSentences.mock.calls.at(-1)[0]
      for (const k of Object.keys(seen)) seen[k].add(a[k])
    }
    for (const k of Object.keys(seen)) expect([...seen[k]].sort(), k).toEqual([false, true])
  })
  it('a missing hydrology is an empty one here (the glance never throws on it)', () => {
    expect(() => glanceRain({ hydrology: null })).not.toThrow()
    expect(glanceRain({ hydrology: null }).rainNote).toBeNull()
  })
})

describe('staleMarker — only for a plan that is not today\'s', () => {
  const at = '2026-09-23T14:00:25.318Z'
  it("today's plan: nothing", () => { expect(staleMarker({ planDate: '2026-09-24', generatedAt: at, today: '2026-09-24' })).toBeNull() })
  it("yesterday's plan says so, with its time", () => {
    expect(staleMarker({ planDate: '2026-09-23', generatedAt: at, today: '2026-09-24' })).toBe('Yesterday’s plan · as of Sep 23 · 10:00 AM')
  })
  it('an older plan never claims to be yesterday\'s', () => {
    expect(staleMarker({ planDate: '2026-09-21', generatedAt: '2026-09-21T14:00:00Z', today: '2026-09-24' })).toBe('An older plan · as of Sep 21 · 10:00 AM')
  })
  it('a plan the service worker served from its cache is "Offline", even when it is today\'s', () => {
    expect(staleMarker({ planDate: '2026-09-24', generatedAt: '2026-09-24T14:00:00Z', fromCache: true, today: '2026-09-24' })).toBe('Offline · plan as of Sep 24 · 10:00 AM')
  })
})

describe('jump chips (§2.4, §2.7; the S3 brief)', () => {
  it('fixed order, and numbers only on the work chips (Protect, Water, Feed, Check)', () => {
    expect(CHIP_ORDER).toEqual(['protect', 'headsup', 'water', 'feed', 'check', 'harvest', 'putup'])
    expect(CHIP_ORDER.filter((c) => CHIPS[c].counted)).toEqual(['protect', 'water', 'feed', 'check'])
    expect(chipText('water', 168)).toBe('Water 168')
    expect(chipText('water', 0)).toBe('Water · done')
    expect(chipText('harvest', 20)).toBe('Harvest')
    expect(chipText('headsup', 1)).toBe('Heads-up')
  })
  it('Water / Feed / Check all land on Needs care, each with its task', () => {
    expect(['water', 'feed', 'check'].map((c) => [CHIPS[c].section, CHIPS[c].task])).toEqual([['care', 'water'], ['care', 'feed'], ['care', 'check']])
  })
  it('one predicate per task: water = water_due + never-watered; feed = fertilize; check = pest + overwintering; cold is Protect\'s', () => {
    const r = (need) => ({ need })
    expect(taskCounts([r('water_due'), r('no_history'), r('fertilize'), r('pest'), r('overwintering'), r('cold')])).toEqual({ water: 2, feed: 1, check: 2 })
  })
  it('live = section present and, for a counted chip, above zero', () => {
    expect(liveChips(['care', 'resting'], { water: 168, feed: 0, check: 7 })).toEqual(['water', 'check'])
    expect(liveChips(['resting'], { water: 168 })).toEqual([])
    expect(liveChips(['protect', 'care', 'harvest'], { protect: 5, water: 1 })).toEqual(['protect', 'water', 'harvest'])
  })
  it('shown = held ∪ live, in the fixed order — a held chip stays at zero, a late one takes its slot', () => {
    expect(shownChips(['water', 'feed'], ['feed'])).toEqual(['water', 'feed'])
    expect(shownChips(['water', 'check'], ['protect', 'water'])).toEqual(['protect', 'water', 'check'])
  })
  it('every chip glyph is a registry key the bar can render in colour or mono', async () => {
    const { getIcon } = await import('../lib/iconRegistry.js')
    for (const c of CHIP_ORDER) expect(getIcon(CHIPS[c].icon), CHIPS[c].icon).toBeTruthy()
    for (const k of ['care.feed', 'event.observation', 'event.brought_inside']) expect(getIcon(k).variants?.filled, k).toBeTruthy()
  })
})
