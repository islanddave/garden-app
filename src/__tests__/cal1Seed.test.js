// CAL-1 seed generator tests (V4-CAL1HARV-001, crucible V100). Pure JSON->SQL transform: fail-closed
// keying + batch idempotency asserted structurally; template/invalid rows dropped; schema version gate.
import { describe, it, expect } from 'vitest'
import { validateModel, collectSamples, generateSeedSQL, derivedPreview, MODEL_SCHEMA } from '../lib/cal1Seed.js'

const baseModel = {
  schema: MODEL_SCHEMA,
  schema_version: '2.0.0',
  by_cultivar_samples: [
    { crop_type_slug: 'tomato', variety_name: 'Sungold', unit: 'count', total_grams: 220, unit_count: 12, sampled_at: '2026-07-30', note: 'ripe' },
    { crop_type_slug: 'tomato', variety_name: 'Sungold', unit: 'count', total_grams: 300, unit_count: 15, sampled_at: '2026-07-31', note: null },
    { crop_type_slug: 'tomato', variety_name: '__TEMPLATE__ replace me', unit: 'count', total_grams: null, unit_count: null, sampled_at: null, note: 't' },
    { crop_type_slug: 'pepper', variety_name: 'Ristra Cayenne', unit: 'count', total_grams: 40, unit_count: 8, sampled_at: '2026-07-30', note: null },
  ],
}

describe('cal1Seed — validateModel', () => {
  it('accepts a v2 model', () => { expect(validateModel(baseModel)).toBe(true) })
  it('rejects a wrong schema', () => { expect(() => validateModel({ ...baseModel, schema: 'x' })).toThrow() })
  it('rejects a non-2.x version', () => { expect(() => validateModel({ ...baseModel, schema_version: '1.0.0' })).toThrow() })
  it('rejects a missing samples array', () => { expect(() => validateModel({ ...baseModel, by_cultivar_samples: null })).toThrow() })
})

describe('cal1Seed — collectSamples (drops template / null / invalid)', () => {
  it('keeps only real samples', () => {
    const s = collectSamples(baseModel)
    expect(s).toHaveLength(3) // 2 Sungold + 1 Ristra; the __TEMPLATE__/null row dropped
    expect(s.every((x) => x.total_grams > 0 && x.unit_count > 0 && !x.name.startsWith('__TEMPLATE__'))).toBe(true)
  })
})

describe('cal1Seed — generateSeedSQL', () => {
  it('requires a batch', () => { expect(() => generateSeedSQL(baseModel, {})).toThrow() })
  it('emits a fail-closed, batch-idempotent INSERT', () => {
    const { seedSQL, stats } = generateSeedSQL(baseModel, { batch: 'b1' })
    expect(stats.samples).toBe(3)
    expect(seedSQL).toContain('INSERT INTO public.cultivar_weight_sample')
    expect(seedSQL).toContain(') = 1') // exactly-one-match fail-closed
    expect(seedSQL).toContain('NOT EXISTS') // batch idempotency
    expect(seedSQL).toContain("'b1'")
    expect(seedSQL).toContain("'Sungold'")
    expect(seedSQL).not.toContain('__TEMPLATE__')
  })
  it('escapes single quotes in a cultivar name', () => {
    const m = { ...baseModel, by_cultivar_samples: [{ crop_type_slug: 'tomato', variety_name: "O'Hara", unit: 'count', total_grams: 10, unit_count: 1, sampled_at: '2026-07-30' }] }
    expect(generateSeedSQL(m, { batch: 'b1' }).seedSQL).toContain("'O''Hara'")
  })
  it('handles an empty model (template only)', () => {
    const { seedSQL, stats } = generateSeedSQL({ ...baseModel, by_cultivar_samples: [baseModel.by_cultivar_samples[2]] }, { batch: 'b1' })
    expect(stats.samples).toBe(0)
    expect(seedSQL).toContain('no real samples')
    expect(seedSQL).not.toContain('INSERT INTO')
  })
  it('emits a coverage query with distinct keys', () => {
    const { coverageSQL } = generateSeedSQL(baseModel, { batch: 'b1' })
    expect(coverageSQL).toContain('matches')
    expect(coverageSQL).toContain("'Sungold'")
    expect(coverageSQL).toContain("'Ristra Cayenne'")
  })
})

describe('cal1Seed — derivedPreview (oracle-driven, no DB)', () => {
  it('groups by (slug,name,unit) and derives via the oracle', () => {
    const p = derivedPreview(baseModel)
    const sungold = p.find((x) => x.name === 'Sungold')
    expect(sungold.derived.sample_n).toBe(2)
    expect(sungold.derived.grams_per_unit).toBeCloseTo(520 / 27, 3)
    const ristra = p.find((x) => x.name === 'Ristra Cayenne')
    expect(ristra.derived.sample_n).toBe(1)
    expect(ristra.derived.usable_for_comparison).toBe(false) // n=1 provisional
  })
})
