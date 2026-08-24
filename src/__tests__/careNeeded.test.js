// Slice 7 (V4-THEME-001) read-path parity anchor + classification (L-104/L-237).
// buildCareNeeded is the SINGLE SOURCE OF TRUTH; locking its output here means the CareNeeded
// component cannot silently reclassify/reorder which plantings need care. No jest-dom (L-182).
import { describe, it, expect } from 'vitest'
import {
  buildCareNeeded, groupRows, needReason, needTier, bedWaitActive, groupSeverity,
  splitContainersBeds, isBedRow, autoExpandKeys, waterStaleness, capStaleRows,
  NEED_EVENT_TYPE, EXPAND_ROW_BUDGET, WATER_STALE_DAYS, WATER_STALE_CAP,
} from '../lib/careNeeded.js'

// Golden plan exercising every bucket + the hard cases: a planting in two buckets (dedup→two rows),
// never:true, overdue ties (stable order), done (drops out), dormant (excluded), rain_skipped present.
const GOLDEN = {
  hydrology: { tomorrow_precip_in: 0.74, tomorrow_pop: 63 },
  rain_skipped: [{ id: 'rs1' }],
  water_due: [
    { id: 'p1', name: 'Bhut Jolokia', crop: 'pepper', project: 'Peppers', project_id: 'prP', overdue_by: 4, in_ground: false },
    { id: 'p2', name: 'Habanero',     crop: 'pepper', project: 'Peppers', project_id: 'prP', overdue_by: 2, in_ground: true },
    { id: 'p3', name: 'Done One',     crop: 'pepper', project: 'Peppers', project_id: 'prP', overdue_by: 1, done: true },
  ],
  no_history: [{ id: 'p4', name: 'New Basil', crop: 'basil', project: 'Herbs', project_id: 'prH', never: true }],
  fertilize: [{ id: 'p1', name: 'Bhut Jolokia', crop: 'pepper', project: 'Peppers', project_id: 'prP', item: 'MG', apply: 'half' }],
  pest: [{ id: 'p5', name: 'Kale', crop: 'kale', project: 'Greens', project_id: 'prG', label: 'Aphids likely' }],
  cold: [{ id: 'p6', name: 'Lime Tree', crop: 'citrus', project: 'Citrus', project_id: 'prC', text: 'Below 40 tonight' }],
  dormant: [{ id: 'p7', name: 'Fig', crop: 'fig', project: 'Citrus', project_id: 'prC' }],
}

const EXPECTED = [
  { key: 'p1:water_due',  plantingId: 'p1', name: 'Bhut Jolokia', crop: 'pepper', project: 'Peppers', projectId: 'prP', need: 'water_due',  eventType: 'watering',       reason: '4d overdue',      tier: 'terra-bold', interval: null, overdueBy: 4, inGround: false, never: false , reasonRedundant: true },
  { key: 'p2:water_due',  plantingId: 'p2', name: 'Habanero',     crop: 'pepper', project: 'Peppers', projectId: 'prP', need: 'water_due',  eventType: 'watering',       reason: '2d overdue',      tier: 'terra',      interval: null, overdueBy: 2, inGround: true,  never: false , reasonRedundant: true },
  { key: 'p4:no_history', plantingId: 'p4', name: 'New Basil',    crop: 'basil',  project: 'Herbs',   projectId: 'prH', need: 'no_history', eventType: 'watering',       reason: 'Never watered',   tier: 'gold',       interval: null, overdueBy: null, inGround: false, never: true , reasonRedundant: false },
  { key: 'p1:fertilize',  plantingId: 'p1', name: 'Bhut Jolokia', crop: 'pepper', project: 'Peppers', projectId: 'prP', need: 'fertilize',  eventType: 'fertilizing',    reason: 'MG · half',       tier: 'gold',       interval: null, overdueBy: null, inGround: false, never: false , reasonRedundant: false },
  { key: 'p5:pest',       plantingId: 'p5', name: 'Kale',         crop: 'kale',   project: 'Greens',  projectId: 'prG', need: 'pest',       eventType: 'observation',    reason: 'Aphids likely',   tier: 'gold',       interval: null, overdueBy: null, inGround: false, never: false , reasonRedundant: false },
  { key: 'p6:cold',       plantingId: 'p6', name: 'Lime Tree',    crop: 'citrus', project: 'Citrus',  projectId: 'prC', need: 'cold',       eventType: 'brought_inside', reason: 'Below 40 tonight',tier: 'gold',       interval: null, overdueBy: null, inGround: false, never: false , reasonRedundant: false },
]

