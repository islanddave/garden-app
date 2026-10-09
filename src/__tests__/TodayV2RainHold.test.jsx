// BUG-DEFERNOSTRESSOVERRIDE-001 (Design A; Dave 2026-10-09) — the plantings the engine holds for forecast rain,
// listed in the glance card's OPEN state, each with the ordinary Water. Mounted through the real TodayV2 on Dave's
// 2026-09-24 plan with the gate's `bedwait` graft (tests/harness/_todaymeasure: 17 in-ground rows moved to
// rain_skipped with the engine's own item shape and satReason() text), only the wire stubbed — TodayV2NeedsCare's
// harness. Pinned: nothing on the closed card; two honest lines; auto-show at 8 or fewer; the row is PlantCareRow
// with Water only; Water posts the body a list row posts; done line + Undo; "Not logged" + Retry; a waiting row is
// never a Needs care row or part of a Water all. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const F = (f) => JSON.parse(readFileSync(resolve(process.cwd(), 'tests/harness/_todaymeasure', f), 'utf8'))
const { planState, prefsState, auth, wire, api } = vi.hoisted(() => {
  const wire = { posts: [], deletes: [], failPlant: null, seq: 0, plants: null, locations: null }
  return {
    planState: { current: null },
    prefsState: { current: { prefs: null, prefsLoaded: true, refreshPrefs: async () => null } },
    auth: { user: { id: 'u' } },
    wire,
    api: {
      getToken: async () => 't',
      fetch: async (path, init = {}) => {
        if (init.method === 'DELETE') { wire.deletes.push(path); return {} }
        if (init.method === 'POST') {
          const body = JSON.parse(init.body)
          if (body.plant_id === wire.failPlant) throw new Error('offline')
          wire.posts.push(body)
          return { id: 'ev' + (++wire.seq) }
        }
        return null
      },
    },
  }
})
vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => planState.current }))
vi.mock('../context/PrefsContext.jsx', () => ({ usePrefs: () => prefsState.current }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth }))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({ ...(await orig()), fetchNotificationPrefs: vi.fn(async () => null), saveTodaySkipped: vi.fn(async () => null) }))
vi.mock('../lib/api.js', async (orig) => ({ ...(await orig()), useApiFetch: () => api }))
vi.mock('../hooks/useCachedFetch.js', () => ({ useCachedFetch: (path) => ({ data: path === '/api/plants' ? wire.plants : wire.locations, loading: false, error: null }) }))
vi.mock('../components/today/v2/useTodayBands.js', () => ({
  useTodayBands: () => ({ settled: true, watch: { data: null, failed: false, reload() {} }, compose: { data: null, settled: true, reload() {} }, soon: { data: null, failed: false, reload() {} }, sow: { items: null, settled: true }, harvest: { present: false, summary: null }, putup: { present: false, summary: null } }),
}))

import TodayV2 from '../pages/TodayV2.jsx'
import * as store from '../components/today/v2/needsCareStore.js'
import { applyGrafts } from '../../tests/harness/_todaymeasure/v2wire.js'
import { FORECAST_SAT_KINDS } from '../lib/rainHold.js'
import { COHORT_CAP } from '../lib/todayV2/spots.js'

const PAYLOAD = F('dailyplan.dave.json')
const PLANTS = (() => { const p = F('plants.json'); return Array.isArray(p) ? p : p.plants })()
const LOCS = F('locations.full.json')
const G = F('v2-grafts.json')
const TODAY = PAYLOAD.plan_date
const HELD = applyGrafts(PAYLOAD, PLANTS, ['bedwait'], G)
const ALL = HELD.payload.plan.rain_skipped
// A rain-credit item as the engine's credit arm writes it: no sat_kind.
const fell = (it) => ({ id: it.id, name: it.name, crop: it.crop, project: it.project, project_id: it.project_id, in_ground: it.in_ground, days_since: it.days_since, interval: it.interval, credited_days: 2, reason: 'Skip — 0.6" rain over the last few days counts as watering' })
const payloadWith = (rain_skipped) => ({ ...HELD.payload, plan: { ...HELD.payload.plan, rain_skipped } })

