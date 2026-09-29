// V5-TODAYREDESIGN-001 S3 — the redesigned Today's jump bar and glance card wired into the page (plan-v2 §2.7,
// §4 "Jump bar", §5.4–5.5, §6.1–6.2, §6.8; §13 Simplify 5; the S3 brief's chip, sticky and focus rules).
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { planState, prefsState, auth, fetchMock, kb } = vi.hoisted(() => ({
  planState: { current: null },
  prefsState: { current: { prefs: null, prefsLoaded: true, refreshPrefs: async () => null } },
  auth: { user: { id: 'u' } },
  fetchMock: vi.fn(async () => ({ ok: true })),
  kb: { up: false },
}))
vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => planState.current }))
vi.mock('../context/PrefsContext.jsx', () => ({ usePrefs: () => prefsState.current }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth }))
vi.mock('../lib/api.js', async (orig) => ({ ...(await orig()), useApiFetch: () => ({ fetch: fetchMock }) }))
vi.mock('../lib/keyboardChrome.js', async (orig) => ({ ...(await orig()), useKeyboardChromeSuppressed: () => kb.up }))
// S4 (merged with S3): the ready point waits for Needs care's /api/plants + /api/locations (useCachedFetch) —
// answered here as S2's TodayV2.test.jsx answers them, so the bar paints on the first mount of the file too.
vi.mock('../hooks/useCachedFetch.js', () => ({ useCachedFetch: (path) => ({ data: path === '/api/plants' ? [] : { locations: [] }, loading: false, error: null }) }))
// S6: the plan-independent bands (Harvest, Put-Up, the Sow row's lines) are fetched at the page and the ready point
// waits for them (useTodayBands); this file is not about them, so they answer at once, settled and empty.
vi.mock('../components/today/v2/useTodayBands.js', () => ({
  useTodayBands: () => ({ settled: true, watch: { data: null, failed: false, reload() {} }, compose: { data: null, settled: true, reload() {} }, soon: { data: null, failed: false, reload() {} }, sow: { items: null, settled: true }, harvest: { present: false, summary: null }, putup: { present: false, summary: null } }),
}))

import TodayV2 from '../pages/TodayV2.jsx'
import { PageScrollProvider } from '../hooks/usePageScrollManager.js'
import { writeSkipped } from '../components/today/careStore.js'

const D = '2026-09-24'
const row = (id, extra = {}) => ({ id, name: `Plant ${id}`, crop: 'Kale', ...extra })
const WEATHER = { tonightLow: 55, highToday: 72, code: 3, hot: false }
const HYDRO = { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0, tomorrow_pop: 0, status: { ok: true, uncertainty: { flag: false } } }
const PLAN = {
  weather: WEATHER, hydrology: HYDRO,
  water_due: [row('w1'), row('w2'), row('w3')],
  no_history: [row('n1', { never: true })],
  fertilize: [row('f1'), row('f2')],
  pest: [row('p1')],
  overwintering: [],
  cold: [],
  dormant: [row('d1', { name: 'Blackberry' })],
}
const payload = (plan = PLAN) => ({ data: { has_plan: true, plan_date: D, generated_at: `${D}T14:00:00.000Z`, plan }, loading: false, error: null, reload: vi.fn() })
const yieldSpy = vi.fn()
const mount = (withManager = false) => render(
  <MemoryRouter>
    {withManager
      ? <PageScrollProvider value={{ api: { yieldScroll: yieldSpy, claim: () => () => {} }, isReturn: false }}><TodayV2 /></PageScrollProvider>
      : <TodayV2 />}
  </MemoryRouter>,
)
const bar = () => screen.queryByRole('navigation', { name: 'Today sections' })
const chip = (k) => bar().querySelector(`[data-chip="${k}"]`)
const band = (key) => screen.getByTestId(`today-sec-${key}`).querySelector('[aria-expanded]')
const visit = () => JSON.parse(sessionStorage.getItem(`today-visit:u:${D}:v2`))
const reducedMotion = (on) => {
  window.matchMedia = vi.fn((q) => ({ matches: on && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }))
}

let scrollSpy
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear()
  planState.current = payload()
  prefsState.current = { prefs: null, prefsLoaded: true, refreshPrefs: vi.fn(async () => null) }
  auth.user = { id: 'u' }
  kb.up = false
  yieldSpy.mockClear()
  reducedMotion(false)
  scrollSpy = vi.fn()
  Element.prototype.scrollIntoView = scrollSpy
})
afterEach(() => { cleanup(); delete Element.prototype.scrollIntoView; delete window.matchMedia })

