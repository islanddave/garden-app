import { describe, it, expect } from 'vitest'
import { snapshotStats } from '../lib/snapshotStats.js'

// BUG-HARVSNAPSHOT7D-001. The "Last 7 days" tile used to be derived by filtering the season
// `entries` array — a 50-row PAGE — and read 50 on live prod against a true 163. It now reads a
// server-scoped 7-day AGGREGATE, which has no cursor and no limit. The tests below are written
// against that input, and the first one is the pin: entries must not be able to move the number.
const E = (o) => ({ event_id: 'x', day_key: '2026-07-20', harvest_log_id: 'h', quantity: 2, unit: 'cup', crop_type_slug: 'blueberry', crop_name: 'Blueberry', ...o })
// One crops[] bucket in the shape computeAggregates emits: per-unit {total, count} plus the
// quantity-less picks, which live outside the unit map and are still picks.
const C = (name, units, unquantified = 0) => ({ crop_type_slug: name.toLowerCase(), crop_name: name, units, unquantified })
const U = (unit, total, count) => ({ unit, unit_key: unit, total, count })

describe('snapshotStats', () => {
  it('lastHarvest = most recent entry; seasonCropCount from aggregates.crop_list', () => {
    const s = snapshotStats([E({ event_id: 'a' }), E({ event_id: 'b' })], { crop_list: [{}, {}, {}] }, null)
    expect(s.lastHarvest.event_id).toBe('a')
    expect(s.seasonCropCount).toBe(3)
  })

  it('THE REGRESSION: last7.count comes from the aggregate, never from the entries page', () => {
    // The truncated-page shape exactly: a handful of entries in hand, 163 picks in the window.
    const s = snapshotStats([E({ event_id: '1' }), E({ event_id: '2' })], { crop_list: [] }, {
      crops: [C('Zucchini', [U('count', 400, 120)]), C('Blueberry', [U('cup', 60, 43)])], other: [],
    })
    expect(s.last7.count).toBe(163)
  })

  it('counts every pick — quantity-less ones live outside the unit map and still happened', () => {
    const s = snapshotStats([], null, { crops: [C('Kale', [U('bunch', 4, 4)], 2)], other: [] })
    expect(s.last7.count).toBe(6)
  })

  it('counts unattributed picks too — other[] holds harvests with no planting', () => {
    const s = snapshotStats([], null, {
      crops: [C('Kale', [U('bunch', 4, 4)])],
      other: [{ project_id: 'p1', project_name: 'Kitchen garden', units: [U('cup', 3, 3)], unquantified: 1 }],
    })
    expect(s.last7.count).toBe(8)
  })

  it('ranks the top 2 crops by event count', () => {
    const s = snapshotStats([], null, {
      crops: [C('Blueberry', [U('cup', 6, 3)]), C('Zucchini', [U('count', 9, 9)]), C('Basil', [U('bunch', 5, 5)])],
      other: [],
    })
    expect(s.last7.top.map((t) => [t.name, t.count])).toEqual([['Zucchini', 9], ['Basil', 5]])
  })

  it('an absent aggregate reads as a quiet week, not as a filtered entries page', () => {
    // Wrong is worse than absent: the fallback must never be the truncated derivation this replaced.
    const s = snapshotStats([E({ event_id: 'a' }), E({ event_id: 'b' })], { crop_list: [{}] }, null)
    expect(s.last7).toEqual({ count: 0, top: [] })
  })

  it('nativeUnit set only for single-unit fully-quantified crops; null otherwise (count fallback)', () => {
    const single = snapshotStats([], null, { crops: [C('Blueberry', [U('cup', 2, 1)])], other: [] })
    expect(single.last7.top[0].nativeUnit).toEqual({ unit: 'cup', total: 2 })
    const mixed = snapshotStats([], null, { crops: [C('Dill', [U('cup', 2, 1), U('bunch', 3, 1)])], other: [] })
    expect(mixed.last7.top[0].nativeUnit).toBeNull()
    const unq = snapshotStats([], null, { crops: [C('Kale', [U('bunch', 2, 1)], 1)], other: [] })
    expect(unq.last7.top[0].nativeUnit).toBeNull()
  })
})
