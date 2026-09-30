// V5-TODAYREDESIGN-001 S4 — the redesigned Needs care, mounted through the real TodayV2 on Dave's 2026-09-24 plan
// (tests/harness/_todaymeasure), only the wire stubbed. Plan-v2 §8 S4 tests: Not today uses the ONE shared skip
// set and its Undo un-skips; a spot's Water all logs its candidates and shrinks to a done line with Undo that
// deletes exactly what it created; a per-plant Moist leaves its done line and turns the spot's button into
// "Water the other N"; a failed write stays on the row as "Not logged · Retry" (no toast); group Water all
// (MF3) is ONE line with ONE Undo; the trigger opened the section (small pots). No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const F = (f) => JSON.parse(readFileSync(resolve(process.cwd(), 'tests/harness/_todaymeasure', f), 'utf8'))
const { planState, prefsState, auth, wire, api } = vi.hoisted(() => {
  const wire = { posts: [], deletes: [], failPlant: null, failPlants: new Set(), seq: 0, plants: null, locations: null, cf: {} }
  return {
    planState: { current: null },
    prefsState: { current: { prefs: null, prefsLoaded: true, refreshPrefs: async () => null } },
    auth: { user: { id: 'u' } },
    wire,
    // ONE api object for the file, as the real useApiFetch memoises its own: hooks keep `fetch` in their effects'
    // deps, so a new function per render re-runs them on every render (integration 2, seam 5).
    api: {
      getToken: async () => 't',
      fetch: async (path, init = {}) => {
        if (init.method === 'DELETE') { wire.deletes.push(path); return {} }
        if (init.method === 'POST') {
          const body = JSON.parse(init.body)
          if (body.plant_id === wire.failPlant || wire.failPlants.has(body.plant_id)) throw new Error('offline')
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
// wire.cf[path] overrides one read's whole answer (a failure, a pending read — review 4160.2 IMPORTANT-3).
vi.mock('../hooks/useCachedFetch.js', () => ({ useCachedFetch: (path) => (wire.cf[path] || { data: path === '/api/plants' ? wire.plants : wire.locations, loading: false, error: null }) }))
// S6: the plan-independent bands (Harvest, Put-Up, the Sow row's lines) are fetched at the page and the ready point
// waits for them (useTodayBands); this file is not about them, so they answer at once, settled and empty.
vi.mock('../components/today/v2/useTodayBands.js', () => ({
  useTodayBands: () => ({ settled: true, watch: { data: null, failed: false, reload() {} }, compose: { data: null, settled: true, reload() {} }, soon: { data: null, failed: false, reload() {} }, sow: { items: null, settled: true }, harvest: { present: false, summary: null }, putup: { present: false, summary: null } }),
}))

import TodayV2 from '../pages/TodayV2.jsx'
import { readSkipped } from '../components/today/careStore.js'
import { buildCareNeeded } from '../lib/careNeeded.js'
import { enrichRows } from '../lib/todayV2/spots.js'
import { PageScrollProvider } from '../hooks/usePageScrollManager.js'
import { FILTER_ACTION_CELLS } from '../../tests/harness/_todaymeasure/today-v2-contract.mjs'

const PAYLOAD = F('dailyplan.dave.json')
const PLANTS = (() => { const p = F('plants.json'); return Array.isArray(p) ? p : p.plants })()
const LOCS = F('locations.full.json')
const TODAY = PAYLOAD.plan_date
// The care rows as the page arranges them (useNeedsCare's join), for naming a spot's plants in a test.
const ROWS = enrichRows(buildCareNeeded(PAYLOAD.plan).filter((r) => ['water_due', 'no_history', 'fertilize', 'pest', 'overwintering'].includes(r.need)), { plan: PAYLOAD.plan, plants: PLANTS, locations: LOCS })
const waterIn = (spotName) => ROWS.filter((r) => r.spotName === spotName && r.task === 'water')

const spot = (name) => document.querySelector(`[data-testid="care-spot"][data-spot="${name}"]`)
const doneLine = (name) => document.querySelector(`[data-testid="care-done-line"][data-spot="${name}"]`)
const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)) })

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(TODAY + 'T14:30:00.000Z'))
  planState.current = { data: PAYLOAD, loading: false, error: null, reload: vi.fn() }
  wire.posts = []; wire.deletes = []; wire.failPlant = null; wire.failPlants = new Set(); wire.seq = 0; wire.plants = PLANTS; wire.locations = LOCS; wire.cf = {}
})
afterEach(() => { cleanup(); vi.useRealTimers() })

const mount = async () => { render(<MemoryRouter><TodayV2 /></MemoryRouter>); await settle() }

