// V5-TODAYREDESIGN-001 S5 — Heads-up (storage windows), mounted through the real TodayV2 over the REAL dataset
// (src/data/storageDeadlines.json: sweet potato, window 09-28, deadline 10-10) and the harness's storage state:
// the quiet 09-24 plan re-dated, /api/plants with the 'Sweet Potatoes' planting's status moved from ended to
// vegetative (storage-grafts.json — SYNTHETIC status, real row). Plan-v2 §1.5 / §3 / §8 S5: the boundaries
// (09-27 no · 09-28 opens · 10-07 closed · 10-08..10-10 open · 10-11..10-24 past, closed · 10-25 gone), copy
// verbatim, the warn plate on the last two days, plan-independent and exempt from staleness, MF1's same-day close.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const F = (f) => JSON.parse(readFileSync(resolve(process.cwd(), 'tests/harness/_todaymeasure', f), 'utf8'))
const { planState, prefsState, auth, wire } = vi.hoisted(() => ({
  planState: { current: null },
  prefsState: { current: { prefs: null, prefsLoaded: true, refreshPrefs: async () => null } },
  auth: { user: { id: 'u' } },
  wire: { plants: null, locations: null, plantsLoading: false },
}))
vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => planState.current }))
vi.mock('../context/PrefsContext.jsx', () => ({ usePrefs: () => prefsState.current }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth }))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({ ...(await orig()), fetchNotificationPrefs: vi.fn(async () => null), saveTodaySkipped: vi.fn(async () => null) }))
vi.mock('../lib/api.js', async (orig) => ({ ...(await orig()), useApiFetch: () => ({ getToken: async () => 't', fetch: async () => ({ id: 'ev' }) }) }))
vi.mock('../hooks/useCachedFetch.js', () => ({
  useCachedFetch: (path) => (path === '/api/plants'
    ? { data: wire.plantsLoading ? undefined : wire.plants, loading: wire.plantsLoading, error: null }
    : { data: wire.locations, loading: false, error: null }),
}))

import TodayV2 from '../pages/TodayV2.jsx'
import DATA from '../data/storageDeadlines.json'

