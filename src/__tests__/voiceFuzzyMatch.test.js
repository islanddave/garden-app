// V5-VOICEFUZZYMATCH-001 — the closed-vocabulary rescue for the /log/voice planting chooser.
//
// The bug: Dave says "Suyo Long", Chrome hands the app "studio long", and matchPlantings returns
// ZERO hits every single time because it is substring containment — "studiolong" is not inside
// "suyolong". Not flaky, not diction: a permanent dead end on every uncommon cultivar he grows.
//
// These tests pin two different things and it is worth being explicit about which is which:
//   * that the rescue FIRES on the real reported failure, and
//   * that it REFUSES everywhere refusing is the safer answer.
// The second set is the one that matters. A rescue that fires too eagerly turns a visibly broken
// zero-match into a confidently wrong planting, which is strictly worse — the same asymmetry
// voiceHarvestGrammar.js states for commands.
import { describe, it, expect } from 'vitest'
import { looseKey } from '../lib/comboboxInput.js'
import {
  scoreAlias, similarity, editDistance, fuzzyMatch, rankPlantings,
  MIN_SCORE, AUTO_MARGIN, MIN_QUERY_CHARS,
} from '../lib/voiceFuzzyMatch.js'
import { plantingAliases, matchPlantings, matchPlantingsWithRescue } from '../pages/VoiceHarvest.jsx'

const p = (id, name, variety, slug) => ({
  id, name, variety_ref: variety ? { name: variety, crop_type_slug: slug ?? null } : null,
})

// Shaped after Dave's real garden: the reported cucumber, other cucumbers it must not be confused
// with, a digit-named planting (his tomato is literally called "1884"), and the crowded crop types
// the peer session measured on prod (tomato 46 plantings, pepper 38).
const GARDEN = [
  p('suyo', 'Suyo Long', 'Suyo Long', 'cucumber'),
  p('ping', 'Ping Tung Long', 'Ping Tung Long', 'eggplant'),
  p('tokyo', 'Tokyo Long White', 'Tokyo Long White', 'onion'),
  p('marketmore', 'Marketmore 76', 'Marketmore 76', 'cucumber'),
  p('1884', '1884', '1884', 'tomato'),
  p('sungold', 'Sun Gold F1', 'Sun Gold F1', 'tomato'),
  p('stupice', 'Stupice', 'Stupice', 'tomato'),
  p('sage', 'Garden Sage', 'Garden Sage', 'sage'),
  p('cubanelle', 'Cubanelle', 'Cubanelle', 'pepper'),
]

describe('the reported failure', () => {
  it('the SHIPPED matcher finds nothing for "studio long" — this is the bug', () => {
    expect(matchPlantings(GARDEN, 'studio long')).toEqual([])
  })

  it('the rescue selects Suyo Long', () => {
    const { hits, rescued } = matchPlantingsWithRescue(GARDEN, 'studio long')
    expect(hits).toHaveLength(1)
    expect(hits[0].id).toBe('suyo')
    // `rescued` non-null is what makes the caller announce the swap out loud. A rescue that reports
    // itself as a clean match is the silent-wrong-save shape this flow exists to prevent.
    expect(rescued).toBe('Suyo Long')
  })

  it('wins by a real margin rather than scraping over the line', () => {
    const res = fuzzyMatch(GARDEN, 'studio long', plantingAliases, looseKey)
    expect(res.kind).toBe('one')
    // Measured against the real 590-name prod vocabulary before this was written: 0.700 vs 0.429.
    expect(res.score).toBeGreaterThan(0.65)
    expect(res.margin).toBeGreaterThan(0.2)
  })

  it('also catches the other ways the recogniser splits the same name', () => {
    for (const heard of ['sue yo long', 'su yo long', 'suyo long']) {
      const { hits } = matchPlantingsWithRescue(GARDEN, heard)
      expect(hits.map((h) => h.id)).toContain('suyo')
    }
  })
})

