// V5-TODAYREDESIGN-001 S2 — the redesigned Today's skeleton: frame, title row, date, page states, the section
// bands, and the three state layers wired together (plan-v2 §1.0–1.4, §2.1–2.2, §4, §6.4).
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { planState, prefsState, auth, api } = vi.hoisted(() => ({
  planState: { current: null },
  prefsState: { current: { prefs: null, prefsLoaded: true, refreshPrefs: async () => null } },
  auth: { user: { id: 'u' } },
  // ONE api object for the file, as the real useApiFetch memoises its own: hooks keep `fetch` in their effects'
  // deps, so a new function per render re-runs them on every render (integration 2, seam 5).
  api: { fetch: async () => ({ id: 'ev' }), getToken: async () => 't' },
}))
vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: (opts) => { planState.lastOpts = opts; return planState.current } }))
vi.mock('../context/PrefsContext.jsx', () => ({ usePrefs: () => prefsState.current }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth }))
// S4: Needs care reads /api/plants + /api/locations (useCachedFetch) and writes through useApiFetch — the
// documented test seam (api.js), so no Clerk provider is needed here.
vi.mock('../lib/api.js', async (orig) => ({ ...(await orig()), useApiFetch: () => api }))
vi.mock('../hooks/useCachedFetch.js', () => ({ useCachedFetch: (path) => ({ data: path === '/api/plants' ? [] : { locations: [] }, loading: false, error: null }) }))
// S6: the plan-independent bands (Harvest, Put-Up, the Sow row's lines) are fetched at the page and the ready point
// waits for them (useTodayBands); this file is not about them, so they answer at once, settled and empty.
vi.mock('../components/today/v2/useTodayBands.js', () => ({
  useTodayBands: () => ({ settled: true, watch: { data: null, failed: false, reload() {} }, compose: { data: null, settled: true, reload() {} }, soon: { data: null, failed: false, reload() {} }, sow: { items: null, settled: true }, harvest: { present: false, summary: null }, putup: { present: false, summary: null } }),
}))

