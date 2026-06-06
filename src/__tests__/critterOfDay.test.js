import { describe, it, expect } from 'vitest'
import { pickCritterOfDay, epochDayUTC, todayUTCDate } from '../lib/critterOfDay.js'

const fake = (n) => Array.from({ length: n }, (_, i) => ({ id: 'X' + i }))

describe('critterOfDay — deterministic household-coherent pick (V3-DELIGHT D1)', () => {
  it('is deterministic for a given date', () => {
    const r = fake(168)
    expect(pickCritterOfDay(r, '2026-06-06').id).toBe(pickCritterOfDay(r, '2026-06-06').id)
  })

  it('returns null on malformed/empty input', () => {
    expect(epochDayUTC('nope')).toBeNull()
    expect(epochDayUTC('2026-13-40')).toBeNull() // not a real calendar date
    expect(pickCritterOfDay(fake(5), 'nope')).toBeNull()
    expect(pickCritterOfDay([], '2026-06-06')).toBeNull()
    expect(pickCritterOfDay(null, '2026-06-06')).toBeNull()
  })

  it('never repeats on consecutive days', () => {
    const r = fake(50)
    let prev = null
    for (let day = 0; day < 200; day++) {
      const ds = new Date(day * 86400000).toISOString().slice(0, 10)
      const id = pickCritterOfDay(r, ds).id
      expect(id).not.toBe(prev)
      prev = id
    }
  })

  it('cycles all N entries with no repeat inside an N-day window', () => {
    const N = 168
    const r = fake(N)
    const seen = new Set()
    for (let day = 0; day < N; day++) {
      const ds = new Date(day * 86400000).toISOString().slice(0, 10)
      seen.add(pickCritterOfDay(r, ds).id)
    }
    expect(seen.size).toBe(N)
  })

  it('todayUTCDate returns a YYYY-MM-DD string', () => {
    expect(todayUTCDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