const D = F('dailyplan.dave.json')
const SG = F('storage-grafts.json')
const PLANTS = (() => { const p = F('plants.json'); return (Array.isArray(p) ? p : p.plants).map((x) => (x.id === SG.sweet_potato_planting.id ? { ...x, status: SG.sweet_potato_planting.status } : x)) })()
const LOCS = F('locations.full.json')
const COPY = DATA.by_crop_type.sweet_potato.check_copy
const QUIET = {
  ...D.plan, water_due: [], fertilize: [], pest: [], cold: [], dormant: [], no_history: [], rain_skipped: [], overwintering: [],
  dormancy_suppressed: [], feed_suppressed: [], alerts_sent: [], weather: { ...D.plan.weather, callout: null },
}
const onDay = (day, over = {}) => {
  vi.setSystemTime(new Date(day + 'T14:30:00.000Z'))
  planState.current = { data: { has_plan: true, plan_date: day, generated_at: day + 'T14:00:25.318Z', plan: QUIET, ...over }, loading: false, error: null, reload: vi.fn() }
}
const settle = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)) })
const mount = async () => { render(<MemoryRouter><TodayV2 /></MemoryRouter>); await settle() }
const sec = () => screen.queryByTestId('today-sec-headsup')
const band = () => sec().querySelector('[aria-expanded]')
const visit = (day) => JSON.parse(sessionStorage.getItem(`today-visit:u:${day}:v2`))

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  prefsState.current = { prefs: null, prefsLoaded: true, refreshPrefs: async () => null }
  wire.plants = PLANTS; wire.locations = LOCS; wire.plantsLoading = false
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('Heads-up — the storage window on the real dataset', () => {
  it('09-27: nothing to say, so no section', async () => {
    onDay('2026-09-27')
    await mount()
    expect(sec()).toBeNull()
  })

  it('09-28 (the window opens): second in the fixed order, OPEN by itself, the summary and plate from the copy, the cue', async () => {
    onDay('2026-09-28')
    await mount()
    expect(band().getAttribute('aria-expanded')).toBe('true')
    expect(band().textContent).toContain('Heads-up')
    expect(band().textContent).toContain('1')
    expect(band().textContent).toContain('Start checking sweet potatoes for lifting · by Oct 10')
    expect(band().querySelector('svg')).toBeTruthy()
    expect(visit('2026-09-28').triggers.headsup).toEqual({ r: 'window' })
    const body = screen.getByTestId('storage-deadline-alert')
    const row = within(body).getByTestId('headsup-row')
    expect(row.getAttribute('data-slug')).toBe('sweet_potato')
    expect(within(row).getByTestId('headsup-plate').textContent).toBe('by Oct 10')
    expect(within(row).getByTestId('headsup-plate').getAttribute('data-soon')).toBe('false')
    expect(row.textContent).toContain('Sweet Potatoes')
    expect(row.querySelector('h3 button')).toBeTruthy()
  })

  it('the copy is VERBATIM: line 1 is the prefix, the opened panel the rest from the dash — together, the sentence', async () => {
    onDay('2026-09-28')
    await mount()
    const row = screen.getByTestId('headsup-row')
    const toggle = row.querySelector('h3 button')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('headsup-rest')).toBeNull() // closed means unmounted
    fireEvent.click(toggle)
    const rest = screen.getByTestId('headsup-rest')
    expect(toggle.getAttribute('aria-controls')).toBe(rest.id)
    const line1 = toggle.querySelector('span > span').firstChild.textContent
    expect(line1 + ' ' + rest.textContent).toBe(COPY)
    expect(COPY.startsWith(line1 + ' — ')).toBe(true)
  })

  it('10-01 and 10-07: present, closed, no cue', async () => {
    for (const day of ['2026-10-01', '2026-10-07']) {
      onDay(day)
      await mount()
      expect(band().getAttribute('aria-expanded')).toBe('false')
      expect(band().querySelector('svg')).toBeNull()
      cleanup(); sessionStorage.clear()
    }
  })

  it('10-08 … 10-10: open, and the plate turns warn with the severity icon (never colour alone)', async () => {
    for (const day of ['2026-10-08', '2026-10-09', '2026-10-10']) {
      onDay(day)
      await mount()
      expect(band().getAttribute('aria-expanded')).toBe('true')
      expect(visit(day).triggers.headsup).toEqual({ r: 'deadline' })
      const plate = screen.getByTestId('headsup-plate')
      expect(plate.getAttribute('data-soon')).toBe('true')
      expect(plate.querySelector('svg')).toBeTruthy()
      expect(plate.textContent).toBe('by Oct 10')
      cleanup(); sessionStorage.clear()
    }
  })

  it('10-12 (grace): present in the past copy, "was due Oct 10", closed · 10-25: gone', async () => {
    onDay('2026-10-12')
    await mount()
    expect(band().getAttribute('aria-expanded')).toBe('false')
    expect(band().textContent).toContain('Sweet potato lifting window has passed · was due Oct 10')
    cleanup(); sessionStorage.clear()
    onDay('2026-10-25')
    await mount()
    expect(sec()).toBeNull()
  })

  it('exempt from staleness: a plan dated yesterday opens nothing else, but the window\'s first day still opens Heads-up', async () => {
    onDay('2026-09-28', { plan_date: '2026-09-27' })
    await mount()
    expect(band().getAttribute('aria-expanded')).toBe('true')
  })

  it('plan-independent: with no plan at all, Heads-up still renders and opens', async () => {
    onDay('2026-09-28', { has_plan: false, plan: null })
    await mount()
    expect(screen.getByTestId('today-noplan-card')).toBeTruthy()
    expect(screen.queryByTestId('today-glance')).toBeNull()
    expect(band().getAttribute('aria-expanded')).toBe('true')
  })

  it('with no plan, the ready point still waits for /api/plants — the window\'s first day is not missed by a slow list', async () => {
    onDay('2026-09-28', { has_plan: false, plan: null })
    wire.plantsLoading = true
    const { rerender } = render(<MemoryRouter><TodayV2 /></MemoryRouter>)
    await settle()
    expect(screen.getByTestId('today-page').hasAttribute('data-today-ready')).toBe(false)
    wire.plantsLoading = false
    rerender(<MemoryRouter><TodayV2 /></MemoryRouter>)
    await settle()
    expect(screen.getByTestId('today-page').getAttribute('data-today-ready')).toBe('true')
    expect(band().getAttribute('aria-expanded')).toBe('true')
  })

  it('its chip (S3\'s table): second in the bar, after Protect and before the work chips, with no number', async () => {
    onDay('2026-10-08', { plan: D.plan })
    await mount()
    const chips = [...screen.getByRole('navigation', { name: 'Today sections' }).querySelectorAll('[data-chip]')]
    expect(chips.map((c) => c.getAttribute('data-chip')).slice(0, 3)).toEqual(['protect', 'headsup', 'water'])
    expect(chips[1].textContent).toBe('Heads-up')
    const order = [...document.querySelectorAll('[data-testid^="today-sec-"]')].map((s) => s.getAttribute('data-section'))
    expect(order.slice(0, 3)).toEqual(['protect', 'headsup', 'care'])
  })

  it('MF1: a close on a deadline day records {r:"deadline"} and holds that day; the next day opens again', async () => {
    onDay('2026-10-08')
    await mount()
    fireEvent.click(band())
    expect(JSON.parse(localStorage.getItem('today-sections:u')).s.headsup).toEqual({ open: false, at: '2026-10-08', ack: { r: 'deadline' } })
    cleanup(); sessionStorage.clear()
    await mount()
    expect(band().getAttribute('aria-expanded')).toBe('false')
    cleanup(); sessionStorage.clear()
    onDay('2026-10-09')
    await mount()
    expect(band().getAttribute('aria-expanded')).toBe('true')
  })
})