const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)) })
const glance = () => screen.getByTestId('today-glance')
const toggle = () => glance().querySelector('h2 > button[aria-expanded]')
const note = () => document.querySelector('[data-testid="care-rain-note"]')
const waitRows = () => [...document.querySelectorAll('[data-testid="rain-wait-row"]')]
const waitLineText = () => document.querySelector('[data-testid="rain-waiting-line"]')?.textContent
const careCount = () => screen.getByTestId('today-sec-care').querySelector('[aria-expanded]').textContent

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear()
  store.__resetTodayLogged()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(TODAY + 'T14:30:00.000Z'))
  wire.posts = []; wire.deletes = []; wire.failPlant = null; wire.seq = 0; wire.plants = HELD.plants; wire.locations = LOCS
})
afterEach(() => { cleanup(); vi.useRealTimers() })

async function mount(rain_skipped, { open = true } = {}) {
  planState.current = { data: payloadWith(rain_skipped), loading: false, error: null, reload: vi.fn() }
  render(<MemoryRouter><TodayV2 /></MemoryRouter>)
  await settle()
  // The card's open state is remembered per device (Layer 1): a second mount in one case may start open.
  if (open && toggle().getAttribute('aria-expanded') !== 'true') { fireEvent.click(toggle()); await settle() }
}

