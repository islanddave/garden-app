// BUG-LOOSEKEYREPEAT-001 — the two defects on comboboxInput.js's looseKey normalisation.
//
// WHY THIS FILE EXISTS SEPARATELY FROM comboboxInput.test.js. That file already pins the
// repeat-collapse, but BOTH its pins are LETTER cases ('chilli'/'chili', 'Minnesota'/'minesota'),
// so they stay green whether the collapse runs over every character or only over non-digits — they
// cannot tell you whether this fix landed. Nothing anywhere asserted a digit run or an underscore
// before this file. The assertions below are the ones that go red on the pre-fix regex.
//
// (A) UNDERSCORE — the half with users today. The separator class dropped whitespace, hyphens,
//     apostrophes and periods but NOT '_', so a snake_case crop-type slug and the words a human
//     says for it could never key-equal. 10 crop types with live plantings carry an underscore
//     slug (12 plantings): bunching_onion, sweet_potato, bee_balm, spider_plant, japanese_maple,
//     christmas_cactus, lemon_verbena, red_raspberry, bitter_melon, flower_mix.
// (B) DIGIT RUNS — latent. The collapse ran over digits too, so '1884' and '184' keyed identically
//     and two plantings whose names differ only by a repeated digit collided in every typed picker.
//     Dave has a tomato literally named 1884.
import { describe, it, expect } from 'vitest'
import { looseKey, looseIncludes, cropTypeTerms, looseIncludesCropType } from '../lib/comboboxInput.js'

describe('BUG-LOOSEKEYREPEAT-001 (B) — digit runs carry meaning per character', () => {
  it('does NOT collapse a repeated digit: 1884 and 184 are different keys', () => {
    expect(looseKey('1884')).toBe('1884')
    expect(looseKey('184')).toBe('184')
    expect(looseKey('1884')).not.toBe(looseKey('184'))
  })

  it('the two plantings the ledger row names cannot reach each other in a typed picker', () => {
    // Both directions: neither name may substring-match the other's key.
    expect(looseIncludes('1884', '184')).toBe(false)
    expect(looseIncludes('184', '1884')).toBe(false)
  })

  it('leaves every other digit run identity-preserving (100 is not 10)', () => {
    expect(looseKey('100')).toBe('100')
    expect(looseKey('Super Sweet 100')).toBe('superswet100')   // letters still collapse: 'ee' -> 'e'
    expect(looseKey('Danvers 126')).toBe('danvers126')
    expect(looseKey('Chinese 5-Color')).toBe('chinese5color')
  })

  it('still collapses repeated LETTERS — the case the collapse exists for is untouched', () => {
    // The same two pins comboboxInput.test.js carries, restated here so this file shows what the
    // fix deliberately did NOT change. A collapse removed wholesale would turn these red.
    expect(looseKey('chilli')).toBe(looseKey('chili'))
    expect(looseKey('Minnesota')).toBe(looseKey('minesota'))
    expect(looseKey('aabb11')).toBe('ab11')                    // mixed: letters collapse, digits do not
  })
})

describe('BUG-LOOSEKEYREPEAT-001 (A) — an underscore is a word boundary, not a letter', () => {
  it('keys a snake_case slug the same as its spoken/typed form', () => {
    expect(looseKey('bunching_onion')).toBe(looseKey('bunching onion'))
    expect(looseKey('sweet_potato')).toBe(looseKey('sweet potato'))
    expect(looseKey('japanese_maple')).toBe(looseKey('Japanese Maple'))
  })

  it('makes the slug reachable from both spellings, which is what the picker term needed', () => {
    expect(looseIncludes('bunching_onion', 'bunching onion')).toBe(true)
    expect(looseIncludes('bunching_onion', 'bunching_onion')).toBe(true)
    // The single word already substring-matched before the fix; it must keep doing so.
    expect(looseIncludes('bunching_onion', 'onion')).toBe(true)
  })

  it('does not fabricate matches — an unrelated query still misses', () => {
    expect(looseIncludes('bunching_onion', 'rutabaga')).toBe(false)
    expect(looseIncludes('sweet_potato', 'potato bread')).toBe(false)
  })
})

describe('V4-SEARCHCROPTYPE-001 — the shared crop-type term builder', () => {
  const BUNCHING = { slug: 'bunching_onion', display_name: 'Onion (bunching / scallion)' }

  it('offers the slug alone when the surface has no crop-type vocabulary', () => {
    expect(cropTypeTerms('cucumber')).toEqual(['cucumber'])
    expect(looseIncludesCropType('cucumber', 'cucumber')).toBe(true)
    expect(looseIncludesCropType('bunching_onion', 'bunching onion')).toBe(true)
  })

  it('adds the display name when the surface holds the row — this is what reaches "scallion"', () => {
    expect(cropTypeTerms(BUNCHING.slug, BUNCHING)).toEqual(['bunching_onion', 'Onion (bunching / scallion)'])
    expect(looseIncludesCropType('bunching_onion', 'scallion')).toBe(false)
    expect(looseIncludesCropType('bunching_onion', 'scallion', BUNCHING)).toBe(true)
  })

  it('a slug-less row matches nothing, including an empty query', () => {
    // Deliberately asymmetric with looseIncludes, which returns true for an empty needle: an
    // untyped crop type must never silently match.
    expect(looseIncludesCropType(null, 'onion')).toBe(false)
    expect(looseIncludesCropType(undefined, '')).toBe(false)
    expect(cropTypeTerms(null, null)).toEqual([])
  })
})