describe('Needs care on Dave\'s 09-24 plan', () => {
  it('opens by itself on the 8 tray cells (D5 small), with the SF8 summary, and lays out Outside / Stable / House', async () => {
    await mount()
    const band = screen.getByTestId('today-sec-care').querySelector('[aria-expanded]')
    expect(band.getAttribute('aria-expanded')).toBe('true')
    expect(band.textContent).toContain('8 tray cells due · 9 spots')
    expect([...document.querySelectorAll('[data-testid="care-group"]')].map((g) => g.getAttribute('data-group'))).toEqual(['Outside', 'Stable', 'House'])
    const group = document.querySelector('[data-testid="care-group-bulk"][data-group="Outside"]')
    expect(group.getAttribute('aria-label')).toBe('Water all 154 outside')
  })

  it('Not today: the spot\'s rows go into the ONE shared skip set, it shrinks to a done line, Undo brings it back', async () => {
    await mount()
    const s = spot('Drive-Shade')
    fireEvent.click(within(s).getByRole('button', { name: 'Not today: Drive-Shade' }))
    await settle()
    expect(spot('Drive-Shade')).toBeNull()
    expect(doneLine('Drive-Shade').textContent).toContain('not today')
    expect(readSkipped().size).toBe(5)
    expect(wire.posts.length).toBe(0)
    fireEvent.click(within(doneLine('Drive-Shade')).getByRole('button', { name: /^Undo/ }))
    await settle()
    expect(spot('Drive-Shade')).toBeTruthy()
    expect(readSkipped().size).toBe(0)
  })

  it('a spot\'s Water all logs exactly its candidates, shrinks to "watered N", and its Undo deletes exactly those', async () => {
    await mount()
    fireEvent.click(within(spot('Drive-Shade')).getByRole('button', { name: 'Water all 5 in Drive-Shade' }))
    await settle()
    expect(wire.posts.length).toBe(5)
    expect(wire.posts.every((b) => b.event_type === 'watering')).toBe(true)
    expect(doneLine('Drive-Shade').textContent).toContain('watered 5')
    expect(doneLine('Drive-Shade').contains(document.activeElement)).toBe(true)
    expect(document.activeElement.getAttribute('data-focus-id')).toMatch(/^spot:/)
    fireEvent.click(within(doneLine('Drive-Shade')).getByRole('button', { name: /^Undo/ }))
    await settle()
    expect(wire.deletes.sort()).toEqual(['/api/events/ev1', '/api/events/ev2', '/api/events/ev3', '/api/events/ev4', '/api/events/ev5'])
    expect(spot('Drive-Shade')).toBeTruthy()
  })

  it('opened Bag Area: 8 differing rows + the cohort line; Moist one → its done line, and the button reads "Water the other 96"', async () => {
    await mount()
    fireEvent.click(within(spot('Bag Area')).getAllByRole('button', { expanded: false })[0])
    await settle()
    expect(document.querySelectorAll('[data-testid="care-exceptions-row"]').length).toBe(8)
    expect(document.querySelector('[data-testid="care-cohort"]').textContent).toContain('89 more like this · mostly daily · last watered 4 d ago')
    const row = [...document.querySelectorAll('[data-testid="care-exceptions-row"]')].find((r) => r.textContent.includes('Red Acre Cabbage'))
    expect(within(row).getByRole('button', { name: 'Log Water for Red Acre Cabbage' })).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: 'Checked Red Acre Cabbage — still moist' }))
    await settle()
    expect(wire.posts.map((b) => b.event_type)).toEqual(['moisture_check'])
    const done = document.querySelector('[data-testid="care-row-done"]')
    expect(done.textContent).toContain('Red Acre Cabbage · moist')
    expect(within(spot('Bag Area')).getByRole('button', { name: 'Water the other 96 in Bag Area' })).toBeTruthy()
  })

  it('a failed one-tap write stays on the row as "Not logged" with Retry — no toast, nothing faded', async () => {
    await mount()
    fireEvent.click(within(spot('Bag Area')).getAllByRole('button', { expanded: false })[0])
    await settle()
    const row = [...document.querySelectorAll('[data-testid="care-exceptions-row"]')].find((r) => r.textContent.includes('Redbor Kale'))
    wire.failPlant = row.getAttribute('data-key').split(':')[0]
    fireEvent.click(within(row).getByRole('button', { name: 'Log Water for Redbor Kale' }))
    await settle()
    const again = document.querySelector(`[data-key="${row.getAttribute('data-key')}"]`)
    expect(again.textContent).toContain('Not logged')
    wire.failPlant = null
    fireEvent.click(within(again).getByRole('button', { name: 'Retry: Redbor Kale' }))
    await settle()
    expect(wire.posts.length).toBe(1)
    expect(document.querySelector('[data-testid="care-row-done"]').textContent).toContain('Redbor Kale · watered')
  })

  it('MF3: the Outside Water all is ONE line with ONE Undo; every touched spot keeps its slot; Undo deletes exactly the created ids', async () => {
    await mount()
    const order = () => [...document.querySelectorAll('[data-testid="care-group"][data-group="Outside"] li[data-spot]')].map((li) => li.getAttribute('data-spot'))
    const before = order()
    fireEvent.click(document.querySelector('[data-testid="care-group-bulk"][data-group="Outside"]'))
    await settle()
    expect(wire.posts.length).toBe(154)
    const line = document.querySelector('[data-testid="care-group-done"][data-group="Outside"]')
    expect(line.textContent).toContain('Outside · watered 154')
    expect(line.querySelectorAll('button').length).toBe(1)
    expect(order()).toEqual(before)
    expect(document.activeElement.getAttribute('data-focus-id')).toBe('group:Outside')
    fireEvent.click(within(line).getByRole('button'))
    await settle()
    expect(new Set(wire.deletes).size).toBe(154)
    expect(document.querySelector('[data-testid="care-group-bulk"][data-group="Outside"]').getAttribute('aria-label')).toBe('Water all 154 outside')
  })
})