describe('buildCareNeeded — read-path parity anchor', () => {
  it('emits the canonical row set byte-identical (ids/need/eventType/reason/tier/order)', () => {
    expect(buildCareNeeded(GOLDEN)).toEqual(EXPECTED)
  })
  it('drops engine-marked done items (V3-TODAYDONE-001 parity)', () => {
    expect(buildCareNeeded(GOLDEN).some(r => r.plantingId === 'p3')).toBe(false)
  })
  it('excludes dormant from the actionable list', () => {
    expect(buildCareNeeded(GOLDEN).some(r => r.need === 'dormant')).toBe(false)
  })
  it('yields two rows for a planting present in two buckets', () => {
    const p1 = buildCareNeeded(GOLDEN).filter(r => r.plantingId === 'p1')
    expect(p1.length).toBe(2)
    expect(p1.map(r => r.need)).toEqual(['water_due', 'fertilize'])
  })
  it('returns [] for a null / empty plan', () => {
    expect(buildCareNeeded(null)).toEqual([])
    expect(buildCareNeeded({})).toEqual([])
  })
})

describe('classification helpers', () => {
  it('maps each bucket to the correct event_type', () => {
    expect(NEED_EVENT_TYPE.water_due).toBe('watering')
    expect(NEED_EVENT_TYPE.no_history).toBe('watering')
    expect(NEED_EVENT_TYPE.fertilize).toBe('fertilizing')
    expect(NEED_EVENT_TYPE.pest).toBe('observation')
    expect(NEED_EVENT_TYPE.cold).toBe('brought_inside')
  })
  it('needTier escalates water by overdue days', () => {
    expect(needTier('water_due', { overdue_by: 0 })).toBe('gold')
    expect(needTier('water_due', { overdue_by: 1 })).toBe('terra')
    expect(needTier('water_due', { overdue_by: 3 })).toBe('terra-bold')
    expect(needTier('fertilize', {})).toBe('gold')
  })
  it('needReason prefers the engine rain_note for water', () => {
    expect(needReason('water_due', { rain_note: 'Rain credit', overdue_by: 5 })).toBe('Rain credit')
    expect(needReason('water_due', { overdue_by: 0 })).toBe('Due today')
  })
})

describe('grouping + bed-wait + expansion', () => {
  it('By type groups in NEED_ORDER', () => {
    const g = groupRows(buildCareNeeded(GOLDEN), 'type')
    expect(g.map(x => x.key)).toEqual(['water_due', 'no_history', 'fertilize', 'pest', 'cold'])
  })
  it('By location sorts the heaviest group first (auto-expand target)', () => {
    const g = groupRows(buildCareNeeded(GOLDEN), 'location')
    expect(g[0].key).toBe('prP')           // Peppers: two water rows (4d + 2d) plus a feed
    expect(groupSeverity(g[0].rows)).toBe(8.5)   // (1+4) + (1+2) + 0.5
  })
  it('bedWaitActive fires on the engine rain-callout gate', () => {
    expect(bedWaitActive(GOLDEN)).toBe(true)
    expect(bedWaitActive({ hydrology: { tomorrow_precip_in: 0.1, tomorrow_pop: 90 } })).toBe(false)
  })
  it('EXPAND_ROW_BUDGET is a small ADHD-friendly chunk', () => {
    expect(EXPAND_ROW_BUDGET).toBe(8)
  })

  it('V4-TODAYLOC-001: By location keys on real locationId/name when rows are enriched', () => {
    const rows = [
      { key: 'a', need: 'water_due', overdueBy: 1, project: 'Peppers', projectId: 'prP', locationId: 'locA', locationName: 'Greenhouse' },
      { key: 'b', need: 'water_due', overdueBy: 5, project: 'Peppers', projectId: 'prP', locationId: 'locB', locationName: 'Pasture Bed' },
    ]
    const g = groupRows(rows, 'location')
    expect(g.map(x => x.key)).toEqual(['locB', 'locA'])   // most-overdue location first
    expect(g[0].label).toBe('Pasture Bed')
  })

  it('V4-TODAYLOC-001: splitContainersBeds separates in-ground/raised beds from containers', () => {
    const rows = [
      { key: 'c1', containerType: 'fabric_bag', inGround: false },
      { key: 'b1', containerType: 'in_ground', inGround: true },
      { key: 'b2', containerType: 'raised_bed', inGround: false },
      { key: 'c2', containerType: 'trough', inGround: false },
    ]
    const { beds, containers } = splitContainersBeds(rows)
    expect(beds.map(r => r.key)).toEqual(['b1', 'b2'])
    expect(containers.map(r => r.key)).toEqual(['c1', 'c2'])
    expect(isBedRow({ inGround: true })).toBe(true)
    expect(isBedRow({ containerType: 'plastic_pot' })).toBe(false)
  })
})

