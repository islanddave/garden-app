import { describe, it, expect } from 'vitest'
import { snapshotStats } from '../lib/snapshotStats.js'

const E = (o) => ({ event_id: 'x', day_key: '2026-07-20', harvest_log_id: 'h', quantity: 2, unit: 'cup', crop_type_slug: 'blueberry', crop_name: 'Blueberry', ...o })
const W = { todayKey: '2026-07-23', sevenDaysAgoKey: '2026-07-17' }

describe('snapshotStats', () => {
  it('lastHarvest = most recent entry; seasonCropCount from aggregates.crop_list', () => {
    const s = snapshotStats([E({ event_id: 'a' }), E({ event_id: 'b' })], { crop_list: [{}, {}, {}] }, W)
    expect(s.lastHarvest.event_id).toBe('a')
    expect(s.seasonCropCount).toBe(3)
  })
  it('last7 counts in-window entries and ranks top crops by event count', () => {
    const entries = [
      E({ event_id: '1', crop_type_slug: 'zucchini', crop_name: 'Zucchini', unit: 'count', quantity: 1 }),
      E({ event_id: '2', crop_type_slug: 'zucchini', crop_name: 'Zucchini', unit: 'count', quantity: 1 }),
      E({ event_id: '3', crop_type_slug: 'blueberry', crop_name: 'Blueberry', unit: 'cup', quantity: 2 }),
    ]
    const s = snapshotStats(entries, null, W)
    expect(s.last7.count).toBe(3)
    expect(s.last7.top[0].name).toBe('Zucchini')
    expect(s.last7.top[0].count).toBe(2)
  })
  it('excludes entries outside the 7-day window', () => {
    expect(snapshotStats([E({ day_key: '2026-07-01' })], null, W).last7.count).toBe(0)
  })
  it('nativeUnit set only for single-unit fully-quantified crops; null otherwise (count fallback)', () => {
    const single = snapshotStats([E({ unit: 'cup', quantity: 2 })], null, W)
    expect(single.last7.top[0].nativeUnit).toEqual({ unit: 'cup', total: 2 })
    const mixed = snapshotStats([E({ event_id: 'a', unit: 'cup', quantity: 2 }), E({ event_id: 'b', unit: 'count', quantity: 3 })], null, W)
    expect(mixed.last7.top[0].nativeUnit).toBeNull()
    const unq = snapshotStats([E({ harvest_log_id: null, quantity: null })], null, W)
    expect(unq.last7.top[0].nativeUnit).toBeNull()
  })
})
