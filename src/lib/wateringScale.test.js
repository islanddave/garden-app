import { describe, it, expect } from 'vitest'
import { computeWateringScale, canRail, pillState } from './wateringScale.js'

describe('computeWateringScale', () => {
  it("today's real shape (recent 0.05, not hot, tomorrow 0.74@63%) -> containers 2, beds 0 (wait)", () => {
    const s = computeWateringScale(
      { recent_precip_in: 0.05, tomorrow_precip_in: 0.74, tomorrow_pop: 63, rain_coming: true },
      { hot: false, highToday: 78 },
    )
    expect(s.containers).toBe(2)
    expect(s.beds).toBe(0)
    expect(s.rainComing).toBe(true)
  })

  it('hot + dry deep-soaks both lanes', () => {
    const s = computeWateringScale({ recent_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 }, { hot: true })
    expect(s.containers).toBe(3)
    expect(s.beds).toBe(2.5)
  })

  it('heavy recent rain (>=0.8) drops containers to 0 and beds to 0', () => {
    const s = computeWateringScale({ recent_precip_in: 1.0 }, { hot: false })
    expect(s.containers).toBe(0)
    expect(s.beds).toBe(0)
  })

  it('clamps to [0,3] and rounds to nearest 0.5', () => {
    const s = computeWateringScale({ recent_precip_in: 0 }, { hot: true })
    expect(s.containers).toBeLessThanOrEqual(3)
    expect(s.beds % 0.5).toBe(0)
  })
})

describe('canRail', () => {
  it('fills cans left-to-right with a half step', () => {
    expect(canRail(0)).toEqual([0, 0, 0])
    expect(canRail(1.5)).toEqual([1, 0.5, 0])
    expect(canRail(3)).toEqual([1, 1, 1])
  })
})

describe('pillState', () => {
  it('0 -> wait, >=0.5 -> do', () => {
    expect(pillState(0)).toBe('wait')
    expect(pillState(0.5)).toBe('do')
    expect(pillState(2)).toBe('do')
  })
})
