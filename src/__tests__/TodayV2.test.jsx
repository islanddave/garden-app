// V5-TODAYREDESIGN-001 S2 — the redesigned Today's skeleton: frame, title row, date, page states, the section
// bands, and the three state layers wired together (plan-v2 §1.0–1.4, §2.1–2.2, §4, §6.4).
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { planState, prefsState, auth } = vi.hoisted(() => ({
  planState: { current: null },
  prefsState: { current: { prefs: null, prefsLoaded: true, refreshPrefs: async () => null } },
  auth: { user: { id: 'u' } },
}))
vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: (opts) => { planState.lastOpts = opts; return planState.current } }))
vi.mock('../context/PrefsContext.jsx', () => ({ usePrefs: () => prefsState.current }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth }))
// S4: Needs care reads /api/plants + /api/locations (useCachedFetch) and writes through useApiFetch — the
// documented test seam (api.js), so no Clerk provider is needed here.
vi.mock('../lib/api.js', async (orig) => ({ ...(await orig()), useApiFetch: () => ({ fetch: async () => ({ id: 'ev' }), getToken: async () => 't' }) }))
vi.mock('../hooks/useCachedFetch.js', () => ({ useCachedFetch: (path) => ({ data: path === '/api/plants' ? [] : { locations: [] }, loading: false, error: null }) }))
// S6: the plan-independent bands (Harvest, Put-Up, the Sow row's lines) are fetched at the page and the ready point
// waits for them (useTodayBands); this file is not about them, so they answer at once, settled and empty.
vi.mock('../components/today/v2/useTodayBands.js', () => ({
  useTodayBands: () => ({ settled: true, watch: { data: null, failed: false, reload() {} }, compose: { data: null, settled: true, reload() {} }, soon: { data: null, failed: false, reload() {} }, sow: { items: null, settled: true }, harvest: { present: false, summary: null }, putup: { present: false, summary: null } }),
}))

import TodayV2, { namesSummary, activeCareRows } from '../pages/TodayV2.jsx'