describe('every current match is preserved — the rescue can only add', () => {
  // The load-bearing compatibility claim: fuzzy runs ONLY on an empty strict result, so no utterance
  // that resolves today can resolve differently tomorrow.
  it.each([
    ['suyo long', 'suyo'],
    ['Suyo Long', 'suyo'],
    ['stupice', 'stupice'],
    ['1884', '1884'],
  ])('%s still resolves strictly to %s', (spoken, id) => {
    const strict = matchPlantings(GARDEN, spoken)
    expect(strict.map((h) => h.id)).toContain(id)
    expect(matchPlantingsWithRescue(GARDEN, spoken).hits).toEqual(strict)
    expect(matchPlantingsWithRescue(GARDEN, spoken).rescued).toBeNull()
  })

  it('a crop-type utterance still lists every planting of that crop', () => {
    const { hits, rescued } = matchPlantingsWithRescue(GARDEN, 'cucumber')
    expect(hits.map((h) => h.id).sort()).toEqual(['marketmore', 'suyo'])
    expect(rescued).toBeNull()
  })
})

describe('it refuses where refusing is safer', () => {
  it('says nothing matched for speech that is not a crop at all', () => {
    for (const junk of ['what time is it', 'the dog is barking', 'hello hello']) {
      expect(matchPlantingsWithRescue(GARDEN, junk).hits).toEqual([])
    }
  })

  it('refuses a short fragment rather than scoring it noisily', () => {
    // Below MIN_QUERY_CHARS nothing is offered: a 2-3 character fragment scores against everything.
    expect(fuzzyMatch(GARDEN, 'st', plantingAliases, looseKey).kind).toBe('none')
    expect(looseKey('st').length).toBeLessThan(MIN_QUERY_CHARS)
  })

  it('offers the "Which one?" list instead of guessing when two plantings score alike', () => {
    // Two rows that are genuinely near-identical — the reversed-word duplicates that exist in Dave's
    // real variety data (Yellow Brandywine / Brandywine Yellow). Neither a matcher nor a human can
    // pick between them, so the only correct behaviour is to ask.
    const dupes = [
      p('a', 'Yellow Brandywine', 'Yellow Brandywine', 'tomato'),
      p('b', 'Brandywine Yellow', 'Brandywine Yellow', 'tomato'),
    ]
    const res = fuzzyMatch(dupes, 'yellow brandywine', plantingAliases, looseKey)
    expect(res.kind).toBe('many')
    expect(res.hits).toHaveLength(2)
  })

  it('does not let a matched common word drag in a wrong planting', () => {
    // "long" is shared by three rows. A scorer that weighted the intact token equally would happily
    // return Ping Tung Long for anything ending in "long".
    const res = fuzzyMatch(GARDEN, 'studio long', plantingAliases, looseKey)
    expect(res.planting.id).toBe('suyo')
  })

  it('measures the margin against the FULL ranking, not the filtered one', () => {
    // REGRESSION PIN for the only wrong auto-select the 750-utterance adversarial sweep produced.
    // "goldeersgold" selected Goldenrod at 0.636 while reporting a margin of 1.000, because the row
    // it was derived from (Gatherer's Gold) scored just under the threshold and was filtered out from
    // underneath the comparison — leaving nothing to compare against and a free pass in place of a
    // guard. The same defect made the threshold non-monotonic: raising it 0.64 -> 0.68 took wrong
    // auto-selects from 0 to 2, because a higher floor removes more rivals.
    const near = [
      p('gatherers', "Gatherer's Gold", "Gatherer's Gold", 'tomato'),
      p('goldenrod', 'Goldenrod', 'Goldenrod', 'flower'),
    ]
    const res = fuzzyMatch(near, 'goldeersgold', plantingAliases, looseKey)
    expect(res.kind).not.toBe('one')
    // and a below-threshold rival must still suppress the margin rather than vanishing from it
    const solo = fuzzyMatch(near, 'goldeersgold', plantingAliases, looseKey, { minScore: 0.62 })
    if (solo.kind === 'one') expect(solo.margin).toBeLessThan(1)
  })

  it('a near-miss of a DIGIT-named planting does not pull a confident wrong match', () => {
    // The peer session's warning: a bare digit name has almost no character overlap with anything, so
    // it is exactly where a fuzzy fallback would invent confidence. Whatever happens here, it must
    // not be a confident selection of the WRONG row.
    for (const heard of ['eighteen eighty four', 'eighteen eighty', 'one thousand']) {
      const res = fuzzyMatch(GARDEN, heard, plantingAliases, looseKey)
      if (res.kind === 'one') expect(res.planting.id).toBe('1884')
    }
  })
})

