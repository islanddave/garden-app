// BUG-LOOSEKEYREPEAT-001 — the tokeniser/keyer agreement voiceFuzzyMatch.js calls load-bearing.
//
// `tokens()` carries a comment saying it splits on "the same separators looseKey() collapses" and
// that disagreement "would make the whole-string floor incoherent". That was a claim in prose with
// nothing checking it, so when looseKey gained '_' the two silently drifted apart and the sentence
// stayed there describing a property the code no longer had. This file is that sentence, executable.
//
// THE INVARIANT IS ONE-DIRECTIONAL, and the direction matters:
//   REQUIRED   every character looseKey REMOVES must also be a token boundary. Otherwise an alias
//              collapses to one token while the utterance arrives as several, both spoken tokens are
//              scored against that single token, the unmatched-token penalty fires, and the
//              consumption rule that makes word order irrelevant cannot run at all.
//   HARMLESS   splitting on a character looseKey KEEPS. That only makes tokens finer, and the floor
//              still compares whole keys.
// Pinning the required direction rather than string-equality of the two regexes is what lets this
// file be true on both sides of the looseKey change — and it is also the stronger guard, because it
// is a statement about behaviour rather than about two spellings that could both be wrong together.
import { describe, it, expect } from 'vitest'
import { looseKey } from '../lib/comboboxInput.js'
import { tokens, scoreAlias, fuzzyMatch } from '../lib/voiceFuzzyMatch.js'

// Is `ch` a character looseKey deletes? Probed on TWO DISJOINT letter pairs and required to agree.
// One pair is not enough: looseKey also collapses repeated characters, so probing 'x'+'x'+'y' would
// read the letter 'x' as a deleted separator and this test would then demand tokens() split on 'x'.
// A character cannot be a member of both pairs, so agreement across the two eliminates that class of
// false positive without needing an exclusion list anyone could forget to update.
function looseKeyDeletes(ch) {
  const a = looseKey(`x${ch}y`) === looseKey('xy')
  const b = looseKey(`m${ch}n`) === looseKey('mn')
  return a && b
}

// Printable ASCII plus the characters that are actually in play: the curly apostrophe a phone
// keyboard produces, and real whitespace.
const CANDIDATES = [
  ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)),
  '’', '\t', '\n', ' ',
]

describe('tokens() and looseKey() agree about word boundaries', () => {
  it('splits on EVERY character looseKey removes', () => {
    const drifted = CANDIDATES.filter((ch) => looseKeyDeletes(ch) && tokens(`x${ch}y`).length !== 2)
    expect(drifted).toEqual([])
  })

  it('the probe actually finds separators — the instrument is checked', () => {
    // A sweep whose predicate never fires would pass the assertion above by being blind, which is the
    // failure mode a "the bad list is empty" test is most prone to. So assert the probe's own answers
    // on characters whose status is not in doubt.
    const deleted = CANDIDATES.filter(looseKeyDeletes)
    expect(deleted).toEqual(expect.arrayContaining([' ', '-', '.', '’', "'"]))
    // And that it does not simply answer true for everything.
    expect(looseKeyDeletes('q')).toBe(false)
    expect(looseKeyDeletes('7')).toBe(false)
    expect(deleted.length).toBeLessThan(CANDIDATES.length / 2)
  })

  it('treats an underscore as a boundary, so a snake_case slug is not one token', () => {
    // The instance that drifted. Asserted directly as well as through the sweep, because this is the
    // case with users today: 10 underscore crop types carry 12 live plantings.
    expect(tokens('bunching_onion')).toEqual(['bunching', 'onion'])
    expect(tokens('bunching onion')).toEqual(['bunching', 'onion'])
  })

  it('ONLY splits — it never normalises, so looseKey stays the single place that does', () => {
    // The other half of BUG-LOOSEKEYREPEAT-001 scoped the repeat-collapse to non-digits. That needed
    // no matching edit here, and this pins WHY: every collapse happens inside the injected keyOf,
    // which is applied to each token and to the whole string alike, so both sides of every comparison
    // move together whatever the collapse does. A future edit that "helpfully" normalises here would
    // split that responsibility in two and break the agreement from the other end.
    expect(tokens('1884 aabb Minnesota')).toEqual(['1884', 'aabb', 'minnesota'])
  })
})

describe('what the agreement buys the voice chooser', () => {
  const P = (id, name, slug) => ({ id, name, variety_ref: { crop_type_slug: slug } })
  const aliasesOf = (p) => [p.name, p.variety_ref.crop_type_slug]
  const PLANTS = [
    P('p1', 'Tokyo Long White', 'bunching_onion'),
    P('p2', 'Beauregard', 'sweet_potato'),
    P('p3', 'Suyo Long', 'cucumber'),
  ]

  it('matches a multi-word crop type spoken in EITHER word order', () => {
    // The measured win, and the one the whole-string floor cannot deliver: with the alias collapsed
    // to a single token, "onion bunching" scored 'none'. Two tokens let the consumption rule do what
    // it is for. Word order out of a recogniser is not reliable, and neither is a person's.
    const forward = fuzzyMatch(PLANTS, 'bunching onion', aliasesOf, looseKey)
    const reversed = fuzzyMatch(PLANTS, 'onion bunching', aliasesOf, looseKey)
    expect(forward.kind).toBe('one')
    expect(forward.planting.id).toBe('p1')
    expect(reversed.kind).toBe('one')
    expect(reversed.planting.id).toBe('p1')
  })

  it('scores a reordered slug as an exact reading, not a near miss', () => {
    expect(scoreAlias('onion bunching', 'bunching_onion', looseKey)).toBe(1)
    expect(scoreAlias('potato sweet', 'sweet_potato', looseKey)).toBe(1)
  })

  it('still refuses an unrelated phrase — the widening has a floor', () => {
    // Non-vacuity for the pair above. A tokeniser change that made everything match everything would
    // satisfy them and destroy the matcher; MIN_SCORE and the margin gate must still bite.
    expect(fuzzyMatch(PLANTS, 'rhubarb crumble', aliasesOf, looseKey).kind).toBe('none')
    expect(scoreAlias('onion bunching', 'Suyo Long', looseKey)).toBeLessThan(0.62)
  })
})