// ── Group severity must see MASS, not just the worst row ────────────────────────────────────────
// Shapes taken from live prod, daily_plan 2026-08-17: "Bag Area" 116 water rows at overdue<=3 vs
// "Legacy Pasture In-Ground" 4 rows carrying a 19-day outlier. Under the old max(overdue_by) the
// 4-row group scored 19 to Bag Area's 3 and the screen opened on 4 of 206 items.
describe('groupSeverity — mass-weighted (C4)', () => {
  const water = (key, loc, overdueBy) => ({ key, need: 'water_due', overdueBy, locationId: loc, locationName: loc })
  const BAG = Array.from({ length: 116 }, (_, i) => water('bag' + i, 'Bag Area', i < 14 ? 3 : 2))
  const PASTURE = [19, 19, 16, 12].map((o, i) => water('pas' + i, 'Legacy Pasture In-Ground', o))

  it('the 116-row group outranks the 4-row group holding a 19-day outlier', () => {
    const g = groupRows([...PASTURE, ...BAG], 'location')
    expect(g[0].label).toBe('Bag Area')
    expect(g[0].severity).toBeGreaterThan(g[1].severity)
  })

  it('MUTATION GUARD: max(overdue_by) would invert this — the outlier group must NOT lead', () => {
    // If groupSeverity regresses to any max/mean aggregate this flips, because Pasture wins both.
    const g = groupRows([...PASTURE, ...BAG], 'location')
    const maxOverdue = (rows) => Math.max(...rows.map(r => r.overdueBy))
    expect(maxOverdue(g[1].rows)).toBeGreaterThan(maxOverdue(g[0].rows))
  })

  it('a single row still scores its presence plus its overdue days; non-water rows score a fraction', () => {
    expect(groupSeverity([water('x', 'L', 4)])).toBe(5)
    expect(groupSeverity([water('x', 'L', 0)])).toBe(1)
    expect(groupSeverity([{ key: 'p', need: 'pest' }])).toBe(0.5)
    // Two due-today rows outweigh one due-today row: presence is what mass is made of.
    expect(groupSeverity([water('a', 'L', 0), water('b', 'L', 0)])).toBe(2)
  })

  it('never_watered rows ride the water clock too (no_history is not a "fraction" need)', () => {
    expect(groupSeverity([{ key: 'n', need: 'no_history', overdueBy: null }])).toBe(1)
  })
})

describe('autoExpandKeys — cumulative row budget', () => {
  const g = (key, n) => ({ key, rows: Array.from({ length: n }, (_, i) => ({ key: key + i })) })

  it('opens every group when they all fit the budget (the old expand-all case)', () => {
    expect([...autoExpandKeys([g('a', 3), g('b', 3), g('c', 2)], 8)]).toEqual(['a', 'b', 'c'])
  })

  it('stops at the budget instead of collapsing everything but one', () => {
    // The cliff the old total<=8 gate had: 9 total needs used to collapse all but the lead group.
    expect([...autoExpandKeys([g('a', 5), g('b', 3), g('c', 1)], 8)]).toEqual(['a', 'b'])
  })

  it('always opens the lead group even when it alone blows the budget', () => {
    // An opening screen with everything collapsed shows nothing — the C4 failure itself.
    expect([...autoExpandKeys([g('a', 116), g('b', 4)], 8)]).toEqual(['a'])
  })

  it('returns an empty set for no groups', () => {
    expect(autoExpandKeys([], 8).size).toBe(0)
    expect(autoExpandKeys(null, 8).size).toBe(0)
  })
})

