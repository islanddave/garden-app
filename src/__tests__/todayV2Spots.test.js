// V5-TODAYREDESIGN-001 S4 — the Needs care model (src/lib/todayV2/spots.js) and its auto-open predicate
// (src/lib/todayV2/triggers.js), on Dave's real 2026-09-24 plan (tests/harness/_todaymeasure) and the S0
// grafts the gate serves (v2wire.js applyGrafts — the same function, so the page judged and the model tested
// cannot describe different states). Plan-v2 §8 S4 tests: every planting accounted for once; group
// assignment; exceptions (Bag Area 8 / cohort 89; House ≤ 5 → no split; Stable → no cohort line); chip ==
// header == Σ spots; filters never re-sort; order held, new spots appended; bed-wait Outside only.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildCareNeeded } from '../lib/careNeeded.js'
import {
  OUTSIDE, SMALL_VESSEL_TYPES, locationIndex, enrichRows, takeOrder, buildModel, exceptionKeys, exceptionReason,
  sortCohort, cohortLine, cohortCapNote, productGroups, careSummary, waterCandidates,
} from '../lib/todayV2/spots.js'
import { careReasons, careTrigger, careOpens } from '../lib/todayV2/triggers.js'
import { applyGrafts } from '../../tests/harness/_todaymeasure/v2wire.js'
import { TRIGGER_CELLS } from '../../tests/harness/_todaymeasure/today-v2-contract.mjs'

const F = (f) => JSON.parse(readFileSync(resolve(process.cwd(), 'tests/harness/_todaymeasure', f), 'utf8'))
const PAYLOAD = F('dailyplan.dave.json')
const PLANTS = (() => { const p = F('plants.json'); return Array.isArray(p) ? p : p.plants })()
const LOCS = F('locations.full.json')
const G = F('v2-grafts.json')
const CARE = new Set(['water_due', 'no_history', 'fertilize', 'pest', 'overwintering'])

function state(grafts = []) {
  const { payload, plants } = applyGrafts(PAYLOAD, PLANTS, grafts, G)
  const plan = payload.plan
  const rows = enrichRows(buildCareNeeded(plan).filter((r) => CARE.has(r.need)), { plan, plants, locations: LOCS })
  return { plan, plants, rows }
}
const spotByName = (model, name) => model.groups.flatMap((g) => g.spots).find((s) => s.name === name)