import TodayV2, { namesSummary, activeCareRows } from '../pages/TodayV2.jsx'
import { PLAN_DATE, GEN, planFor, tonight, coldText, coldTextAllYear } from './helpers/twoLowsFixtures.js'

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

  // Finish plan D-1: the caught-up line sits in Needs care's SLOT — after Protect tonight, never above it.
  it('D-1: with Protect on the page and nothing to care for, the caught-up line comes after Protect', () => {
    planState.current = { data: { has_plan: true, plan_date: D, plan: { water_due: [], cold: PLAN.cold, dormant: [] } }, loading: false, error: null, reload: vi.fn() }
    mount()
    const empty = screen.getByTestId('care-empty')
    const protect = screen.getByTestId('today-sec-protect')
    expect(protect.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // Finish plan D-5: V1 always shows the "No feed schedule" line; the redesigned page dropped it whenever Needs care
  // was absent. On an empty day it now sits with the caught-up line, in the page's own words and type size.
  it('D-5: an empty day still says which plantings have no feed schedule', () => {
    planState.current = { data: { has_plan: true, plan_date: D, plan: { water_due: [], dormant: [], feed_suppressed: [row('s1', { name: 'Hydrangea' }), row('s2', { name: 'Rose' })] } }, loading: false, error: null, reload: vi.fn() }
    mount()
    const line = screen.getByTestId('care-feed-suppressed')
    expect(line.textContent).toContain('No feed schedule: 2 plantings')
    expect(screen.getByTestId('care-empty').compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(line.querySelector('button'))
    expect(line.textContent).toContain('Fed on plant signals, never by the calendar.')
    expect(line.textContent).toContain('Hydrangea')
  })

  // Finish plan D-9: the stale marker lived only inside the glance card, which a plan with no weather does not have.
  it('D-9: yesterday\'s plan with no weather still says how old it is', () => {
    planState.current = { data: { has_plan: true, plan_date: '2020-01-01', generated_at: null, plan: { water_due: [], dormant: [] } }, loading: false, error: null, reload: vi.fn() }
    mount()
    expect(screen.queryByTestId('today-glance')).toBeNull()
    const stale = screen.getByTestId('today-stale')
    expect(stale.getAttribute('data-stale')).toBe('true')
    expect(stale.textContent).toBe('An older plan')
  })

  // Finish plan D-7: a one-item section that is open drops its summary (it would repeat its only row).
  it('D-7: Resting with one plant names it while closed, and drops the name once opened', () => {
    planState.current = { data: { has_plan: true, plan_date: D, plan: { ...PLAN, dormant: [row('d1', { name: 'Blackberry' })] } }, loading: false, error: null, reload: vi.fn() }
    mount()
    const sec = () => screen.getByTestId('today-sec-resting')
    expect(sec().querySelector('[data-testid="section-summary"]').textContent).toBe('Blackberry')
    fireEvent.click(band('resting'))
    expect(sec().querySelector('[data-testid="section-summary"]')).toBeNull()
  })

  // Finish plan D-5: the feeding note showed only under the Feed filter; now it heads the Needs care body whenever it
  // asks for something, as an advisory line, and stays quiet when the engine holds feeding.
  it('D-5: the feeding note heads the opened Needs care body without a filter; on hold, it says nothing', () => {
    planState.current = { data: { has_plan: true, plan_date: D, plan: { ...PLAN, substrate: { msg: '3 plantings are past the feed window.', on_hold: false } } }, loading: false, error: null, reload: vi.fn() }
    mount()
    fireEvent.click(band('care'))
    const note = screen.getByTestId('today-substrate-note')
    expect(note.textContent).toBe('3 plantings are past the feed window.')
    expect(screen.getByTestId('today-care').firstElementChild).toBe(note)
    cleanup()
    planState.current = { data: { has_plan: true, plan_date: D, plan: { ...PLAN, substrate: { msg: 'Feeding on hold.', on_hold: true } } }, loading: false, error: null, reload: vi.fn() }
    mount()
    fireEvent.click(band('care'))
    expect(screen.queryByTestId('today-substrate-note')).toBeNull()
  })

  // Finish plan D-9 + review I-2: the verdict counts the Water rows still on the list — never-watered ones too — so
  // it cannot say "Nothing due" while the Water chip still counts one.
  it('D-9: with the overdue rows skipped and a never-watered row left, the verdict still asks for water', () => {
    const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)
    localStorage.setItem(`today-skipped:${today}`, JSON.stringify(['w1:water_due', 'w2:water_due', 'w3:water_due']))
    const weather = { tonightLow: 55, highToday: 72, code: 3, hot: false }
    const hydrology = { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0, tomorrow_pop: 0, upcoming_precip_in: 0 }
    planState.current = { data: { has_plan: true, plan_date: today, plan: { ...PLAN, cold: [], weather, hydrology } }, loading: false, error: null, reload: vi.fn() }
    mount()
    expect(screen.getByTestId('today-verdict').textContent).not.toMatch(/Nothing due/)
    expect(screen.getByTestId('today-verdict').textContent).toMatch(/^Water/)
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

// V5-CHILLBAND-001 — the cold line's words follow the season of the PLAN DATE, and on a night the frost line
// names, the page re-words the cue at the agreed low (src/lib/tonightLow.js agreeCallout). That re-wording
// needs the plan date from THIS page: without it the line would fall back to the all-year words in the fall.
describe('TodayV2 hands the plan date to the cue it re-words', () => {
  // No cold cards on the plan, so no Protect section takes the cue (finish plan §3.3): it is its own line.
  it('plan dated Oct 9, engine cue at 44, frost line naming tonight at 42 -> "Cold night (42°F)" in the FALL words', () => {
    const plan = { ...planFor(44, [tonight(42)]), cold: [] }
    expect(plan.weather.callout).toEqual({ icon: 'cold', text: coldText(44) })   // the real engine's, for PLAN_DATE
    planState.current = { data: { has_plan: true, plan_date: PLAN_DATE, generated_at: GEN, plan }, loading: false, error: null, reload: vi.fn() }
    mount()
    const cue = screen.getByTestId('weather-cue-line')
    expect(cue.textContent).toBe('Cold night (42°F) — pick coloring peppers & tomatoes')
    expect(cue.textContent).not.toBe(coldTextAllYear(42))
    expect(cue.dataset.cue).toBe('cold')
  })
  // Finish plan §3.3 (D15): with Protect on the page the same cue is the pick link's words — the fall words prove
  // the date arrived (the all-year cue, "protect flowering…", is no pick and leaves the link its own words).
  it('the same night with cold cards: Protect carries the cue as its pick link, and the glance prints no cue line', async () => {
    const plan = planFor(44, [tonight(42)])
    planState.current = { data: { has_plan: true, plan_date: PLAN_DATE, generated_at: GEN, plan }, loading: false, error: null, reload: vi.fn() }
    mount()
    expect(screen.queryByTestId('weather-cue-line')).toBeNull()
    // The plan is dated Oct 9, not this device's today, so nothing opens by itself (stale, §3): open Protect.
    const sec = await screen.findByTestId('today-sec-protect')
    fireEvent.click(sec.querySelector('[aria-expanded]'))
    const pick = await screen.findByTestId('protect-pick')
    expect(pick.textContent).toBe('Pick coloring peppers & tomatoes first — log a harvest ›')
  })
})
