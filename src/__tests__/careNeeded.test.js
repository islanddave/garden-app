// Slice 7 (V4-THEME-001) read-path parity anchor + classification (L-104/L-237).
// buildCareNeeded is the SINGLE SOURCE OF TRUTH; locking its output here means the CareNeeded
// component cannot silently reclassify/reorder which plantings need care. No jest-dom (L-182).
import { describe, it, expect } from 'vitest'
import {
  buildCareNeeded, groupRows, needReason, needTier, bedWaitActive, groupSeverity,
  splitContainersBeds, isBedRow,
  NEED_EVENT_TYPE, EXPAND_ALL_THRESHOLD,
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
  { key: 'p1:water_due',  plantingId: 'p1', name: 'Bhut Jolokia', crop: 'pepper', project: 'Peppers', projectId: 'prP', need: 'water_due',  eventType: 'watering',       reason: '4d overdue',      tier: 'terra-bold', overdueBy: 4, inGround: false, never: false },
  { key: 'p2:water_due',  plantingId: 'p2', name: 'Habanero',     crop: 'pepper', project: 'Peppers', projectId: 'prP', need: 'water_due',  eventType: 'watering',       reason: '2d overdue',      tier: 'terra',      overdueBy: 2, inGround: true,  never: false },
  { key: 'p4:no_history', plantingId: 'p4', name: 'New Basil',    crop: 'basil',  project: 'Herbs',   projectId: 'prH', need: 'no_history', eventType: 'watering',       reason: 'Never watered',   tier: 'gold',       overdueBy: null, inGround: false, never: true },
  { key: 'p1:fertilize',  plantingId: 'p1', name: 'Bhut Jolokia', crop: 'pepper', project: 'Peppers', projectId: 'prP', need: 'fertilize',  eventType: 'fertilizing',    reason: 'MG · half',       tier: 'gold',       overdueBy: null, inGround: false, never: false },
  { key: 'p5:pest',       plantingId: 'p5', name: 'Kale',         crop: 'kale',   project: 'Greens',  projectId: 'prG', need: 'pest',       eventType: 'observation',    reason: 'Aphids likely',   tier: 'gold',       overdueBy: null, inGround: false, never: false },
  { key: 'p6:cold',       plantingId: 'p6', name: 'Lime Tree',    crop: 'citrus', project: 'Citrus',  projectId: 'prC', need: 'cold',       eventType: 'brought_inside', reason: 'Below 40 tonight',tier: 'gold',       overdueBy: null, inGround: false, never: false },
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
  it('By location sorts the most-overdue group first (auto-expand target)', () => {
    const g = groupRows(buildCareNeeded(GOLDEN), 'location')
    expect(g[0].key).toBe('prP')           // Peppers holds the 4d-overdue water need
    expect(groupSeverity(g[0].rows)).toBe(4)
  })
  it('bedWaitActive fires on the engine rain-callout gate', () => {
    expect(bedWaitActive(GOLDEN)).toBe(true)
    expect(bedWaitActive({ hydrology: { tomorrow_precip_in: 0.1, tomorrow_pop: 90 } })).toBe(false)
  })
  it('EXPAND_ALL_THRESHOLD is a small ADHD-friendly chunk', () => {
    expect(EXPAND_ALL_THRESHOLD).toBe(8)
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