describe('groups and spots on the busy plan (SF5, D7)', () => {
  const { rows } = state()
  const held = takeOrder(rows, locationIndex(LOCS).groupOrder)
  const m = buildModel(rows, { held })

  it('exactly Outside, Stable, House — in that order', () => {
    expect(m.groups.map((g) => g.key)).toEqual([OUTSIDE, 'Stable', 'House'])
  })
  it('spots per group, heaviest first, with plan §1.1\'s counts', () => {
    const sum = (s) => s.counts.water + s.counts.feed + s.counts.check
    expect(m.groups[0].spots.map((s) => [s.name, sum(s)])).toEqual([
      ['Bag Area', 141], ['Trough', 34], ['In-Ground', 29], ['Drive-Shade', 5], ['Drive', 4], ['Deck', 2], ['Yard - Stable', 1],
    ])
    expect(m.groups[1].spots.map((s) => [s.name, sum(s)])).toEqual([['Stable', 15]])
    expect(m.groups[2].spots.map((s) => [s.name, sum(s)])).toEqual([['House', 2]])
    expect(spotByName(m, 'Bag Area').parentPath).toBe('Pasture')
    expect(spotByName(m, 'Yard - Stable').group).toBe(OUTSIDE)
  })
  it('every planting row is accounted for exactly once; chip == header == Σ spots (§2.4 invariant)', () => {
    const seen = m.groups.flatMap((g) => g.spots.flatMap((s) => s.rows.map((r) => r.key)))
    expect(seen.length).toBe(rows.length)
    expect(new Set(seen).size).toBe(rows.length)
    const water = rows.filter((r) => r.task === 'water').length
    expect(water).toBe(168)
    expect(m.groups.flatMap((g) => g.spots).reduce((n, s) => n + s.counts.water, 0)).toBe(water)
    expect(rows.length).toBe(233)
  })
  it('group Water all = the visible spots\' candidates: Outside 154 with bed-wait off', () => {
    expect(m.groups[0].candidates.size).toBe(154)
    expect(m.groups[1].candidates.size).toBe(12)
    expect(m.groups[2].candidates.size).toBe(2)
  })
  it('filters hide, never re-sort; the spot filter drops spots, the task filter drops rows', () => {
    const w = buildModel(rows, { held, tasks: ['water'] })
    expect(w.groups[0].spots.map((s) => s.name)).toEqual(['Bag Area', 'Trough', 'In-Ground', 'Drive-Shade', 'Drive', 'Deck', 'Yard - Stable'])
    expect(spotByName(w, 'Yard - Stable').rows.length).toBe(0)
    expect(spotByName(w, 'Bag Area').counts).toEqual({ water: 97, feed: 0, check: 0 })
    const bag = spotByName(m, 'Bag Area').key
    const trough = spotByName(m, 'Trough').key
    const s = buildModel(rows, { held, spots: [trough, bag] })
    expect(s.groups.flatMap((g) => g.spots.map((x) => x.name))).toEqual(['Bag Area', 'Trough'])
  })
  it('order is held: a spot that empties keeps no slot in the model but a later spot never moves up past held ones; new spots append', () => {
    const drained = rows.filter((r) => r.spotName !== 'Trough')
    const d = buildModel(drained, { held })
    expect(d.groups[0].spots.map((s) => s.name)).toEqual(['Bag Area', 'In-Ground', 'Drive-Shade', 'Drive', 'Deck', 'Yard - Stable'])
    const partial = { groups: held.groups, spots: { ...held.spots, [OUTSIDE]: held.spots[OUTSIDE].slice(2) } }
    const n = buildModel(rows, { held: partial })
    expect(n.groups[0].spots.map((s) => s.name).slice(-2)).toEqual(['Bag Area', 'Trough'])
  })
  // S4g (MF3): rows whose write failed this visit are out of every bulk — spot and group — and only their Retry
  // re-posts them; they still count (they are still due), so chip == header == Σ spots holds.
  it('`exclude` keeps failed rows out of Water all (spot and group) and in the counts', () => {
    const bag = rows.filter((r) => r.spotName === 'Bag Area' && r.task === 'water').slice(0, 2).map((r) => r.key)
    const ds = rows.filter((r) => r.spotName === 'Drive-Shade').map((r) => r.key)
    const x = buildModel(rows, { held, exclude: new Set([...bag, ...ds]) })
    expect(spotByName(x, 'Bag Area').candidates.size).toBe(95)
    expect(bag.some((k) => spotByName(x, 'Bag Area').candidates.has(k))).toBe(false)
    expect(spotByName(x, 'Drive-Shade').candidates.size).toBe(0)
    expect(x.groups[0].candidates.size).toBe(147)
    expect(x.groups[0].spotsWithWater).toBe(5)
    expect(spotByName(x, 'Bag Area').counts).toEqual(spotByName(m, 'Bag Area').counts)
    expect(x.groups.flatMap((g) => g.spots).reduce((n, s) => n + s.counts.water, 0)).toBe(168)
    expect(waterCandidates(spotByName(m, 'Drive-Shade').rows, OUTSIDE, false, new Set(ds.slice(0, 1))).keys.size).toBe(4)
    expect(waterCandidates(spotByName(m, 'Drive-Shade').rows, OUTSIDE, false).keys.size).toBe(5)
  })
})

