// V4-APPBANNER-001 — pick-function contract. No jest-dom (L-182).
import { describe, it, expect } from 'vitest'
import { pickBanner, localDayNumber, seasonOf } from '../lib/pickBanner.js'
import { BANNERS } from '../lib/bannerManifest.js'

const at = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0) // local noon anchor

describe('localDayNumber — DST-immune local calendar math', () => {
  it('increments by exactly 1 across the 2026 spring-forward day (Mar 8)', () => {
    expect(localDayNumber(at(2026, 3, 9)) - localDayNumber(at(2026, 3, 8))).toBe(1)
  })
  it('increments by exactly 1 across the 2026 fall-back day (Nov 1)', () => {
    expect(localDayNumber(at(2026, 11, 2)) - localDayNumber(at(2026, 11, 1))).toBe(1)
  })
  it('increments by exactly 1 across the year boundary', () => {
    expect(localDayNumber(at(2027, 1, 1)) - localDayNumber(at(2026, 12, 31))).toBe(1)
  })
  it('handles leap day (2028-02-29)', () => {
    expect(localDayNumber(at(2028, 3, 1)) - localDayNumber(at(2028, 2, 29))).toBe(1)
  })
})

describe('seasonOf', () => {
  it('maps months to pools', () => {
    expect(seasonOf(at(2026, 1, 15))).toBe('winter')
    expect(seasonOf(at(2026, 12, 15))).toBe('winter')
    expect(seasonOf(at(2026, 4, 15))).toBe('spring')
    expect(seasonOf(at(2026, 7, 15))).toBe('summer')
    expect(seasonOf(at(2026, 10, 15))).toBe('fall')
  })
})

describe('pickBanner', () => {
  it('is deterministic for the same date', () => {
    expect(pickBanner(at(2026, 7, 2), BANNERS)).toBe(pickBanner(at(2026, 7, 2), BANNERS))
  })
  it('returns null on an empty pool', () => {
    expect(pickBanner(at(2026, 7, 2), [])).toBe(null)
  })
  it('summer date picks from the summer pool', () => {
    expect(pickBanner(at(2026, 7, 10), BANNERS).season).toBe('summer')
  })
  it('winter date picks from the winter pool', () => {
    expect(pickBanner(at(2027, 1, 10), BANNERS).season).toBe('winter')
  })
  it('a season with no photos falls back to the full pool (spring today)', () => {
    const b = pickBanner(at(2026, 4, 10), BANNERS)
    expect(BANNERS.includes(b)).toBe(true)
  })
  it('changes daily within a block (no repeats across one block of the summer pool)', () => {
    const pool = BANNERS.filter((b) => b.season === 'summer')
    const n = pool.length
    // find a block-aligned local day, then walk n consecutive days
    let d = at(2026, 7, 1)
    while (localDayNumber(d) % n !== 0) d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 12)
    const ids = new Set()
    for (let i = 0; i < n; i++) {
      const di = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, 12)
      ids.add(pickBanner(di, BANNERS).id)
    }
    expect(ids.size).toBe(n)
  })
  it('leap day picks a valid banner', () => {
    expect(BANNERS.includes(pickBanner(at(2028, 2, 29), BANNERS))).toBe(true)
  })
})

describe('banner manifest shape', () => {
  it('every entry carries id/src/season/source/captured provenance', () => {
    expect(BANNERS.length).toBeGreaterThan(0)
    for (const b of BANNERS) {
      expect(typeof b.id).toBe('string')
      expect(typeof b.src).toBe('string')
      expect(['spring', 'summer', 'fall', 'winter'].includes(b.season)).toBe(true)
      expect(typeof b.source).toBe('string')
      expect(/^\d{4}-\d{2}-\d{2}$/.test(b.captured)).toBe(true)
    }
  })
  it('ids are unique', () => {
    expect(new Set(BANNERS.map((b) => b.id)).size).toBe(BANNERS.length)
  })
})
