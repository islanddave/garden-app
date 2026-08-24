// BUG-CADENCEONEDAY-001 — the wi=1 framing rules, pinned.
//
// Live shape these fixtures come from (prod daily_plan, 2026-08-18): 82 of 228 active plantings
// resolve to interval 1, ~54 of them CORRECTLY — the cultivar profiles say "grow bags likely daily
// summer" in their own words. So the number is not the defect and no test here asserts it should
// change. What is pinned is that a one-day cadence stops rendering as an accumulating backlog while
// a two-day-or-longer cadence keeps every bit of its overdue escalation. The two must never be
// conflated: every rule below is asserted on a wi=1 row AND on a wi>=2 row carrying the IDENTICAL
// overdue_by, so a change that flattens both at once fails here.
import { describe, it, expect } from 'vitest'
import {
  buildCareNeeded, needReason, needTier, groupSeverity,
  EXPAND_ROW_BUDGET, WATER_STALE_DAYS,
} from '../lib/careNeeded.js'
import { isDailyCadence, DAILY_INTERVAL_DAYS } from '../lib/waterDue.js'

// A 10-gal fabric-bag tomato on the profile-authored daily cadence, five days past its last logged
// bulk water — i.e. Super Sweet 100 as it actually stood on 2026-08-18.
const daily = (over) => ({ id: 'd1', name: 'Super Sweet 100', crop: 'tomato', project: 'Bag Area', project_id: 'prB', interval: 1, days_since: over + 1, overdue_by: over, in_ground: false })
// The control: same elapsed gap, same overdue_by, a cadence where that number MEANS something.
const weekly = (over) => ({ id: 'w1', name: 'Blueberry', crop: 'blueberry', project: 'Bag Area', project_id: 'prB', interval: 7, days_since: over + 7, overdue_by: over, in_ground: false })

describe('isDailyCadence — the one definition of "daily"', () => {
  it('is exactly the interval 1, and nothing that merely looks like it', () => {
    expect(DAILY_INTERVAL_DAYS).toBe(1)
    expect(isDailyCadence(1)).toBe(true)
    expect(isDailyCadence(2)).toBe(false)
    expect(isDailyCadence(0)).toBe(false)
    // The three ways an interval goes missing, all of which must fall through to the normal path
    // rather than silently claim a daily cadence.
    expect(isDailyCadence(null)).toBe(false)
    expect(isDailyCadence(undefined)).toBe(false)
    expect(isDailyCadence('1')).toBe(false)
  })
})

describe('needReason — a daily cadence never says "overdue"', () => {
  it('reads as the cadence, not a backlog, when the record is fresh', () => {
    expect(needReason('water_due', daily(0))).toBe('Daily — due today')
    expect(needReason('water_due', daily(1))).toBe('Daily — due today')
  })

  it('states the RECORD as a fact once the gap is genuinely long', () => {
    // days_since crosses WATER_STALE_DAYS: still no "overdue", but the elapsed fact is not hidden —
    // a daily plant untouched for five days is visibly different from one watered yesterday.
    expect(needReason('water_due', daily(4))).toBe('Daily — last watered 5d ago')
    expect(needReason('water_due', { interval: 1, days_since: WATER_STALE_DAYS, overdue_by: 2 }))
      .toBe('Daily — last watered ' + WATER_STALE_DAYS + 'd ago')
    expect(needReason('water_due', { interval: 1, days_since: WATER_STALE_DAYS - 1, overdue_by: 1 }))
      .toBe('Daily — due today')
  })

  it('leaves a wi>=2 cadence untouched at the SAME overdue_by', () => {
    expect(needReason('water_due', weekly(4))).toBe('4d overdue')
    expect(needReason('water_due', weekly(0))).toBe('Due today')
    expect(needReason('water_due', { interval: 2, days_since: 6, overdue_by: 4 })).toBe('4d overdue')
  })

  it('still yields to the engine rain_note, on both cadences', () => {
    expect(needReason('water_due', { ...daily(4), rain_note: 'Water — 0.1" rain didn’t cover the gap' }))
      .toBe('Water — 0.1" rain didn’t cover the gap')
    expect(needReason('water_due', { ...weekly(4), rain_note: 'Water — fresh transplant' }))
      .toBe('Water — fresh transplant')
  })

  it('does not touch no_history — "never watered" is a fact, not an elapsed-time inference', () => {
    // The engine emits interval on never-watered rows too (engine.js:702), so this row WOULD match
    // the daily predicate if the rule were applied bucket-blind.
    expect(needReason('no_history', { interval: 1, never: true, days_since: null })).toBe('Never watered')
  })
})

describe('needTier — daily is pinned to gold, wi>=2 still escalates', () => {
  it('never escalates a daily cadence on elapsed days alone', () => {
    expect(needTier('water_due', daily(0))).toBe('gold')
    expect(needTier('water_due', daily(1))).toBe('gold')
    expect(needTier('water_due', daily(4))).toBe('gold')
    expect(needTier('water_due', daily(19))).toBe('gold')
  })

  it('keeps the full escalation for wi>=2 at the SAME overdue_by', () => {
    expect(needTier('water_due', weekly(0))).toBe('gold')
    expect(needTier('water_due', weekly(1))).toBe('terra')
    expect(needTier('water_due', weekly(4))).toBe('terra-bold')
  })
})

describe('buildCareNeeded — the daily row is present, actionable, and carries no backlog number', () => {
  const plan = {
    water_due: [daily(4), weekly(4)],
    no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
  }

  it('does NOT hide the daily planting — it is still a row with a watering action', () => {
    const rows = buildCareNeeded(plan)
    const d = rows.find(r => r.plantingId === 'd1')
    expect(d).toBeTruthy()
    expect(d.need).toBe('water_due')
    expect(d.eventType).toBe('watering')     // one-tap Log + the bulk fan-out both key off this
    expect(d.name).toBe('Super Sweet 100')
  })

  it('suppresses overdueBy at the source for daily, keeps it for wi>=2', () => {
    const rows = buildCareNeeded(plan)
    expect(rows.find(r => r.plantingId === 'd1').overdueBy).toBe(null)
    expect(rows.find(r => r.plantingId === 'w1').overdueBy).toBe(4)
  })

  it('carries the interval through so the rule stays checkable downstream', () => {
    const rows = buildCareNeeded(plan)
    expect(rows.find(r => r.plantingId === 'd1').interval).toBe(1)
    expect(rows.find(r => r.plantingId === 'w1').interval).toBe(7)
  })
})

describe('groupSeverity — a daily cohort scores its mass, not a phantom backlog', () => {
  it('scores daily water rows at presence only', () => {
    // Ten wi=1 rows at overdue_by 4 apiece. Under the old rule they would score 10 x (1+4) = 50 and
    // out-shout every other group on the screen purely for being on a daily cadence.
    const rows = buildCareNeeded({ water_due: Array.from({ length: 10 }, (_, i) => ({ ...daily(4), id: 'd' + i })) })
    expect(groupSeverity(rows)).toBe(10)
  })

  it('still scores the backlog for wi>=2 rows at the same overdue_by', () => {
    const rows = buildCareNeeded({ water_due: Array.from({ length: 10 }, (_, i) => ({ ...weekly(4), id: 'w' + i })) })
    expect(groupSeverity(rows)).toBe(50)
  })
})

// The three `bulkWaterNote` cases that stood here were deleted with the function itself
// (V4-TODAYVERBIAGE-001, 2026-08-24 — Dave: "I understand the arithmetic"). Kept as a marker so a
// future reader does not go looking for coverage that was removed on purpose rather than lost.
