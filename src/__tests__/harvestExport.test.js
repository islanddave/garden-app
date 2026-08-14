// V4-HARVEXPORT-001 — the export text, BYTE-EXACT against fixtures (design §6-S5).
//
// Byte-exact and not "contains": an export is a document Dave pastes into a spreadsheet or a note
// and then TRUSTS. A contains-assertion cannot see a dropped variety sub-line, a silently converted
// unit, or a weight number that lost its qualifier — every one of which is a wrong document that
// still passes. Named mutation targets in the design: add a unit conversion → these fail.
import { describe, it, expect } from 'vitest'
import { buildTotalsExport, buildLogExport, narratedHeader, timeframeLabel, scopeLine } from '../lib/harvestExport.js'

const AGG = {
  crops: [
    {
      crop_type_slug: 'cherry-tomato',
      crop_name: 'Cherry Tomato',
      units: [{ unit: 'cup', unit_key: 'cup', total: 14, count: 6 }, { unit: 'count', unit_key: 'count', total: 212, count: 20 }],
      unquantified: 2,
      varieties: [
        { variety_id: 'v1', variety_name: 'Sungold', units: [{ unit: 'count', total: 100 }], unquantified: 0 },
        { variety_id: 'v2', variety_name: 'Black Cherry', units: [{ unit: 'cup', total: 14 }, { unit: 'count', total: 112 }], unquantified: 2 },
      ],
    },
    {
      crop_type_slug: 'basil',
      crop_name: 'Basil',
      units: [{ unit: 'bunch', total: 3 }],
      unquantified: 0,
      varieties: [{ variety_id: null, variety_name: null, units: [{ unit: 'bunch', total: 3 }], unquantified: 0 }],
    },
  ],
  other: [{ project_id: 'pr9', project_name: 'Back Bed', units: [{ unit: 'count', total: 4 }], unquantified: 1 }],
  first_pick: [
    { plant_id: 'p1', planting_name: 'Bed A cherry', crop_type_slug: 'cherry-tomato', first_pick_date: '2026-06-14' },
    { plant_id: 'p9', planting_name: 'Old bed', crop_type_slug: 'cherry-tomato', first_pick_date: '2025-07-02' },
  ],
  weight: { grams: 12400, measured: 14, estimated: 200, unweighed: 2 },
}

describe('timeframeLabel / scopeLine', () => {
  it('speaks only the server vocabulary — no arbitrary from/to exists to name', () => {
    expect(timeframeLabel('')).toBe('All time')
    expect(timeframeLabel('7d')).toBe('Last 7 days')
    expect(timeframeLabel('month')).toBe('This month')
    expect(timeframeLabel('season:2026')).toBe('2026 season')
  })
  it('names the crop filter explicitly — an omission must never read as "everything"', () => {
    expect(scopeLine('season:2026', [])).toBe('2026 season · All crops')
    expect(scopeLine('season:2026', ['Cherry Tomato', 'Basil'])).toBe('2026 season · Cherry Tomato, Basil')
  })
})

