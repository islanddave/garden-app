// V4-HARVSURFACE-001 Slice 1 — pure helpers behind the "worth checking" watch list.
// + panel decisions 20260812: Q2 slot allocation, Q4 tail mechanics + overflow grouping.
import { describe, it, expect } from 'vitest'
import {
  MAX_WATCH_ROWS, WATCH_PROJECT_SLOT_CAP, watchingSinceLabel, rankWatchCandidates, observableFrom,
  selectWatchDisplay, groupWatchOverflow, revealStep, monthDayLabel,
  TAIL_REVEAL_STEP, TAIL_REVEAL_ALL_AT_OR_BELOW,
} from '../lib/harvestWatch.js'

describe('watchingSinceLabel', () => {
  // The whole reason this is string surgery and not a Date: `new Date('2026-08-04')` parses as
  // midnight UTC, which is Aug 3 20:00 in America/New_York, so a Date-based formatter renders the
  // row as "Checking since Aug 3" for the entire US day (L-107). Dave reads this on a phone in ET.
  it('formats a date-only string without a Date object (no UTC off-by-one)', () => {
    expect(watchingSinceLabel('2026-08-04')).toBe('Checking since Aug 4')
    expect(watchingSinceLabel('2026-01-01')).toBe('Checking since Jan 1')
    expect(watchingSinceLabel('2026-12-31')).toBe('Checking since Dec 31')
  })

  it('reads the leading date out of a full timestamp', () => {
    expect(watchingSinceLabel('2026-08-04T00:00:00.000Z')).toBe('Checking since Aug 4')
  })

  it('returns empty string for missing or unparseable input', () => {
    expect(watchingSinceLabel(null)).toBe('')
    expect(watchingSinceLabel(undefined)).toBe('')
    expect(watchingSinceLabel('')).toBe('')
    expect(watchingSinceLabel('sometime')).toBe('')
    expect(watchingSinceLabel('2026-13-04')).toBe('')
  })
})

describe('rankWatchCandidates', () => {
  const c = (over) => ({ plant_id: 'x', name: 'X', watching_since: '2026-08-01', ...over })

  it('orders newest watching_since first', () => {
    const out = rankWatchCandidates([
      c({ plant_id: 'a', name: 'Old', watching_since: '2026-07-20' }),
      c({ plant_id: 'b', name: 'New', watching_since: '2026-08-09' }),
      c({ plant_id: 'c', name: 'Mid', watching_since: '2026-08-01' }),
    ])
    expect(out.map(r => r.plant_id)).toEqual(['b', 'c', 'a'])
  })

  it('breaks ties on name so ordering is deterministic across renders', () => {
    const out = rankWatchCandidates([
      c({ plant_id: 'z', name: 'Zephyr Squash' }),
      c({ plant_id: 'a', name: 'Aster Blackberry' }),
    ])
    expect(out.map(r => r.name)).toEqual(['Aster Blackberry', 'Zephyr Squash'])
  })

  it('drops an id-less row rather than rendering a dismissal that cannot write', () => {
    expect(rankWatchCandidates([c({ plant_id: null }), c({ plant_id: 'ok' })]).map(r => r.plant_id))
      .toEqual(['ok'])
  })

  it('never mutates the input array', () => {
    const input = [c({ plant_id: 'a', watching_since: '2026-07-01' }), c({ plant_id: 'b', watching_since: '2026-08-01' })]
    rankWatchCandidates(input)
    expect(input.map(r => r.plant_id)).toEqual(['a', 'b'])
  })

  it('tolerates a non-array payload', () => {
    expect(rankWatchCandidates(null)).toEqual([])
    expect(rankWatchCandidates(undefined)).toEqual([])
  })

  it('caps at five rows per design §3.5', () => {
    expect(MAX_WATCH_ROWS).toBe(5)
  })
})

describe('observableFrom', () => {
  const rec = (over) => ({ window: [{ at: 'breaker', look: 'x', gives: 'y' }], confidence: 'high', ...over })

  it('names the state at which the window OPENS — the target "start checking" points at', () => {
    expect(observableFrom({ cultivar: rec(), crop: null })).toEqual({ at: 'breaker', qualifier: null })
  })

  it('prefers the cultivar record over the crop mechanic (same grain rule as CropCard)', () => {
    const out = observableFrom({ cultivar: rec({ window: [{ at: 'first pink blush' }] }), crop: rec() })
    expect(out.at).toBe('first pink blush')
  })

  it('labels a crop-level fallback as general guidance — a derivation must never read as a claim', () => {
    expect(observableFrom({ cultivar: null, crop: rec({ window: [{ at: 'mature green' }] }) }))
      .toEqual({ at: 'mature green', qualifier: 'general guidance for this crop, not this variety' })
  })

  it('labels a low-confidence cultivar record as derived', () => {
    expect(observableFrom({ cultivar: rec({ confidence: 'low' }), crop: null }))
      .toEqual({ at: 'breaker', qualifier: 'derived from the variety type' })
  })

  it('returns null when nothing resolves, or when the record carries no window points', () => {
    expect(observableFrom({ cultivar: null, crop: null })).toBeNull()
    expect(observableFrom(null)).toBeNull()
    expect(observableFrom({ cultivar: rec({ window: [] }) })).toBeNull()
    expect(observableFrom({ cultivar: rec({ window: [{ at: '   ' }] }) })).toBeNull()
    expect(observableFrom({ cultivar: rec({ window: null }) })).toBeNull()
  })
})