// S3 × S4 (integration): a Water / Feed / Check chip in S3's jump bar pre-selects that task filter in S4's Needs
// care, through the visit record (record.filter.care = { tasks, n }). Each lane tested its own half alone and
// both stayed green with the halves keyed differently, so this drives the real chip and reads the real filter row.
describe('a jump chip pre-selects its task filter in Needs care (S3 → S4)', () => {
  const chip = (k) => screen.getByRole('navigation', { name: 'Today sections' }).querySelector(`[data-chip="${k}"]`)
  const taskRow = () => screen.getByTestId('care-filter-tasks')
  const pressed = () => [...taskRow().querySelectorAll('button[aria-pressed="true"]')].map((b) => b.textContent.trim())
  const filterBtn = (label) => [...taskRow().querySelectorAll('button[aria-pressed]')].find((b) => b.textContent.trim() === label)
  const careBand = () => screen.getByTestId('today-sec-care').querySelector('[aria-expanded]')
  const tap = async (el) => { fireEvent.click(el); await settle() }

  it('Water, Feed and Check each replace the task row with their own task; the same chip again re-applies over a hand change', async () => {
    await mount()
    expect(careBand().getAttribute('aria-expanded')).toBe('true') // open already (the small-pot trigger)
    expect(pressed()).toEqual([])
    await tap(chip('water'))
    expect(pressed()).toEqual(['Water'])
    await tap(chip('feed'))
    expect(pressed()).toEqual(['Feed'])
    await tap(chip('check'))
    expect(pressed()).toEqual(['Check'])
    await tap(filterBtn('Water'))
    expect(pressed()).toEqual(['Water', 'Check'])
    await tap(chip('check'))
    expect(pressed()).toEqual(['Check'])
  })

  it('also when the chip is what opens a closed Needs care — its body mounts with the intent already written', async () => {
    await mount()
    await tap(careBand())
    expect(careBand().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('care-filter-tasks')).toBeNull()
    await tap(chip('water'))
    expect(careBand().getAttribute('aria-expanded')).toBe('true')
    expect(pressed()).toEqual(['Water'])
  })

  it('an intent already applied is not applied again when the body remounts: a filter chosen by hand survives a close and re-open', async () => {
    await mount()
    await tap(chip('water'))
    expect(pressed()).toEqual(['Water'])
    await tap(filterBtn('Water'))
    await tap(filterBtn('Feed'))
    expect(pressed()).toEqual(['Feed'])
    await tap(careBand())
    await tap(careBand())
    expect(careBand().getAttribute('aria-expanded')).toBe('true')
    expect(pressed()).toEqual(['Feed'])
  })
})

