// V4-HARVESTQTY-001 — the pure aggregation seam. Every case here is a real trap found in the
// live data or in review: backdated rows, mixed units on one planting, the year boundary at
// 23:00 ET, and the "count" schema token leaking into the UI.
import { describe, it, expect } from 'vitest'
import { summarizeHarvests, formatEntries, formatEntry, unitLabel, fmtQuantity, etDay, addDays, cropNoun, harvestSpanDays, harvestWindow } from '../lib/harvestSummary.js'

const TODAY = '2026-07-21'
const opts = (extra = {}) => ({ today: TODAY, windowDays: 14, ...extra })
const row = (event_date, quantity, unit) => ({ event_date, quantity, unit })

describe('etDay', () => {
  it('passes a bare YYYY-MM-DD through untouched', () => {
    expect(etDay('2026-07-21')).toBe('2026-07-21')
  })
  it('projects a UTC timestamp into ET (23:00 ET Dec 31 is still Dec 31)', () => {
    expect(etDay('2027-01-01T04:00:00Z')).toBe('2026-12-31')
    expect(etDay('2026-12-31T23:00:00-05:00')).toBe('2026-12-31')
  })
  it('returns null for junk', () => {
    expect(etDay(null)).toBe(null)
    expect(etDay('not-a-date')).toBe(null)
  })
})

describe('addDays', () => {
  it('crosses month and year boundaries without local-zone drift', () => {
    expect(addDays('2026-07-21', -13)).toBe('2026-07-08')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
  })
})

describe('summarizeHarvests — windows', () => {
  it('14-day window is INCLUSIVE of today and of today-13; today-14 is out', () => {
    const rows = [
      row(TODAY, 1, 'count'),
      row(addDays(TODAY, -13), 1, 'count'),   // boundary day — IN
      row(addDays(TODAY, -14), 1, 'count'),   // boundary minus one — OUT
    ]
    const s = summarizeHarvests(rows, opts())
    expect(s.recent.events).toBe(2)
    expect(s.recent.entries).toEqual([{ unit: 'count', quantity: 2, converted: false }])
    expect(s.allTime.events).toBe(3)
    expect(s.recentStart).toBe('2026-07-08')
  })

  it('a 23:00 ET Dec 31 harvest counts to the OLD year, not the new one', () => {
    // Same instant, expressed as UTC: 2027-01-01T04:00Z.
    const rows = [row('2027-01-01T04:00:00Z', 5, 'count')]
    const s = summarizeHarvests(rows, { today: '2027-01-05', windowDays: 14 })
    expect(s.year.events).toBe(0)          // 2027 bucket is empty
    expect(s.allTime.events).toBe(1)
    expect(s.firstHarvestDate).toBe('2026-12-31')
  })

  it('scopes "this year" to the calendar year of seasonStart', () => {
    const rows = [row('2026-01-01', 3, 'count'), row('2025-12-31', 9, 'count')]
    const s = summarizeHarvests(rows, opts())
    expect(s.year.entries).toEqual([{ unit: 'count', quantity: 3, converted: false }])
    expect(s.seasonStart).toBe('2026-01-01')
  })

  it('zero-harvest empty state', () => {
    const s = summarizeHarvests([], opts())
    expect(s.hasAny).toBe(false)
    expect(s.allTime.entries).toEqual([])
    expect(s.lastHarvestDate).toBe(null)
    expect(formatEntries(s.allTime.entries)).toBe('—')
  })

  it('is clock-free — no today means an empty summary, never a guess', () => {
    const s = summarizeHarvests([row(TODAY, 1, 'count')], { windowDays: 14 })
    expect(s.hasAny).toBe(false)
  })

  it('drops rows with no usable date rather than mis-bucketing them', () => {
    const s = summarizeHarvests([row(null, 4, 'count'), row(TODAY, 1, 'count')], opts())
    expect(s.allTime.events).toBe(1)
  })
})

