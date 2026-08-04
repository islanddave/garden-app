// estimateSourceCopy — the read-path guard for the harvest weight_basis enum.
//
// weight_basis is a SERVER-derived vocabulary that has already grown twice ('cultivar'/'crop_type'
// in v2, 'cultivar_sample' in v4-harvbasis-sample-001) and is widened by migration, not by a
// frontend deploy. So the client can legitimately receive a value it was never built to know about
// — a browser on a cached bundle, or simply a DB migrated ahead of the deployed frontend. An
// unhandled enum value rendering `undefined` into a sentence is the classic silent failure in that
// situation, and these tests exist to make it impossible rather than unlikely.
import { describe, it, expect } from 'vitest'
import { estimateSourceCopy } from '../pages/EventDetail.jsx'

describe('estimateSourceCopy — harvest weight_basis provenance wording', () => {
  it('distinguishes a SAMPLE-backed estimate from a CATALOGUE-backed one', () => {
    // The entire point of the cultivar_sample value: these two must not read the same.
    const sample = estimateSourceCopy('cultivar_sample')
    const catalogue = estimateSourceCopy('cultivar')
    expect(sample).not.toBe(catalogue)
    expect(sample).toMatch(/your own weighings/i)
    expect(catalogue).toMatch(/typical weight/i)
  })

  it('names the crop-level average as such', () => {
    expect(estimateSourceCopy('crop_type')).toMatch(/typical weight for this crop/i)
  })

  it.each([
    ['an unknown FUTURE vocabulary value', 'cultivar_lab_assay'],
    ['a value from a newer DB than this bundle', 'some_basis_shipped_after_this_build'],
    ['null', null],
    ['undefined (field absent from the payload)', undefined],
    ['empty string', ''],
    ['a non-string', 42],
  ])('falls back to generic copy for %s rather than rendering undefined', (_label, basis) => {
    const copy = estimateSourceCopy(basis)
    expect(copy).toBe('Currently estimated.')
    expect(copy).not.toMatch(/undefined/)
  })

  it('never returns a non-string, for any input', () => {
    for (const basis of ['measured', 'cultivar', 'cultivar_sample', 'crop_type', null, undefined, {}, [], 0]) {
      expect(typeof estimateSourceCopy(basis)).toBe('string')
      expect(estimateSourceCopy(basis).length).toBeGreaterThan(0)
    }
  })

  it('does not claim a provenance for a MEASURED weight', () => {
    // The caller gates on weight_estimated === true, so 'measured' should never arrive here. If it
    // ever does, the generic sentence is the only honest thing to say — it must not claim the
    // weight was estimated from a variety reference.
    expect(estimateSourceCopy('measured')).toBe('Currently estimated.')
    expect(estimateSourceCopy('measured')).not.toMatch(/variety|crop|weighings/i)
  })

  it('every known value produces a complete sentence', () => {
    for (const basis of ['cultivar_sample', 'cultivar', 'crop_type']) {
      expect(estimateSourceCopy(basis)).toMatch(/^Currently estimated.*\.$/)
    }
  })
})