// S4g — MF3 "failures stay per spot 'Not logged · Retry'": a failed write stays on its SPOT, open or closed (not
// only on the plant rows inside it and in the status region), out of Water all, and its Retry completes the run
// it failed in — so that run's one done line and one Undo still cover every id it created.
describe('S4g: a failed write stays on its spot as "Not logged · Retry" (MF3)', () => {
  const status = () => screen.getByTestId('today-status').textContent
  const failLine = (name) => spot(name)?.querySelector('[data-testid="care-spot-failed"]') ?? null
  const retryOf = (name) => spot(name)?.querySelector('[data-testid="care-spot-retry"]') ?? null
  const groupDone = () => document.querySelector('[data-testid="care-group-done"][data-group="Outside"]')
  const tapTask = async (label) => { fireEvent.click([...screen.getByTestId('care-filter-tasks').querySelectorAll('button[aria-pressed]')].find((b) => b.textContent.trim() === label)); await settle() }

  it('a spot Water all with failures: the CLOSED row keeps "2 not logged" + Retry (out of Water all), focus lands on it; Retry completes the run — one done line, one Undo for all 5 ids', async () => {
    await mount()
    const ds = waterIn('Drive-Shade')
    expect(ds.length).toBe(5)
    wire.failPlants = new Set([ds[0].plantingId, ds[1].plantingId])
    fireEvent.click(within(spot('Drive-Shade')).getByRole('button', { name: 'Water all 5 in Drive-Shade' }))
    await settle()
    expect(wire.posts.length).toBe(3)
    expect(spot('Drive-Shade').querySelector('[aria-expanded]').getAttribute('aria-expanded')).toBe('false')
    expect(failLine('Drive-Shade').textContent).toContain('2 not logged')
    expect(retryOf('Drive-Shade').getAttribute('aria-label')).toBe('Retry: 2 not logged in Drive-Shade')
    expect(spot('Drive-Shade').querySelector('[data-testid="care-spot-bulk"]')).toBeNull()
    expect(document.activeElement).toBe(retryOf('Drive-Shade'))
    expect(status()).toMatch(/^Watered 3 in Drive-Shade\. 2 not logged in Drive-Shade: .+ and .+\. Retry is on each\.$/)
    expect(status()).toContain(ds[0].name)
    wire.failPlants = new Set()
    fireEvent.click(retryOf('Drive-Shade'))
    await settle()
    expect(wire.posts.slice(3).map((b) => b.plant_id).sort()).toEqual([ds[0].plantingId, ds[1].plantingId].sort())
    expect(wire.posts.every((b) => b.event_type === 'watering')).toBe(true)
    expect(spot('Drive-Shade')).toBeNull()
    expect(doneLine('Drive-Shade').textContent).toContain('Drive-Shade · watered 5')
    expect(doneLine('Drive-Shade').contains(document.activeElement)).toBe(true)
    fireEvent.click(within(doneLine('Drive-Shade')).getByRole('button', { name: /^Undo/ }))
    await settle()
    expect(wire.deletes.sort()).toEqual(['/api/events/ev1', '/api/events/ev2', '/api/events/ev3', '/api/events/ev4', '/api/events/ev5'])
    expect(within(spot('Drive-Shade')).getByRole('button', { name: 'Water all 5 in Drive-Shade' })).toBeTruthy()
    expect(failLine('Drive-Shade')).toBeNull()
  })

  it('group Water all with failures in two spots: each touched spot reads its OWN share, the failed spots keep Retry (focus on the first); a Retry completes the GROUP run, whose one Undo deletes every id', async () => {
    await mount()
    await tapTask('Water')
    const bag = waterIn('Bag Area'), ds = waterIn('Drive-Shade')
    wire.failPlants = new Set([bag[5].plantingId, ds[0].plantingId])
    fireEvent.click(document.querySelector('[data-testid="care-group-bulk"][data-group="Outside"]'))
    await settle()
    expect(wire.posts.length).toBe(152)
    expect(groupDone().textContent).toContain('Outside · watered 152')
    // MF3 "each touched spot shrinks to its own done line": its own count, never the group's.
    expect(doneLine('Trough').textContent).toContain('Trough · watered 29')
    expect(doneLine('In-Ground').textContent).toContain('In-Ground · watered 19')
    expect(doneLine('Drive').textContent).toContain('Drive · watered 3')
    expect(doneLine('Deck').textContent).toContain('Deck · watered 1')
    expect(spot('Bag Area').querySelector('[aria-expanded]').textContent).toContain('Watered 96')
    expect(failLine('Bag Area').textContent).toContain('1 not logged')
    expect(failLine('Drive-Shade').textContent).toContain('1 not logged')
    expect(document.activeElement).toBe(retryOf('Bag Area'))
    wire.failPlants = new Set()
    fireEvent.click(retryOf('Drive-Shade'))
    await settle()
    expect(wire.posts.length).toBe(153)
    expect(wire.posts[152].plant_id).toBe(ds[0].plantingId)
    expect(doneLine('Drive-Shade').textContent).toContain('Drive-Shade · watered 5')
    expect(groupDone().textContent).toContain('Outside · watered 153')
    expect(groupDone().querySelectorAll('button').length).toBe(1)
    fireEvent.click(within(groupDone()).getByRole('button'))
    await settle()
    expect(new Set(wire.deletes).size).toBe(153)
    // The run is undone: its remaining failure is simply due again, not "Not logged".
    expect(failLine('Bag Area')).toBeNull()
    expect(document.querySelector('[data-testid="care-group-bulk"][data-group="Outside"]').getAttribute('aria-label')).toBe('Water all 154 outside')
  })

  it('a one-tap failure inside a spot shows on the spot row once it is closed; the spot\'s Water all takes the other 96, never the failed row; the spot Retry re-posts it as its own type', async () => {
    await mount()
    fireEvent.click(within(spot('Bag Area')).getAllByRole('button', { expanded: false })[0])
    await settle()
    const row = [...document.querySelectorAll('[data-testid="care-exceptions-row"]')].find((r) => r.textContent.includes('Redbor Kale'))
    const key = row.getAttribute('data-key')
    wire.failPlant = key.split(':')[0]
    fireEvent.click(within(row).getByRole('button', { name: 'Log Water for Redbor Kale' }))
    await settle()
    // §5.5: the row's Retry replaces the chip that had focus — focus moves to it, never to BODY.
    expect(document.activeElement).toBe(within(document.querySelector(`[data-key="${key}"]`)).getByRole('button', { name: 'Retry: Redbor Kale' }))
    fireEvent.click(within(spot('Bag Area')).getAllByRole('button', { expanded: true })[0])
    await settle()
    expect(failLine('Bag Area').textContent).toContain('1 not logged')
    expect(within(spot('Bag Area')).getByRole('button', { name: 'Water the other 96 in Bag Area' })).toBeTruthy()
    wire.failPlant = null
    fireEvent.click(retryOf('Bag Area'))
    await settle()
    expect(wire.posts.map((b) => [b.plant_id, b.event_type])).toEqual([[key.split(':')[0], 'watering']])
    expect(failLine('Bag Area')).toBeNull()
    expect(document.activeElement).toBe(spot('Bag Area').querySelector('[data-focus-id^="spotrow:"]'))
  })

  it('a failed Moist is retried as Moist — never as the row\'s watering', async () => {
    await mount()
    fireEvent.click(within(spot('Bag Area')).getAllByRole('button', { expanded: false })[0])
    await settle()
    const row = [...document.querySelectorAll('[data-testid="care-exceptions-row"]')].find((r) => r.textContent.includes('Red Acre Cabbage'))
    const key = row.getAttribute('data-key')
    wire.failPlant = key.split(':')[0]
    fireEvent.click(within(row).getByRole('button', { name: 'Checked Red Acre Cabbage — still moist' }))
    await settle()
    const again = document.querySelector(`[data-key="${key}"]`)
    expect(again.textContent).toContain('Not logged')
    wire.failPlant = null
    fireEvent.click(within(again).getByRole('button', { name: 'Retry: Red Acre Cabbage' }))
    await settle()
    expect(wire.posts.map((b) => b.event_type)).toEqual(['moisture_check'])
    expect(document.querySelector('[data-testid="care-row-done"]').textContent).toContain('Red Acre Cabbage · moist')
  })
})

