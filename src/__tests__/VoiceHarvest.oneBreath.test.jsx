// V5-VOICEVOCAB-001 (lane D4) — one breath, no units, against Dave's REAL planting names.
//
// Dave's directive (2026-09-13): "assume the unit and assume grams, so 'planting 2 165' replaces
// 'planting 2 count 165 grams'". BUG-VOICETWOBARENUM-001 made that work when Chrome delivers the parts
// as separate finals. These pin the same sentence delivered as ONE final — which is how his own example
// reads — and the hazard that makes it hard: thirteen of the 244 live plantings carry a digit or a
// number word in some alias, so a number next to a name can belong to either side. The rule under test,
// in one line: a one-breath final is read exactly as its parts would be read as separate finals, and it
// is REFUSED when the split into parts is not unique.
//
// The page-level cases drive the real page through the shared fake recogniser, as the rest of the
// VoiceHarvest suite does, and assert on the POSTed body: a card that looks right is not a row that is.
import { describe, it, expect } from 'vitest'

import {
  resolveOneBreath, plantingOwnsNumbers, plantingsNamedExactly, digitRuns,
} from '../pages/VoiceHarvest.jsx'
import { segmentCandidates } from '../lib/voiceHarvestGrammar.js'
import { VOCAB, byName } from './voiceHarvest.vocabulary.fixture.js'

// ── the unit-bearing one-breath reader: a number is never a name by substring ──────────────────────
//
// Measured on cb32814 with this fixture: "Suyo Long", "2 165 grams" SWITCHED the crop to Danvers 126
// Carrot (segmentCandidates offers the name "2"; the strict layer is character substring, and "2" is
// inside "126"). "4 …" went to 1884, "5 …" to Chinese 5-Color, "6 …" to Danvers. And "cucumber 3 231
// grams" kept 231 g on Suyo Long while the 3 disappeared into the name through the fuzzy layer.
describe('resolveOneBreath — the name half may keep only numbers the planting owns', () => {
  const reading = (s) => {
    const r = resolveOneBreath(VOCAB, segmentCandidates(s))
    return r && { planting: r.planting.name, values: r.values.map((v) => `${v.value} ${v.unit}`) }
  }

  it.each([
    '2 165 grams', '4 231 grams', '5 231 grams', '6 231 grams', '12 100 grams', '80 100 grams', '126 90 grams',
  ])('%j offers a bare number as a name — no planting may be chosen by a digit substring', (s) => {
    expect(reading(s)).toBeNull()
  })

  it.each([
    ['cucumber 3 231 grams'], ['suyo long 2 165 grams'], ['danvers 12 165 grams'], ['studio long 2 165 grams'],
  ])('%j — an amount is never swallowed into the name', (s) => {
    expect(reading(s)).toBeNull()
  })

  // The bounds must not cost a digit-named planting its own name — every census row still resolves.
  it.each([
    ['1884 two count', '1884', ['2 count']],
    ['eighteen eighty four two count 165 grams', '1884', ['2 count', '165 g']],
    ['danvers 126 3 count', 'Danvers 126 Carrot', ['3 count']],
    ['danvers one twenty six 3 count', 'Danvers 126 Carrot', ['3 count']],
    ['cherry rescue 1 3 count', 'Cherry Rescue 1', ['3 count']],
    ['cherry rescue one 3 count', 'Cherry Rescue 1', ['3 count']],
    ['clemson spineless 80 3 count', 'Clemson Spineless 80', ['3 count']],
    ['clemson spineless eighty 3 count', 'Clemson Spineless 80', ['3 count']],
    ['chinese 5 color 3 count', 'Chinese 5-Color', ['3 count']],
    ['chinese five color 3 count', 'Chinese 5-Color', ['3 count']],
    ['marvel of four seasons 3 count', 'Marvel of Four Seasons Butterhead Lettuce', ['3 count']],
    ['alaska mix nasturtium 1 3 count', 'Alaska Mix Nasturtium 1', ['3 count']],
    ['fairway orange coleus clone 1 3 count', 'Fairway Orange Coleus Clone 1', ['3 count']],
    ['super sweet 100 rescue 3 count', 'Super Sweet 100 Rescue', ['3 count']],
    ['armageddon f1 3 count', 'Armageddon', ['3 count']],
    ['peach tree 3 count', 'Peach tree', ['3 count']],
    ['1884 165 grams', '1884', ['165 g']],
  ])('%j still resolves to %s', (s, planting, values) => {
    expect(reading(s)).toEqual({ planting, values })
  })

  it('"super sweet 100" is two plantings (they share the variety name) — refused, as before', () => {
    expect(reading('super sweet 100 3 count')).toBeNull()
  })

  it('digit runs compare WHOLE — the helper the rule rests on', () => {
    expect(digitRuns('Danvers 126 Carrot')).toEqual(['126'])
    expect(digitRuns('Chinese 5-Color')).toEqual(['5'])
    expect(digitRuns('Megatron F1 (jumbo jalapeno)')).toEqual(['1'])
    expect(digitRuns('marvel of four seasons')).toEqual(['4'])
    expect(plantingOwnsNumbers(byName('Danvers 126 Carrot'), 'danvers 126')).toBe(true)
    expect(plantingOwnsNumbers(byName('Danvers 126 Carrot'), 'danvers 12')).toBe(false)
    expect(plantingOwnsNumbers(byName('Suyo Long'), 'suyo long 2')).toBe(false)
    expect(plantingOwnsNumbers(byName('Marvel of Four Seasons Butterhead Lettuce'), 'marvel of four seasons four'))
      .toBe(false)   // counted with multiplicity: the name has one 4
    expect(plantingsNamedExactly(VOCAB, '2').map((p) => p.name)).toEqual([])
    expect(plantingsNamedExactly(VOCAB, 'eighteen eighty four').map((p) => p.name)).toEqual(['1884'])
  })
})