describe('exceptions and cohort (D11, §11.0 E8, SF2)', () => {
  const { rows } = state()
  const water = (name) => rows.filter((r) => r.spotName === name && r.task === 'water')

  it('Bag Area: the 8 tray cells differ from the rest; the cohort is 89', () => {
    const ex = exceptionKeys(water('Bag Area'))
    expect(ex.length).toBe(8)
    const exRows = water('Bag Area').filter((r) => ex.includes(r.key))
    expect(exRows.every((r) => r.containerType === 'tray_cell')).toBe(true)
    expect(exRows.map((r) => r.name).sort()).toEqual(['Copenhagen Market Cabbage', 'Dwarf Blue Curled Kale', 'Gourmet Blend Beets', 'Lacinato Dinosaur Kale', 'Palla Rossa Mavrik Radicchio', 'Rapini Broccoli Raab', 'Red Acre Cabbage', 'Redbor Kale'])
    const cohort = water('Bag Area').filter((r) => !ex.includes(r.key))
    expect(cohort.length).toBe(89)
    expect(cohortLine(cohort, true)).toBe('89 more like this · mostly daily · last watered 4 d ago')
    expect(exceptionReason(exRows[0])).toBe('Tray cell — dries fastest · every 2 days · last watered 4 d ago')
  })
  it('House (≤ 5 water rows) shows every row: no split', () => { expect(exceptionKeys(water('House'))).toBe(null) })
  it('Stable (no shared record) shows every row: no cohort line', () => { expect(exceptionKeys(water('Stable'))).toBe(null) })
  it('Trough: one shared record, nothing differs → all cohort', () => {
    const ex = exceptionKeys(water('Trough'))
    expect(ex).toEqual([])
    expect(cohortLine(water('Trough'), false)).toMatch(/^29 alike · mostly every 2 days · last watered 4 d ago$/)
  })
  it('a cohort under 3 is not a cohort', () => {
    const rs = water('Bag Area').slice(0, 7).map((r, i) => (i < 5 ? { ...r, containerType: 'tray_cell' } : r))
    expect(exceptionKeys(rs)).toBe(null)
  })
  it('SF2: cohort sorted by record, then crop, then name; tied ages drop "longest-waiting"', () => {
    const ex = exceptionKeys(water('Bag Area'))
    const cohort = sortCohort(water('Bag Area').filter((r) => !ex.includes(r.key)))
    const keyOf = (r) => [r.crop || '', r.name]
    for (let i = 1; i < cohort.length; i++) {
      const [a, b] = [keyOf(cohort[i - 1]), keyOf(cohort[i])]
      expect(a[0].localeCompare(b[0]) < 0 || (a[0] === b[0] && a[1].localeCompare(b[1]) <= 0)).toBe(true)
    }
    expect(cohortCapNote(cohort, 20)).toBe('Showing 20 of 89.')
    const mixed = [{ daysSince: 9, crop: 'a', name: 'x' }, ...cohort]
    expect(cohortCapNote(sortCohort(mixed), 20)).toBe('Showing the longest-waiting 20.')
    expect(cohortCapNote(cohort, 89)).toBe(null)
  })
})

describe('bed-wait applies to Outside only (D7, §2.4, SF4 graft)', () => {
  const { rows, plan } = state(['bedwait'])
  const idx = locationIndex(LOCS)
  it('Outside Water all 135; In-Ground has no candidates, 2 beds wait', () => {
    const m = buildModel(rows, { held: takeOrder(rows, idx.groupOrder), bedWait: true })
    expect(m.groups[0].candidates.size).toBe(G.bedwait.expect.outside_water_all_after)
    const ig = spotByName(m, 'In-Ground')
    expect(ig.candidates.size).toBe(0)
    expect(ig.bedsWaiting).toBe(2)
    expect(plan.hydrology.tomorrow_precip_in).toBe(0.62)
  })
  it('a covered group never excludes its beds', () => {
    const bed = { key: 'b', eventType: 'watering', inGround: true }
    expect(waterCandidates([bed], 'Stable', true).keys.size).toBe(1)
    expect(waterCandidates([bed], OUTSIDE, true).keys.size).toBe(0)
  })
})

describe('Feed per product across the garden (D12)', () => {
  const { rows } = state()
  it('one row per product + method; every feed row once', () => {
    const pg = productGroups(rows)
    expect(pg.reduce((n, g) => n + g.rows.length, 0)).toBe(58)
    expect(new Set(pg.map((g) => g.key)).size).toBe(pg.length)
    expect(pg[0].rows.length).toBeGreaterThanOrEqual(pg[pg.length - 1].rows.length)
  })
})

