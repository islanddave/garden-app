// V5-TODAYREDESIGN-001 S5 — Protect tonight, mounted through the real TodayV2 on Dave's 2026-09-24 plans
// (tests/harness/_todaymeasure: busy at 47°F; busyfull's radiative advisory naming tonight at 41.8°F; the freeze
// graft's 79 bring_in cards at 36°F — the one SYNTHETIC payload, labelled so in v2-grafts.json), only the wire
// stubbed. Plan-v2 §8 S5 tests: tiers open it (chill first seen / frost), seen-before stays closed, stale opens
// nothing; `cover` vs `brought_inside` bodies; SF1's 8 px; the pick link on frost nights only; cold rows never
// render in Needs care; the household's cold rows join Protect once, named, only with the household view on
// (the orchestrator's rule, 2026-09-29). No jest-dom (L-182).
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
  wire: { posts: [], deletes: [], failPlant: null, seq: 0, plants: null, locations: null, members: null },
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
vi.mock('../hooks/useCachedFetch.js', () => ({
  useCachedFetch: (path) => ({ data: path === '/api/plants' ? wire.plants : path === '/api/members' ? wire.members : wire.locations, loading: false, error: null }),
}))

import TodayV2 from '../pages/TodayV2.jsx'
import { readSkipped } from '../components/today/careStore.js'
import { applyGrafts } from '../../tests/harness/_todaymeasure/v2wire.js'

const PAYLOAD = F('dailyplan.dave.json')
const PLANTS = (() => { const p = F('plants.json'); return Array.isArray(p) ? p : p.plants })()
const LOCS = F('locations.full.json')
const G = F('v2-grafts.json')
const BUSYFULL_ALERTS = F('busyfull-grafts.json').alerts_sent.value
const TODAY = PAYLOAD.plan_date // 2026-09-24
const ID = Object.fromEntries(PAYLOAD.plan.cold.map((c) => [c.name, c.id]))