describe('buildTotalsExport', () => {
  it('is byte-exact: crop lines, variety sub-lines, first picks, unquantified, weight qualifier, Unassigned', () => {
    const out = buildTotalsExport({ aggregates: AGG, timeframe: 'season:2026', cropNames: [], generatedOn: '2026-08-12', currentYear: 2026 })
    expect(out).toBe([
      'Garden harvests — Totals',
      '2026 season · All crops',
      'Generated 2026-08-12',
      '',
      'Cherry Tomato — 14 cups · 212 Cherry Tomatoes · +2 unrecorded',
      '  Sungold — 100 Cherry Tomatoes',
      '  Black Cherry — 14 cups · 112 Cherry Tomatoes',
      '  First pick Jun 14 · Bed A cherry',
      '  First pick Jul 2, 2025 · Old bed',
      'Basil — 3 bunches',
      '',
      'Total weight: ≈ 12 kg (14 weighed · 200 estimated · 2 with no weight yet)',
      '',
      'Unassigned',
      '  Back Bed — 4',
    ].join('\n'))
  })

  it('NEVER converts units — cups and counts stay separate segments, no gram total invented', () => {
    const out = buildTotalsExport({ aggregates: AGG, timeframe: '', cropNames: [], generatedOn: '2026-08-12', currentYear: 2026 })
    expect(out).toContain('14 cups · 212 Cherry Tomatoes')
    expect(out).not.toMatch(/226/) // 14 + 212 would be the conversion bug
  })

  it('the weight number NEVER appears without its measured/estimated/unweighed qualifier', () => {
    const out = buildTotalsExport({ aggregates: AGG, timeframe: '', cropNames: [], generatedOn: '2026-08-12' })
    expect(out).toContain('Total weight: ≈ 12 kg (14 weighed · 200 estimated · 2 with no weight yet)')
    expect(out).not.toMatch(/Total weight: ≈ 12 kg\n/)
  })

  it('an older Lambda (no weight field) emits NO weight line — never a fake zero', () => {
    const out = buildTotalsExport({ aggregates: { ...AGG, weight: undefined }, timeframe: '', generatedOn: '2026-08-12' })
    expect(out).not.toContain('Total weight')
  })

  it('a single UNNAMED variety gets no sub-line — it would just repeat the crop total', () => {
    const out = buildTotalsExport({ aggregates: AGG, timeframe: '', generatedOn: '2026-08-12' })
    expect(out).toContain('Basil — 3 bunches')
    expect(out).not.toContain('  Unspecified')
  })

  it('Unassigned is DROPPED under a crop filter — slug-less events belong to no selected crop', () => {
    const out = buildTotalsExport({ aggregates: AGG, timeframe: '', cropNames: ['Basil'], generatedOn: '2026-08-12', cropFilterActive: true })
    expect(out).not.toContain('Unassigned')
    expect(out).toContain('All time · Basil')
  })

  it('PROJECTS_HIDDEN wording is honored by the caller, not baked in', () => {
    const out = buildTotalsExport({ aggregates: AGG, timeframe: '', generatedOn: '2026-08-12', projectsHidden: true })
    expect(out).toContain('  Unattributed — 4')
  })

  it('an empty universe says so — never an empty document that reads as "nothing was picked"', () => {
    const out = buildTotalsExport({ aggregates: { crops: [], other: [] }, timeframe: '7d', generatedOn: '2026-08-12' })
    expect(out).toBe(['Garden harvests — Totals', 'Last 7 days · All crops', 'Generated 2026-08-12', '', 'No harvests match.'].join('\n'))
  })
})

const ENTRIES = [
  { event_id: 'e1', day_key: '2026-08-11', crop_type_slug: 'cherry-tomato', crop_name: 'Cherry Tomato', variety_name: 'Sungold', quantity: 4, unit: 'count', harvest_log_id: 'h1' },
  { event_id: 'e2', day_key: '2026-08-11', crop_type_slug: 'basil', crop_name: 'Basil', variety_name: 'Genovese', quantity: 2, unit: 'bunch', harvest_log_id: 'h2' },
  { event_id: 'e3', day_key: '2026-08-10', crop_type_slug: 'basil', crop_name: 'Basil', variety_name: null, quantity: null, unit: null, harvest_log_id: null },
]