// ── Watering staleness (C1) ─────────────────────────────────────────────────────────────────────
describe('waterStaleness — median days_since, not min or max', () => {
  const due = (...daysSince) => ({ water_due: daysSince.map((d, i) => ({ id: 'p' + i, days_since: d })) })

  it('fires when half the list rests on a record >= WATER_STALE_DAYS old', () => {
    // Live 2026-08-17 shape: 194 due, median days_since 4, 93% at >= 4.
    const s = waterStaleness(due(2, 4, 4, 4, 4))
    expect(s.stale).toBe(true)
    expect(s.daysSince).toBe(4)
    expect(s.sampled).toBe(5)
  })

  it('stays silent on a big list whose record is fresh', () => {
    // Live 2026-08-15: 134 due at median 2 — Dave logged two days ago, the wi=1 cohort really is due.
    expect(waterStaleness(due(1, 2, 2, 2, 3)).stale).toBe(false)
  })

  it('MUTATION GUARD: min() could never fire and max() would fire every day', () => {
    // Both defeated on the SAME live-shaped input: one fresh wi=1 row and one long straggler.
    const plan = due(1, 4, 4, 4, 19)
    expect(Math.min(...plan.water_due.map(x => x.days_since))).toBe(1)   // min => never stale
    expect(Math.max(...plan.water_due.map(x => x.days_since))).toBe(19)  // max => always stale
    expect(waterStaleness(plan).daysSince).toBe(4)
    expect(waterStaleness(plan).stale).toBe(true)
    // ...and the same straggler must NOT drag a fresh list over the line.
    expect(waterStaleness(due(1, 1, 2, 19)).stale).toBe(false)
  })

  it('takes the LOWER median on an even count, so the flag never overstates', () => {
    expect(waterStaleness(due(2, 4)).daysSince).toBe(2)
    expect(waterStaleness(due(2, 4)).stale).toBe(false)
  })

  it('is not stale when there is nothing to measure (absent/null/checked-off days_since)', () => {
    expect(waterStaleness(null)).toEqual({ stale: false, daysSince: null, sampled: 0 })
    expect(waterStaleness({ water_due: [] }).stale).toBe(false)
    expect(waterStaleness({ water_due: [{ id: 'a' }, { id: 'b', days_since: null }] }).stale).toBe(false)
    expect(waterStaleness({ water_due: [{ id: 'a', days_since: 9, done: true }] }).sampled).toBe(0)
  })

  it('pins the threshold at the engine naked-fallback interval', () => {
    expect(WATER_STALE_DAYS).toBe(3)
  })
})

describe('capStaleRows — withholds inferences, never facts', () => {
  const w = (i) => ({ key: 'w' + i, need: 'water_due' })

  it('keeps the first `limit` water_due rows (engine order = longest-waiting first)', () => {
    const { rows, hidden } = capStaleRows(Array.from({ length: 30 }, (_, i) => w(i)), 20)
    expect(rows.length).toBe(20)
    expect(hidden).toBe(10)
    expect(rows[0].key).toBe('w0')
  })

  it('never withholds no_history / pest / feed / cold rows', () => {
    const rows = [w(0), w(1), { key: 'n', need: 'no_history' }, { key: 'p', need: 'pest' }, { key: 'c', need: 'cold' }]
    const out = capStaleRows(rows, 1)
    expect(out.rows.map(r => r.key)).toEqual(['w0', 'n', 'p', 'c'])
    expect(out.hidden).toBe(1)
  })

  it('returns the input array by identity when nothing is withheld', () => {
    const rows = [w(0), w(1)]
    const out = capStaleRows(rows, 20)
    expect(out.rows).toBe(rows)
    expect(out.hidden).toBe(0)
  })

  it('caps at about one phone screen of rows', () => {
    expect(WATER_STALE_CAP).toBe(20)
  })
})