describe('the fixture is the engine\'s', () => {
  it('17 held rows, every one a forecast kind with the engine\'s reason text', () => {
    expect(ALL.length).toBe(17)
    for (const it of ALL) { expect(FORECAST_SAT_KINDS.has(it.sat_kind)).toBe(true); expect(it.reason).toMatch(/^Skip — 0\.62" rain expected tomorrow @ 70%/) }
  })
})

describe('the closed card', () => {
  it('says nothing about held plantings, and is the same markup with 17 held as with none', async () => {
    await mount(ALL, { open: false })
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(note()).toBeNull()
    expect(waitRows().length).toBe(0)
    expect(glance().textContent).not.toMatch(/Waiting for rain/)
    const withHolds = glance().outerHTML
    cleanup()
    await mount([], { open: false })
    expect(glance().outerHTML).toBe(withHolds)
  })
})

describe('the open card — two honest lines', () => {
  it('3 waiting: the list shows itself; each row is the plant, when and how much, and Water — nothing else', async () => {
    const three = ALL.slice(0, 3)
    await mount(three)
    expect(waitLineText()).toBe('Waiting for rain · 3')
    const t = screen.getByTestId('rain-waiting-toggle')
    expect(t.textContent).toBe('Hide')
    expect(t.getAttribute('aria-expanded')).toBe('true')
    expect(t.getAttribute('aria-label')).toBe('Hide the 3 plantings waiting for rain')
    const rows = waitRows()
    expect(rows.length).toBe(3)
    rows.forEach((row, i) => {
      expect(row.textContent).toContain(three[i].name)
      expect(row.textContent).toContain('Rain expected tomorrow · 0.62″')
      expect(row.textContent).not.toMatch(/@|%|Skip|deferred|saturat/i)
      const buttons = within(row).getAllByRole('button')
      expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Log Water for ' + three[i].name])
      expect(buttons[0].textContent).toBe('Water')
      expect(row.getAttribute('role')).toBe('listitem')
    })
    // No held planting was rained on: nothing says rain fell.
    expect(screen.queryByTestId('rain-covered-line')).toBeNull()
    expect(note().textContent).not.toMatch(/recent rain|covered|handled|already fell|watered by rain|counts/i)
    // The rows are siblings of the card's toggle, never inside it.
    expect(toggle().contains(rows[0])).toBe(false)
    expect(rows[0].closest('button')).toBeNull()
    expect(glance().contains(rows[0])).toBe(true)
  })

  it('8 waiting shows itself; 9 waits behind Show, and Show / Hide is the visit\'s', async () => {
    await mount(ALL.slice(0, 8))
    expect(waitRows().length).toBe(8)
    cleanup()
    await mount(ALL.slice(0, 9))
    expect(waitLineText()).toBe('Waiting for rain · 9')
    expect(waitRows().length).toBe(0)
    const t = screen.getByTestId('rain-waiting-toggle')
    expect(t.textContent).toBe('Show')
    expect(t.getAttribute('aria-expanded')).toBe('false')
    expect(t.getAttribute('aria-label')).toBe('Show the 9 plantings waiting for rain')
    fireEvent.click(t); await settle()
    expect(waitRows().length).toBe(9)
    expect(screen.getByTestId('rain-waiting-toggle').textContent).toBe('Hide')
    fireEvent.click(screen.getByTestId('rain-waiting-toggle')); await settle()
    expect(waitRows().length).toBe(0)
    // Closing and re-opening the card keeps the visit's choice (it was hidden by hand).
    fireEvent.click(screen.getByTestId('rain-waiting-toggle')); await settle()
    fireEvent.click(toggle()); await settle()
    expect(note()).toBeNull()
    fireEvent.click(toggle()); await settle()
    expect(waitRows().length).toBe(9)
  })

  it('rain that fell: "Already watered by rain · M", no control; a missing sat_kind is never a waiting row', async () => {
    await mount(ALL.slice(0, 2).map(fell))
    expect(screen.getByTestId('rain-covered-line').textContent).toBe('Already watered by rain · 2')
    expect(screen.queryByTestId('rain-waiting')).toBeNull()
    expect(waitRows().length).toBe(0)
    expect(within(note()).queryAllByRole('button').length).toBe(0)
  })

  it('both: waiting first, then covered; a held planting the read path marks done (watered elsewhere) is neither', async () => {
    await mount([...ALL.slice(0, 3), { ...ALL[3], done: true }, ...ALL.slice(4, 6).map(fell)])
    expect(waitLineText()).toBe('Waiting for rain · 3')
    expect(waitRows().length).toBe(3)
    expect(note().textContent).not.toContain(ALL[3].name)
    expect(screen.getByTestId('rain-covered-line').textContent).toBe('Already watered by rain · 2')
    expect(note().firstElementChild.getAttribute('data-testid')).toBe('rain-waiting')
  })

  it('nothing held and nothing covered: no rain lines at all', async () => {
    await mount([])
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(note()).toBeNull()
  })
})

// A same-day forecast below 85F holds every due outdoor planting, pots included (review I2: ~150 on the busy
// fixture). 150 of the plan's own water_due items, moved to rain_skipped as the engine's 'today' kind writes them.
describe('150 waiting: the list is capped as a Needs care cohort is', () => {
  const MOVED = HELD.payload.plan.water_due.slice(0, 150)
  const MANY = MOVED.map((it) => ({ ...ALL[0], id: it.id, name: it.name, crop: it.crop, project: it.project, project_id: it.project_id, in_ground: it.in_ground, days_since: it.days_since, interval: it.interval, sat_kind: 'today', reason: 'Skip — 0.6" rain expected later today @ 70%; waiting for it beats watering twice' }))
  async function mountMany() {
    planState.current = { data: { ...HELD.payload, plan: { ...HELD.payload.plan, water_due: HELD.payload.plan.water_due.slice(150), rain_skipped: MANY } }, loading: false, error: null, reload: vi.fn() }
    render(<MemoryRouter><TodayV2 /></MemoryRouter>)
    await settle()
    if (toggle().getAttribute('aria-expanded') !== 'true') { fireEvent.click(toggle()); await settle() }
  }

  it('behind Show; Show draws 20 and "Show 130 more"; that draws the rest; the heading says 150 throughout', async () => {
    expect(MANY.length).toBe(150)
    await mountMany()
    expect(waitLineText()).toBe('Waiting for rain · 150')
    expect(waitRows().length).toBe(0)
    expect(screen.queryByTestId('rain-show-more')).toBeNull()
    const t = screen.getByTestId('rain-waiting-toggle')
    expect(t.textContent).toBe('Show')
    expect(t.getAttribute('aria-label')).toBe('Show the 150 plantings waiting for rain')
    fireEvent.click(t); await settle()
    expect(waitRows().length).toBe(COHORT_CAP)
    expect(COHORT_CAP).toBe(20)
    expect(waitRows().map((r) => r.getAttribute('data-key'))).toEqual(MANY.slice(0, 20).map((it) => it.id + ':rain_skipped'))
    expect(waitLineText()).toBe('Waiting for rain · 150')
    const more = screen.getByTestId('rain-show-more')
    expect(more.textContent).toBe('Show 130 more')
    expect(more.closest('[data-testid="rain-wait-row"]')).toBeNull()
    expect(screen.getByTestId('rain-cap-note').textContent).toBe('Showing 20 of 150.')
    fireEvent.click(more); await settle()
    expect(waitRows().length).toBe(150)
    expect(screen.queryByTestId('rain-show-more')).toBeNull()
    expect(screen.queryByTestId('rain-cap-note')).toBeNull()
    expect(waitLineText()).toBe('Waiting for rain · 150')
    // Hide and Show again: the visit keeps "all".
    fireEvent.click(screen.getByTestId('rain-waiting-toggle')); await settle()
    expect(waitRows().length).toBe(0)
    fireEvent.click(screen.getByTestId('rain-waiting-toggle')); await settle()
    expect(waitRows().length).toBe(150)
  })

  it('20 waiting is the whole list: no "Show more"; 21 is 20 and "Show 1 more"', async () => {
    planState.current = { data: payloadWith(MANY.slice(0, 20)), loading: false, error: null, reload: vi.fn() }
    render(<MemoryRouter><TodayV2 /></MemoryRouter>); await settle()
    if (toggle().getAttribute('aria-expanded') !== 'true') { fireEvent.click(toggle()); await settle() }
    fireEvent.click(screen.getByTestId('rain-waiting-toggle')); await settle()
    expect(waitRows().length).toBe(20)
    expect(screen.queryByTestId('rain-show-more')).toBeNull()
    cleanup(); sessionStorage.clear()
    planState.current = { data: payloadWith(MANY.slice(0, 21)), loading: false, error: null, reload: vi.fn() }
    render(<MemoryRouter><TodayV2 /></MemoryRouter>); await settle()
    if (toggle().getAttribute('aria-expanded') !== 'true') { fireEvent.click(toggle()); await settle() }
    fireEvent.click(screen.getByTestId('rain-waiting-toggle')); await settle()
    expect(waitRows().length).toBe(20)
    expect(screen.getByTestId('rain-show-more').textContent).toBe('Show 1 more')
  })
})

describe('Water on a waiting row is the ordinary watering', () => {
  it('posts the body a Needs care row\'s Water posts; the row becomes its done line with Undo; Undo deletes that event', async () => {
    const three = ALL.slice(0, 3)
    await mount(three)
    const before = careCount()
    fireEvent.click(within(waitRows()[0]).getByRole('button', { name: 'Log Water for ' + three[0].name }))
    await settle()
    expect(wire.posts.length).toBe(1)
    const held = wire.posts[0]
    expect(held.plant_id).toBe(three[0].id)
    expect(held.project_id).toBe(three[0].project_id)
    expect(held.event_type).toBe('watering')

    // The same tap on an ordinary list row (Drive-Shade: 5 water rows, every row shown).
    const spot = document.querySelector('[data-testid="care-spot"][data-spot="Drive-Shade"]')
    fireEvent.click(within(spot).getAllByRole('button', { expanded: false })[0]); await settle()
    const listRow = document.querySelector('[data-testid="care-spot"][data-spot="Drive-Shade"] [data-testid="care-row"]')
    fireEvent.click(within(listRow).getByRole('button', { name: /^Log Water for / })); await settle()
    expect(wire.posts.length).toBe(2)
    const listed = wire.posts[1]
    const shape = ({ plant_id, project_id, ...rest }) => rest // eslint-disable-line no-unused-vars
    expect(shape(held)).toEqual(shape(listed))
    expect(Object.keys(held).sort()).toEqual(Object.keys(listed).sort())
    expect(held.metadata).toEqual(listed.metadata)
    expect(held.metadata).toBeTruthy()

    // Done line in place, the count drops, Needs care never moved for the held one.
    const done = document.querySelector('[data-testid="care-rain-note"] [data-testid="care-row-done"]')
    expect(done.textContent).toContain(three[0].name + ' · watered')
    expect(waitRows().length).toBe(2)
    expect(waitLineText()).toBe('Waiting for rain · 2')
    expect(screen.getByTestId('today-status').textContent).toMatch(/: watered\.$/)
    expect(before).toMatch(/\d/)

    fireEvent.click(within(done).getByRole('button', { name: 'Undo: ' + three[0].name + ' watered' }))
    await settle()
    expect(wire.deletes).toEqual(['/api/events/ev1'])
    expect(waitRows().length).toBe(3)
    expect(waitLineText()).toBe('Waiting for rain · 3')
    expect(within(waitRows()[0]).getByRole('button', { name: 'Log Water for ' + three[0].name })).toBeTruthy()
  })

  it('the done line takes focus (the Water chip is gone), and the last one watered keeps the line for its Undo', async () => {
    const one = ALL.slice(0, 1)
    await mount(one)
    fireEvent.click(within(waitRows()[0]).getByRole('button', { name: 'Log Water for ' + one[0].name }))
    await settle()
    expect(document.activeElement.getAttribute('data-focus-id')).toBe('row:' + one[0].id + ':rain_skipped')
    expect(waitLineText()).toBe('Waiting for rain · 0')
    expect(within(note()).getByRole('button', { name: /^Undo: / })).toBeTruthy()
  })

  it('a write that fails: "Not logged" with Retry on the row, nothing faded; Retry posts the watering', async () => {
    const three = ALL.slice(0, 3)
    await mount(three)
    wire.failPlant = three[1].id
    fireEvent.click(within(waitRows()[1]).getByRole('button', { name: 'Log Water for ' + three[1].name }))
    await settle()
    expect(wire.posts.length).toBe(0)
    const row = waitRows()[1]
    expect(row.textContent).toContain('Not logged')
    expect(within(row).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Retry: ' + three[1].name])
    expect(document.activeElement.getAttribute('aria-label')).toBe('Retry: ' + three[1].name)
    expect(waitLineText()).toBe('Waiting for rain · 3')
    expect(screen.getByTestId('today-status').textContent).toBe(three[1].name + ' not logged. Retry is on the row.')
    wire.failPlant = null
    fireEvent.click(within(row).getByRole('button', { name: 'Retry: ' + three[1].name }))
    await settle()
    expect(wire.posts.map((b) => [b.plant_id, b.event_type])).toEqual([[three[1].id, 'watering']])
    expect(document.querySelector('[data-testid="care-rain-note"] [data-testid="care-row-done"]').textContent).toContain(three[1].name + ' · watered')
    expect(waitLineText()).toBe('Waiting for rain · 2')
  })

  it('a second tap while the first is in the air posts once', async () => {
    const one = ALL.slice(0, 1)
    await mount(one)
    const chip = within(waitRows()[0]).getByRole('button', { name: 'Log Water for ' + one[0].name })
    fireEvent.click(chip); fireEvent.click(chip)
    await settle()
    expect(wire.posts.length).toBe(1)
  })
})

describe('a waiting planting is never Needs care\'s', () => {
  it('the count, the group Water all and its run are the same with 17 held as with none', async () => {
    await mount(ALL)
    const group = () => document.querySelector('[data-testid="care-group-bulk"][data-group="Outside"]')
    const count = careCount()
    expect(group().getAttribute('aria-label')).toBe('Water all 137 outside')
    fireEvent.click(group()); await settle()
    expect(wire.posts.length).toBe(137)
    const heldIds = new Set(ALL.map((it) => it.id))
    expect(wire.posts.some((b) => heldIds.has(b.plant_id))).toBe(false)
    // The two in-ground beds the engine kept ARE in it.
    for (const id of G.bedwait.carve_outs) expect(wire.posts.some((b) => b.plant_id === id)).toBe(true)
    expect(waitLineText()).toBe('Waiting for rain · 17')
    cleanup()
    wire.posts = []
    store.__resetTodayLogged(); sessionStorage.clear()
    await mount([])
    expect(careCount()).toBe(count)
    expect(group().getAttribute('aria-label')).toBe('Water all 137 outside')
  })
})