// S4g — §2.6 / §5.6: a filter change says its result through the page's ONE status region, once per change: a
// chip, a Clear, a spot chip, a jump chip's pre-select. A re-render that changes no filter says nothing.
describe('S4g: a filter change says its result once, through the one status region (§2.6)', () => {
  const statusEl = () => screen.getByTestId('today-status')
  const pressIn = (row, label) => [...screen.getByTestId(row).querySelectorAll('button[aria-pressed]')].find((b) => b.textContent.trim() === label)
  const watch = () => {
    const log = []
    // One entry per WRITE (per record): two writes in one task arrive in a single callback.
    const mo = new MutationObserver((recs) => { for (const r of recs) if (r.type === 'characterData' || r.addedNodes.length) log.push(statusEl().textContent) })
    mo.observe(statusEl(), { childList: true, characterData: true, subtree: true })
    return { log, stop: () => mo.disconnect() }
  }
  const tap = async (el) => { fireEvent.click(el); await settle() }

  it('chips, Clear, a spot chip and a jump chip each say it ONCE; opening a spot or logging a plant says no filter again', async () => {
    await mount()
    const w = watch()
    await tap(pressIn('care-filter-tasks', 'Water'))
    expect(statusEl().textContent).toBe('Needs care: Water, 168 in 8 spots.')
    expect(w.log).toEqual(['Needs care: Water, 168 in 8 spots.'])
    await tap(pressIn('care-filter-tasks', 'Feed'))
    expect(w.log.at(-1)).toBe('Needs care: Water and Feed, 226 in 9 spots.')
    expect(w.log.length).toBe(2)
    // Re-renders that change no filter: a spot opened and closed, a one-tap log (its own announcement only).
    await tap(within(spot('Trough')).getAllByRole('button', { expanded: false })[0])
    await tap(within(spot('Trough')).getAllByRole('button', { expanded: true })[0])
    expect(w.log.length).toBe(2)
    await tap(within(spot('Drive-Shade')).getByRole('button', { name: 'Water all 5 in Drive-Shade' }))
    expect(w.log.filter((m) => m.startsWith('Needs care:')).length).toBe(2)
    await tap(within(screen.getByTestId('care-filter-tasks')).getByRole('button', { name: 'Clear' }))
    // Drive-Shade's 5 are logged: 228 left, in the 8 spots that still hold any.
    expect(statusEl().textContent).toBe('Needs care: everything, 228 in 8 spots.')
    await tap(pressIn('care-filter-spots', 'Bag Area'))
    expect(statusEl().textContent).toBe('Needs care: Bag Area, 141 in 1 spot.')
    await tap(within(screen.getByTestId('care-filter-spots')).getByRole('button', { name: 'Clear' }))
    const before = w.log.length
    await tap(screen.getByRole('navigation', { name: 'Today sections' }).querySelector('[data-chip="check"]'))
    expect(statusEl().textContent).toBe('Needs care: Check, 7 in 2 spots.')
    expect(w.log.length).toBe(before + 1)
    w.stop()
  })
})

// S4g — §2.5: an emptied Needs care keeps its header, which reads "Needs care · all caught up" over what was logged
// today (the plan's done items ∪ this tab's store) and what rain took; §5.5: the action that empties it sends focus
// to that header. On a small day built from the real plan: Drive-Shade's 5 and House's 2 still due, 3 items already
// done today (the read path's annotation), 1 logged in this tab before a remount (the store), rain_skipped = busyfull's 70.
describe('S4g: an emptied Needs care reads "Needs care · all caught up" (§2.5)', () => {
  const band = () => screen.getByTestId('today-sec-care').querySelector('[aria-expanded]')
  const small = () => {
    const p = PAYLOAD.plan
    const listed = new Set([...waterIn('Drive-Shade'), ...waterIn('House')].map((r) => r.plantingId))
    const others = p.water_due.filter((it) => !listed.has(it.id))
    const water_due = [...p.water_due.filter((it) => listed.has(it.id)), ...others.slice(0, 3).map((it) => ({ ...it, done: true })), others[3]]
    const rain = F('busyfull-grafts.json').rain_skipped.value
    return { payload: { ...PAYLOAD, plan: { ...p, water_due, no_history: [], fertilize: [], pest: [], overwintering: [], rain_skipped: rain } }, stored: others[3].id + ':water_due', rain: rain.length }
  }

  it('logging the last rows turns the header to "all caught up" with "11 logged today, 70 covered by rain", focus on it; an Undo brings the work back', async () => {
    const day = small()
    expect(day.rain).toBe(70)
    sessionStorage.setItem('today-logged:u:' + TODAY, JSON.stringify([day.stored]))
    planState.current = { data: day.payload, loading: false, error: null, reload: vi.fn() }
    await mount()
    if (band().getAttribute('aria-expanded') !== 'true') { fireEvent.click(band()); await settle() }
    expect(band().textContent).not.toContain('all caught up')
    expect(screen.getByTestId('today-sec-care').getAttribute('data-count')).toBe('7')
    fireEvent.click(within(spot('Drive-Shade')).getByRole('button', { name: 'Water all 5 in Drive-Shade' }))
    await settle()
    fireEvent.click(within(spot('House')).getByRole('button', { name: 'Water all 2 in House' }))
    await settle()
    expect(band().textContent).toContain('Needs care · all caught up')
    expect(band().textContent).toContain('11 logged today, 70 covered by rain')
    expect(screen.getByTestId('today-sec-care').getAttribute('data-count')).toBe(null)
    expect(document.activeElement).toBe(band())
    fireEvent.click(within(doneLine('House')).getByRole('button', { name: /^Undo/ }))
    await settle()
    expect(band().textContent).not.toContain('all caught up')
    expect(screen.getByTestId('today-sec-care').getAttribute('data-count')).toBe('2')
  })

  // Integration 2 (S4g x S5): Protect tonight keeps its double-log guard in the SAME today-logged store, as `<id>:cold`
  // keys. "N logged today" under an emptied Needs care counts care rows only — a plant covered for the night is not
  // care logged, so the same small day still reads 11 after two Covered taps.
  it('Protect\'s Covered writes land in the same store but never count as "logged today" in Needs care', async () => {
    const day = small()
    sessionStorage.setItem('today-logged:u:' + TODAY, JSON.stringify([day.stored]))
    planState.current = { data: day.payload, loading: false, error: null, reload: vi.fn() }
    await mount()
    const protect = screen.getByTestId('today-sec-protect')
    const header = protect.querySelector('[aria-expanded]')
    if (header.getAttribute('aria-expanded') !== 'true') { fireEvent.click(header); await settle() }
    const cold = day.payload.plan.cold.slice(0, 2)
    for (const c of cold) { fireEvent.click(within(protect).getByRole('button', { name: `Covered: ${c.name}` })); await settle() }
    expect(wire.posts.filter((b) => b.event_type === 'cover').map((b) => b.plant_id).sort()).toEqual(cold.map((c) => c.id).sort())
    const stored = JSON.parse(sessionStorage.getItem('today-logged:u:' + TODAY))
    expect(stored.filter((k) => k.endsWith(':cold')).sort()).toEqual(cold.map((c) => c.id + ':cold').sort())
    if (band().getAttribute('aria-expanded') !== 'true') { fireEvent.click(band()); await settle() }
    fireEvent.click(within(spot('Drive-Shade')).getByRole('button', { name: 'Water all 5 in Drive-Shade' }))
    await settle()
    fireEvent.click(within(spot('House')).getByRole('button', { name: 'Water all 2 in House' }))
    await settle()
    expect(band().textContent).toContain('Needs care · all caught up')
    expect(band().textContent).toContain('11 logged today, 70 covered by rain')
  })
})

