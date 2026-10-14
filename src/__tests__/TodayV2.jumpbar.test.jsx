// V5-TODAYREDESIGN-001 S3 — the redesigned Today's jump bar and glance card wired into the page (plan-v2 §2.7,
// §4 "Jump bar", §5.4–5.5, §6.1–6.2, §6.8; §13 Simplify 5; the S3 brief's chip, sticky and focus rules). Finish plan
// §3.4–3.5 (Dave's D16 + D17, 2026-10-14): count-over-label cells that never scroll, and Water / Feed / Check as THE
// task filter.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { planState, prefsState, auth, fetchMock, api, kb } = vi.hoisted(() => {
  const fetchMock = vi.fn(async () => ({ ok: true }))
  return {
    planState: { current: null },
    prefsState: { current: { prefs: null, prefsLoaded: true, refreshPrefs: async () => null } },
    auth: { user: { id: 'u' } },
    fetchMock,
    // ONE api object for the file, as the real useApiFetch memoises its own (integration 2, seam 5).
    api: { fetch: fetchMock },
    kb: { up: false },
  }
})
vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => planState.current }))
vi.mock('../context/PrefsContext.jsx', () => ({ usePrefs: () => prefsState.current }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth }))
vi.mock('../lib/api.js', async (orig) => ({ ...(await orig()), useApiFetch: () => api }))
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
import { barColumns } from '../components/today/v2/JumpBar.jsx'
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

