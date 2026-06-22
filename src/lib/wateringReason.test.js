import { describe, it, expect } from 'vitest'
import { wateringReason, computeWateringScale } from './wateringScale.js'

describe('V3-WATERWHY-001 wateringReason', () => {
  const scenarios = [
    { name: 'dry normal',   h: { recent_precip_in: 0.0 }, w: { hot: false } },
    { name: 'hot dry',      h: { recent_precip_in: 0.0 }, w: { hot: true } },
    { name: 'rain coming',  h: { recent_precip_in: 0.0, tomorrow_precip_in: 0.74, tomorrow_pop: 63 }, w: { hot: false } },
    { name: 'soaked',       h: { recent_precip_in: 0.9 }, w: { hot: false } },
    { name: 'raining today',h: { today_precip_in: 0.5, today_pop: 80 }, w: { hot: false } },
  ]
  it('never contradicts computeWateringScale (level parity for both lanes)', () => {
    for (const s of scenarios) {
      const scale = computeWateringScale(s.h, s.w)
      const why = wateringReason(s.h, s.w)
      expect(why.containers.level).toBe(scale.containers)
      expect(why.beds.level).toBe(scale.beds)
    }
  })
  it('explains a hold when the recommendation is hold', () => {
    const why = wateringReason({ recent_precip_in: 0.0, tomorrow_precip_in: 0.74, tomorrow_pop: 63 }, { hot: false })
    expect(why.beds.level).toBe(0)
    expect(why.beds.verdict.toLowerCase()).toContain('hold')
    expect(why.beds.lines.join(' ')).toMatch(/soak is coming/i)
  })
  it('always returns at least one reason line per lane', () => {
    const why = wateringReason({}, {})
    expect(why.containers.lines.length).toBeGreaterThan(0)
    expect(why.beds.lines.length).toBeGreaterThan(0)
  })
})
