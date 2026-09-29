// V5-PLANTSTARTDATES-001 — lib/catchUp.js, the rules behind /plants/catch-up. Each guard names the
// mutation that kills it; every one was run against the code and seen red before this landed.
import { describe, it, expect } from 'vitest'
import {
  needsStartDates, monthLabel, plantingGrowYear, monthOptions, monthToDate, outBeforeSown,
  catchUpBody, groupCatchUpRows, locationPath,
} from '../lib/catchUp.js'

const TODAY = '2026-09-29'

describe('needsStartDates — who is listed', () => {
  // KILLING MUTATION: drop either half of `!p.sown_at && !p.planted_out_at`. RESULT: RED.
  it('lists a planting with NEITHER date, and not one with either', () => {
    expect(needsStartDates({ id: 'a', sown_at: null, planted_out_at: null })).toBe(true)
    expect(needsStartDates({ id: 'b', sown_at: '2026-03-01', planted_out_at: null })).toBe(false)
    expect(needsStartDates({ id: 'c', sown_at: null, planted_out_at: '2026-05-20' })).toBe(false)
    expect(needsStartDates({ id: 'd', sown_at: '2026-03-01', planted_out_at: '2026-05-20' })).toBe(false)
  })

  it('any status counts — an ended planting still belongs on the record', () => {
    for (const status of ['ended', 'failed', 'harvested', 'fruiting', 'seed']) {
      expect(needsStartDates({ id: 'x', status, sown_at: null, planted_out_at: null }), status).toBe(true)
    }
  })

  it('germination and transplant dates do not answer "when did it go in"', () => {
    expect(needsStartDates({ id: 'x', germinated_at: '2026-03-09', transplanted_at: '2026-04-02' })).toBe(true)
  })

  // KILLING MUTATION: drop the deleted_at / archived_at refusal. RESULT: RED.
  it('a deleted or archived planting is never listed', () => {
    expect(needsStartDates({ id: 'x', deleted_at: '2026-08-01T00:00:00Z' })).toBe(false)
    expect(needsStartDates({ id: 'x', archived_at: '2026-08-01T00:00:00Z' })).toBe(false)
    expect(needsStartDates(null)).toBe(false)
  })
})

describe('the month pickers', () => {
  it('labels a month without a Date (no UTC-midnight slide into the previous month)', () => {
    expect(monthLabel('2026-09')).toBe('Sep 2026')
    expect(monthLabel('2025-11')).toBe('Nov 2025')
    expect(monthLabel('junk')).toBe('')
  })

  // KILLING MUTATION: drop the `ym > cap` stop. RESULT: RED (Oct 2026 offered on Sep 29).
  it('offers the grow year Nov → Oct, oldest first, and nothing after this month', () => {
    const opts = monthOptions(2026, TODAY)
    expect(opts[0]).toBe('2025-11')
    expect(opts.at(-1)).toBe('2026-09')
    expect(opts).toHaveLength(11)
    expect(opts).not.toContain('2026-10')
    expect(monthOptions(2025, TODAY)).toEqual([
      '2024-11', '2024-12', '2025-01', '2025-02', '2025-03', '2025-04',
      '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10',
    ])
  })

  it('a planting belongs to the grow year its record was created in, judged in ET', () => {
    expect(plantingGrowYear({ created_at: '2026-05-10T14:00:00Z' }, TODAY)).toBe(2026)
    // Nov 1 in New York = grow year 2026; 02:00Z on Nov 1 is still Oct 31 in New York.
    expect(plantingGrowYear({ created_at: '2025-11-01T12:00:00Z' }, TODAY)).toBe(2026)
    expect(plantingGrowYear({ created_at: '2025-11-01T02:00:00Z' }, TODAY)).toBe(2025)
    expect(plantingGrowYear({}, TODAY)).toBe(2026)
  })
})

describe('the stored date and the PUT body', () => {
  // KILLING MUTATION: store the 1st (or drop the today clamp). RESULT: RED.
  it('stores a month as its 15th, never a day after today', () => {
    expect(monthToDate('2026-05', TODAY)).toBe('2026-05-15')
    expect(monthToDate('2025-12', TODAY)).toBe('2025-12-15')
    expect(monthToDate('2026-09', '2026-09-10')).toBe('2026-09-10')
  })

  // KILLING MUTATION: send approx false, send an extra key, or send a date that was not chosen. RESULT: RED.
  it('sends only the chosen date(s), each with its *_approx = true', () => {
    expect(catchUpBody({ sown: '2026-02', plantedOut: '' }, TODAY))
      .toEqual({ sown_at: '2026-02-15', sown_at_approx: true })
    expect(catchUpBody({ sown: '', plantedOut: '2026-05' }, TODAY))
      .toEqual({ planted_out_at: '2026-05-15', planted_out_at_approx: true })
    expect(catchUpBody({ sown: '2026-02', plantedOut: '2026-05' }, TODAY)).toEqual({
      sown_at: '2026-02-15', sown_at_approx: true, planted_out_at: '2026-05-15', planted_out_at_approx: true,
    })
    expect(catchUpBody({ sown: '', plantedOut: '' }, TODAY)).toEqual({})
  })

  // KILLING MUTATION: compare with <= (refuse the same month) or drop the guard. RESULT: RED.
  it('planted out may share the sown month but not precede it', () => {
    expect(outBeforeSown({ sown: '2026-05', plantedOut: '2026-04' })).toBe(true)
    expect(outBeforeSown({ sown: '2026-05', plantedOut: '2026-05' })).toBe(false)
    expect(outBeforeSown({ sown: '', plantedOut: '2026-04' })).toBe(false)
    expect(outBeforeSown({ sown: '2026-05', plantedOut: '' })).toBe(false)
  })
})

describe('grouping by location', () => {
  const locations = [
    { id: 'drive', name: 'Drive', parent_id: null, sort_order: 1 },
    { id: 'bed2', name: 'Raised bed 2', parent_id: 'drive', sort_order: 0 },
    { id: 'stable', name: 'Stable', parent_id: null, sort_order: 2 },
    { id: 'empty', name: 'Empty shelf', parent_id: 'stable', sort_order: 0 },
  ]

  // KILLING MUTATION: drop the count > 0 filter. RESULT: RED (Drive and Empty shelf appear).
  it('drops empty locations, keeps Garden order, and sends unknown locations to Unsorted', () => {
    const rows = [
      { id: 'p1', name: 'Piquin', location_id: 'bed2' },
      { id: 'p2', name: 'Emerald Green', location_id: 'bed2' },
      { id: 'p3', name: 'Black Krim', location_id: 'stable' },
      { id: 'p4', name: 'Sweet Chocolate', location_id: null },
      { id: 'p5', name: 'Palmetto Punch', location_id: 'gone' },
    ]
    const groups = groupCatchUpRows(rows, locations)
    expect(groups.map(g => g.label)).toEqual(['Raised bed 2', 'Stable', 'Unsorted'])
    expect(groups[0].plantings.map(p => p.name)).toEqual(['Emerald Green', 'Piquin'])
    expect(groups[2].plantings.map(p => p.name)).toEqual(['Palmetto Punch', 'Sweet Chocolate'])
  })

  it('names a nested location by its path, and survives a parent loop', () => {
    expect(locationPath('bed2', locations)).toBe('Drive › Raised bed 2')
    expect(locationPath('stable', locations)).toBe('Stable')
    const loop = [{ id: 'a', name: 'A', parent_id: 'b' }, { id: 'b', name: 'B', parent_id: 'a' }]
    expect(locationPath('a', loop)).toBe('B › A')
    expect(locationPath('missing', locations)).toBe('')
  })
})