describe('summarizeHarvests — units', () => {
  it('converts WITHIN the mass class and renders the dominant unit', () => {
    // 2 lb (907.18 g) + 500 g -> lb dominates -> 1407.18 g / 453.59237 = 3.10 lb
    const s = summarizeHarvests([row(TODAY, 2, 'lb'), row(TODAY, 500, 'g')], opts())
    expect(s.allTime.entries).toHaveLength(1)
    expect(s.allTime.entries[0].unit).toBe('lb')
    expect(s.allTime.entries[0].converted).toBe(true)
    expect(fmtQuantity(s.allTime.entries[0].quantity)).toBe('3.1')
  })

  it('NEVER converts across classes — count/cup/bunch/head stay discrete', () => {
    const rows = [row(TODAY, 3, 'count'), row(TODAY, 2, 'cup'), row(TODAY, 1, 'bunch'), row(TODAY, 4, 'head')]
    const s = summarizeHarvests(rows, opts())
    // 4 distinct entries, nothing summed together.
    expect(s.allTime.entries.map(e => e.unit)).toEqual(['head', 'count', 'cup', 'bunch'])
    expect(s.allTime.entries.map(e => e.quantity)).toEqual([4, 3, 2, 1])
  })

  it('two-unit fixture mirroring live data (count + cup on one planting)', () => {
    const s = summarizeHarvests([row(TODAY, 30, 'count'), row(TODAY, 8, 'cup')], opts())
    expect(formatEntries(s.allTime.entries, 'tomato')).toBe('30 tomatoes · 8 cups')
  })

  it('orders deterministically: quantity desc, then unit name asc', () => {
    const rows = [row(TODAY, 5, 'cup'), row(TODAY, 5, 'bunch'), row(TODAY, 5, 'head')]
    const s = summarizeHarvests(rows, opts())
    expect(s.allTime.entries.map(e => e.unit)).toEqual(['bunch', 'cup', 'head'])
  })

  it('ignores non-positive and non-numeric quantities', () => {
    const s = summarizeHarvests([row(TODAY, 0, 'count'), row(TODAY, 'abc', 'cup'), row(TODAY, 2, 'cup')], opts())
    expect(s.allTime.entries).toEqual([{ unit: 'cup', quantity: 2, converted: false }])
  })

  it('treats a missing unit as count rather than emitting an empty unit', () => {
    const s = summarizeHarvests([row(TODAY, 2, null)], opts())
    expect(s.allTime.entries[0].unit).toBe('count')
  })
})

describe('summarizeHarvests — unattributed', () => {
  it('counts unlinked harvests per bucket without folding them into the totals', () => {
    const rows = [row(TODAY, 3, 'count')]
    const unattributedRows = [row(TODAY, 9, 'count'), row('2026-01-05', 9, 'count'), row('2025-06-01', 9, 'count')]
    const s = summarizeHarvests(rows, opts({ unattributedRows }))
    expect(s.recent.unattributed).toBe(1)
    expect(s.year.unattributed).toBe(2)
    expect(s.allTime.unattributed).toBe(3)
    // quantities are untouched by the unlinked rows
    expect(s.allTime.entries).toEqual([{ unit: 'count', quantity: 3, converted: false }])
  })
})

