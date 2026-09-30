// V5-TODAYREDESIGN-001 S6 — the household sections on the redesigned Today ("Jen's care"), through the real TodayV2
// on the 2026-09-24 fixtures (Dave's plan + Jen's real plan, tests/harness/_todaymeasure), only the wire stubbed.
// Plan-v2 §1.6, §2.9, §13 SF6 and the orchestrator's note: shown only while THIS device has the household view on
// (V1's switch, lib/householdView.js readShowOthers — the one reader S5 shares), closed by default, never opened
// by a trigger, NO cold rows (a member's tender plants belong to Protect tonight, "(Jen)", S5), the same row
// anatomy, and the SAME shared skip set V1's household list reads. `include=household` on every plan read is
// pinned in TodayV2.includeHousehold.test.jsx. No jest-dom (L-182).
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
  auth: { user: { id: 'harness_user' }, profile: { id: 'harness_user' } },
  wire: (globalThis.__s6hhwire = { posts: [], seq: 0, plants: null, locations: null, members: null }),
}))
const api = vi.hoisted(() => {
  const fetch = async (path, init = {}) => {
    const w = globalThis.__s6hhwire
    if (init.method === 'POST' && path === '/api/events') { w.posts.push(JSON.parse(init.body)); return { id: 'ev' + (++w.seq) } }
    if (path === '/api/harvests/watch?limit=200') return { candidates: [], snoozed: [] }
    if (path.startsWith('/api/harvests?')) return { entries: [], aggregates: null }
    if (path === '/api/preservation/use-soon') return { items: [] }
    return null
  }
  return { value: { getToken: async () => 't', fetch } }
})
vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => planState.current }))
vi.mock('../context/PrefsContext.jsx', () => ({ usePrefs: () => prefsState.current }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth }))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({ ...(await orig()), fetchNotificationPrefs: vi.fn(async () => null), saveTodaySkipped: vi.fn(async () => null) }))
vi.mock('../lib/api.js', async (orig) => ({ ...(await orig()), useApiFetch: () => api.value }))
vi.mock('../hooks/useCachedFetch.js', () => ({
  useCachedFetch: (path) => ({ data: path === '/api/plants' ? wire.plants : path === '/api/members' ? wire.members : wire.locations, loading: false, error: null }),
}))

import TodayV2 from '../pages/TodayV2.jsx'
import CareNeeded from '../components/today/CareNeeded.jsx'
import { readSkipped } from '../components/today/careStore.js'
import { householdKey, householdSummary } from '../components/today/v2/HouseholdSection.jsx'
import { TRIGGER_CELLS } from '../../tests/harness/_todaymeasure/today-v2-contract.mjs'

const DAVE = F('dailyplan.dave.json')
const JEN = F('dailyplan.jen.json')
const PLANTS = (() => { const p = F('plants.json'); return Array.isArray(p) ? p : p.plants })()
const LOCS = F('locations.full.json')
const TODAY = DAVE.plan_date
const JEN_ID = 'member_jen'
const withJen = (jenPlan = JEN) => ({ ...DAVE, household_plans: [{ user_id: JEN_ID, generated_at: DAVE.generated_at, plan: jenPlan }] })

