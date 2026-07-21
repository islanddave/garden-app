// V4-HARVESTSURF-001 — the harvest-readiness predicate. NULL means UNKNOWN and must never fire; the
// DOY window is a suppressor (incl. wrap-around); `single` is terminal; clock skew must not fire.
import { describe, it, expect } from 'vitest'
import { inHarvestWindow, isReadyToPick, rankHarvestReady, lastPickedLabel } from '../lib/harvestReadiness.js'

const c = (over = {}) => ({
  plant_id: 'p1', project_id: 'proj1', name: 'Test Planting',
  harvest_habit: 'repeat', repeat_interval_days: 3, days_since_last_harvest: 5,
  harvest_season_start_doy: null, harvest_season_end_doy: null, ...over,
})

describe('inHarvestWindow', () => {
  it('no window configured => never suppresses', () => {
    expect(inHarvestWindow(202, null, null)).toBe(true)
  })
  it('forward window: inside fires, outside does not, edges inclusive', () => {
    expect(inHarvestWindow(130, 115, 166)).toBe(true)
    expect(inHarvestWindow(115, 115, 166)).toBe(true)
    expect(inHarvestWindow(166, 115, 166)).toBe(true)
    expect(inHarvestWindow(114, 115, 166)).toBe(false)
    expect(inHarvestWindow(202, 115, 166)).toBe(false)
  })
  it('wrap-around window (start > end) spans the year boundary', () => {
    expect(inHarvestWindow(350, 330, 40)).toBe(true)
    expect(inHarvestWindow(10, 330, 40)).toBe(true)
    expect(inHarvestWindow(330, 330, 40)).toBe(true)
    expect(inHarvestWindow(40, 330, 40)).toBe(true)
    expect(inHarvestWindow(200, 330, 40)).toBe(false)
  })
  it('unknown doy with a configured window suppresses (UNKNOWN never fires)', () => {
    expect(inHarvestWindow(null, 115, 166)).toBe(false)
  })
})

describe('isReadyToPick', () => {
  it('fires for a repeating crop past its interval', () => {
    expect(isReadyToPick(c(), 202)).toBe(true)
  })
  it('fires exactly AT the interval (boundary)', () => {
    expect(isReadyToPick(c({ repeat_interval_days: 3, days_since_last_harvest: 3 }), 202)).toBe(true)
  })
  it('does NOT fire at interval minus one', () => {
    expect(isReadyToPick(c({ repeat_interval_days: 3, days_since_last_harvest: 2 }), 202)).toBe(false)
  })
  it('`single` habit never fires (terminal harvest)', () => {
    expect(isReadyToPick(c({ harvest_habit: 'single', repeat_interval_days: 3 }), 202)).toBe(false)
  })
  it('cut_and_come_again fires', () => {
    expect(isReadyToPick(c({ harvest_habit: 'cut_and_come_again', repeat_interval_days: 7, days_since_last_harvest: 9 }), 202)).toBe(true)
  })
  it('NULL interval never fires', () => {
    expect(isReadyToPick(c({ repeat_interval_days: null }), 202)).toBe(false)
  })
  it('NULL habit never fires', () => {
    expect(isReadyToPick(c({ harvest_habit: null }), 202)).toBe(false)
  })
  it('NULL days_since never fires', () => {
    expect(isReadyToPick(c({ days_since_last_harvest: null }), 202)).toBe(false)
  })
  it('negative days_since (future-dated harvest / clock skew) never fires', () => {
    expect(isReadyToPick(c({ days_since_last_harvest: -4 }), 202)).toBe(false)
  })
  it('DOY suppressor: in-window fires, out-of-window does not (asparagus)', () => {
    const asparagus = c({ harvest_habit: 'repeat', repeat_interval_days: 1, days_since_last_harvest: 6,
      harvest_season_start_doy: 115, harvest_season_end_doy: 166 })
    expect(isReadyToPick(asparagus, 130)).toBe(true)
    expect(isReadyToPick(asparagus, 202)).toBe(false)
  })
  it('DOY suppressor honours a wrap-around window', () => {
    const winter = c({ harvest_season_start_doy: 330, harvest_season_end_doy: 40 })
    expect(isReadyToPick(winter, 5)).toBe(true)
    expect(isReadyToPick(winter, 200)).toBe(false)
  })
  it('rejects a null/undefined candidate', () => {
    expect(isReadyToPick(null, 202)).toBe(false)
  })
})

describe('rankHarvestReady', () => {
  it('orders by overdue ratio descending and drops ineligible rows', () => {
    const out = rankHarvestReady([
      c({ plant_id: 'squash', name: 'Zephyr Squash', repeat_interval_days: 2, days_since_last_harvest: 2 }),   // 1.00
      c({ plant_id: 'wine', name: 'Wild Wineberry', repeat_interval_days: 2, days_since_last_harvest: 7 }),    // 3.50
      c({ plant_id: 'brocc', name: 'Green Magic', repeat_interval_days: 6, days_since_last_harvest: 11 }),     // 1.83
      c({ plant_id: 'melon', name: 'Melon', harvest_habit: 'single', repeat_interval_days: null }),            // dropped
      c({ plant_id: 'early', name: 'Not Yet', repeat_interval_days: 9, days_since_last_harvest: 1 }),          // dropped
    ], 202)
    expect(out.map(r => r.plant_id)).toEqual(['wine', 'brocc', 'squash'])
    expect(out[0].overdue_ratio).toBeCloseTo(3.5)
  })
  it('returns [] for an empty or non-array input', () => {
    expect(rankHarvestReady([], 202)).toEqual([])
    expect(rankHarvestReady(undefined, 202)).toEqual([])
  })
})

describe('lastPickedLabel', () => {
  it('reads as neutral cadence copy', () => {
    expect(lastPickedLabel(0)).toBe('last picked today')
    expect(lastPickedLabel(1)).toBe('last picked 1 day ago')
    expect(lastPickedLabel(7)).toBe('last picked 7 days ago')
  })
})
