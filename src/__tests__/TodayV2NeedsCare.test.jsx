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
const { planState, prefsState, auth, wire } = vi.hoisted(() => ({
  planState: { current: null },
  prefsState: { current: { prefs: null, prefsLoaded: true, refreshPrefs: async () => null } },
  auth: { user: { id: 'u' } },
  wire: { posts: [], deletes: [], failPlant: null, seq: 0, plants: null, locations: null },
}))
vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => planState.current }))
vi.mock('../context/PrefsContext.jsx', () => ({ usePrefs: () => prefsState.current }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth }))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({ ...(await orig()), fetchNotificationPrefs: vi.fn(async () => null), saveTodaySkipped: vi.fn(async () => null) }))
vi.mock('../lib/api.js', async (orig) => ({
  ...(await orig()),
  useApiFetch: () => ({
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
  }),
}))
vi.mock('../hooks/useCachedFetch.js', () => ({ useCachedFetch: (path) => ({ data: path === '/api/plants' ? wire.plants : wire.locations, loading: false, error: null }) }))

import TodayV2 from '../pages/TodayV2.jsx'
import { readSkipped } from '../components/today/careStore.js'

const PAYLOAD = F('dailyplan.dave.json')
const PLANTS = (() => { const p = F('plants.json'); return Array.isArray(p) ? p : p.plants })()
const LOCS = F('locations.full.json')
const TODAY = PAYLOAD.plan_date

const spot = (name) => document.querySelector(`[data-testid="care-spot"][data-spot="${name}"]`)
const doneLine = (name) => document.querySelector(`[data-testid="care-done-line"][data-spot="${name}"]`)
const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)) })

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(TODAY + 'T14:30:00.000Z'))
  planState.current = { data: PAYLOAD, loading: false, error: null, reload: vi.fn() }
  wire.posts = []; wire.deletes = []; wire.failPlant = null; wire.seq = 0; wire.plants = PLANTS; wire.locations = LOCS
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