describe('the scorer itself', () => {
  it('editDistance and similarity are the standard thing', () => {
    expect(editDistance('suyo', 'studio')).toBe(3)
    expect(editDistance('', 'abc')).toBe(3)
    expect(similarity('abc', 'abc')).toBe(1)
    expect(similarity('', '')).toBe(1)
  })

  it('penalises alias words the speaker never said', () => {
    // Property 3 in the module: without it "cucumber" scores a perfect 1.0 against every long name
    // that happens to contain it, and one-word utterances drag in the whole garden.
    const tight = scoreAlias('cucumber', 'Cucumber', looseKey)
    const loose = scoreAlias('cucumber', 'Cucumber Beetle Trap Crop', looseKey)
    expect(tight).toBe(1)
    expect(loose).toBeLessThan(tight)
  })

  it('weights a token by its length so a short hit cannot carry a long miss', () => {
    // Property 1. "long" is intact in both; the difference is entirely the first word.
    expect(scoreAlias('studio long', 'Suyo Long', looseKey))
      .toBeGreaterThan(scoreAlias('studio long', 'Ping Tung Long', looseKey))
  })

  it('consumes an alias token so one word cannot satisfy two', () => {
    // Property 2. Without consumption "long long" scores full marks against "Suyo Long".
    expect(scoreAlias('long long', 'Suyo Long', looseKey)).toBeLessThan(1)
  })

  it('survives a word-boundary disagreement via the whole-string floor', () => {
    // The recogniser disagrees about spaces as often as about letters.
    expect(scoreAlias('sunray', 'Sun Ray', looseKey)).toBe(1)
    expect(scoreAlias('brandy wine', 'Brandywine', looseKey)).toBe(1)
  })

  it('ranks best-first and reports which alias matched', () => {
    const ranked = rankPlantings(GARDEN, 'studio long', plantingAliases, looseKey)
    expect(ranked[0].planting.id).toBe('suyo')
    expect(ranked[0].alias).toBe('Suyo Long')
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score)
    }
  })

  it('two aliases of the SAME planting are agreement, not ambiguity', () => {
    // name and variety_ref.name are usually identical. Treating that as a tie would make the ordinary
    // case permanently unselectable.
    const res = fuzzyMatch([p('x', 'Suyo Long', 'Suyo Long', 'cucumber')], 'studio long',
      plantingAliases, looseKey)
    expect(res.kind).toBe('one')
    expect(res.margin).toBe(1)
  })

  it('empty and malformed input never throws or matches', () => {
    expect(fuzzyMatch(GARDEN, '', plantingAliases, looseKey).kind).toBe('none')
    expect(fuzzyMatch([], 'studio long', plantingAliases, looseKey).kind).toBe('none')
    expect(fuzzyMatch(null, 'studio long', plantingAliases, looseKey).kind).toBe('none')
    expect(scoreAlias('', 'Suyo Long', looseKey)).toBe(0)
    expect(scoreAlias('studio', '', looseKey)).toBe(0)
  })

  it('the tuning constants are the ones that were measured', () => {
    // Pinned so a later nudge is a deliberate edit with a reason, not a drift.
    expect(MIN_SCORE).toBe(0.62)
    expect(AUTO_MARGIN).toBe(0.12)
    expect(MIN_QUERY_CHARS).toBe(4)
  })
})