// Review 4160.2 IMPORTANT-1 (integration 2): §6.3's double-log guard — the today-logged store (useNeedsCare's
// loggedAtMount) keeps a row this tab logged out of the list when a Back remount paints a plan read BEFORE the write
// (useDailyPlan's seed). Remounted here on the SAME 09-24 payload, as that seed would paint it, and as a Back (a
// page-scroll return, so the visit record is restored): the watered spot stays its done line, and neither it nor a
// one-tap row comes back into a Water all.
describe('§6.3: a row logged before a Back never comes back live on the remount (review 4160.2 IMPORTANT-1)', () => {
  const groupBulk = (g) => document.querySelector(`[data-testid="care-group-bulk"][data-group="${g}"]`)
  const back = async () => {
    render(<MemoryRouter><PageScrollProvider value={{ api: null, isReturn: true }}><TodayV2 /></PageScrollProvider></MemoryRouter>)
    await settle()
  }

  it('a spot Water all: after unmount + Back on the same plan the spot is still its done line, and the group Water all re-POSTs none of it', async () => {
    const first = render(<MemoryRouter><TodayV2 /></MemoryRouter>); await settle()
    const five = waterIn('Drive-Shade').map((r) => r.plantingId)
    fireEvent.click(within(spot('Drive-Shade')).getByRole('button', { name: 'Water all 5 in Drive-Shade' }))
    await settle()
    expect(wire.posts.map((b) => b.plant_id).sort()).toEqual([...five].sort())
    first.unmount()
    await back()
    expect(spot('Drive-Shade')).toBeNull()
    expect(doneLine('Drive-Shade').textContent).toContain('watered 5')
    expect(groupBulk('Outside').getAttribute('aria-label')).toBe('Water all 149 outside')
    fireEvent.click(groupBulk('Outside'))
    await settle()
    expect(wire.posts.length).toBe(5 + 149)
    expect(wire.posts.slice(5).filter((b) => five.includes(b.plant_id))).toEqual([])
  })

  // (A one-tap row's own done line does not survive the Back: the guard drops the logged key from the plan day's
  // rows altogether, so the row is simply gone — never live. Recorded in build-int2.md, not changed here.)
  it('a one-tap row (plantRun): after unmount + Back the row is never live again, and the group Water all re-POSTs nothing for it', async () => {
    const first = render(<MemoryRouter><TodayV2 /></MemoryRouter>); await settle()
    fireEvent.click(within(spot('Drive-Shade')).getAllByRole('button', { expanded: false })[0])
    await settle()
    const show = within(spot('Drive-Shade')).queryByRole('button', { name: 'Show them' })
    if (show) { fireEvent.click(show); await settle() }
    const row = waterIn('Drive-Shade')[0]
    fireEvent.click(within(spot('Drive-Shade')).getByRole('button', { name: `Log Water for ${row.name}` }))
    await settle()
    expect(wire.posts.map((b) => b.plant_id)).toEqual([row.plantingId])
    first.unmount()
    await back()
    // The Back restored the visit: Drive-Shade is open again, with its other four rows live.
    expect(spot('Drive-Shade').querySelector('[aria-expanded]').getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector(`[data-testid="care-row"][data-key="${row.key}"]`)).toBeNull()
    expect(within(spot('Drive-Shade')).queryByRole('button', { name: `Log Water for ${row.name}` })).toBeNull()
    expect(within(spot('Drive-Shade')).getAllByRole('button', { name: /^Water (all|the other) 4 in Drive-Shade$/ }).length).toBeGreaterThan(0)
    expect(groupBulk('Outside').getAttribute('aria-label')).toBe('Water all 153 outside')
    fireEvent.click(groupBulk('Outside'))
    await settle()
    expect(wire.posts.slice(1).filter((b) => b.plant_id === row.plantingId)).toEqual([])
  })
})

