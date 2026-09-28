// The gate:today-shape:v2 contract and its fixture transforms, checked without a browser (V5-TODAYREDESIGN-001 S0).
// The gate proves the page; this proves the table and the grafts the page is served, so a typo in either fails
// in the unit suite instead of as a confusing red in real Chrome.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STATES, SLICES, LANDED, SHELL, REGIONS_V2, TRIGGER_CELLS, isArmed } from './today-v2-contract.mjs'
import { redatePayload, applyGrafts, localSeeds, selectorFor } from './v2wire.js'
import { groupsOfRows, EXPECTED_GROUPS } from './v2groups.mjs'
import { MUTANTS_V2 } from '../todayMutantsV2.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (f) => JSON.parse(readFileSync(join(HERE, f), 'utf8'))
const D = read('dailyplan.dave.json')
const PLANTS = read('plants.json')
const G = read('v2-grafts.json')
const FIXTURES = ['busy', 'busyfull', 'busyhh', 'quiet', 'noplan', 'storage']

describe('today-v2 contract table', () => {
  it('names every state once, with a known fixture, a prefs file that exists, and an ET-10:30 clock', () => {
    const names = STATES.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('v2-closed-today') // MF1's added state
    for (const s of STATES) {
      expect(FIXTURES).toContain(s.fixture)
      expect(existsSync(join(HERE, s.prefs))).toBe(true)
      expect(s.clock).toMatch(/^\d{4}-\d{2}-\d{2}T14:30:00\.000Z$/)
      for (const g of s.grafts || []) expect(Object.keys(G)).toContain(g)
    }
  })
  it('arms checks only by slices that exist, and S0 arms the instrument on every state', () => {
    const all = [...STATES.flatMap((s) => s.checks), ...SHELL, ...REGIONS_V2]
    for (const c of all) for (const sl of [].concat(c.armedAt)) expect(SLICES).toContain(sl)
    for (const s of STATES) expect(s.checks.some((c) => c.family === 'prefs-instrument' && isArmed(c))).toBe(true)
    expect(LANDED).toEqual(['S0', 'S2'])
  })
  // S2 arms the skeleton on EVERY state (version, prefs-loaded, no side-scroll, floors, title + date on the
  // first screen) plus the states S2's surface can answer: the quiet and no-plan first screens and both
  // remembered states. Pinned so a later edit cannot quietly un-arm them.
  it('S2 arms the skeleton everywhere and the quiet / no-plan / remembered states', () => {
    for (const s of STATES) for (const fam of ['version', 'prefs-loaded-attr', 'no-hscroll', 'floors', 'first-screen']) {
      expect(s.checks.some((c) => c.family === fam && isArmed(c))).toBe(true)
    }
    const armedIn = (name, fam) => STATES.find((s) => s.name === name).checks.filter((c) => c.family === fam && isArmed(c))
    expect(armedIn('v2-quiet', 'first-screen').some((c) => c.mustContain?.includes('care-empty') && c.wholePage)).toBe(true)
    expect(armedIn('v2-noplan', 'first-screen').some((c) => c.mustContain?.includes('today-noplan-card'))).toBe(true)
    expect(armedIn('v2-remembered', 'section-open-set').map((c) => c.open)).toEqual([['resting']])
    expect(armedIn('v2-remembered-conflict', 'section-open-set').map((c) => c.closed)).toEqual([['care']])
  })
  it('keeps every trigger-predicate mutant as a unit-table cell (Simplify 3), never silently dropped', () => {
    const cellMutants = new Set(TRIGGER_CELLS.map((c) => c.killedMutant))
    for (const [n, m] of Object.entries(MUTANTS_V2)) if (m.kind === 'unit-table') expect(cellMutants.has(n)).toBe(true)
  })
})

describe('v2 grafts and the re-dating helper', () => {
  it('re-dates plan_date and moves generated_at by whole days', () => {
    const p = redatePayload({ plan_date: '2026-10-01', generated_at: '2026-10-01T14:00:25.318Z' }, '2026-10-08')
    expect(p).toEqual({ plan_date: '2026-10-08', generated_at: '2026-10-08T14:00:25.318Z' })
    expect(() => redatePayload({ plan_date: '2026-10-01' }, '10/08')).toThrow()
  })
  it('routine moves exactly the 8 tray cells to fabric_bag and nothing else', () => {
    const { plants } = applyGrafts(D, PLANTS, ['routine'], G)
    const moved = plants.filter((p, i) => p.container_type !== PLANTS[i].container_type)
    expect(moved).toHaveLength(8)
    expect(new Set(moved.map((p) => p.container_type))).toEqual(new Set(['fabric_bag']))
  })
  it('never moves one real row to no_history with the engine never-arm shape', () => {
    const { payload } = applyGrafts(D, PLANTS, ['routine', 'never'], G)
    expect(payload.plan.water_due).toHaveLength(D.plan.water_due.length - 1)
    expect(payload.plan.no_history).toEqual([expect.objectContaining({ never: true, days_since: null, overdue_by: null })])
  })
  it('bedwait (SF4) leaves Outside Water all at 135 with two carve-out beds still listed', () => {
    const { payload } = applyGrafts(D, PLANTS, ['bedwait'], G)
    const beds = payload.plan.water_due.filter((r) => r.in_ground)
    expect(beds).toHaveLength(2)
    expect(payload.plan.rain_skipped).toHaveLength(17)
    expect(payload.plan.hydrology).toMatchObject({ tomorrow_precip_in: 0.62, tomorrow_pop: 70 })
    const g = groupsOfRows(payload.plan.water_due, PLANTS, read('locations.full.json'))
    expect(g.Outside - 2).toBe(135)
  })
  it('stale serves the plan one day back', () => {
    expect(applyGrafts(D, PLANTS, ['stale'], G).payload.plan_date).toBe('2026-09-23')
  })
  it('seeds the flag always, and first-seen for every served cold card', () => {
    const s = STATES.find((x) => x.name === 'v2-busy-seen')
    const seeds = Object.fromEntries(localSeeds(s, D, 'harness_user'))
    expect(seeds['garden.todayV2']).toBe('1')
    expect(Object.keys(JSON.parse(seeds['today-seen:harness_user']).chill)).toHaveLength(D.plan.cold.length)
  })
  it('resolves interaction targets to the contract anchors, and refuses an unknown one', () => {
    expect(selectorFor('jump:water')).toBe('[data-testid="today-jumpbar"] [data-chip="water"]')
    expect(selectorFor('today-sec-care', '-X')).toBe('[data-testid="today-sec-care-X"] [aria-expanded]')
    expect(() => selectorFor('bogus:thing')).toThrow()
  })
})

describe('SF5 — the locations dump groups into exactly Outside / Stable / House', () => {
  it('over every busy care row', () => {
    const p = D.plan
    const g = groupsOfRows([...p.water_due, ...p.fertilize, ...p.pest], PLANTS, read('locations.full.json'))
    expect(Object.keys(g).sort()).toEqual([...EXPECTED_GROUPS].sort())
    expect(g).toEqual({ Outside: 216, Stable: 15, House: 2 })
  })
})