const D = '2026-09-24'
const row = (id, extra = {}) => ({ id, name: `Plant ${id}`, crop: 'Kale', ...extra })
const PLAN = {
  water_due: [row('w1'), row('w2'), row('w3')],
  no_history: [row('n1', { never: true })],
  fertilize: [row('f1'), row('f2')],
  pest: [row('p1')],
  overwintering: [],
  cold: [row('c1', { level: 'protect', text: 'Protect tonight (≤ 45°F)' })],
  dormant: [row('d1', { name: 'Blackberry' }), row('d2', { name: 'Kousa Dogwood' }), row('d3', { name: 'Christmas Cactus' }), row('d4', { name: 'Fig' })],
}
const busy = () => ({ data: { has_plan: true, plan_date: D, plan: PLAN }, loading: false, error: null, reload: vi.fn() })
const mount = () => render(<MemoryRouter><TodayV2 /></MemoryRouter>)
const band = (key) => screen.getByTestId(`today-sec-${key}`).querySelector('[aria-expanded]')

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear()
  planState.current = busy()
  prefsState.current = { prefs: null, prefsLoaded: true, refreshPrefs: vi.fn(async () => null) }
  auth.user = { id: 'u' }
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('TodayV2 skeleton', () => {
  it('marks itself V2, reports prefs, and asks the household question always', () => {
    mount()
    const page = screen.getByTestId('today-page')
    expect(page.getAttribute('data-today-version')).toBe('2')
    expect(page.getAttribute('data-prefs-loaded')).toBe('true')
    expect(page.getAttribute('data-today-ready')).toBe('true')
    expect(planState.lastOpts).toEqual({ includeHousehold: true, seed: 'u' })
    expect(screen.getByRole('heading', { level: 1, name: 'Today' }).style.color).toBe('rgb(45, 106, 79)')
    expect(screen.getByTestId('today-date').textContent).toBe('Thursday, September 24')
    expect(screen.getByTestId('today-status').getAttribute('role')).toBe('status')
  })

  it('Needs care counts water + feed + check (cold rows are Protect\'s), and Resting names its plants', () => {
    mount()
    expect(band('care').textContent).toContain('Needs care')
    expect(band('care').textContent).toContain('7') // 3 water + 1 never + 2 feed + 1 check
    expect(band('resting').textContent).toContain('4')
    expect(band('resting').textContent).toContain('Blackberry, Kousa Dogwood, Christmas Cactus +1')
    expect(band('care').closest('h2')).toBeTruthy()
    expect(screen.queryByTestId('care-empty')).toBeNull()
  })

  // S4 added Needs care's trigger (§3): PLAN's never-watered row opens it by itself — so this pins the closed
  // default on a plan with no reason (the never row removed), and the trigger in its own test below.
  it('sections are closed by default without a trigger, and closed means unmounted', () => {
    planState.current = { ...busy(), data: { ...busy().data, plan: { ...PLAN, no_history: [] } } }
    mount()
    expect(band('care').getAttribute('aria-expanded')).toBe('false')
    expect(band('care').hasAttribute('aria-controls')).toBe(false)
    expect(screen.queryByTestId('today-v2-pending')).toBeNull()
    fireEvent.click(band('care'))
    expect(band('care').getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(band('care').getAttribute('aria-controls'))).toBeTruthy()
  })

  it('a header tap is remembered (Layer 1 mirror, dirty) and held by the visit', () => {
    mount()
    fireEvent.click(band('resting'))
    expect(JSON.parse(localStorage.getItem('today-sections:u'))).toEqual({ v: 1, s: { resting: { open: true, at: D } }, dirty: ['resting'] })
    const visit = JSON.parse(sessionStorage.getItem(`today-visit:u:${D}:v2`))
    expect(visit.layer1.resting).toBe(true)
    fireEvent.click(band('resting'))
    expect(JSON.parse(localStorage.getItem('today-sections:u')).s.resting).toEqual({ open: false, at: D })
  })

  it('Expand all / Collapse all move the visit only — nothing is remembered', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(band('care').getAttribute('aria-expanded')).toBe('true')
    expect(band('resting').getAttribute('aria-expanded')).toBe('true')
    expect(localStorage.getItem('today-sections:u')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(band('care').getAttribute('aria-expanded')).toBe('false')
    expect(localStorage.getItem('today-sections:u')).toBeNull()
  })

  it('a remembered open (server) applies at the visit start', () => {
    prefsState.current = { ...prefsState.current, prefs: { today_sections: { v: 1, resting: { open: true, at: '2026-09-23' } } } }
    mount()
    expect(band('resting').getAttribute('aria-expanded')).toBe('true')
    expect(band('care').getAttribute('aria-expanded')).toBe('false')
  })

  it('with a mirror, the visit starts without waiting for prefs, and a later server answer waits for the next visit', () => {
    localStorage.setItem('today-sections:u', JSON.stringify({ v: 1, s: { care: { open: false, at: D } }, dirty: [] }))
    prefsState.current = { prefs: null, prefsLoaded: false, refreshPrefs: vi.fn() }
    const { rerender } = mount()
    expect(screen.getByTestId('today-page').getAttribute('data-today-ready')).toBe('true')
    expect(band('care').getAttribute('aria-expanded')).toBe('false')
    prefsState.current = { prefs: { today_sections: { v: 1, care: { open: true, at: D } } }, prefsLoaded: true, refreshPrefs: vi.fn() }
    rerender(<MemoryRouter><TodayV2 /></MemoryRouter>)
    expect(band('care').getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByTestId('today-page').getAttribute('data-prefs-loaded')).toBe('true')
  })

  it('with no mirror and prefs not in, the ready point waits up to 300 ms, then paints closed', () => {
    vi.useFakeTimers()
    prefsState.current = { prefs: null, prefsLoaded: false, refreshPrefs: vi.fn() }
    mount()
    expect(screen.getByTestId('today-page').hasAttribute('data-today-ready')).toBe(false)
    expect(screen.queryByTestId('today-sec-care')).toBeNull()
    expect(screen.queryByTestId('cultivation-lead')).toBeNull()
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByTestId('today-page').getAttribute('data-today-ready')).toBe('true')
    expect(band('care').getAttribute('aria-expanded')).toBe('false')
  })

  it('the shared skip set is not counted', () => {
    localStorage.setItem(`today-skipped:${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)}`, JSON.stringify(['w1:water_due', 'f1:fertilize']))
    mount()
    expect(band('care').textContent).toMatch(/Needs care\s*5/)
  })
})

