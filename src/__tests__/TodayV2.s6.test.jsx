// V5-TODAYREDESIGN-001 S6 — the redesigned Today's plan-independent sections, mounted through the real TodayV2 and
// the real band hooks (useTodayBands) on the 2026-09-24 fixtures (tests/harness/_todaymeasure), only the wire
// stubbed. Plan-v2 §8 S6 tests:
//   · the V2 harvest-surface port (Today.harvestSurface.test.jsx's pins, re-anchored): Harvest is a section whose
//     header NAMES what its bands list (no count, no watch denominator), its body is the two bands bare, no
//     HarvestReadyBand is mounted or fetched, and the Sow link row is LAST — the door alone while the 2027 sowing
//     freeze holds, with no sow request;
//   · the CareNeededDormant port: Resting's rows (DormantList, bare), Resume never optimistic;
//   · the page states (§1.4): no plan / error / loading, with the plan-independent sections still rendering;
//   · the ready point waits for the bands (a remembered-open Harvest is open at the visit start), capped at 300 ms;
//   · the handedness adopt runs at the page (hoisted from the watch band, whose body is unmounted while closed).
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const F = (f) => JSON.parse(readFileSync(resolve(process.cwd(), 'tests/harness/_todaymeasure', f), 'utf8'))
const { planState, prefsState, auth, wire, syncSpy } = vi.hoisted(() => ({
  planState: { current: null },
  prefsState: { current: { prefs: null, prefsLoaded: true, refreshPrefs: async () => null } },
  auth: { user: { id: 'harness_user' }, profile: { id: 'harness_user' } },
  wire: (globalThis.__s6wire = { calls: [], watch: null, watchFail: false, watchHold: null, harvests: null, soon: null, putFail: false, putHold: null, plants: null, locations: null, members: null }),
  syncSpy: { calls: 0 },
}))
vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => planState.current }))
vi.mock('../context/PrefsContext.jsx', () => ({ usePrefs: () => prefsState.current }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth }))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({ ...(await orig()), fetchNotificationPrefs: vi.fn(async () => null), saveTodaySkipped: vi.fn(async () => null) }))
vi.mock('../hooks/useHandedness.js', async (orig) => ({ ...(await orig()), useHandednessSync: () => { syncSpy.calls++ } }))
// ONE fetch function for the whole file, as the real useApiFetch memoises its own: the band hooks keep `fetch` in
// their effect deps, so a new function per render would refetch forever.
const api = vi.hoisted(() => {
  const getToken = async () => 't'
  const fetch = async (path, init = {}) => {
    const w = globalThis.__s6wire
    w.calls.push(`${init.method || 'GET'} ${path}`)
    if (path === '/api/harvests/watch?limit=200') {
      if (w.watchHold) return w.watchHold
      if (w.watchFail) throw new Error('offline')
      return w.watch
    }
    if (path.startsWith('/api/harvests?')) return w.harvests
    if (path === '/api/preservation/use-soon') return w.soon
    if (path.startsWith('/api/plants/') && init.method === 'PUT') {
      if (w.putHold) return w.putHold
      if (w.putFail) throw new Error('500')
      return {}
    }
    return null
  }
  return { value: { getToken, fetch } }
})
vi.mock('../lib/api.js', async (orig) => ({ ...(await orig()), useApiFetch: () => api.value }))
vi.mock('../hooks/useCachedFetch.js', () => ({
  useCachedFetch: (path) => ({ data: path === '/api/plants' ? wire.plants : path === '/api/members' ? wire.members : wire.locations, loading: false, error: null }),
}))

import TodayV2 from '../pages/TodayV2.jsx'
import { watchSelection } from '../components/HarvestWatchBand.jsx'