describe('the jump bar — navigation only (§2.7, §5.4; Simplify 5)', () => {
  it('a <nav> "Today sections" of plain buttons; numbers only on work chips; no in-view or pressed state', () => {
    mount()
    expect(bar()).toBeTruthy()
    const chips = [...bar().querySelectorAll('[data-chip]')]
    expect(chips.map((c) => c.getAttribute('data-chip'))).toEqual(['water', 'feed', 'check'])
    expect(chips.map((c) => c.textContent)).toEqual(['Water 4', 'Feed 2', 'Check 1'])
    for (const c of chips) {
      expect(c.tagName).toBe('BUTTON')
      expect(c.getAttribute('type')).toBe('button')
      expect(c.hasAttribute('aria-current')).toBe(false)
      expect(c.hasAttribute('aria-pressed')).toBe(false)
    }
    expect(screen.getByRole('button', { name: 'Water 4' })).toBe(chips[0])
  })
  it('the colour variant on every chip glyph (the approved S3b bar): regions painted, no bare currentColor fill', () => {
    mount()
    for (const k of ['water', 'feed', 'check']) {
      const svg = chip(k).querySelector('svg')
      expect(svg.getAttribute('aria-hidden')).toBe('true')
      expect(svg.innerHTML, k).toMatch(/data-region="[^"]+"[^>]*(fill|stroke)="#[0-9a-fA-F]{3,6}"/)
    }
  })
  it('one sticky layer just under TopChrome: sticky, 52px + safe area, z 70, a sideways strip, 57px by min-height', () => {
    mount()
    const s = bar().style
    expect(s.position).toBe('sticky')
    expect(s.top).toBe('calc(52px + env(safe-area-inset-top))')
    expect(s.zIndex).toBe('70')
    expect(s.overflowX).toBe('auto')
    expect(s.overflowY).toBe('')
    expect(s.flexWrap).toBe('nowrap')
    expect(s.minHeight).toBe('57px')
    expect(s.height).toBe('')
    expect(bar().parentElement).toBe(screen.getByTestId('today-page'))
  })
  it('drops to static while the keyboard is up — the same in-flow box (§6.8)', () => {
    kb.up = true
    mount()
    expect(bar().style.position).toBe('static')
  })
  it('no bar with fewer than two chips at the ready point', () => {
    planState.current = payload({ ...PLAN, no_history: [], fertilize: [], pest: [] })
    mount()
    expect(bar()).toBeNull()
  })
  it('the chip set is HELD for the visit: an emptied chip stays and reads "· done"', () => {
    mount()
    expect(visit().order.chips).toEqual(['water', 'feed', 'check'])
    act(() => writeSkipped(new Set(['w1:water_due', 'w2:water_due', 'w3:water_due', 'n1:no_history'])))
    expect(chip('water').textContent).toBe('Water · done')
    expect(chip('feed').textContent).toBe('Feed 2')
  })
})

describe('a chip tap (§2.7, §5.5, §6.2)', () => {
  it('opens Needs care as a visit overlay — never remembered', () => {
    mount()
    expect(band('care').getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(chip('water'))
    expect(band('care').getAttribute('aria-expanded')).toBe('true')
    expect(visit().overlay.care).toBe('open')
    const mirror = JSON.parse(localStorage.getItem('today-sections:u') || 'null')
    expect(mirror?.s?.care).toBeUndefined()
  })
  it('scrolls the section to the top of the scrollport (smooth), then focuses its header without a second scroll', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    mount()
    fireEvent.click(chip('water'))
    const sec = screen.getByTestId('today-sec-care')
    expect(scrollSpy).toHaveBeenCalledTimes(1)
    expect(scrollSpy.mock.contexts[0]).toBe(sec)
    expect(scrollSpy.mock.calls[0][0]).toEqual({ block: 'start', behavior: 'smooth' })
    expect(document.activeElement).toBe(band('care'))
    expect(focus.mock.contexts.at(-1)).toBe(band('care'))
    expect(focus.mock.calls.at(-1)[0]).toEqual({ preventScroll: true })
    focus.mockRestore()
  })
  it('instant under reduced motion', () => {
    reducedMotion(true)
    mount()
    fireEvent.click(chip('feed'))
    expect(scrollSpy.mock.calls[0][0]).toEqual({ block: 'start', behavior: 'instant' })
  })
  it('the page-scroll manager stands down first (usePageScrollYield)', () => {
    mount(true)
    fireEvent.click(chip('check'))
    expect(yieldSpy).toHaveBeenCalledTimes(1)
  })
  it('Water / Feed / Check leave S4 a pre-select intent in the visit record, one per tap', () => {
    mount()
    fireEvent.click(chip('water'))
    expect(visit().filter).toEqual({ care: { tasks: ['water'], n: 1 } })
    fireEvent.click(chip('feed'))
    expect(visit().filter).toEqual({ care: { tasks: ['feed'], n: 2 } })
    fireEvent.click(chip('feed'))
    expect(visit().filter.care.n).toBe(3)
  })
  it('a chip cut at the strip\'s edge slides into view by strip.scrollTo — never chip.scrollIntoView', () => {
    mount()
    const strip = bar()
    strip.scrollTo = vi.fn()
    strip.getBoundingClientRect = () => ({ left: 16, right: 410, top: 0, bottom: 57, width: 394, height: 57 })
    chip('check').getBoundingClientRect = () => ({ left: 380, right: 485, top: 4, bottom: 52, width: 105, height: 48 })
    fireEvent.click(chip('check'))
    expect(strip.scrollTo).toHaveBeenCalledWith({ left: 75, behavior: 'smooth' })
    expect(scrollSpy.mock.contexts.every((el) => el !== chip('check'))).toBe(true)
  })
  it('a chip already in view does not move the strip', () => {
    mount()
    const strip = bar()
    strip.scrollTo = vi.fn()
    strip.getBoundingClientRect = () => ({ left: 16, right: 410, top: 0, bottom: 57, width: 394, height: 57 })
    chip('water').getBoundingClientRect = () => ({ left: 16, right: 132, top: 4, bottom: 52, width: 116, height: 48 })
    fireEvent.click(chip('water'))
    expect(strip.scrollTo).not.toHaveBeenCalled()
  })
})