const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)) })
const sec = (key) => screen.queryByTestId(`today-sec-${key}`)
const header = (key) => sec(key)?.querySelector('[aria-expanded]')
const mount = async () => { render(<MemoryRouter><TodayV2 /></MemoryRouter>); await settle() }
const HH = householdKey(JEN_ID)

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(TODAY + 'T14:30:00.000Z'))
  planState.current = { data: withJen(), loading: false, error: null, reload: vi.fn() }
  prefsState.current = { prefs: null, prefsLoaded: true, refreshPrefs: vi.fn(async () => null) }
  Object.assign(wire, { posts: [], seq: 0, plants: PLANTS, locations: LOCS, members: { members: [{ id: 'harness_user', display_name: 'Dave N' }, { id: JEN_ID, display_name: 'Jen X' }] } })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('SF6 — household sections only while this device has the household view on', () => {
  it('off (V1\'s switch unset): no other member\'s section, although the plan read carried her plan', async () => {
    await mount()
    expect(HH).toBe('hh-member_j')
    expect(sec(HH)).toBeNull()
    expect(screen.queryByTestId('today-household')).toBeNull()
    expect(document.body.textContent).not.toMatch(/Jen.s care/)
  })
  it('switched OFF explicitly ("0") reads off too', async () => {
    localStorage.setItem('garden.today.showOthers', '0')
    await mount()
    expect(sec(HH)).toBeNull()
  })
  it('on: "Jen’s care · 15" (her water 8 + feed 7), "Water 8 · Feed 7", closed, after Resting, before the Sow row', async () => {
    localStorage.setItem('garden.today.showOthers', '1')
    await mount()
    const h = header(HH)
    expect(h.getAttribute('aria-expanded')).toBe('false')
    expect(h.closest('h2')).toBeTruthy()
    expect(h.textContent).toContain('Jen’s care')
    expect(sec(HH).getAttribute('data-count')).toBe('15')
    expect(sec(HH).querySelector('[data-testid="section-summary"]').textContent).toBe('Water 8 · Feed 7')
    const wrap = screen.getByTestId('today-household')
    expect(sec('resting').compareDocumentPosition(wrap) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(wrap.compareDocumentPosition(screen.getByTestId('cultivation-lead')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(sec(HH)).queryByTestId('today-care')).toBeNull() // closed = unmounted
  })
  it('names by the roster\'s first word, "Someone else" when the roster does not know her (V1\'s rule, memberFirstName)', async () => {
    localStorage.setItem('garden.today.showOthers', '1')
    wire.members = { members: [{ id: 'harness_user', display_name: 'Dave N' }] }
    await mount()
    expect(header(HH).textContent).toContain('Someone else’s care')
  })
})

// The contract's unit-table cell for householdAlwaysOpen (§13 Simplify 3) drives this: with a reason that opens a
// section by itself on the page, household sections are never in the open set.
describe('never opens by itself', () => {
  const cell = TRIGGER_CELLS.find((c) => c.killedMutant === 'householdAlwaysOpen')
  it(`${cell.cell} — Dave's small pots open Needs care; her never-watered planting opens nothing of hers`, async () => {
    expect(cell.expectOpenExcludes).toEqual(['hh-*'])
    localStorage.setItem('garden.today.showOthers', '1')
    const jenNever = { ...JEN, water_due: JEN.water_due.slice(1), no_history: [{ ...JEN.water_due[0], never: true, days_since: null, overdue_by: null }] }
    planState.current = { data: withJen(jenNever), loading: false, error: null, reload: vi.fn() }
    await mount()
    expect(header('care').getAttribute('aria-expanded')).toBe('true') // the page's trigger did fire (small, D5)
    const open = [...document.querySelectorAll('[data-testid^="today-sec-"]')].filter((s) => s.querySelector('[aria-expanded]').getAttribute('aria-expanded') === 'true').map((s) => s.getAttribute('data-testid').slice('today-sec-'.length))
    expect(open.filter((k) => k.startsWith('hh-'))).toEqual([])
    expect(header(HH).getAttribute('aria-expanded')).toBe('false')
  })
})

describe('no cold rows in a member\'s section — Protect tonight owns them ("(Jen)", S5)', () => {
  it('a cold card on her plan is neither counted nor listed', async () => {
    localStorage.setItem('garden.today.showOthers', '1')
    const jenCold = { ...JEN, cold: [{ id: 'jen-cold-1', crop: 'lemongrass', name: 'Lemon Grass', text: 'Protect tonight (≤ 45°F)', level: 'protect', project: 'Herbs', project_id: 'pj' }] }
    planState.current = { data: withJen(jenCold), loading: false, error: null, reload: vi.fn() }
    await mount()
    expect(sec(HH).getAttribute('data-count')).toBe('15')
    fireEvent.click(header(HH))
    await settle()
    expect(sec(HH).textContent).not.toMatch(/Lemon Grass/)
    expect(householdSummary([{ need: 'cold' }])).toBe('All caught up.')
  })
})

describe('the same row anatomy and the SAME shared skip set', () => {
  it('opened: her groups and spots, as Needs care lays out Dave\'s', async () => {
    localStorage.setItem('garden.today.showOthers', '1')
    await mount()
    fireEvent.click(header(HH))
    await settle()
    const body = sec(HH)
    expect([...body.querySelectorAll('[data-testid="care-group"]')].map((g) => g.getAttribute('data-group'))).toEqual(['Outside', 'House'])
    expect([...body.querySelectorAll('[data-testid="care-spot"]')].map((s) => s.getAttribute('data-spot'))).toEqual(['Deck', 'House'])
    expect(within(body).getByRole('button', { name: 'Not today: House' })).toBeTruthy()
  })

  it('a Skip in her section lands in careStore\'s ONE set under V1\'s row key, and V1\'s household list for her hides the row', async () => {
    localStorage.setItem('garden.today.showOthers', '1')
    await mount()
    const daveCount = sec('care').getAttribute('data-count')
    fireEvent.click(header(HH))
    await settle()
    fireEvent.click(within(sec(HH)).getAllByRole('button', { name: /^Not today: House/ })[0])
    await settle()
    const skipped = readSkipped()
    const housePlantings = JEN.water_due.concat(JEN.fertilize).filter((r) => PLANTS.find((p) => p.id === r.id)?.location_id?.startsWith('7ee03125'))
    expect(housePlantings.length).toBeGreaterThan(0)
    for (const r of JEN.water_due.filter((x) => housePlantings.includes(x))) expect(skipped.has(r.id + ':water_due')).toBe(true)
    expect(sec(HH).getAttribute('data-count')).not.toBe('15')
    expect(sec('care').getAttribute('data-count')).toBe(daveCount) // Dave's own list untouched
    cleanup()
    // V1's household list for her (CareNeeded list=<member>) reads the same store: those rows are gone there too.
    render(<MemoryRouter><CareNeeded plan={JEN} planDate={TODAY} list={JEN_ID} /></MemoryRouter>)
    await settle()
    expect(document.body.textContent).not.toMatch(/Green Fittonia/)
    expect(document.body.textContent).toMatch(/Scallion/) // her Deck rows were not skipped
  })

  it('a write on her planting goes through the one events path with her planting and project', async () => {
    localStorage.setItem('garden.today.showOthers', '1')
    await mount()
    fireEvent.click(header(HH))
    await settle()
    fireEvent.click(within(sec(HH)).getByRole('button', { name: /^Water all 2 in Deck$/ }))
    await settle()
    const deck = JEN.water_due.filter((r) => /Scallion|Onion/.test(r.name)).map((r) => r.id).sort()
    expect(wire.posts.map((b) => b.plant_id).sort()).toEqual(deck)
    expect(wire.posts.every((b) => b.event_type === 'watering')).toBe(true)
  })
})

describe('visit + Layer 1, as every section', () => {
  it('Expand all opens her section with the rest (visit only); a header tap is remembered under hh-<sub8>', async () => {
    localStorage.setItem('garden.today.showOthers', '1')
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' })) // Needs care opened itself (small pots)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    await settle()
    expect(header(HH).getAttribute('aria-expanded')).toBe('true')
    expect(localStorage.getItem('today-sections:harness_user')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    await settle()
    expect(header(HH).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(header(HH))
    await settle()
    expect(JSON.parse(localStorage.getItem('today-sections:harness_user')).s[HH]).toEqual({ open: true, at: TODAY })
  })
})
