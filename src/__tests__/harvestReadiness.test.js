// V4-HARVESTSURF-001 — the harvest-readiness predicate. NULL means UNKNOWN and must never fire; the
// DOY window is a suppressor (incl. wrap-around); `single` is terminal; clock skew must not fire.
import { describe, it, expect } from 'vitest'
import { inHarvestWindow, isReadyToPick, rankHarvestReady, lastPickedLabel, MAX_OVERDUE_RATIO } from '../lib/harvestReadiness.js'

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
    // interval 3 / 6 days = ratio 2.0, inside the BD-001 staleness ceiling on purpose, so DOY is the
    // only variable here (the old interval-1/6-day fixture was ratio 6 and would now be rejected by
    // the ceiling, making the in-window leg fail and the out-of-window leg pass for the wrong reason).
    const asparagus = c({ harvest_habit: 'repeat', repeat_interval_days: 3, days_since_last_harvest: 6,
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

  // ── INCOHERENT MIXED ROW (added 2026-07-21 after a 7-agent crucible) ────────────────────────
  // A candidate can arrive carrying habit='single' TOGETHER WITH a non-null repeat_interval_days.
  // That shape is impossible within crop_types — chk_crop_types_repeat_interval forbids it — but
  // it becomes constructible the moment any resolver merges attributes from two sources (e.g. a
  // variety-level habit override inheriting the crop's interval). No table-local CHECK can reject
  // it, because the invariant spans two rows.
  //
  // Today isReadyToPick rejects it ONLY because the REPEATING_HABITS test happens to sit after the
  // interval test. That safety is a property of guard ORDER, not of the contract — and overdueRatio
  // reads repeat_interval_days with NO habit check at all, so the coincidence does not generalize.
  // These tests pin the behavior so a future reorder fails loudly instead of shipping a 2-day nag
  // on a single-harvest crop (the winter-squash hazard).
  it('never fires on habit=single even when an interval is present and exceeded', () => {
    expect(isReadyToPick(c({ harvest_habit: 'single', repeat_interval_days: 2, days_since_last_harvest: 9 }), 202)).toBe(false)
  })
  it('never fires on habit=single regardless of how far past the interval it is', () => {
    for (const days of [2, 30, 400]) {
      expect(isReadyToPick(c({ harvest_habit: 'single', repeat_interval_days: 2, days_since_last_harvest: days }), 202)).toBe(false)
    }
  })
  it('a habit override with no interval is INERT, not a firing signal', () => {
    // The mirror-image case. Overriding habit to a repeating value while the interval resolves to
    // NULL (e.g. crop_types.onion has harvest_habit='single' and repeat_interval_days NULL) is a
    // silent no-op — NULL still means UNKNOWN. Pinned so nobody assumes a habit-only fix "works".
    expect(isReadyToPick(c({ harvest_habit: 'cut_and_come_again', repeat_interval_days: null, days_since_last_harvest: 44 }), 202)).toBe(false)
  })

  // ── STALENESS CEILING (BD-001, harvest-window crucible V100 §6.1) ───────────────────────────
  // A row far past its own cadence is evidence the model is WRONG about that plant, not that the
  // plant is urgent — and rankHarvestReady sorts by ratio DESC, so those rows were being promoted
  // to the top of a 5-row band. Boundary is inclusive: exactly at the ceiling still fires.
  it('staleness ceiling: fires AT the ceiling ratio, rejects just past it', () => {
    expect(MAX_OVERDUE_RATIO).toBe(3)
    expect(isReadyToPick(c({ repeat_interval_days: 2, days_since_last_harvest: 6 }), 202)).toBe(true)   // 3.0
    expect(isReadyToPick(c({ repeat_interval_days: 2, days_since_last_harvest: 7 }), 202)).toBe(false)  // 3.5
  })
  it('staleness ceiling: rejects the live wineberry row (interval 2, 21 days => 10.5)', () => {
    expect(isReadyToPick(c({ name: 'Wild Wineberry', repeat_interval_days: 2, days_since_last_harvest: 21 }), 202)).toBe(false)
  })
  it('staleness ceiling: a genuinely-missed pick inside the ceiling still fires', () => {
    // 2-day cucumber left 5 days (2.5) and a 14-day scallion at 28 days (2.0) are real nudges.
    expect(isReadyToPick(c({ repeat_interval_days: 2, days_since_last_harvest: 5 }), 202)).toBe(true)
    expect(isReadyToPick(c({ repeat_interval_days: 14, days_since_last_harvest: 28 }), 202)).toBe(true)
  })
  it('staleness ceiling never widens the predicate — NULL/single/out-of-window still decide first', () => {
    // ratio 1.0 (well inside the ceiling) must not rescue any of the pre-existing rejections.
    expect(isReadyToPick(c({ harvest_habit: 'single', repeat_interval_days: 4, days_since_last_harvest: 4 }), 202)).toBe(false)
    expect(isReadyToPick(c({ repeat_interval_days: null, days_since_last_harvest: 4 }), 202)).toBe(false)
    expect(isReadyToPick(c({ repeat_interval_days: 4, days_since_last_harvest: 4, harvest_season_start_doy: 115, harvest_season_end_doy: 166 }), 202)).toBe(false)
  })
})

describe('rankHarvestReady', () => {
  it('orders by overdue ratio descending and drops ineligible rows', () => {
    const out = rankHarvestReady([
      c({ plant_id: 'squash', name: 'Zephyr Squash', repeat_interval_days: 2, days_since_last_harvest: 2 }),   // 1.00
      c({ plant_id: 'wine', name: 'Wild Wineberry', repeat_interval_days: 3, days_since_last_harvest: 7 }),    // 2.33
      c({ plant_id: 'brocc', name: 'Green Magic', repeat_interval_days: 6, days_since_last_harvest: 11 }),     // 1.83
      c({ plant_id: 'melon', name: 'Melon', harvest_habit: 'single', repeat_interval_days: null }),            // dropped
      c({ plant_id: 'early', name: 'Not Yet', repeat_interval_days: 9, days_since_last_harvest: 1 }),          // dropped
      c({ plant_id: 'stale', name: 'Long Gone', repeat_interval_days: 2, days_since_last_harvest: 21 }),       // 10.5 — dropped by the ceiling
    ], 202)
    expect(out.map(r => r.plant_id)).toEqual(['wine', 'brocc', 'squash'])
    expect(out[0].overdue_ratio).toBeCloseTo(2.33, 1)
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
