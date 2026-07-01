import { describe, it, expect } from 'vitest'
import { shuLabel, determinacyLabel } from '../lib/varietySpec.js'

describe('V4-VARSLUG-001 shuLabel', () => {
  it('null when no scoville data', () => expect(shuLabel({})).toBeNull())
  it('range with K/M', () => {
    expect(shuLabel({ scoville_min: 50000, scoville_max: 100000 })).toBe('50K–100K SHU')
    expect(shuLabel({ scoville_min: 800000, scoville_max: 1041427 })).toBe('800K–1.04M SHU')
  })
  it('sweet peppers read as Sweet · 0 SHU', () => expect(shuLabel({ scoville_min: 0, scoville_max: 0 })).toBe('Sweet · 0 SHU'))
  it('single value when min==max or one side null', () => {
    expect(shuLabel({ scoville_min: 2500, scoville_max: 2500 })).toBe('2.5K SHU')
    expect(shuLabel({ scoville_min: 8000, scoville_max: null })).toBe('8K SHU')
  })
})

describe('V4-VARSLUG-001 determinacyLabel', () => {
  it('null when no growth_habit', () => expect(determinacyLabel({})).toBeNull())
  it('maps indeterminate/determinate/semi', () => {
    expect(determinacyLabel({ growth_habit: 'indeterminate' })).toBe('Indeterminate')
    expect(determinacyLabel({ growth_habit: 'determinate' })).toBe('Determinate')
    expect(determinacyLabel({ growth_habit: 'semi-determinate' })).toBe('Semi-determinate')
  })
})
