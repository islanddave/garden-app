// V4-HARVESTVIEW-001 S4 — the shared grow-year helper (design §2b: the enumerated derivation set —
// 11-01 -> next year, 10-31 -> same year, a DST-week date, empty data -> current season only).
// Server-side season-boundary correctness is NOT provable here: the Lambda filters in SQL and only
// tests/integration/harvests.int.test.js exercises it against real Postgres. These pin the CLIENT
// derivation only.
import { describe, it, expect } from 'vitest'
import { growYearOfDayKey, currentGrowYear, growYearSpan, growYearOptions, HARVEST_TZ } from '../lib/growYear.js'

describe('growYearOfDayKey', () => {
  it('Nov 1 belongs to the FOLLOWING grow-year (a November harvest files under next season)', () => {
    expect(growYearOfDayKey('2025-11-01')).toBe(2026)
    expect(growYearOfDayKey('2025-11-15')).toBe(2026)
    expect(growYearOfDayKey('2025-12-31')).toBe(2026)
  })
  it('Oct 31 stays in the SAME grow-year (season ends Oct 31)', () => {
    expect(growYearOfDayKey('2025-10-31')).toBe(2025)
    expect(growYearOfDayKey('2026-01-15')).toBe(2026)
  })
  it('a DST-transition-week day derives cleanly (pure string math, no Date)', () => {
    // US DST ends Sun 2026-11-01; days on both sides of the fall-back week:
    expect(growYearOfDayKey('2026-11-01')).toBe(2027)
    expect(growYearOfDayKey('2026-10-31')).toBe(2026)
    // spring-forward week (2026-03-08):
    expect(growYearOfDayKey('2026-03-08')).toBe(2026)
  })
  it('junk -> null, never NaN', () => {
    expect(growYearOfDayKey(null)).toBeNull()
    expect(growYearOfDayKey('')).toBeNull()
    expect(growYearOfDayKey('not-a-day')).toBeNull()
    expect(growYearOfDayKey('2026-13-01')).toBeNull()
  })
})

describe('currentGrowYear (ET-safe on Date inputs)', () => {
  it('projects the instant into ET before deriving — the new Date(\'YYYY-MM-DD\') trap', () => {
    // 2025-11-01T03:30Z is 2025-10-31 23:30 EDT: still October in the garden zone -> 2025,
    // even though the UTC calendar already says November.
    expect(currentGrowYear(new Date('2025-11-01T03:30:00Z'), HARVEST_TZ)).toBe(2025)
    // By 2025-11-01T05:30Z it is 00:30 EST Nov 1 -> the 2026 season has begun.
    expect(currentGrowYear(new Date('2025-11-01T05:30:00Z'), HARVEST_TZ)).toBe(2026)
  })
  it('mid-season date derives the ending-October year', () => {
    expect(currentGrowYear(new Date('2026-08-12T16:00:00Z'), HARVEST_TZ)).toBe(2026)
  })
})

describe('growYearSpan', () => {
  it('half-open [Nov 1 prior year, Nov 1 label year)', () => {
    expect(growYearSpan(2026)).toEqual({ start: '2025-11-01', end: '2026-11-01' })
  })
})

describe('growYearOptions (season-sheet universe)', () => {
  it('continuous range from earliest grow-year to current, newest first — empty seasons included', () => {
    expect(growYearOptions('2023-06-10', 2026)).toEqual([2026, 2025, 2024, 2023])
  })
  it('a November first pick files under the FOLLOWING-year option (no phantom prior year)', () => {
    expect(growYearOptions('2025-11-15', 2026)).toEqual([2026])
  })
  it('empty data -> current season only (All time is a chip, not a sheet row)', () => {
    expect(growYearOptions(null, 2026)).toEqual([2026])
    expect(growYearOptions(undefined, 2026)).toEqual([2026])
  })
})