const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)) })
const mount = async () => { render(<MemoryRouter><TodayV2 /></MemoryRouter>); await settle() }
const band = (key) => screen.getByTestId(`today-sec-${key}`).querySelector('[aria-expanded]')
const rowOf = (name) => [...document.querySelectorAll('[data-testid="protect-row"]')].find((r) => r.textContent.includes(name))
const doneOf = (name) => [...document.querySelectorAll('[data-testid="protect-row-done"]')].find((r) => r.textContent.includes(name))
const serve = (payload) => { planState.current = { data: payload, loading: false, error: null, reload: vi.fn() } }

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(TODAY + 'T14:30:00.000Z'))
  serve(PAYLOAD)
  prefsState.current = { prefs: null, prefsLoaded: true, refreshPrefs: async () => null }
  wire.posts = []; wire.deletes = []; wire.failPlant = null; wire.seq = 0
  wire.plants = PLANTS; wire.locations = LOCS; wire.members = { members: [{ id: 'u', display_name: 'Dave' }, { id: 'member_jen', display_name: 'Jen' }] }
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('Protect tonight on the 09-24 plan (47°F, five protect cards, no alert)', () => {
  it('opens by itself on the chill plantings\' first night here: first section, count 5, "Tonight · low 47°F · …" with the urgency cue', async () => {
    await mount()
    const sections = [...document.querySelectorAll('[data-testid^="today-sec-"]')].map((s) => s.getAttribute('data-section'))
    expect(sections[0]).toBe('protect')
    expect(band('protect').getAttribute('aria-expanded')).toBe('true')
    const text = band('protect').textContent
    expect(text).toContain('Protect tonight')
    expect(text).toContain('5')
    expect(text).toContain('Tonight · low 47°F · Lemon Verbena, Sweet Basil +3')
    expect(band('protect').querySelector('svg')).toBeTruthy() // severity.med: a trigger opened it
    expect(JSON.parse(sessionStorage.getItem(`today-visit:u:${TODAY}:v2`)).triggers.protect).toEqual({ t: 'chill' })
  })

  it('lists the five in the page\'s spot order, each "{spot} · below 50°F", with no pick link on a chill night', async () => {
    await mount()
    const rows = [...document.querySelectorAll('[data-testid="protect-row"]')]
    expect(rows.map((r) => r.querySelector('a').firstChild.textContent)).toEqual(['Lemon Verbena', 'Sweet Basil', 'Lantana', 'Tuberous Begonia (bronze-leaf, hanging)', 'Spider Plant'])
    expect(rows.map((r) => r.querySelector('a').lastChild.textContent)).toEqual(['Bag Area · below 50°F', 'Bag Area · below 50°F', 'Trough · below 50°F', 'Deck · below 50°F', 'Stable · below 50°F'])
    expect(rows[0].querySelector('a').getAttribute('href')).toBe(`/projects/${PAYLOAD.plan.cold[0].project_id}/plantings/${ID['Lemon Verbena']}`)
    expect(screen.queryByTestId('protect-pick')).toBeNull()
  })

  it('the chip reads "Protect 5" and leads the bar', async () => {
    await mount()
    const chips = [...screen.getByRole('navigation', { name: 'Today sections' }).querySelectorAll('[data-chip]')]
    expect(chips[0].getAttribute('data-chip')).toBe('protect')
    expect(chips[0].textContent).toBe('Protect 5')
  })

  it('marks the five first-seen on this device (plan day), and seen yesterday it stays closed — no cue, the words stand', async () => {
    await mount()
    const seen = JSON.parse(localStorage.getItem('today-seen:u'))
    expect(seen.season).toBe('2026-autumn')
    expect(Object.values(seen.chill)).toEqual(Array(5).fill(TODAY))
    cleanup(); sessionStorage.clear()
    localStorage.setItem('today-seen:u', JSON.stringify({ season: '2026-autumn', chill: Object.fromEntries(Object.keys(seen.chill).map((k) => [k, '2026-09-23'])) }))
    await mount()
    expect(band('protect').getAttribute('aria-expanded')).toBe('false')
    expect(band('protect').textContent).toContain('Tonight · low 47°F · Lemon Verbena, Sweet Basil +3')
    expect(band('protect').querySelector('svg')).toBeNull()
  })

  it('MF1: a close while the trigger holds it open records {t:"chill"} for the plan day, and holds on the next visit', async () => {
    await mount()
    fireEvent.click(band('protect'))
    expect(JSON.parse(localStorage.getItem('today-sections:u')).s.protect).toEqual({ open: false, at: TODAY, ack: { t: 'chill' } })
    cleanup(); sessionStorage.clear()
    await mount()
    expect(band('protect').getAttribute('aria-expanded')).toBe('false')
  })

  it('a stale plan (dated yesterday) opens nothing, and marks nothing seen', async () => {
    serve(applyGrafts(PAYLOAD, PLANTS, ['stale'], G).payload)
    await mount()
    expect(band('protect').getAttribute('aria-expanded')).toBe('false')
    expect(localStorage.getItem('today-seen:u')).toBeNull()
  })
})