// Review 4160.2 IMPORTANT-2 (integration 2): a Back remount paints the SEED — the plan read before the page was left —
// while it revalidates (useDailyPlan `seedPending`). A watering logged elsewhere in between (the planting's own
// Water, then Back) is still due in that seed, so until the revalidation lands every write control is inert: aria-
// disabled, and nothing is posted or skipped. Then the fresh plan speaks and the controls work.
describe('a seeded Back remount holds every write until its revalidation lands (review 4160.2 IMPORTANT-2)', () => {
  it('Water all, the group Water all, Not today, a one-tap row and Protect\'s Covered are inert on the seed; the fresh plan drops the plant logged elsewhere and Water all works', async () => {
    const drive = waterIn('Drive-Shade')
    const elsewhere = drive[0] // watered on its own planting page while V2 was unmounted: no today-logged key
    planState.current = { data: PAYLOAD, loading: false, error: null, reload: vi.fn(), seedPending: true }
    const view = render(<MemoryRouter><TodayV2 /></MemoryRouter>); await settle()
    const inert = (b) => expect(b.getAttribute('aria-disabled'), b.getAttribute('aria-label') || b.textContent).toBe('true')
    const bulk = spot('Drive-Shade').querySelector('[data-testid="care-spot-bulk"]')
    expect(bulk.getAttribute('aria-label')).toBe('Water all 5 in Drive-Shade')
    inert(bulk); fireEvent.click(bulk); await settle()
    const group = document.querySelector('[data-testid="care-group-bulk"][data-group="Outside"]')
    inert(group); fireEvent.click(group); await settle()
    const nt = within(spot('Drive-Shade')).getByRole('button', { name: 'Not today: Drive-Shade' })
    inert(nt); fireEvent.click(nt); await settle()
    fireEvent.click(within(spot('Drive-Shade')).getAllByRole('button', { expanded: false })[0]); await settle()
    const show = within(spot('Drive-Shade')).queryByRole('button', { name: 'Show them' })
    if (show) { fireEvent.click(show); await settle() }
    for (const b of within(spot('Drive-Shade')).getAllByRole('button', { name: /^(Water |Skip |Log |Checked )/ })) { inert(b); fireEvent.click(b); await settle() }
    const protect = screen.getByTestId('today-sec-protect')
    const covered = within(protect).getAllByRole('button', { name: /^Covered: / })[0]
    inert(covered); fireEvent.click(covered); await settle()
    expect(wire.posts).toEqual([])
    expect(readSkipped().size).toBe(0)

    // The revalidation lands: the fresh plan marks the plant logged elsewhere done (the read path's annotation).
    const fresh = { ...PAYLOAD, plan: { ...PAYLOAD.plan, water_due: PAYLOAD.plan.water_due.map((it) => (it && it.id === elsewhere.plantingId ? { ...it, done: true } : it)) } }
    planState.current = { data: fresh, loading: false, error: null, reload: vi.fn(), seedPending: false }
    view.rerender(<MemoryRouter><TodayV2 /></MemoryRouter>); await settle()
    const bulk4 = spot('Drive-Shade').querySelector('[data-testid="care-spot-bulk"]')
    expect(bulk4.getAttribute('aria-label')).toMatch(/^Water (all|the other) 4 in Drive-Shade$/)
    expect(bulk4.getAttribute('aria-disabled')).toBe(null)
    fireEvent.click(bulk4); await settle()
    expect(wire.posts.map((b) => b.plant_id).sort()).toEqual(drive.slice(1).map((r) => r.plantingId).sort())
  })
})

// Review 4160.2 IMPORTANT-3 (integration 2): spots are LOCATIONS only when /api/locations AND /api/plants both
// answered — location_id comes from the plant list. A failed /api/plants (an error, or a body that is not a list)
// used to put every row in ONE "Unplaced" spot under Outside, whose "Water all 168 in Unplaced" covered the whole
// garden. Now it falls back exactly as a failed /api/locations always has: one spot per project, no group header,
// no group Water all. Still pending, the page keeps waiting (no sections, no jump bar).
describe('a failed /api/plants or /api/locations never builds a whole-garden spot (review 4160.2 IMPORTANT-3)', () => {
  const HTTP500 = () => Object.assign(new Error('HTTP 500'), { status: 500 })
  const projects = [...new Set(ROWS.map((r) => r.project || 'Other'))].sort()
  const layout = () => ({
    spots: [...document.querySelectorAll('[data-testid="care-spot"]')].map((s) => s.getAttribute('data-spot')).sort(),
    groupBulk: document.querySelectorAll('[data-testid="care-group-bulk"]').length,
    spotBulk: [...document.querySelectorAll('[data-testid="care-spot-bulk"]')].map((b) => b.getAttribute('aria-label')),
  })
  const openCare = async () => {
    const band = screen.getByTestId('today-sec-care').querySelector('[aria-expanded]')
    if (band.getAttribute('aria-expanded') !== 'true') { fireEvent.click(band); await settle() }
  }

  it('/api/locations 500: one spot per project, no group Water all', async () => {
    wire.cf['/api/locations'] = { data: undefined, loading: false, error: HTTP500() }
    await mount(); await openCare()
    const l = layout()
    expect(l.spots).toEqual(projects)
    expect(l.spots).not.toContain('Unplaced')
    expect(l.groupBulk).toBe(0)
    expect(l.spotBulk.length).toBeGreaterThan(1)
  })

  for (const [name, answer] of [
    ['/api/plants 500 (an errored read that still carries an empty list)', () => ({ data: [], loading: false, error: HTTP500() })],
    ['/api/plants answering a body that is not a list', () => ({ data: { error: 'bad gateway' }, loading: false, error: null })],
  ]) {
    it(`${name}: the same project spots — never one Unplaced spot holding the garden, no group Water all`, async () => {
      wire.cf['/api/plants'] = answer()
      await mount(); await openCare()
      const l = layout()
      expect(l.spots).not.toContain('Unplaced')
      expect(l.spots).toEqual(projects)
      expect(l.groupBulk).toBe(0)
      expect(l.spotBulk.some((s) => /Water all 168/.test(s))).toBe(false)
    })
  }

  it('/api/plants still pending: the page keeps waiting — no sections, no jump bar', async () => {
    wire.cf['/api/plants'] = { data: undefined, loading: true, error: null }
    await mount()
    expect(screen.getByTestId('today-page').getAttribute('data-today-ready')).toBe(null)
    expect(screen.queryByTestId('today-sec-care')).toBeNull()
    expect(document.querySelector('nav[aria-label="Today sections"]')).toBeNull()
  })
})

