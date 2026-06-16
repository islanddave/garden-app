import { describe, it, expect } from 'vitest'
import { sortFindings } from '../lib/findingsSort.js'

const mk = (o) => ({ finding_id: o.id, trend: o.trend, decay_state: o.decay, urgency_level: o.urg })

describe('sortFindings', () => {
  it('orders worsening before steady before improving', () => {
    const out = sortFindings([
      mk({ id: 'a', trend: 'improving', decay: 'fresh' }),
      mk({ id: 'b', trend: 'worsening', decay: 'fresh' }),
      mk({ id: 'c', trend: 'steady', decay: 'fresh' }),
    ]).map(f => f.finding_id)
    expect(out).toEqual(['b', 'c', 'a'])
  })

  it('within a trend, fresher decay_state first', () => {
    const out = sortFindings([
      mk({ id: 'x', trend: 'steady', decay: 'resolved' }),
      mk({ id: 'y', trend: 'steady', decay: 'fresh' }),
      mk({ id: 'z', trend: 'steady', decay: 'decaying' }),
    ]).map(f => f.finding_id)
    expect(out).toEqual(['y', 'z', 'x'])
  })

  it('urgency_level is NOT an ordering key (C7 de-privileged)', () => {
    // high-urgency but improving must sort AFTER low-urgency worsening.
    const out = sortFindings([
      mk({ id: 'highUrg', trend: 'improving', decay: 'fresh', urg: 'high' }),
      mk({ id: 'lowUrg',  trend: 'worsening', decay: 'fresh', urg: 'low' }),
    ]).map(f => f.finding_id)
    expect(out).toEqual(['lowUrg', 'highUrg'])
  })

  it('is pure (does not mutate input) and tolerates empty/missing', () => {
    const input = [mk({ id: 'a', trend: 'steady', decay: 'fresh' })]
    const copy = [...input]
    sortFindings(input)
    expect(input).toEqual(copy)
    expect(sortFindings(undefined)).toEqual([])
    expect(sortFindings([])).toEqual([])
  })
})
