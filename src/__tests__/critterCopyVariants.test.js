import { describe, it, expect } from 'vitest'
import {
  SINGLE_VARIANTS, BURST_VARIANT, PRESENT_TENSE_VARIANTS, resolveCopy,
} from '../lib/critterCopyVariants.js'

describe('critterCopyVariants — pool integrity', () => {
  it('has exactly 10 single-action variants (walkthrough-stable count)', () => {
    expect(SINGLE_VARIANTS.length).toBe(10)
  })

  it('has exactly 2 present-tense variants', () => {
    expect(PRESENT_TENSE_VARIANTS.length).toBe(2)
  })

  it('burst variant matches V100 §7 verbatim', () => {
    expect(BURST_VARIANT).toBe('✨ A few visitors heard about that — heading to your garden.')
  })

  it('every single variant carries the ✨ prefix (renderer relies on it for aria strip)', () => {
    for (const v of SINGLE_VARIANTS) expect(v.startsWith('✨ ')).toBe(true)
  })

  it('verb audit: no internal app vocabulary leaks into single variants', () => {
    const BANNED = ['task', 'job', 'chore', 'earned', 'unlocked', 'achievement', 'xp', 'completed', 'reward']
    for (const v of SINGLE_VARIANTS) {
      const lc = v.toLowerCase()
      for (const word of BANNED) expect(lc).not.toContain(word)
    }
  })
})

describe('resolveCopy — interpolation + aria strip', () => {
  it('interpolates species_capitalized + strips ✨ for aria', () => {
    const { visible, aria } = resolveCopy({
      mode: 'arrival',
      variantIndex: 0,
      speciesAnnounceName: 'a blue jay',
    })
    expect(visible.startsWith('✨ ')).toBe(true)
    expect(visible).toContain('A blue jay')          // capitalized
    expect(aria.startsWith('✨')).toBe(false)        // emoji stripped
    expect(aria).toContain('A blue jay')              // text preserved
    expect(aria).not.toContain('✨')
  })

  it('present_tense mode interpolates {plant}', () => {
    const { visible } = resolveCopy({
      mode: 'present_tense',
      variantIndex: 0,
      speciesAnnounceName: 'a sparrow',
      plantName: 'tomatoes',
    })
    expect(visible).toContain('tomatoes')
  })

  it('burst mode returns the burst variant verbatim', () => {
    const { visible, aria } = resolveCopy({ mode: 'burst', speciesAnnounceName: 'unused' })
    expect(visible).toBe(BURST_VARIANT)
    expect(aria).toBe('A few visitors heard about that — heading to your garden.')
  })

  it('variantIndex wraps modulo pool size (deterministic)', () => {
    const a = resolveCopy({ variantIndex: 0, speciesAnnounceName: 'a robin' })
    const b = resolveCopy({ variantIndex: 10, speciesAnnounceName: 'a robin' })
    expect(a.visible).toBe(b.visible)
  })

  it('graceful default when speciesAnnounceName missing', () => {
    const { visible, aria } = resolveCopy({ variantIndex: 0 })
    expect(typeof visible).toBe('string')
    expect(typeof aria).toBe('string')
    expect(aria.length).toBeGreaterThan(0)
  })
})