describe('buildLogExport', () => {
  // V4-HARVEXPORTGROUP-001 (BD-019): day -> crop type -> variety. The count leaf carries NO crop
  // noun — "Sungold — 4", not "Sungold — 4 Cherry Tomatoes" — because the crop line above it
  // already says so. Named units ("2 bunches") have no crop noun to drop and are untouched.
  it('is byte-exact: day -> crop -> variety, in feed order, leaf drops the parent crop noun', () => {
    const out = buildLogExport({ entries: ENTRIES, timeframe: 'season:2026', cropNames: [], generatedOn: '2026-08-12', currentYear: 2026 })
    expect(out).toBe([
      'Garden harvests — Log',
      '2026 season · All crops',
      'Generated 2026-08-12',
      '',
      'Tue, Aug 11',
      '  Cherry Tomato',
      '    Sungold — 4',
      '  Basil',
      '    Genovese — 2 bunches',
      '',
      'Mon, Aug 10',
      '  Basil',
      '    Unspecified — +1 unrecorded',
    ].join('\n'))
  })

  it('folds repeat pickings of ONE variety on ONE day into a single leaf, summed PER UNIT', () => {
    const out = buildLogExport({
      entries: [
        { event_id: 'a', day_key: '2026-08-11', crop_type_slug: 'basil', crop_name: 'Basil', variety_name: 'Genovese', quantity: 2, unit: 'bunch', harvest_log_id: 'h1' },
        { event_id: 'b', day_key: '2026-08-11', crop_type_slug: 'basil', crop_name: 'Basil', variety_name: 'Genovese', quantity: 3, unit: 'bunch', harvest_log_id: 'h2' },
        // A different unit on the SAME variety must stay its own segment — 5 bunches + 1 cup is
        // not 6 of anything. This is the file's standing no-conversion rule, at leaf grain.
        { event_id: 'c', day_key: '2026-08-11', crop_type_slug: 'basil', crop_name: 'Basil', variety_name: 'Genovese', quantity: 1, unit: 'cup', harvest_log_id: 'h3' },
      ],
      timeframe: '', generatedOn: '2026-08-12',
    })
    expect(out).toContain('  Basil\n    Genovese — 5 bunches · 1 cup')
    // The conversion mutant: 5 bunches + 1 cup collapsing to a single "6 <unit>" segment.
    expect(out).not.toMatch(/—\s*6\b/)
  })

  it('drops the crop name the parent carries from the variety LABEL, but never to empty', () => {
    const out = buildLogExport({
      entries: [
        { event_id: 'a', day_key: '2026-08-11', crop_type_slug: 'tomato', crop_name: 'Tomato', variety_name: 'Sungold Tomato', quantity: 2, unit: 'count', harvest_log_id: 'h1' },
        // Whole name IS the crop: keep it rather than render a bare dash.
        { event_id: 'b', day_key: '2026-08-11', crop_type_slug: 'ginger', crop_name: 'Ginger', variety_name: 'Ginger', quantity: 1, unit: 'count', harvest_log_id: 'h2' },
      ],
      timeframe: '', generatedOn: '2026-08-12',
    })
    expect(out).toContain('    Sungold — 2')
    expect(out).toContain('  Ginger\n    Ginger — 1')
  })

  it('slug-less entries group under Unassigned and keep their planting name as the leaf', () => {
    const out = buildLogExport({
      entries: [{ event_id: 'a', day_key: '2026-08-11', crop_type_slug: null, crop_name: null, variety_name: null, planting_name: 'Back bed', quantity: 3, unit: 'count', harvest_log_id: 'h1' }],
      timeframe: '', generatedOn: '2026-08-12',
    })
    expect(out).toContain('  Unassigned\n    Back bed — 3')
  })

  it('an empty range says so', () => {
    expect(buildLogExport({ entries: [], timeframe: '7d', generatedOn: '2026-08-12' }))
      .toBe(['Garden harvests — Log', 'Last 7 days · All crops', 'Generated 2026-08-12', '', 'No harvests match.'].join('\n'))
  })
})

// V4-HARVEXPORTDAYS-001 (BD-018)
describe('timeframeLabel — day-grain scopes', () => {
  it('names Today and Yesterday so the export header states its own scope', () => {
    expect(timeframeLabel('today')).toBe('Today')
    expect(timeframeLabel('yesterday')).toBe('Yesterday')
  })

  it('carries the day-grain scope into the scope line like any other timeframe', () => {
    expect(scopeLine('today', ['Basil'])).toBe('Today · Basil')
    expect(scopeLine('yesterday', [])).toBe('Yesterday · All crops')
  })
})

describe('narratedHeader (SHARE only)', () => {
  it('frames Totals for a human recipient using the shipped seasonTotalPhrase primitive', () => {
    expect(narratedHeader({ mode: 'totals', aggregates: AGG, timeframe: 'season:2026' }))
      .toBe('My garden, 2026 season — 14 cups · 212 cherry tomato and 1 more crop:')
  })
  it('frames Log by pick count, singular-correct', () => {
    expect(narratedHeader({ mode: 'log', entries: ENTRIES, timeframe: '7d' })).toBe('My garden, last 7 days — 3 harvests logged:')
    expect(narratedHeader({ mode: 'log', entries: [ENTRIES[0]], timeframe: '' })).toBe('My garden, all time — 1 harvest logged:')
  })
  it('degrades honestly on an empty universe rather than narrating a harvest that did not happen', () => {
    expect(narratedHeader({ mode: 'totals', aggregates: { crops: [] }, timeframe: 'month' })).toBe('My garden, this month:')
  })
})
