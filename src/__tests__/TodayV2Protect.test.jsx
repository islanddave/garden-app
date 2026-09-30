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
const { planState, prefsState, auth, wire, api } = vi.hoisted(() => {
  const wire = { posts: [], deletes: [], failPlant: null, seq: 0, plants: null, locations: null, members: null, hold: false, held: [] }
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
          // wire.hold: the POST is SENT (counted) but answers only when the test releases it — weak signal.
          if (wire.hold) {
            wire.posts.push(body)
            await new Promise((r) => wire.held.push(r))
            return { id: 'ev' + (++wire.seq) }
          }
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
vi.mock('../hooks/useCachedFetch.js', () => ({
  useCachedFetch: (path) => ({ data: path === '/api/plants' ? wire.plants : path === '/api/members' ? wire.members : wire.locations, loading: false, error: null }),
}))
// S6 (merged at integration 2): the plan-independent bands (Harvest, Put-Up, the Sow row's lines) are fetched at the
// page and the ready point waits for them (useTodayBands); this file is not about them, so they answer at once,
// settled and empty — as in TodayV2.test.jsx.
vi.mock('../components/today/v2/useTodayBands.js', () => ({
  useTodayBands: () => ({ settled: true, watch: { data: null, failed: false, reload() {} }, compose: { data: null, settled: true, reload() {} }, soon: { data: null, failed: false, reload() {} }, sow: { items: null, settled: true }, harvest: { present: false, summary: null }, putup: { present: false, summary: null } }),
}))

import TodayV2 from '../pages/TodayV2.jsx'
import { PageScrollProvider } from '../hooks/usePageScrollManager.js'
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
  wire.posts = []; wire.deletes = []; wire.failPlant = null; wire.seq = 0; wire.hold = false; wire.held = []
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

  // Review 4160.2 IMPORTANT-3 (integration 2), Protect's half: /api/plants answering something that is not a list
  // must not gather the freeze night's 79 bring_in cards into ONE "Unplaced" cover row ("Cover all 79 in Unplaced"):
  // the rows fall back to project spots, as a failed /api/locations does.
  it('freeze with /api/plants answering a non-list: the cover rows are per project, never one Unplaced row covering all 79', async () => {
    serve(applyGrafts(PAYLOAD, PLANTS, ['freeze'], G).payload)
    wire.plants = { error: 'bad gateway' }
    await mount()
    const spots = [...document.querySelectorAll('[data-testid="protect-spot"]')]
    expect(spots.map((s) => s.getAttribute('data-spot'))).not.toContain('Unplaced')
    expect(spots.length).toBeGreaterThan(1)
    expect(spots.reduce((n, s) => n + Number(s.getAttribute('data-count')), 0)).toBe(79)
    expect(spots.every((s) => Number(s.getAttribute('data-count')) < 79)).toBe(true)
  })
})

