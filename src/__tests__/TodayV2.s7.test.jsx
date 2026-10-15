// V5-TODAYREDESIGN-001 S7 — the page's half of Layer 1's server copy: ONLY an explicit header tap reaches the
// server (plan-v2 §2.1). Expand/Collapse all, a chip jump and a trigger move the visit and never send. The sender
// itself (sent alone, merged per key, kept dirty on failure) is useTodaySections.sync.test.jsx; here the page is
// mounted whole and the one network door, saveTodaySections, is watched.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { planState, prefsState, auth, api, saves } = vi.hoisted(() => ({
  planState: { current: null },
  prefsState: { current: { prefs: null, prefsLoaded: true, refreshPrefs: async () => null } },
  auth: { user: { id: 'u' } },
  api: { fetch: async () => ({ id: 'ev' }), getToken: async () => 't' },
  saves: [],
}))
vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => planState.current }))
vi.mock('../context/PrefsContext.jsx', () => ({ usePrefs: () => prefsState.current }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth }))
vi.mock('../lib/api.js', async (orig) => ({ ...(await orig()), useApiFetch: () => api }))
vi.mock('../hooks/useCachedFetch.js', () => ({ useCachedFetch: (path) => ({ data: path === '/api/plants' ? [] : { locations: [] }, loading: false, error: null }) }))
vi.mock('../components/today/v2/useTodayBands.js', () => ({
  useTodayBands: () => ({ settled: true, watch: { data: null, failed: false, reload() {} }, compose: { data: null, settled: true, reload() {} }, soon: { data: null, failed: false, reload() {} }, sow: { items: null, settled: true }, harvest: { present: false, summary: null }, putup: { present: false, summary: null } }),
}))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({
  ...(await orig()),
  saveTodaySections: vi.fn(async ({ sections }) => { saves.push(sections); return { ok: true } }),
}))

import TodayV2 from '../pages/TodayV2.jsx'

const TODAY = '2026-10-14'
const row = (id, extra = {}) => ({ id, name: `Plant ${id}`, crop: 'Kale', ...extra })
const WEATHER = { tonightLow: 55, highToday: 72, code: 3, hot: false }
const HYDRO = { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0, tomorrow_pop: 0, status: { ok: true, uncertainty: { flag: false } } }
const PLAN = {
  weather: WEATHER, hydrology: HYDRO,
  water_due: [row('w1'), row('w2'), row('w3')],
  no_history: [row('n1', { never: true })],        // the "never" reason: Needs care opens by itself
  fertilize: [row('f1'), row('f2')],
  pest: [row('p1')],
  overwintering: [],
  cold: [],
  dormant: [row('d1', { name: 'Blackberry' })],
}
const payload = () => ({ data: { has_plan: true, plan_date: TODAY, generated_at: `${TODAY}T14:00:00.000Z`, plan: PLAN }, loading: false, error: null, reload: vi.fn() })
const mount = async () => { render(<MemoryRouter><TodayV2 /></MemoryRouter>); await act(async () => {}) }
const band = (key) => screen.getByTestId(`today-sec-${key}`).querySelector('[aria-expanded]')
const chip = (k) => screen.getByRole('navigation', { name: 'Today sections' }).querySelector(`[data-chip="${k}"]`)
const flush = () => act(async () => {})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(TODAY + 'T14:30:00.000Z'))
  localStorage.clear(); sessionStorage.clear()
  saves.length = 0
  planState.current = payload()
  prefsState.current = { prefs: null, prefsLoaded: true, refreshPrefs: vi.fn(async () => null) }
  auth.user = { id: 'u' }
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { cleanup(); vi.useRealTimers(); delete Element.prototype.scrollIntoView })

describe('S7 — only a header tap reaches the server', () => {
  it('a trigger opening Needs care at the visit start sends nothing', async () => {
    await mount()
    expect(band('care').getAttribute('aria-expanded')).toBe('true')
    await flush()
    expect(saves).toEqual([])
  })

  it('Expand all, Collapse all and a chip jump send nothing', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    fireEvent.click(chip('feed'))
    await flush()
    expect(band('care').getAttribute('aria-expanded')).toBe('true')
    expect(saves).toEqual([])
    expect(localStorage.getItem('today-sections:u')).toBeNull()
  })

  it('a header tap sends exactly that section, and the 200 clears it from dirty', async () => {
    await mount()
    fireEvent.click(band('resting'))
    await flush()
    expect(saves).toEqual([{ v: 1, resting: { open: true, at: TODAY } }])
    expect(JSON.parse(localStorage.getItem('today-sections:u'))).toEqual({ v: 1, s: { resting: { open: true, at: TODAY } }, dirty: [] })
  })

  it('closing a section the trigger opened sends the date-scoped ack (MF1)', async () => {
    await mount()
    fireEvent.click(band('care'))
    await flush()
    expect(saves).toEqual([{ v: 1, care: { open: false, at: TODAY, ack: { r: 'never' } } }])
  })

  it('a visit start sends what an earlier visit left dirty, and nothing it has already had confirmed', async () => {
    localStorage.setItem('today-sections:u', JSON.stringify({
      v: 1, s: { harvest: { open: true, at: '2026-10-13' }, resting: { open: true, at: '2026-10-12' } }, dirty: ['harvest'],
    }))
    await mount()
    await flush()
    expect(saves).toEqual([{ v: 1, harvest: { open: true, at: '2026-10-13' } }])
  })
})
