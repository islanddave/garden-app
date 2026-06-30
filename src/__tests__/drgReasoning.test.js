// Slice 8 (V4-THEME-001) — DrG reasoning is anti-fabrication-locked: every line must be backed by
// real daily-plan data, and no-plan/steady states are honest. No jest-dom (L-182).
import { describe, it, expect } from 'vitest'
import { buildReasoningLines } from '../lib/drgReasoning.js'

describe('buildReasoningLines — DrG "why today"', () => {
  it('returns noplan when there is no plan', () => {
    expect(buildReasoningLines(null)).toEqual({ state: 'noplan', lines: [] })
    expect(buildReasoningLines({ has_plan: false, plan: null })).toEqual({ state: 'noplan', lines: [] })
  })

  it('builds only the lines the plan data supports', () => {
    const data = {
      has_plan: true,
      plan: {
        weather: { highToday: 84, tonightLow: 61, hot: true },
        counts: { plantings: 12, water_due: 4, no_history: 0, fertilize: 2, pest: 0, cold: 1, dormant: 0, rain_skipped: 3 },
        substrate: { msg: 'Feeding window open.' },
        rain_skipped: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      },
    }
    const r = buildReasoningLines(data)
    expect(r.state).toBe('plan')
    expect(r.lines[0]).toBe('High 84°, low 61° tonight — hot day')
    expect(r.lines[1]).toBe('12 plantings — 4 to water, 2 to feed, 1 cold-sensitive')
    expect(r.lines[2]).toBe('Feeding window open.')
    expect(r.lines[3]).toBe('Skipped watering 3 plantings — recent rain counted.')
  })

  it('omits the care-summary clause set when nothing needs care, and rain when none', () => {
    const data = { has_plan: true, plan: { weather: { highToday: 70, tonightLow: 55, hot: false }, counts: { plantings: 5, water_due: 0, no_history: 0, fertilize: 0, pest: 0, cold: 0 }, rain_skipped: [] } }
    const r = buildReasoningLines(data)
    expect(r.state).toBe('plan')
    expect(r.lines).toEqual(['High 70°, low 55° tonight'])
  })

  it('returns steady when a plan exists but yields no narratable lines', () => {
    expect(buildReasoningLines({ has_plan: true, plan: {} })).toEqual({ state: 'steady', lines: [] })
  })
})