// ── Panel Q2: slot allocation ─────────────────────────────────────────────────────────────────────

describe('selectWatchDisplay (panel Q2 slot cap)', () => {
  const c = (plant_id, project_id) => ({ plant_id, project_id, name: plant_id, watching_since: '2026-08-01' })

  it('caps any one project at 2 of the 5 visible slots, backfilling from other projects', () => {
    const ranked = [
      c('a1', 'A'), c('a2', 'A'), c('a3', 'A'),
      c('b1', 'B'), c('b2', 'B'), c('c1', 'C'), c('d1', 'D'),
    ]
    const { visible, overflow } = selectWatchDisplay(ranked)
    expect(WATCH_PROJECT_SLOT_CAP).toBe(2)
    expect(visible.map(r => r.plant_id)).toEqual(['a1', 'a2', 'b1', 'b2', 'c1'])
    // The displaced row leads the overflow in rank order — displaced, never dropped.
    expect(overflow.map(r => r.plant_id)).toEqual(['a3', 'd1'])
  })

  it('does NOT backfill past the cap when one project is all there is', () => {
    const ranked = ['a1', 'a2', 'a3', 'a4'].map(id => c(id, 'A'))
    const { visible, overflow } = selectWatchDisplay(ranked)
    expect(visible.map(r => r.plant_id)).toEqual(['a1', 'a2'])
    expect(overflow).toHaveLength(2)
  })

  it('projectless rows never pool into one phantom project', () => {
    const ranked = ['x1', 'x2', 'x3'].map(id => c(id, null))
    expect(selectWatchDisplay(ranked).visible).toHaveLength(3)
  })

  it('tolerates a non-array', () => {
    expect(selectWatchDisplay(null)).toEqual({ visible: [], overflow: [] })
  })
})

// ── Panel Q4: tail mechanics ──────────────────────────────────────────────────────────────────────

describe('revealStep (panel Q4: 20 at a time above 25 hidden)', () => {
  it('reveals everything at or below the threshold, a step above it', () => {
    expect(TAIL_REVEAL_STEP).toBe(20)
    expect(TAIL_REVEAL_ALL_AT_OR_BELOW).toBe(25)
    expect(revealStep(25)).toBe(25)
    expect(revealStep(26)).toBe(20)
    expect(revealStep(40)).toBe(20)
    expect(revealStep(4)).toBe(4)
    expect(revealStep(0)).toBe(0)
    expect(revealStep(null)).toBe(0)
  })
})

describe('monthDayLabel', () => {
  it('formats by string surgery, never a Date (L-107)', () => {
    expect(monthDayLabel('2026-08-22')).toBe('Aug 22')
    expect(monthDayLabel('2026-01-01')).toBe('Jan 1')
  })
  it('empty for junk', () => {
    expect(monthDayLabel(null)).toBe('')
    expect(monthDayLabel('soon')).toBe('')
    expect(monthDayLabel('2026-13-01')).toBe('')
  })
})

describe('groupWatchOverflow (panel Q4 expanded order)', () => {
  const row = (plant_id, location_name, project_id, crop) => ({
    plant_id, location_name, project_id, crop_display_name: crop, name: plant_id,
  })

  it('groups by location in rank order, clustering 2+ same-project rows into a labelled subgroup', () => {
    const groups = groupWatchOverflow([
      row('p1', 'Hilltop bed 2', 'proj-pep', 'Peppers'),
      row('p2', 'Kitchen bed', 'proj-basil', 'Basil'),
      row('p3', 'Hilltop bed 2', 'proj-pep', 'Peppers'),
      row('p4', 'Hilltop bed 2', 'proj-mel', 'Melon'),
    ])
    expect(groups.map(g => g.label)).toEqual(['Hilltop bed 2', 'Kitchen bed'])
    const hilltop = groups[0]
    expect(hilltop.entries[0]).toMatchObject({ type: 'project', label: 'Peppers' })
    expect(hilltop.entries[0].rows.map(r => r.plant_id)).toEqual(['p1', 'p3'])
    expect(hilltop.entries[1]).toMatchObject({ type: 'row' })
    expect(hilltop.entries[1].row.plant_id).toBe('p4')
  })

  it('a single-row project is a plain row, not a one-item subgroup', () => {
    const [g] = groupWatchOverflow([row('p1', 'Bed', 'proj-x', 'Kale')])
    expect(g.entries).toEqual([{ type: 'row', row: expect.objectContaining({ plant_id: 'p1' }) }])
  })

  it("unlocated rows land under 'Other' (careNeeded.js convention)", () => {
    const groups = groupWatchOverflow([row('p1', null, null, null)])
    expect(groups[0].label).toBe('Other')
  })

  it('tolerates junk input', () => {
    expect(groupWatchOverflow(null)).toEqual([])
    expect(groupWatchOverflow([null, { name: 'no id' }])).toEqual([])
  })
})