describe('formatting', () => {
  it('never renders the literal string "count"', () => {
    expect(formatEntry({ unit: 'count', quantity: 3 }, 'tomato')).toBe('3 tomatoes')
    expect(formatEntry({ unit: 'count', quantity: 1 }, 'tomato')).toBe('1 tomato')
    expect(formatEntry({ unit: 'count', quantity: 3 }, null)).toBe('3')
    expect(unitLabel('count', 3, null)).toBe('')
  })

  it('pluralizes discrete units but leaves mass symbols alone', () => {
    expect(formatEntry({ unit: 'cup', quantity: 2 })).toBe('2 cups')
    expect(formatEntry({ unit: 'cup', quantity: 1 })).toBe('1 cup')
    expect(formatEntry({ unit: 'bunch', quantity: 3 })).toBe('3 bunches')
    expect(formatEntry({ unit: 'head', quantity: 2 })).toBe('2 heads')
    expect(formatEntry({ unit: 'lb', quantity: 6 })).toBe('6 lb')
  })

  it('formats numeric(N,3) strings instead of printing them raw', () => {
    expect(fmtQuantity('3.000')).toBe('3')
    expect(fmtQuantity('0.500')).toBe('0.5')
    expect(fmtQuantity('2.125')).toBe('2.13')
  })

  it('cropNoun humanizes a crop_type_slug and pluralizes sanely', () => {
    expect(cropNoun({ variety_ref: { crop_type_slug: 'sweet-pepper' } })).toBe('sweet pepper')
    expect(cropNoun({ variety_ref: {} })).toBe(null)
    expect(formatEntry({ unit: 'count', quantity: 4 }, 'squash')).toBe('4 squashes')
  })
})

// ── V4-HARVESTSURF-001 remainder — OBSERVED harvest window ──────────────────────────────────
// Descriptive only. A PREDICTED window was killed by measurement (22/233 live plantings carry both
// a fruit_set anchor and set_to_first_pick_days), so nothing here forecasts a future pick date.
describe('harvestSpanDays / harvestWindow', () => {
  it('same day is an inclusive span of 1', () => {
    expect(harvestSpanDays('2026-07-21', '2026-07-21')).toBe(1)
  })
  it('counts inclusively across a month boundary', () => {
    expect(harvestSpanDays('2026-06-28', '2026-07-21')).toBe(24)
  })
  it('is DST-immune (a 23h and a 25h day both count as one day)', () => {
    // US DST forward 2026-03-08, back 2026-11-01. UTC anchors make both spans exact.
    expect(harvestSpanDays('2026-03-07', '2026-03-09')).toBe(3)
    expect(harvestSpanDays('2026-10-31', '2026-11-02')).toBe(3)
  })
  it('spans a leap day correctly', () => {
    expect(harvestSpanDays('2028-02-28', '2028-03-01')).toBe(3)
  })
  it('returns null on a missing or unparseable anchor', () => {
    expect(harvestSpanDays(null, '2026-07-21')).toBeNull()
    expect(harvestSpanDays('2026-07-21', null)).toBeNull()
    expect(harvestSpanDays('not-a-date', '2026-07-21')).toBeNull()
  })
  it('never returns a negative span even if anchors arrive reversed', () => {
    expect(harvestSpanDays('2026-07-21', '2026-06-28')).toBe(24)
  })
  it('harvestWindow marks a single-day history as NOT a span (caller shows "Last picked")', () => {
    const w = harvestWindow({ firstHarvestDate: '2026-07-21', lastHarvestDate: '2026-07-21' })
    expect(w).toEqual({ first: '2026-07-21', last: '2026-07-21', days: 1, isSpan: false })
  })
  it('harvestWindow marks a multi-day history as a span', () => {
    const w = harvestWindow({ firstHarvestDate: '2026-06-28', lastHarvestDate: '2026-07-21' })
    expect(w.isSpan).toBe(true)
    expect(w.days).toBe(24)
  })
  it('harvestWindow is null when the planting has no harvests at all', () => {
    expect(harvestWindow({ firstHarvestDate: null, lastHarvestDate: null })).toBeNull()
    expect(harvestWindow(null)).toBeNull()
    expect(harvestWindow(summarizeHarvests([], { today: '2026-07-21' }))).toBeNull()
  })
  it('composes with a real summarizeHarvests result', () => {
    const rows = [
      { quantity: 2, unit: 'lb', event_date: '2026-06-28' },
      { quantity: 1, unit: 'lb', event_date: '2026-07-05' },
      { quantity: 3, unit: 'lb', event_date: '2026-07-21' },
    ]
    const w = harvestWindow(summarizeHarvests(rows, { today: '2026-07-21' }))
    expect(w).toEqual({ first: '2026-06-28', last: '2026-07-21', days: 24, isSpan: true })
  })
})