describe('TodayV2 page states', () => {
  it('a quiet plan: the Needs care done line, no bands, no Expand all, the Sow link row last', () => {
    planState.current = { data: { has_plan: true, plan_date: D, plan: { water_due: [], dormant: [] } }, loading: false, error: null, reload: vi.fn() }
    mount()
    expect(screen.getByTestId('care-empty').textContent).toBe('Needs care: all caught up — nothing due today.')
    expect(screen.getByTestId('care-empty').tagName).toBe('P')
    expect(document.querySelector('[data-testid^="today-sec-"]')).toBeNull()
    expect(screen.queryByRole('button', { name: /Expand all|Collapse all/ })).toBeNull()
    const sow = screen.getByTestId('cultivation-lead')
    expect(sow.textContent).toContain('All sow windows')
    expect(sow.getAttribute('href')).toBe('/seeds?view=sow')
    expect(sow.style.color).toBeTruthy()
  })

  it('no plan: the one neutral sentence, no care line, the Sow link row', () => {
    planState.current = { data: { has_plan: false, plan: null, plan_date: D }, loading: false, error: null, reload: vi.fn() }
    mount()
    expect(screen.getByTestId('today-noplan-card').textContent).toBe('Today’s plan hasn’t arrived yet — it’s built overnight.')
    expect(screen.queryByTestId('care-empty')).toBeNull()
    expect(screen.getByTestId('cultivation-lead')).toBeTruthy()
  })

  it('loading shows the house loading state; an error with no data offers Retry', () => {
    planState.current = { data: null, loading: true, error: null, reload: vi.fn() }
    const { unmount } = mount()
    expect(screen.getByText(/Loading/)).toBeTruthy()
    expect(screen.getByTestId('today-page').hasAttribute('data-today-ready')).toBe(false)
    unmount()
    const reload = vi.fn()
    planState.current = { data: null, loading: false, error: 'Failed to load your plan', reload }
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(reload).toHaveBeenCalled()
  })

  it('a new plan day while mounted re-reads prefs and starts a new visit', async () => {
    const refreshPrefs = vi.fn(async () => null)
    prefsState.current = { prefs: null, prefsLoaded: true, refreshPrefs }
    const { rerender } = mount()
    fireEvent.click(band('resting'))
    const firstVisit = JSON.parse(sessionStorage.getItem(`today-visit:u:${D}:v2`)).id
    planState.current = { data: { has_plan: true, plan_date: '2026-09-25', plan: PLAN }, loading: false, error: null, reload: vi.fn() }
    await act(async () => { rerender(<MemoryRouter><TodayV2 /></MemoryRouter>) })
    expect(refreshPrefs).toHaveBeenCalled()
    const next = JSON.parse(sessionStorage.getItem('today-visit:u:2026-09-25:v2'))
    expect(next.id).not.toBe(firstVisit)
    expect(sessionStorage.getItem(`today-visit:u:${D}:v2`)).toBeNull()
    // Layer 1 carries the remembered open into the new day's visit.
    expect(band('resting').getAttribute('aria-expanded')).toBe('true')
  })
})

describe('helpers', () => {
  it('namesSummary: three names, then +N', () => {
    expect(namesSummary([{ name: 'A' }, { name: 'B' }])).toBe('A, B')
    expect(namesSummary([{ name: 'A' }, { crop: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' }])).toBe('A, B, C +2')
    expect(namesSummary([])).toBeNull()
  })
  it('activeCareRows excludes cold and skipped rows', () => {
    const rows = activeCareRows(PLAN, new Set(['p1:pest']))
    expect(rows.map((r) => r.need)).not.toContain('cold')
    expect(rows).toHaveLength(6)
  })
})