const PAYLOAD = F('dailyplan.dave.json')
const PLANTS = (() => { const p = F('plants.json'); return Array.isArray(p) ? p : p.plants })()
const LOCS = F('locations.full.json')
const WATCH = F('harvestwatch.json')
const JARS = F('storage-grafts.json').use_soon.value
const TODAY = PAYLOAD.plan_date
const NOW = new Date(TODAY + 'T14:30:00.000Z').getTime()
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString()
const pick = (m, name, crop) => ({ event_id: name + m, event_type: 'harvest', created_at: minsAgo(m), created_by: 'harness_user', planting_name: name, variety_name: name, crop_name: crop, quantity: 2, unit: 'count', note_excerpt: null })
const BATCH = { entries: [pick(25, 'Moskvich', 'Tomato'), pick(24, 'San Marzano', 'Tomato'), pick(23, 'Cubanelle', 'Pepper'), pick(22, 'Piri Piri', 'Pepper'), pick(21, 'Sungold', 'Tomato'), pick(20, 'Lemon Drop', 'Pepper')], aggregates: null }

const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)) })
const wait = (ms) => act(async () => { await new Promise((r) => setTimeout(r, ms)) })
const sec = (key) => screen.queryByTestId(`today-sec-${key}`)
const header = (key) => sec(key)?.querySelector('[aria-expanded]')
const calls = (prefix) => wire.calls.filter((c) => c.startsWith(prefix)).length
const mount = async () => { render(<MemoryRouter><TodayV2 /></MemoryRouter>); await settle() }

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  planState.current = { data: PAYLOAD, loading: false, error: null, reload: vi.fn() }
  prefsState.current = { prefs: null, prefsLoaded: true, refreshPrefs: vi.fn(async () => null) }
  Object.assign(wire, { calls: [], watch: WATCH, watchFail: false, watchHold: null, harvests: BATCH, soon: { items: [] }, putFail: false, putHold: null, plants: PLANTS, locations: LOCS, members: { members: [{ id: 'harness_user', display_name: 'Dave N' }, { id: 'member_jen', display_name: 'Jen' }] } })
  syncSpy.calls = 0
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('Harvest — the V2 harvest surface (port of Today.harvestSurface)', () => {
  it('a closed section that NAMES what its bands list: the picks line, then the watch band\'s first three — no count', async () => {
    await mount()
    const h = header('harvest')
    expect(h.getAttribute('aria-expanded')).toBe('false')
    expect(sec('harvest').hasAttribute('data-count')).toBe(false)
    const first3 = watchSelection(WATCH).visible.slice(0, 3).map((c) => c.name).join(', ')
    expect(sec('harvest').querySelector('[data-testid="section-summary"]').textContent).toBe(`6 picks · logged 20 min ago · check ${first3}…`)
    expect(screen.queryByTestId('today-watch-band')).toBeNull() // closed = unmounted
    expect(screen.queryByTestId('compose-harvest-band')).toBeNull()
  })

  it('opened: both bands bare — the compose row first, then the watch rows — from ONE request each', async () => {
    await mount()
    fireEvent.click(header('harvest'))
    await settle()
    const body = sec('harvest')
    const compose = within(body).getByTestId('compose-harvest-band')
    const watch = within(body).getByTestId('today-watch-band')
    expect(compose.compareDocumentPosition(watch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(body.textContent).not.toMatch(/Looking ahead|Worth checking soon|Tonight.s harvest|start of a stream/)
    expect(within(watch).getAllByText(/^Start checking /)).toHaveLength(5)
    expect(calls('GET /api/harvests/watch')).toBe(1)
    expect(calls('GET /api/harvests?')).toBe(1)
  })

  it('mounts no HarvestReadyBand: no "Due for a pick" and no harvest-ready fetch, even opened', async () => {
    await mount()
    fireEvent.click(header('harvest'))
    await settle()
    expect(document.body.textContent).not.toMatch(/Due for a pick/i)
    expect(wire.calls.some((c) => c.includes('/api/events/harvest-ready'))).toBe(false)
  })

  it('no watch denominator anywhere: no "N of M", and the Harvest header carries no number of its own', async () => {
    await mount()
    fireEvent.click(header('harvest'))
    await settle()
    expect(document.body.textContent).not.toMatch(/\b\d+ of \d+\b/)
    expect(sec('harvest').hasAttribute('data-count')).toBe(false)
  })

  it('the Sow link row is LAST, and while the 2027 freeze holds it is the door alone — no sow request at all', async () => {
    await mount()
    const frame = screen.getByTestId('today-page')
    const lead = screen.getByTestId('cultivation-lead')
    expect(frame.lastElementChild).toBe(lead)
    expect(lead.textContent).toBe('All sow windows ›')
    expect(lead.getAttribute('href')).toBe('/seeds?view=sow')
    expect(calls('GET /api/inventory-items/sow-candidates')).toBe(0)
  })

  it('a watch fetch that fails twice reads "Couldn’t check just now" in the header; the body offers Try again', async () => {
    wire.watchFail = true
    wire.harvests = { entries: [], aggregates: null }
    await mount()
    await wait(1800) // useAmbientBandFetch's one retry (RETRY_DELAY_MS) before it calls the fetch failed
    await settle()
    expect(sec('harvest').querySelector('[data-testid="section-summary"]').textContent).toBe('Couldn’t check just now')
    fireEvent.click(header('harvest'))
    await settle()
    expect(within(sec('harvest')).getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(within(sec('harvest')).queryByRole('region')).toBeNull()
  }, 10000)
})

describe('From your Put-Up', () => {
  it('names the use-soon slice\'s jars, past date marked, no count; opened, the band bare with its Open Put-Up door', async () => {
    wire.soon = JARS
    await mount()
    const s = sec('putup')
    expect(header('putup').textContent).toContain('From your Put-Up')
    expect(s.hasAttribute('data-count')).toBe(false)
    expect(s.querySelector('[data-testid="section-summary"]').textContent).toBe('Summer Squash (past date) · Plum · Basil · Basil')
    expect(header('putup').getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(header('putup'))
    await settle()
    const band = within(sec('putup')).getByTestId('putup-use-soon')
    expect(band.getAttribute('style')).toBeNull()
    expect(band.textContent).not.toMatch(/From your stores|Cook these next/)
    expect(within(band).getByRole('button', { name: 'Open Put-Up' })).toBeTruthy()
  })
  it('an empty shelf renders no section (a section with nothing in it renders nothing)', async () => {
    await mount()
    expect(sec('putup')).toBeNull()
  })
})

describe('Resting — DormantList bare (port of CareNeededDormant)', () => {
  it('one explainer, then the rows; Resume is never optimistic, and a resumed plant leaves the list and the count', async () => {
    await mount()
    expect(header('resting').textContent).toContain('9')
    fireEvent.click(header('resting'))
    await settle()
    const body = sec('resting')
    expect(body.textContent.match(/No routine care while resting/g)).toHaveLength(1)
    expect(body.textContent).not.toMatch(/Dormant/)
    let resolvePut
    wire.putHold = new Promise((r) => { resolvePut = r })
    fireEvent.click(within(body).getByRole('button', { name: 'Resume Blackberry' }))
    await settle()
    expect(within(sec('resting')).getByText('Blackberry')).toBeTruthy() // nothing hidden before the PUT lands
    expect(header('resting').textContent).toContain('9')
    resolvePut({})
    await settle()
    expect(within(sec('resting')).queryByText('Blackberry')).toBeNull()
    expect(header('resting').textContent).toContain('8')
    expect(header('resting').textContent).not.toContain('Blackberry')
    expect(wire.calls).toContain('PUT /api/plants/' + PAYLOAD.plan.dormant[0].id)
  })

  it('a failed Resume leaves the row and the count', async () => {
    wire.putFail = true
    await mount()
    fireEvent.click(header('resting'))
    await settle()
    fireEvent.click(within(sec('resting')).getByRole('button', { name: 'Resume Blackberry' }))
    await settle()
    expect(within(sec('resting')).getByText('Blackberry')).toBeTruthy()
    expect(header('resting').textContent).toContain('9')
  })

  it('a resumed plant stays off the list across a close and re-open — the set is held on the visit, not in the body', async () => {
    await mount()
    fireEvent.click(header('resting'))
    await settle()
    fireEvent.click(within(sec('resting')).getByRole('button', { name: 'Resume Kousa Dogwood' }))
    await settle()
    fireEvent.click(header('resting')) // close — the body unmounts
    await settle()
    fireEvent.click(header('resting'))
    await settle()
    expect(within(sec('resting')).queryByText('Kousa Dogwood')).toBeNull()
    expect(header('resting').textContent).toContain('8')
  })
})

describe('the page states (§1.4) — the plan-independent sections still render', () => {
  it('no plan: the one sentence, no glance, no care line — Harvest and Put-Up still there, the Sow row last', async () => {
    wire.soon = JARS
    planState.current = { data: { has_plan: false, plan: null, plan_date: TODAY, generated_at: null }, loading: false, error: null, reload: vi.fn() }
    await mount()
    expect(screen.getByTestId('today-noplan-card').textContent).toBe('Today’s plan hasn’t arrived yet — it’s built overnight.')
    expect(screen.queryByTestId('today-glance')).toBeNull()
    expect(screen.queryByTestId('care-empty')).toBeNull()
    expect(sec('care')).toBeNull()
    expect(sec('harvest')).toBeTruthy()
    expect(sec('putup')).toBeTruthy()
    expect(screen.getByTestId('today-page').lastElementChild).toBe(screen.getByTestId('cultivation-lead'))
  })

  it('an error with no data: the error card with Retry, and still the plan-independent sections', async () => {
    const reload = vi.fn()
    planState.current = { data: null, loading: false, error: 'Network error', reload }
    await mount()
    fireEvent.click(screen.getByRole('button', { name: /retry|try again/i }))
    expect(reload).toHaveBeenCalledTimes(1)
    expect(sec('harvest')).toBeTruthy()
    expect(screen.getByTestId('cultivation-lead')).toBeTruthy()
  })

  it('loading (a cold load): the house loading state, and no section yet — they paint at the ready point', async () => {
    planState.current = { data: null, loading: true, error: null, reload: vi.fn() }
    await mount()
    expect(screen.getByTestId('today-page').textContent).toMatch(/Loading/i)
    expect(sec('harvest')).toBeNull()
    expect(screen.queryByTestId('cultivation-lead')).toBeNull()
  })
})

describe('the ready point waits for the bands (§6.4), capped by the prefs window', () => {
  it('a remembered-open Harvest is OPEN at the visit start, although its data lands after the plan', async () => {
    prefsState.current = { ...prefsState.current, prefs: { today_sections: { v: 1, harvest: { open: true, at: '2026-09-23' } } } }
    await mount()
    expect(header('harvest').getAttribute('aria-expanded')).toBe('true')
    expect(within(sec('harvest')).getByTestId('today-watch-band')).toBeTruthy()
  })

  it('a band slower than the 300 ms window does not hold the page; it is inserted, closed, when it lands', async () => {
    let answer
    wire.watchHold = new Promise((r) => { answer = r })
    wire.harvests = { entries: [], aggregates: null }
    prefsState.current = { ...prefsState.current, prefs: { today_sections: { v: 1, harvest: { open: true, at: '2026-09-23' } } } }
    await mount()
    expect(screen.getByTestId('today-page').getAttribute('data-today-ready')).toBeNull()
    await wait(350)
    expect(screen.getByTestId('today-page').getAttribute('data-today-ready')).toBe('true')
    expect(sec('harvest')).toBeNull()
    expect(sec('resting')).toBeTruthy()
    answer(WATCH)
    await settle()
    expect(header('harvest').getAttribute('aria-expanded')).toBe('false') // §2.9: inserted closed
  })
})

describe('the handedness adopt, hoisted to the page', () => {
  it('runs with Harvest closed — the watch band that used to run it is not mounted', async () => {
    await mount()
    expect(header('harvest').getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('today-watch-band')).toBeNull()
    expect(syncSpy.calls).toBeGreaterThan(0)
  })
})