// Review 4160.2 IMPORTANT-4 (integration 2; the orchestrator's call): the two filter × action cells, pinned AS THEY
// BEHAVE — each predicate is stated in the contract (today-v2-contract.mjs FILTER_ACTION_CELLS) and each test here
// carries its cell's name.
describe('filter × action cells, as stated in the contract (review 4160.2 IMPORTANT-4)', () => {
  const [SPOT_X_GROUP, TASK_X_NOTTODAY] = FILTER_ACTION_CELLS
  const tasksRow = () => screen.getByTestId('care-filter-tasks')
  const taskChip = (label) => [...tasksRow().querySelectorAll('button')].find((b) => b.textContent.trim() === label)
  const spotChip = (label) => [...screen.getByTestId('care-filter-spots').querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(label) && !b.textContent.trim().startsWith(label + '-'))
  const groupLine = () => document.querySelector('[data-testid="care-group-done"][data-group="Outside"]')

  it('names exactly the two cells', () => {
    expect(FILTER_ACTION_CELLS.map((c) => c.cell)).toEqual(['spot filter × group Water all', 'task filter × Not today'])
  })

  it(`${SPOT_X_GROUP.cell}: the filtered spots only, ONE group line held for the visit, the other spots keep their own Water all`, async () => {
    await mount()
    fireEvent.click(spotChip('Trough')); await settle()
    fireEvent.click(spotChip('In-Ground')); await settle()
    const n = waterIn('Trough').length + waterIn('In-Ground').length
    expect(n).toBe(48)
    const group = document.querySelector('[data-testid="care-group-bulk"][data-group="Outside"]')
    expect(group.getAttribute('aria-label')).toBe(`Water all ${n} outside`)
    fireEvent.click(group); await settle()
    const filtered = new Set([...waterIn('Trough'), ...waterIn('In-Ground')].map((r) => r.plantingId))
    expect(wire.posts.length).toBe(n)
    expect(wire.posts.every((b) => filtered.has(b.plant_id))).toBe(true)
    expect(groupLine().textContent).toContain(`Outside · watered ${n}`)
    // The filter cleared: the line holds, no group button comes back, every other Outside spot keeps its own button.
    fireEvent.click(spotChip('Trough')); await settle()
    fireEvent.click(spotChip('In-Ground')); await settle()
    expect([...screen.getByTestId('care-filter-spots').querySelectorAll('button[aria-pressed="true"]')]).toEqual([])
    expect(groupLine().textContent).toContain(`Outside · watered ${n}`)
    expect(within(groupLine()).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([`Undo: Outside watered ${n}`])
    expect(document.querySelector('[data-testid="care-group-bulk"][data-group="Outside"]')).toBeNull()
    for (const s of ['Bag Area', 'Drive-Shade', 'Drive', 'Deck']) {
      expect(spot(s).querySelector('[data-testid="care-spot-bulk"]').getAttribute('aria-label'), s).toBe(`Water ${waterIn(s).length === 1 ? '1' : 'all ' + waterIn(s).length} in ${s}`)
    }
  })

  it(`${TASK_X_NOTTODAY.cell}: under Water, Not today skips only the spot's water rows; its feed row stays due`, async () => {
    await mount()
    fireEvent.click(taskChip('Water')); await settle()
    expect(taskChip('Water').getAttribute('aria-pressed')).toBe('true')
    const water = waterIn('Drive').map((r) => r.key)
    const feed = ROWS.filter((r) => r.spotName === 'Drive' && r.task === 'feed').map((r) => r.key)
    expect([water.length, feed.length]).toEqual([3, 1])
    fireEvent.click(within(spot('Drive')).getByRole('button', { name: 'Not today: Drive' })); await settle()
    expect([...readSkipped()].sort()).toEqual([...water].sort())
    expect(doneLine('Drive').textContent).toContain('not today')
    // The filter cleared: Drive is a live spot again holding its one feed row (its line says what was done: "Not
    // today"), and Needs care counts everything but the three skipped water rows.
    fireEvent.click(taskChip('Water')); await settle()
    expect(spot('Drive').getAttribute('data-count')).toBe('1')
    expect(readSkipped().has(feed[0])).toBe(false)
    expect(screen.getByTestId('today-sec-care').getAttribute('data-count')).toBe(String(ROWS.length - 3))
  })
})
