// CAL-1 MEASURED-tier pooling tests (V4-CAL1-REFWEIGHT-001 follow-up).
// poolSamples decides every measured yield number in the app, so the arithmetic is asserted rather
// than trusted — in particular that pooling is COUNT-WEIGHTED (raw grams/count summed) and not a
// mean of per-sample ratios, which is the subtle way a big pick gets under-counted.
import { describe, it, expect } from 'vitest'
import { poolSamples, generateSQL } from '../../scripts/cal1/apply-measured-samples.mjs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const live = JSON.parse(readFileSync(resolve(HERE, '../data/harvest-weights-v2.json'), 'utf8'))

const S = (variety, total_grams, unit_count, extra = {}) => ({
  crop_type_slug: 'tomato', variety_name: variety, unit: 'count',
  total_grams, unit_count, sampled_at: '2026-08-03', ...extra,
})

describe('poolSamples — derivation', () => {
  it('divides total grams by unit count', () => {
    const [r] = poolSamples({ by_cultivar_samples: [S('Cherry Falls', 74, 12)] })
    expect(r.units.count).toBeCloseTo(6.167, 3)
  })

  it('pools count-weighted, not as a mean of ratios', () => {
    // 74/12 = 6.17 and 115/1 = 115. Count-weighted = 189/13 = 14.54.
    // A naive mean of the two ratios would give 60.6 — 4x wrong.
    const [r] = poolSamples({ by_cultivar_samples: [S('X', 74, 12), S('X', 115, 1)] })
    expect(r.units.count).toBeCloseTo(14.538, 3)
    expect(r.n).toBe(2)
  })

  it('keeps a separate factor per unit on the same variety', () => {
    const [r] = poolSamples({
      by_cultivar_samples: [S('X', 100, 4), S('X', 500, 2, { unit: 'cup' })],
    })
    expect(r.units.count).toBe(25)
    expect(r.units.cup).toBe(250)
  })

  it('handles variety names containing spaces', () => {
    // the pooling key is NUL-separated precisely so 'San Marzano Roma' does not split apart
    const [r] = poolSamples({ by_cultivar_samples: [S('San Marzano Roma', 337, 5)] })
    expect(r.variety).toBe('San Marzano Roma')
    expect(r.units.count).toBeCloseTo(67.4, 3)
  })
})

describe('poolSamples — exclusions', () => {
  it('drops template, null and non-positive rows', () => {
    expect(poolSamples({ by_cultivar_samples: [
      S('__TEMPLATE__ replace me', 100, 4),
      S('A', null, 4), S('B', 100, null), S('C', 0, 4), S('D', 100, 0), S('E', -5, 2),
    ] })).toHaveLength(0)
  })

  it('excludes a voided sample and keeps its replacement', () => {
    const doc = {
      by_cultivar_samples: [S('X', 9999, 1), S('X', 115, 1)],
      by_cultivar_voids: [{ crop_type_slug: 'tomato', variety_name: 'X', sampled_at: '2026-08-03', total_grams: 9999 }],
    }
    const [r] = poolSamples(doc)
    expect(r.units.count).toBe(115)
    expect(r.n).toBe(1)
  })

  it('throws on a unit outside the harvest vocabulary', () => {
    expect(() => poolSamples({ by_cultivar_samples: [S('X', 100, 4, { unit: 'grams' })] })).toThrow(/vocabulary/)
  })
})

describe('generateSQL', () => {
  it('emits one measured UPDATE per variety and never claims an unmeasured unit', () => {
    const sql = generateSQL(poolSamples({ by_cultivar_samples: [S('X', 100, 4)] }))
    expect(sql).toMatch(/UPDATE public\.plant_varieties/)
    expect(sql).toMatch(/weight_source='measured'/)
    expect(sql).toMatch(/'\{"count":25\}'::jsonb/)
    expect(sql).not.toMatch(/"cup"/) // unmeasured units must fall back to the crop tier
  })

  it('escapes single quotes in a variety name', () => {
    const sql = generateSQL(poolSamples({ by_cultivar_samples: [S("Dave's Best", 100, 4)] }))
    expect(sql).toContain("name='Dave''s Best'")
  })
})

describe('the live v2 sample file', () => {
  it('pools without error and yields plausible per-fruit weights', () => {
    const rows = poolSamples(live)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      for (const [u, g] of Object.entries(r.units)) {
        expect(g, `${r.variety}.${u}`).toBeGreaterThan(0)
        expect(g, `${r.variety}.${u}`).toBeLessThan(20000)
      }
    }
  })
})