describe('write paths (§2.3), done lines (§2.5) and SF1', () => {
  it('Covered posts `cover` for that planting, leaves "· covered" with Undo (focus on it); Undo deletes exactly that event', async () => {
    await mount()
    fireEvent.click(within(rowOf('Lantana')).getByRole('button', { name: 'Covered: Lantana' }))
    await settle()
    expect(wire.posts).toEqual([expect.objectContaining({ event_type: 'cover', plant_id: ID.Lantana, event_date: TODAY })])
    expect(doneOf('Lantana').textContent).toContain('Lantana · covered')
    expect(doneOf('Lantana').contains(document.activeElement)).toBe(true)
    expect(band('protect').textContent).toContain('4')
    fireEvent.click(within(doneOf('Lantana')).getByRole('button', { name: 'Undo: Lantana covered' }))
    await settle()
    expect(wire.deletes).toEqual(['/api/events/ev1'])
    expect(rowOf('Lantana')).toBeTruthy()
  })

  it('Brought in posts `brought_inside`; its done line says it is off the frost list until it goes back out (SF1)', async () => {
    await mount()
    fireEvent.click(within(rowOf('Spider Plant')).getByRole('button', { name: 'Brought in: Spider Plant' }))
    await settle()
    expect(wire.posts.map((b) => [b.event_type, b.plant_id])).toEqual([['brought_inside', ID['Spider Plant']]])
    expect(doneOf('Spider Plant').textContent).toBe('Spider Plant · brought in · off the frost list until it goes back outUndo')
  })

  it('Skip goes into the ONE shared skip set (no event); Undo takes it out', async () => {
    await mount()
    fireEvent.click(within(rowOf('Sweet Basil')).getByRole('button', { name: 'Skip Sweet Basil tonight' }))
    await settle()
    expect(wire.posts).toEqual([])
    expect([...readSkipped()]).toEqual([`${ID['Sweet Basil']}:cold`])
    expect(doneOf('Sweet Basil').textContent).toContain('Sweet Basil · skipped')
    fireEvent.click(within(doneOf('Sweet Basil')).getByRole('button', { name: /^Undo/ }))
    await settle()
    expect(readSkipped().size).toBe(0)
    expect(rowOf('Sweet Basil')).toBeTruthy()
  })

  it('SF1: 8 px of dead space between Covered and Brought in, and between Skip and Covered', async () => {
    await mount()
    const controls = within(rowOf('Lemon Verbena')).getByTestId('protect-controls')
    expect(controls.style.gap).toBe('8px')
    expect([...controls.children].map((b) => b.textContent)).toEqual(['Covered', 'Brought in'])
    const skip = within(rowOf('Lemon Verbena')).getByRole('button', { name: 'Skip Lemon Verbena tonight' })
    expect(skip.style.marginRight).toBe('8px')
    expect(skip.nextElementSibling).toBe(controls)
  })

  it('a failed write stays on its row as "Not logged" with Retry, which posts the same kind again', async () => {
    await mount()
    wire.failPlant = ID.Lantana
    fireEvent.click(within(rowOf('Lantana')).getByRole('button', { name: 'Covered: Lantana' }))
    await settle()
    expect(rowOf('Lantana').textContent).toContain('Not logged')
    wire.failPlant = null
    fireEvent.click(within(rowOf('Lantana')).getByRole('button', { name: 'Retry: Lantana' }))
    await settle()
    expect(wire.posts.map((b) => b.event_type)).toEqual(['cover'])
    expect(doneOf('Lantana').textContent).toContain('covered')
  })
})

describe('frost and freeze nights', () => {
  it('busyfull — a radiative advisory naming tonight: frost, "Before dark · low 42°F", the pick link first → /log/harvest', async () => {
    serve({ ...PAYLOAD, plan: { ...PAYLOAD.plan, alerts_sent: BUSYFULL_ALERTS } })
    await mount()
    expect(band('protect').getAttribute('aria-expanded')).toBe('true')
    expect(band('protect').textContent).toContain('Before dark · low 42°F · Lemon Verbena, Sweet Basil +3')
    const pick = screen.getByTestId('protect-pick')
    expect(pick.textContent).toBe('Pick what’s ripe first — log a harvest ›')
    expect(pick.getAttribute('href')).toBe('/log/harvest')
    expect(screen.getByTestId('protect-body').firstElementChild).toBe(pick)
    expect(JSON.parse(sessionStorage.getItem(`today-visit:u:${TODAY}:v2`)).triggers.protect).toEqual({ t: 'frost' })
  })

  it('freeze — the 79 bring_in cards group into cover rows per spot; Cover all posts `cover` for each and shrinks to one done line with ONE Undo', async () => {
    serve(applyGrafts(PAYLOAD, PLANTS, ['freeze'], G).payload)
    await mount()
    expect(band('protect').textContent).toContain('84')
    expect(screen.getByTestId('protect-pick')).toBeTruthy()
    expect(document.querySelectorAll('[data-testid="protect-row"]').length).toBe(5) // the tender tropicals, each its own row
    const spots = [...document.querySelectorAll('[data-testid="protect-spot"]')]
    expect(spots.reduce((n, s) => n + Number(s.getAttribute('data-count')), 0)).toBe(79)
    const s = spots[0]
    const name = s.getAttribute('data-spot')
    const n = Number(s.getAttribute('data-count'))
    fireEvent.click(within(s).getByRole('button', { name: `Cover all ${n} in ${name}` }))
    await settle()
    expect(wire.posts.length).toBe(n)
    expect(wire.posts.every((b) => b.event_type === 'cover')).toBe(true)
    const line = document.querySelector(`[data-testid="protect-done-line"][data-spot="${name}"]`)
    expect(line.textContent).toContain(`${name} · covered ${n}`)
    expect(line.querySelectorAll('button').length).toBe(1)
    fireEvent.click(within(line).getByRole('button'))
    await settle()
    expect(new Set(wire.deletes).size).toBe(n)
    expect(document.querySelector(`[data-testid="protect-spot"][data-spot="${name}"]`)).toBeTruthy()
  })
})

