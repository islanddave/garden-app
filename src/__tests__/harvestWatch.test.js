// V4-HARVSURFACE-001 Slice 1 — pure helpers behind the "worth checking" watch list.
import { describe, it, expect } from 'vitest'
import {
  MAX_WATCH_ROWS, watchingSinceLabel, rankWatchCandidates, observableFrom,
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
