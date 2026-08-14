// V4-HARVWEIGHTREAD-001 — the harvest-weight read model.
//
// The behaviours pinned here are the ones where a plausible implementation silently lies:
//   * a missing weight must never render as 0 (a harvest that weighs nothing is missing data)
//   * an ESTIMATE must never be presentable as a measurement (that laundering is the whole risk)
//   * an unknown weight_basis must degrade to generic copy, never print `undefined` in a sentence
//   * a total must not imply completeness it does not have
import { describe, it, expect } from 'vitest'
import {
  formatGrams, describeHarvestWeight, estimateSourceCopy, sumHarvestWeights,
  estimateSourceShort, weightBasisLabel,
  ESTIMATE_SOURCE_COPY, ESTIMATE_SOURCE_FALLBACK, NO_WEIGHT_COPY,
  ESTIMATE_SOURCE_SHORT, ESTIMATE_SOURCE_SHORT_FALLBACK, MEASURED_SHORT,
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

// ── V4-HARVWEIGHTSURF-001 — the basis as a RENDERED label ────────────────────────────────────────
//
// The defect these pin: the provenance shipped only as title=, and title= requires a hover. On the
// one browser this app is actually read in (Chrome for Android) it never fires, so the basis was
// invisible on every harvest surface. These guard the short vocabulary that replaced it — and,
// because jsdom performs no layout and cannot measure an overflow, they guard the LENGTH BUDGET
// that keeps the label inside a 390px row structurally rather than by eye.
describe('weightBasisLabel — provenance the user can see without hovering', () => {
  it('names the source of each estimate, in the wording the full sentence already uses', () => {
    expect(weightBasisLabel({ weight_grams: 150, weight_estimated: true, weight_basis: 'cultivar_sample' })).toBe('your weighings')
    expect(weightBasisLabel({ weight_grams: 492, weight_estimated: true, weight_basis: 'cultivar' })).toBe('typical for this variety')
    expect(weightBasisLabel({ weight_grams: 300, weight_estimated: true, weight_basis: 'crop_type' })).toBe('typical for this crop')
  })

  // The single distinction the whole basis axis exists to make: Dave's own data versus a generic
  // number. If these two ever collapse to the same string the feature is decorative.
  it('never lets a sample-backed estimate read the same as a catalogue or crop one', () => {
    const labels = ['cultivar_sample', 'cultivar', 'crop_type'].map(estimateSourceShort)
    expect(new Set(labels).size).toBe(3)
    expect(estimateSourceShort('cultivar_sample')).toMatch(/your/i)
  })

  it('labels a MEASURED weight explicitly — the absent ≈ is not a disclosure', () => {
    expect(weightBasisLabel({ weight_grams: 337, weight_estimated: false, weight_basis: 'measured' })).toBe(MEASURED_SHORT)
    expect(MEASURED_SHORT).toBe('weighed')
  })

  it('returns null where there is nothing to label, rather than an empty chip', () => {
    for (const h of [{ weight_grams: null }, { weight_grams: 0 }, {}, null, undefined]) {
      expect(weightBasisLabel(h)).toBeNull()
    }
  })

  // weight_basis is widened by MIGRATION, not by a frontend deploy, so a bundle can legitimately
  // receive a value it has never heard of. Same failure mode ESTIMATE_SOURCE_COPY was audited for.
  it.each([
    ['a future vocabulary value', 'cultivar_lab_assay'],
    ['a value from a newer DB than this bundle', 'basis_shipped_after_this_build'],
    ['null', null],
    ['absent from the payload', undefined],
    ['empty string', ''],
    ['a non-string', 42],
  ])('degrades to a still-true generic label for %s, never "undefined"', (_label, basis) => {
    const l = weightBasisLabel({ weight_grams: 200, weight_estimated: true, weight_basis: basis })
    expect(l).toBe(ESTIMATE_SOURCE_SHORT_FALLBACK)
    expect(l).not.toMatch(/undefined/)
  })

  // A tri-state guard that is live, not hypothetical: 15 rows carry a NULL weight_estimated, and
  // describeHarvestWeight deliberately treats those as estimated. The label must follow it, or a
  // guess gets labelled "weighed".
  it('follows describeHarvestWeight on a NULL weight_estimated — never labels a guess "weighed"', () => {
    expect(weightBasisLabel({ weight_grams: 200, weight_estimated: null, weight_basis: 'cultivar' }))
      .toBe('typical for this variety')
  })

  // DRIFT GUARD. Two maps now describe the same enum. A future value added to one and not the other
  // silently falls back on a surface Dave reads, with nothing failing.
  it('carries a short label for every basis the full sentence knows about', () => {
    expect(Object.keys(ESTIMATE_SOURCE_SHORT).sort()).toEqual(Object.keys(ESTIMATE_SOURCE_COPY).sort())
  })
})

describe('the basis label fits a 390px harvest row', () => {
  // jsdom does no layout, so an overflow cannot be observed here. What CAN be pinned is the
  // structural budget behind it. A prior harvest-row change overflowed at exactly this viewport
  // (min-content 399px against a 390px screen), so these are the load-invariant facts:
  //
  //   usable row content at 390px ≈ 390 − 32 (page gutters) − 56 (Edit affordance + gap)
  //                                     − 26 (card padding) ≈ 276px
  //   the label renders at 0.72rem ≈ 11.5px, so ≈6px per character
  const ALL = [...Object.values(ESTIMATE_SOURCE_SHORT), ESTIMATE_SOURCE_SHORT_FALLBACK, MEASURED_SHORT]

  it('keeps every label short enough to sit beside the number, not under it', () => {
    // 28 chars ≈ 170px, leaving room for "≈ 12.5 kg" (~60px) and the separator inside the 276px.
    for (const l of ALL) expect(l.length, l).toBeLessThanOrEqual(28)
  })

  // This is the one that actually bounds min-content: the label span is allowed to WRAP, so the
  // row's minimum width is driven by its longest unbreakable WORD, not by the whole string.
  it('contains no word long enough to widen the row on its own', () => {
    for (const l of ALL) {
      for (const w of l.split(' ')) expect(w.length, w).toBeLessThanOrEqual(12)
    }
  })

  // The short label is a COMPRESSION of the sentence already shipped in the tooltip and the
  // EventDetail edit form, not a second vocabulary for the same idea. Two surfaces render the short
  // form and two render the long one; if they drift, the basis means different things per screen.
  it('introduces no new vocabulary — every label reuses the shipped sentence wording', () => {
    const union = Object.values(ESTIMATE_SOURCE_COPY).join(' ').toLowerCase()
    for (const [basis, short] of Object.entries(ESTIMATE_SOURCE_SHORT)) {
      const own = ESTIMATE_SOURCE_COPY[basis].toLowerCase()
      for (const w of short.split(' ')) {
        // Every word, function words included, must already exist somewhere in the shipped copy…
        expect(union, `${basis}: "${w}" is not in any shipped sentence`).toContain(w)
        // …and every MEANING-bearing word must come from THIS basis's own sentence, or the label is
        // describing a different provenance than the tooltip beside it.
        if (w.length >= 4 && !['this', 'from'].includes(w)) {
          expect(own, `${basis}: "${w}" is not in its own sentence`).toContain(w)
        }
      }
    }
  })
})