describe('cold rows have ONE owner', () => {
  it('never in Needs care: with every section and spot open, no cold key renders outside Protect; Needs care counts 233', async () => {
    await mount()
    for (const b of [...document.querySelectorAll('[data-testid="care-spot"] [aria-expanded="false"]')]) { fireEvent.click(b); await settle() }
    expect(document.querySelectorAll('[data-testid="today-sec-care"] [data-key$=":cold"]').length).toBe(0)
    expect(document.querySelectorAll('[data-testid="today-sec-protect"] [data-key$=":cold"]').length).toBe(5)
    expect(band('care').textContent).toContain('233')
  })

  // The household's cold rows join Protect, named, only for a person with the household view on (SF6), and nowhere
  // else. SYNTHETIC: Jen's real 09-24 plan has no cold card (her plantings are in the heated House or hardy), so one
  // is grafted — a real Trough coleus, as her planting, on the engine's protect-card template.
  const JEN_ROW = { id: '9a75c6e2-922c-4509-8ef2-0aec1385b013', name: 'Kiwi Fern Coleus', crop: 'coleus', project: 'Coleus', project_id: 'jen-coleus', level: 'protect', text: 'tender tropical — bring in tonight (low 47°F ≤ 50°F)' }
  const withJen = () => serve({ ...PAYLOAD, household_plans: [{ user_id: 'member_jen', generated_at: PAYLOAD.generated_at, plan: { ...F('dailyplan.jen.json'), cold: [JEN_ROW] } }] })
  const everywhere = () => [...document.querySelectorAll(`[data-key="${JEN_ROW.id}:cold"]`)]

  it('household view ON: Jen\'s cold row joins Protect exactly once, labelled "(Jen)", counted; it opens nothing else and shows nowhere else', async () => {
    localStorage.setItem('garden.today.showOthers', '1')
    withJen()
    await mount()
    expect(band('protect').textContent).toContain('6')
    const jen = rowOf('Kiwi Fern Coleus')
    expect(jen.textContent).toContain('Kiwi Fern Coleus (Jen)')
    expect(jen.textContent).toContain('Trough · below 50°F')
    expect(within(jen).getByRole('button', { name: 'Brought in: Kiwi Fern Coleus (Jen)' })).toBeTruthy()
    // Every section open, every spot open: still exactly one row for it on the whole page.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    await settle()
    for (const b of [...document.querySelectorAll('[data-testid="care-spot"] [aria-expanded="false"]')]) { fireEvent.click(b); await settle() }
    expect(everywhere().length).toBe(1)
    expect(everywhere()[0].closest('[data-testid="today-sec-protect"]')).toBeTruthy()
    expect(band('care').textContent).toContain('233') // her rows are counted in her own section, never the viewer's
    fireEvent.click(within(rowOf('Kiwi Fern Coleus')).getByRole('button', { name: 'Covered: Kiwi Fern Coleus (Jen)' }))
    await settle()
    expect(wire.posts).toEqual([expect.objectContaining({ event_type: 'cover', plant_id: JEN_ROW.id, project_id: 'jen-coleus' })])
  })

  it('household view OFF (the default): Jen\'s cold row appears nowhere and Protect counts the viewer\'s five', async () => {
    withJen()
    await mount()
    expect(band('protect').textContent).toContain('5')
    expect(everywhere().length).toBe(0)
    expect(rowOf('Kiwi Fern Coleus')).toBeUndefined()
  })

  it('with no plan of the viewer\'s own, the household\'s cold rows still make Protect (their one owner)', async () => {
    localStorage.setItem('garden.today.showOthers', '1')
    serve({ has_plan: false, plan: null, plan_date: TODAY, household_plans: [{ user_id: 'member_jen', plan: { ...F('dailyplan.jen.json'), cold: [JEN_ROW] } }] })
    await mount()
    expect(screen.getByTestId('today-noplan-card')).toBeTruthy()
    expect(band('protect').textContent).toContain('1')
    // Her coleus's first night on this device (chill): it opened by itself.
    expect(band('protect').getAttribute('aria-expanded')).toBe('true')
    expect(everywhere().length).toBe(1)
  })
})
