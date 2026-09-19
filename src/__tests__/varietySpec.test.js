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

// V5-SEEDCARDS-001 / v5-scovillesource-001 — a best guess is labelled as one. The marker is the WORD
// "est. " (commit 4382da4's house rule: no leading glyph on a line this small), and ONLY the
// 'inference' source earns it. Everything else must stay byte-identical to the pre-source label,
// which is why the "unchanged" cases compare against literals rather than against shuLabel itself.
describe('V5-SEEDCARDS-001 shuLabel — scoville_source', () => {
  const RANGE = { scoville_min: 100000, scoville_max: 350000 }

  it("an 'inference' figure is prefixed with the word est.", () => {
    expect(shuLabel({ ...RANGE, scoville_source: 'inference' })).toBe('est. 100K–350K SHU')
    expect(shuLabel({ scoville_min: 2500, scoville_max: 2500, scoville_source: 'inference' })).toBe('est. 2.5K SHU')
    expect(shuLabel({ scoville_min: 8000, scoville_max: null, scoville_source: 'inference' })).toBe('est. 8K SHU')
    expect(shuLabel({ scoville_min: 0, scoville_max: 0, scoville_source: 'inference' })).toBe('est. Sweet · 0 SHU')
  })

  it('a sourced figure renders exactly as before, for every other vocabulary value', () => {
    for (const src of ['packet_label', 'vendor_catalog', 'breeder', 'reference_work', 'grower_record']) {
      expect(shuLabel({ ...RANGE, scoville_source: src }), src).toBe('100K–350K SHU')
      expect(shuLabel({ scoville_min: 0, scoville_max: 0, scoville_source: src }), src).toBe('Sweet · 0 SHU')
    }
  })

  it('no source — null, undefined or absent — renders exactly as before', () => {
    expect(shuLabel({ ...RANGE, scoville_source: null })).toBe('100K–350K SHU')
    expect(shuLabel({ ...RANGE, scoville_source: undefined })).toBe('100K–350K SHU')
    expect(shuLabel(RANGE)).toBe('100K–350K SHU')
  })

  it('matches the one value exactly — a near-miss spelling is not treated as a guess', () => {
    // The DB CHECK admits only the lower-case value, so these cannot arrive from the API; pinned so
    // a loosened comparison (includes / toLowerCase) is a deliberate change rather than a drift.
    for (const src of ['Inference', 'inferred', ' inference', 'est']) {
      expect(shuLabel({ ...RANGE, scoville_source: src }), src).toBe('100K–350K SHU')
    }
  })

  it('a source alone never makes a chip appear — no numbers is still null', () => {
    expect(shuLabel({ scoville_source: 'inference' })).toBeNull()
    expect(shuLabel({ scoville_min: null, scoville_max: null, scoville_source: 'vendor_catalog' })).toBeNull()
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