// Review 4162.1 IMPORTANT-B (QA-T4): Protect's copy of the §6.3 double-log guard — useProtect's `loggedAtMount` over the
// today-logged store — pinned. Remounted as a Back (a page-scroll return: the visit record is restored) on the SAME plan,
// as useDailyPlan's seed would paint it before the refetch: what was covered or brought in stays off the list, and the
// page's every live cover control re-posts none of it. The in-flight variant is IMPORTANT-A's twin for Cover all.
describe('§6.3 in Protect: a covered plant never comes back live on the Back remount (review 4162.1 IMPORTANT-B)', () => {
  const back = async () => {
    render(<MemoryRouter><PageScrollProvider value={{ api: null, isReturn: true }}><TodayV2 /></PageScrollProvider></MemoryRouter>)
    await settle()
  }
  const coverSpot = (name) => document.querySelector(`[data-testid="protect-spot"][data-spot="${name}"]`)
  const spotNames = () => [...document.querySelectorAll('[data-testid="protect-spot"]')].map((s) => s.getAttribute('data-spot'))
  const perPlant = (ids) => ids.map((id) => wire.posts.filter((b) => b.plant_id === id).length)
  // Every live write control Protect offers after the Back, tapped once: whatever came back would be re-posted.
  const tapEverything = async () => {
    for (const b of [...document.querySelectorAll('[data-testid="protect-cover-all"]')]) { fireEvent.click(b); await settle() }
    for (const b of within(screen.getByTestId('protect-body')).queryAllByRole('button', { name: /^(Covered|Brought in): / })) { fireEvent.click(b); await settle() }
  }
  const freezeSpot = () => {
    const s = document.querySelectorAll('[data-testid="protect-spot"]')[0]
    return { name: s.getAttribute('data-spot'), n: Number(s.getAttribute('data-count')), el: s }
  }
  const plantsOf = (name) => {
    const s = coverSpot(name)
    if (s.querySelector('[aria-expanded]').getAttribute('aria-expanded') !== 'true') fireEvent.click(s.querySelector('[aria-expanded]'))
    return [...s.querySelectorAll('[data-testid="protect-row"] a')].map((a) => a.getAttribute('href').split('/').pop())
  }

  it('QA-T4: freeze graft, Cover all, unmount, Back on the same plan — the spot is not live and nothing is re-posted', async () => {
    serve(applyGrafts(PAYLOAD, PLANTS, ['freeze'], G).payload)
    const first = render(<MemoryRouter><TodayV2 /></MemoryRouter>); await settle()
    const { name, n, el } = freezeSpot()
    const others = spotNames().filter((x) => x !== name)
    const ids = plantsOf(name); await settle()
    expect(ids.length).toBe(n)
    fireEvent.click(within(el).getByRole('button', { name: `Cover all ${n} in ${name}` }))
    await settle()
    expect(perPlant(ids)).toEqual(Array(n).fill(1))
    first.unmount()
    await back()
    expect(band('protect').getAttribute('aria-expanded')).toBe('true')
    expect(spotNames()).toEqual(others) // the other cover rows are there, live — only the covered spot is gone
    expect(coverSpot(name)).toBeNull()
    expect(within(screen.getByTestId('protect-body')).queryByRole('button', { name: `Cover all ${n} in ${name}` })).toBeNull()
    await tapEverything()
    expect(perPlant(ids)).toEqual(Array(n).fill(1))
  })

  // On a Back the restored visit record's rowsDone also draws these two as done lines, so the guard is what holds them
  // on a NEW visit of the same plan day in this tab — Today's tab tapped from another page, the plan not yet refetched.
  it('one row each: Covered and Brought in, unmount, then a Back and a new visit on the same plan — neither row is live, neither is re-posted', async () => {
    const first = render(<MemoryRouter><TodayV2 /></MemoryRouter>); await settle()
    fireEvent.click(within(rowOf('Lantana')).getByRole('button', { name: 'Covered: Lantana' })); await settle()
    fireEvent.click(within(rowOf('Spider Plant')).getByRole('button', { name: 'Brought in: Spider Plant' })); await settle()
    expect(wire.posts.map((b) => [b.event_type, b.plant_id])).toEqual([['cover', ID.Lantana], ['brought_inside', ID['Spider Plant']]])
    first.unmount()
    await back()
    expect(band('protect').getAttribute('aria-expanded')).toBe('true')
    expect(rowOf('Lemon Verbena')).toBeTruthy() // the section's other rows are there, live
    expect(rowOf('Lantana')).toBeUndefined()
    expect(rowOf('Spider Plant')).toBeUndefined()
    cleanup()
    await mount() // a new visit: no record restored
    expect(band('protect').getAttribute('aria-expanded')).toBe('true')
    expect(rowOf('Lemon Verbena')).toBeTruthy()
    expect(rowOf('Lantana')).toBeUndefined()
    expect(rowOf('Spider Plant')).toBeUndefined()
    expect(doneOf('Lantana')).toBeUndefined()
    expect(band('protect').textContent).toContain('3')
    await tapEverything()
    expect(perPlant([ID.Lantana, ID['Spider Plant']])).toEqual([1, 1])
  })

  it('IMPORTANT-A\'s twin: a Cover all still in flight at unmount — Back, tap everything, release — each plant POSTed exactly once', async () => {
    serve(applyGrafts(PAYLOAD, PLANTS, ['freeze'], G).payload)
    wire.hold = true
    const first = render(<MemoryRouter><TodayV2 /></MemoryRouter>); await settle()
    const { name, n, el } = freezeSpot()
    const others = spotNames().filter((x) => x !== name)
    const ids = plantsOf(name); await settle()
    fireEvent.click(within(el).getByRole('button', { name: `Cover all ${n} in ${name}` }))
    await settle()
    expect(wire.posts.length).toBe(4) // concurrency 4: four sent, none answered
    first.unmount()
    await back()
    wire.hold = false
    expect(spotNames()).toEqual(others)
    expect(coverSpot(name)).toBeNull()
    await tapEverything()
    for (let i = 0; i < 20 && wire.held.length; i++) { wire.held.splice(0).forEach((r) => r()); await settle() }
    expect(perPlant(ids)).toEqual(Array(n).fill(1))
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
    // Integration 2 (S5 x S6): the count runs over S6's household section too — Jen's section is on the page, OPEN,
    // with every disclosure inside it open (its spots and their "Show them" cohorts) and her plant rows rendered — so
    // a second home for her cold row could not hide there.
    const hh = screen.getByTestId('today-sec-hh-member_j')
    expect(band('hh-member_j').getAttribute('aria-expanded')).toBe('true')
    for (let i = 0, b; i < 20 && (b = hh.querySelector('[aria-expanded="false"]')); i++) { fireEvent.click(b); await settle() }
    expect(hh.querySelectorAll('[aria-expanded="false"]').length).toBe(0)
    expect(hh.querySelectorAll('[role="listitem"][data-key]').length).toBeGreaterThan(0)
    expect(everywhere().length).toBe(1)
    expect(everywhere()[0].closest('[data-testid="today-sec-protect"]')).toBeTruthy()
    expect(hh.querySelectorAll('[data-key$=":cold"]').length).toBe(0)
    // ...nor counted there: her section counts her care rows alone (water 8 + feed 7), never the cold row Protect owns.
    expect(hh.getAttribute('data-count')).toBe('15')
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
