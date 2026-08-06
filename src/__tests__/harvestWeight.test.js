// V4-HARVESTSURF-001 — the harvest-weight read model.
//
// The behaviours pinned here are the ones where a plausible implementation silently lies:
//   * a missing weight must never render as 0 (a harvest that weighs nothing is missing data)
//   * an ESTIMATE must never be presentable as a measurement (that laundering is the whole risk)
//   * an unknown weight_basis must degrade to generic copy, never print `undefined` in a sentence
//   * a total must not imply completeness it does not have
import { describe, it, expect } from 'vitest'
import {
  formatGrams, describeHarvestWeight, estimateSourceCopy, sumHarvestWeights,
  ESTIMATE_SOURCE_COPY, ESTIMATE_SOURCE_FALLBACK, NO_WEIGHT_COPY,
} from '../lib/harvestWeight.js'

describe('formatGrams', () => {
  it('renders grams under 1 kg, rounded', () => {
    expect(formatGrams(337)).toBe('337 g')
    expect(formatGrams(4.5)).toBe('5 g')
    expect(formatGrams(999)).toBe('999 g')
  })

  it('switches to kg at 1 kg and trims trailing zeros', () => {
    expect(formatGrams(1000)).toBe('1 kg')
    expect(formatGrams(1360.776)).toBe('1.36 kg')
    expect(formatGrams(2500)).toBe('2.5 kg')
  })

  it('drops decimals past 10 kg, where they are noise on an estimate', () => {
    expect(formatGrams(17258.6)).toBe('17 kg')
  })

  it('returns null — never "0 g" — for every flavour of absent', () => {
    for (const v of [null, undefined, '', 0, -5, NaN, 'abc', {}]) {
      expect(formatGrams(v)).toBeNull()
    }
  })
})

describe('estimateSourceCopy — the fallback is the point', () => {
  it('maps every basis the resolver can currently produce', () => {
    expect(estimateSourceCopy('cultivar_sample')).toBe(ESTIMATE_SOURCE_COPY.cultivar_sample)
    expect(estimateSourceCopy('cultivar')).toBe(ESTIMATE_SOURCE_COPY.cultivar)
    expect(estimateSourceCopy('crop_type')).toBe(ESTIMATE_SOURCE_COPY.crop_type)
  })

  it('degrades a FUTURE / unknown / null basis to generic copy, never undefined', () => {
    for (const v of ['tier_7_not_invented_yet', null, undefined, '', 'measured']) {
      const copy = estimateSourceCopy(v)
      expect(copy).toBe(ESTIMATE_SOURCE_FALLBACK)
      expect(copy).not.toMatch(/undefined/)
    }
  })
})

describe('describeHarvestWeight — three states, not interchangeable', () => {
  it('a user-supplied weight is MEASURED and carries no estimate copy', () => {
    const d = describeHarvestWeight({ weight_grams: 337, weight_estimated: false, weight_basis: 'measured' })
    expect(d.state).toBe('measured')
    expect(d.estimated).toBe(false)
    expect(d.text).toBe('337 g')
    expect(d.sourceCopy).toBeNull()
  })

  it('a resolver estimate is ESTIMATED and carries basis-specific copy', () => {
    const d = describeHarvestWeight({ weight_grams: 171.6, weight_estimated: true, weight_basis: 'cultivar' })
    expect(d.state).toBe('estimated')
    expect(d.estimated).toBe(true)
    expect(d.sourceCopy).toBe(ESTIMATE_SOURCE_COPY.cultivar)
  })

  it('no weight is the RATCHET state, not an error, and never 0', () => {
    const d = describeHarvestWeight({ weight_grams: null, weight_estimated: null, weight_basis: null })
    expect(d.state).toBe('none')
    expect(d.text).toBeNull()
    expect(d.grams).toBeNull()
    expect(d.sourceCopy).toBe(NO_WEIGHT_COPY)
  })

  it('tolerates a missing harvest object entirely', () => {
    for (const v of [null, undefined, {}]) {
      expect(describeHarvestWeight(v).state).toBe('none')
    }
  })

  it('an ambiguous weight_estimated is treated as an ESTIMATE — understate, never launder', () => {
    // Cannot happen by construction (chk_harvest_log_weight_basis_pairing), but if it ever does,
    // the safe direction is to under-claim. Labelling a real measurement "estimated" is cosmetic;
    // labelling a guess "measured" corrupts the record.
    const d = describeHarvestWeight({ weight_grams: 200, weight_estimated: null, weight_basis: 'cultivar' })
    expect(d.state).toBe('estimated')
  })
})

describe('sumHarvestWeights — a total must not imply completeness it lacks', () => {
  const ROWS = [
    { weight_grams: 100, weight_estimated: false, weight_basis: 'measured' },
    { weight_grams: 250, weight_estimated: true,  weight_basis: 'cultivar' },
    { weight_grams: null, weight_estimated: null, weight_basis: null },
    { weight_grams: 150, weight_estimated: true,  weight_basis: 'cultivar_sample' },
  ]

  it('sums measured and estimated together and reports the split', () => {
    const s = sumHarvestWeights(ROWS)
    expect(s.grams).toBe(500)
    expect(s.text).toBe('500 g')
    expect(s.measured).toBe(1)
    expect(s.estimated).toBe(2)
  })

  it('counts the rows it could NOT weigh rather than hiding them', () => {
    expect(sumHarvestWeights(ROWS).unweighed).toBe(1)
  })

  it('an all-unweighed set totals to null text, not "0 g"', () => {
    const s = sumHarvestWeights([{ weight_grams: null }, {}])
    expect(s.grams).toBe(0)
    expect(s.text).toBeNull()
    expect(s.unweighed).toBe(2)
  })

  it('tolerates an absent list', () => {
    expect(sumHarvestWeights(null).grams).toBe(0)
    expect(sumHarvestWeights(undefined).unweighed).toBe(0)
  })
})