describe('the Needs care trigger (§3 care half, D5, MF1)', () => {
  it('busy: 8 small pots due → small; the summary names reasons + spots (SF8)', () => {
    const { rows, plan } = state()
    const reasons = careReasons({ rows, plan })
    expect(reasons.small.length).toBe(8)
    expect(reasons.never.length).toBe(0)
    expect(reasons.hot).toBe(false)
    expect(careTrigger(reasons)).toEqual({ r: 'small' })
    expect(careSummary({ reasons, rows, spotCount: 9 })).toBe('8 tray cells due · 9 spots')
  })
  it('routine graft: nothing opens it', () => {
    const { rows, plan } = state(['routine'])
    expect(careTrigger(careReasons({ rows, plan }))).toBe(null)
  })
  it('hot graft: a hot day with containers due', () => {
    const { rows, plan } = state(['routine', 'hot'])
    expect(careTrigger(careReasons({ rows, plan }))).toEqual({ r: 'hot' })
  })
  it('never graft: a never-watered planting', () => {
    const { rows, plan } = state(['routine', 'never'])
    expect(careTrigger(careReasons({ rows, plan }))).toEqual({ r: 'never' })
  })
  it('stale opens nothing', () => {
    const { rows, plan } = state()
    expect(careTrigger(careReasons({ rows, plan }), { stale: true })).toBe(null)
  })
  it('SMALL_VESSEL_TYPES matches the engine', () => {
    const src = readFileSync(resolve(process.cwd(), 'lambda/daily-plan/engine.js'), 'utf8')
    const m = src.match(/const SMALL_VESSEL_TYPES = new Set\(\[([^\]]*)\]\)/)
    expect(new Set(m[1].split(',').map((s) => s.trim().replace(/'/g, '')))).toEqual(SMALL_VESSEL_TYPES)
  })

  // The contract's trigger table (today-v2-contract.mjs TRIGGER_CELLS, §13 Simplify 3) — its Needs care cells.
  const CARE_CELLS = TRIGGER_CELLS.filter((c) => c.plan && !('lowRaw' in c.plan) && !c.household && !('frostTonight' in c.plan))
  it('the table has the four Needs care cells', () => { expect(CARE_CELLS.length).toBe(4) })
  for (const cell of CARE_CELLS) {
    it(`cell: ${cell.cell}`, () => {
      const p = cell.plan
      const reasons = { never: p.never ? ['n'] : [], hot: !!(p.hot && p.containerDue), small: p.small ? ['s'] : [] }
      const today = '2026-09-24'
      const entry = cell.ack ? { open: false, at: cell.ack.at === 'today' ? today : '2026-09-23', ack: { r: cell.ack.r } } : null
      const open = careOpens(careTrigger(reasons, { stale: !!p.stale }), entry, today)
      expect(open ? ['care'] : []).toEqual(cell.expectOpen.filter((k) => k === 'care'))
    })
  }
  it('stale cell of the table opens nothing', () => {
    const cell = TRIGGER_CELLS.find((c) => c.cell === 'stale plan opens nothing')
    expect(careTrigger({ small: ['s'], never: [], hot: false }, { stale: cell.plan.stale })).toBe(null)
  })
  it('MF1: a close with no ack, or an ack dated yesterday, holds nothing; a same-day ack holds until a new reason type', () => {
    const t = { r: 'small' }
    expect(careOpens(t, { open: false, at: '2026-09-24' }, '2026-09-24')).toBe(true)
    expect(careOpens(t, { open: false, at: '2026-09-23', ack: { r: 'small' } }, '2026-09-24')).toBe(true)
    expect(careOpens(t, { open: false, at: '2026-09-24', ack: { r: 'small' } }, '2026-09-24')).toBe(false)
    expect(careOpens({ r: ['never', 'small'] }, { open: false, at: '2026-09-24', ack: { r: 'small' } }, '2026-09-24')).toBe(true)
    expect(careOpens({ r: ['never', 'small'] }, { open: false, at: '2026-09-24', ack: { r: ['small', 'never'] } }, '2026-09-24')).toBe(false)
    expect(careOpens(null, null, '2026-09-24')).toBe(false)
  })
})

describe('degrades when /api/locations is unreadable', () => {
  it('spots fall back to projects, in no named group', () => {
    const { plan } = state()
    const rows = enrichRows(buildCareNeeded(plan).filter((r) => CARE.has(r.need)), { plan, plants: PLANTS, locations: null })
    expect(rows.every((r) => r.group === null && r.spotKey.startsWith('project:'))).toBe(true)
  })
  it('an unplaced planting lands in Outside, spot "Unplaced"', () => {
    const idx = locationIndex(LOCS)
    expect(idx.spotOf(undefined)).toEqual({ key: '_unplaced', name: 'Unplaced', parentPath: null, group: OUTSIDE })
  })
})