describe('scroll offsets while V2 is mounted (§6.2)', () => {
  it('html scroll-padding subtracts TopChrome + the bar (top) and BottomNav + one toast (bottom); cleared on unmount', () => {
    const { unmount } = mount()
    const s = document.documentElement.style
    expect(s.scrollPaddingTop).toBe('calc(52px + env(safe-area-inset-top) + 57px)')
    expect(s.scrollPaddingBottom).toBe('calc(var(--bottom-nav-height, 56px) + env(safe-area-inset-bottom) + 64px)')
    unmount()
    expect(s.scrollPaddingTop || '').toBe('')
    expect(s.scrollPaddingBottom || '').toBe('')
  })
  it('no bar, no bar in the padding', () => {
    planState.current = payload({ ...PLAN, no_history: [], fertilize: [], pest: [] })
    mount()
    expect(document.documentElement.style.scrollPaddingTop).toBe('calc(52px + env(safe-area-inset-top))')
  })
  it('every section carries the 8px landing gap as scroll-margin-top', () => {
    mount()
    for (const k of ['care', 'resting']) expect(screen.getByTestId(`today-sec-${k}`).style.scrollMarginTop).toBe('8px')
  })
})

describe('the glance card on the page (§1.0, §6.4)', () => {
  it('paints with the plan, closed, above the bar', () => {
    mount()
    const g = screen.getByTestId('today-glance')
    expect(g.querySelector('[aria-expanded]').getAttribute('aria-expanded')).toBe('false')
    expect(g.compareDocumentPosition(bar()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
  it('no plan, no card', () => {
    planState.current = { data: { has_plan: false, plan_date: D, plan: null }, loading: false, error: null, reload: vi.fn() }
    mount()
    expect(screen.queryByTestId('today-glance')).toBeNull()
  })
  it('a tap is remembered (Layer 1 key "glance") and restored on the next visit; Expand all never opens it', () => {
    const { unmount } = mount()
    fireEvent.click(screen.getByTestId('today-expand-all'))
    expect(screen.getByTestId('today-glance').querySelector('[aria-expanded]').getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByTestId('today-glance').querySelector('[aria-expanded]'))
    expect(JSON.parse(localStorage.getItem('today-sections:u')).s.glance).toEqual({ open: true, at: D })
    expect(screen.getAllByTestId('today-weather')).toHaveLength(1)
    unmount(); sessionStorage.clear()
    mount()
    expect(screen.getByTestId('today-glance').querySelector('[aria-expanded]').getAttribute('aria-expanded')).toBe('true')
  })
  it('a plan dated before today carries the stale marker', () => {
    planState.current = { data: { has_plan: true, plan_date: '2020-01-01', generated_at: '2020-01-01T14:00:00.000Z', plan: PLAN }, loading: false, error: null, reload: vi.fn() }
    mount()
    expect(screen.getByTestId('today-glance').querySelector('[data-stale="true"]').textContent).toBe('An older plan · as of Jan 1 · 9:00 AM')
  })
})