describe('the jump bar — cells, never scroll (§2.7, §5.4; Simplify 5; finish plan D16)', () => {
  const name = (c) => c.getAttribute('aria-label')
  it('a <nav> "Today sections" of buttons, count over label; the accessible name is the label with its count; no in-view state', () => {
    mount()
    expect(bar()).toBeTruthy()
    const chips = [...bar().querySelectorAll('[data-chip]')]
    expect(chips.map((c) => c.getAttribute('data-chip'))).toEqual(['water', 'feed', 'check'])
    expect(chips.map(name)).toEqual(['Water 4', 'Feed 2', 'Check 1'])
    // Count first (on top), label under it.
    expect(chips.map((c) => [...c.children].map((x) => x.textContent))).toEqual([['4', 'Water'], ['2', 'Feed'], ['1', 'Check']])
    for (const c of chips) {
      expect(c.tagName).toBe('BUTTON')
      expect(c.getAttribute('type')).toBe('button')
      expect(c.hasAttribute('aria-current')).toBe(false)
      // The task cells are the filter's toggles (D17): pressed only while their task is the filter.
      expect(c.getAttribute('aria-pressed')).toBe('false')
    }
    expect(screen.getByRole('button', { name: 'Water 4' })).toBe(chips[0])
  })
  it('a counted cell draws no glyph — its number sits where the icon was', () => {
    mount()
    for (const k of ['water', 'feed', 'check']) expect(chip(k).querySelector('svg'), k).toBeNull()
  })
  it('one sticky layer just under TopChrome: sticky, 52px + safe area, z 70, equal-width auto-fit cells, no sideways scroll, 52px by min-height', () => {
    mount()
    const s = bar().style
    expect(s.position).toBe('sticky')
    expect(s.top).toBe('calc(52px + env(safe-area-inset-top))')
    expect(s.zIndex).toBe('70')
    expect(s.display).toBe('grid')
    expect(s.gridTemplateColumns).toBe('repeat(auto-fit, minmax(3.75rem, 1fr))')
    expect(s.overflowX).toBe('')
    expect(s.overflowY).toBe('')
    expect(s.minHeight).toBe('52px')
    expect(s.height).toBe('')
    expect(bar().parentElement).toBe(screen.getByTestId('today-page'))
  })
  it('wraps — never scrolls — when one row cannot give every cell its minimum: two even rows, then fewer columns as text grows', () => {
    expect(barColumns(5, true)).toBe('repeat(auto-fit, minmax(3.75rem, 1fr))')
    // Seven at 426px: "Heads-up" needs 3.75rem, a seventh of the row is less — 4 + 3.
    expect(barColumns(7, false)).toBe('repeat(auto-fit, minmax(max(3.75rem, calc((100% - 12px) / 4)), 1fr))')
    const RO = globalThis.ResizeObserver
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    globalThis.ResizeObserver = class { observe() {} disconnect() {} }
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.getAttribute('data-testid') === 'today-jumpbar' ? 150 : 0 } })
    try {
      mount()
      // Three cells need 3 × 60 + 2 × 4 = 188px; 150 cannot give them one row.
      expect(bar().style.gridTemplateColumns).toBe('repeat(auto-fit, minmax(max(3.75rem, calc((100% - 4px) / 2)), 1fr))')
    } finally {
      if (RO) globalThis.ResizeObserver = RO; else delete globalThis.ResizeObserver
      if (width) Object.defineProperty(HTMLElement.prototype, 'clientWidth', width); else delete HTMLElement.prototype.clientWidth
    }
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
  it('the chip set is HELD for the visit: an emptied cell stays, a check in place of its number, named "· done", no toggle', () => {
    mount()
    expect(visit().order.chips).toEqual(['water', 'feed', 'check'])
    act(() => writeSkipped(new Set(['w1:water_due', 'w2:water_due', 'w3:water_due', 'n1:no_history'])))
    expect(name(chip('water'))).toBe('Water · done')
    expect(chip('water').textContent).toBe('Water')
    expect(chip('water').querySelector('svg')).toBeTruthy()
    expect(chip('water').hasAttribute('aria-pressed')).toBe(false)
    expect(name(chip('feed'))).toBe('Feed 2')
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
  it('Water / Feed / Check ARE the task filter (D17): a tap sets its task, another task replaces it, the same cell again clears it', () => {
    mount()
    const pressed = () => ['water', 'feed', 'check'].filter((k) => chip(k).getAttribute('aria-pressed') === 'true')
    const saved = () => JSON.parse(sessionStorage.getItem('today-filters:u') || 'null')
    fireEvent.click(chip('water'))
    expect(pressed()).toEqual(['water'])
    expect(saved()).toMatchObject({ plan_date: D, tasks: ['water'] })
    fireEvent.click(chip('feed'))
    expect(pressed()).toEqual(['feed'])
    fireEvent.click(chip('feed'))
    expect(pressed()).toEqual([])
    expect(saved().tasks).toEqual([])
    // Every tap still jumps — the clearing one too.
    expect(scrollSpy).toHaveBeenCalledTimes(3)
    // No intent is handed through the visit record any more: the bar's cells are the filter itself.
    expect(visit().filter).toBeUndefined()
  })
  it('the selected cell shows it beyond colour: the filter chips\' green fill, a doubled border, label 700', () => {
    mount()
    fireEvent.click(chip('check'))
    expect(chip('check').style.background).toBe('rgb(216, 243, 220)')
    expect(chip('check').style.boxShadow).toBe('inset 0 0 0 1px #2d6a4f')
    expect(chip('check').children[1].style.fontWeight).toBe('700')
    expect(chip('water').style.background).toBe('rgb(255, 255, 255)')
  })
  it('the filter shows on the bar while Needs care is closed, and holds across a remount (saved per session)', () => {
    const { unmount } = mount()
    fireEvent.click(chip('feed'))
    fireEvent.click(band('care'))
    expect(band('care').getAttribute('aria-expanded')).toBe('false')
    expect(chip('feed').getAttribute('aria-pressed')).toBe('true')
    unmount()
    mount()
    expect(chip('feed').getAttribute('aria-pressed')).toBe('true')
  })
  it('an emptied task cell only jumps: it sets no filter', () => {
    mount()
    act(() => writeSkipped(new Set(['p1:pest'])))
    fireEvent.click(chip('check'))
    expect(scrollSpy).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem('today-filters:u')).toBeNull()
    expect(['water', 'feed'].map((k) => chip(k).getAttribute('aria-pressed'))).toEqual(['false', 'false'])
  })
})

describe('scroll offsets while V2 is mounted (§6.2)', () => {
  it('html scroll-padding subtracts TopChrome + the bar (top) and BottomNav + one toast (bottom); cleared on unmount', () => {
    const { unmount } = mount()
    const s = document.documentElement.style
    expect(s.scrollPaddingTop).toBe('calc(52px + env(safe-area-inset-top) + 52px)')
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
