// V5-HARVESTVOICEFLOW-001 (BD-068) — THIS FILE IS THE FINDING for investigation question (2)
// "spoken value-plus-unit parsing" and question (3) "a voice command vocabulary distinct from data".
//
// The ledger row asks whether the harvest form COULD be driven by voice. Two of its four questions
// are answerable without a device, and the honest way to answer them is to write the parser and run
// real utterances at it rather than assert feasibility. Every `it` below is a claim about what Dave
// can say; a red one is a claim withdrawn.
//
// Dave's flow, quoted in the row: "cucumber" → "three count" → "231 grams" → "next".
// That exact sequence is the first test.
import { describe, it, expect } from 'vitest'
import {
  classify, parseNumber, normalise, collapseAdjacentDupes, COMMANDS, COMMAND_PHRASES, UNIT_ALIASES,
} from '../lib/voiceHarvestGrammar.js'
import { HARVEST_UNITS, WEIGHT_UNITS } from '../lib/harvest-constants.js'

describe("BD-068 — Dave's stated flow, end to end", () => {
  it('parses the exact four-utterance sequence from the ledger row', () => {
    const seq = ['cucumber', 'three count', '231 grams', 'next'].map(classify)
    expect(seq[0]).toMatchObject({ kind: 'search', text: 'cucumber' })
    expect(seq[1]).toMatchObject({ kind: 'quantity', value: 3, unit: 'count' })
    expect(seq[2]).toMatchObject({ kind: 'weight', value: 231, unit: 'g', grams: 231 })
    expect(seq[3]).toMatchObject({ kind: 'command', command: 'save_and_advance' })
  })

  it('reaches the same result when the recogniser spells the number out', () => {
    // Chrome's recogniser is inconsistent about digits vs words for 3-digit numbers, so both forms
    // have to land on the same value or the flow is a coin flip.
    expect(classify('two hundred thirty one grams')).toMatchObject({ kind: 'weight', value: 231, grams: 231 })
  })

  it('survives the comma Chrome inserts into dictated numbers', () => {
    expect(classify('231, grams')).toMatchObject({ kind: 'weight', value: 231 })
  })
})

describe('command vs data — the discrimination that prevents a silent wrong save', () => {
  it('fires a command ONLY on an exact whole-utterance match', () => {
    expect(classify('next')).toMatchObject({ kind: 'command', command: 'save_and_advance' })
  })

  // The core safety property. Each of these CONTAINS a command word and must NOT be a command.
  it.each([
    ['next to the fence', 'search'],
    ['cucumber next', 'search'],
    ['save the seeds', 'search'],
    ['clear gem squash', 'search'],
    ['done bean', 'search'],
  ])('treats %j as data, not a command', (utterance, kind) => {
    expect(classify(utterance).kind).toBe(kind)
  })

  it('never classifies a value-plus-unit utterance as a command', () => {
    for (const alias of Object.keys(UNIT_ALIASES)) {
      const r = classify(`three ${alias}`)
      expect(r.kind).not.toBe('command')
    }
  })

  // A command token that is also a crop name would be an unfixable collision — a save fired by
  // saying the crop out loud. This proves the two vocabularies are disjoint rather than assuming it.
  it('shares no token with the harvest unit vocabulary or common crop names', () => {
    const CROPS = [
      'cucumber', 'tomato', 'pepper', 'bean', 'kale', 'lettuce', 'squash', 'garlic', 'shallot',
      'onion', 'beet', 'carrot', 'basil', 'collard', 'broccoli', 'blueberry', 'peach', 'melon',
      'chard', 'pea', 'corn', 'radish', 'turnip', 'leek', 'spinach', 'zucchini', 'okra', 'celery',
    ]
    const commandTokens = new Set([...Object.keys(COMMANDS), ...Object.keys(COMMAND_PHRASES)])
    for (const crop of CROPS) expect(commandTokens.has(crop)).toBe(false)
    for (const unit of Object.keys(UNIT_ALIASES)) expect(commandTokens.has(unit)).toBe(false)
  })
})

describe('homophones — the to/two/too case Dave named explicitly', () => {
  it.each([
    ['to count', 2], ['too count', 2], ['two count', 2],
    ['for count', 4], ['fore count', 4], ['four count', 4],
    ['won count', 1], ['one count', 1],
    ['ate count', 8], ['eight count', 8],
    ['tree count', 3], ['three count', 3],
  ])('reads %j as %i', (utterance, value) => {
    expect(classify(utterance)).toMatchObject({ kind: 'quantity', value, unit: 'count' })
  })

  // The homophone map is scoped to the pre-unit slot ONLY. "to" on its own is a search term, not a
  // 2 — otherwise every stray preposition becomes a number.
  it('does not turn a bare homophone into a number outside the unit slot', () => {
    expect(classify('to')).toMatchObject({ kind: 'search' })
    expect(classify('for')).toMatchObject({ kind: 'search' })
  })
})

describe('the axis question — which field a spoken unit lands in', () => {
  it('routes mass units to weight and counting units to quantity', () => {
    expect(classify('two pounds').kind).toBe('weight')
    expect(classify('1.2 kilograms')).toMatchObject({ kind: 'weight', grams: 1200 })
    expect(classify('eight ounces').kind).toBe('weight')
    expect(classify('three bunch').kind).toBe('quantity')
    expect(classify('two head').kind).toBe('quantity')
    expect(classify('four cups').kind).toBe('quantity')
  })

  it('emits only units the app and its server CHECK already accept', () => {
    const seen = new Set()
    for (const alias of Object.keys(UNIT_ALIASES)) {
      const r = classify(`two ${alias}`)
      if (r.unit) seen.add(r.unit)
    }
    for (const u of seen) expect([...HARVEST_UNITS, ...WEIGHT_UNITS]).toContain(u)
  })

  it('converts to grams the same way toGrams does', () => {
    expect(classify('one pound').grams).toBeCloseTo(453.592, 3)
    expect(classify('one ounce').grams).toBeCloseTo(28.3495, 4)
    expect(classify('one kilogram').grams).toBe(1000)
  })
})

describe('refusing to guess — the branch that keeps a wrong number off the record', () => {
  it.each([
    ['grams', 'unit-without-number'],
    ['about grams', 'unit-without-number'],
    ['zero count', 'non-positive'],
    ['', 'empty'],
  ])('returns unparsed for %j', (utterance, reason) => {
    expect(classify(utterance)).toMatchObject({ kind: 'unparsed', reason })
  })

  it('rejects a sequence that is only PARTLY a number rather than taking the numeric part', () => {
    // "three quarters cucumber grams" is nonsense; taking the 3 would be worse than refusing.
    expect(parseNumber(['three', 'cucumber'])).toBeNull()
  })

  it('flags an implausible value instead of silently accepting or dropping it', () => {
    // Server CHECK caps count at 10000 and weight at 50000g. A misheard digit is the likeliest
    // cause and Dave is standing there — so the caller should confirm, which needs a flag, not a
    // rejection.
    expect(classify('99999 count')).toMatchObject({ kind: 'quantity', value: 99999, implausible: true })
    expect(classify('80 kilograms')).toMatchObject({ kind: 'weight', implausible: true })
    expect(classify('231 grams').implausible).toBe(false)
  })
})

describe('BUG-VOICEDUPE resilience — the defect that has recurred three times', () => {
  it('collapses an immediate whole-token repeat', () => {
    // "Chinese" -> "Chinese Chinese" was the shipped defect; in continuous mode the same machinery
    // runs once per utterance for a whole session, so the parser does not assume a clean transcript.
    expect(classify('three three count')).toMatchObject({ kind: 'quantity', value: 3, unit: 'count' })
    expect(classify('cucumber cucumber')).toMatchObject({ kind: 'search', text: 'cucumber cucumber' })
    expect(collapseAdjacentDupes(['a', 'a', 'b', 'a'])).toEqual(['a', 'b', 'a'])
  })

  it('does not collapse a non-adjacent repeat', () => {
    expect(collapseAdjacentDupes(['two', 'hundred', 'two'])).toEqual(['two', 'hundred', 'two'])
  })
})

describe('number parsing', () => {
  it.each([
    [['twelve'], 12], [['a', 'dozen'], 12], [['two', 'hundred', 'thirty', 'one'], 231],
    [['a', 'hundred'], 100], [['1.5'], 1.5], [['half'], 0.5], [['half', 'a'], 0.5],
    [['twenty', 'five'], 25], [['one', 'thousand'], 1000],
  ])('parses %j as %s', (tokens, expected) => {
    expect(parseNumber(tokens)).toBeCloseTo(expected, 5)
  })

  it('normalises case, punctuation and whitespace', () => {
    expect(normalise('  Three   COUNT. ')).toBe('three count')
  })

  // REGRESSION, and the most valuable single case in this file — it is the one the parser got WRONG
  // on the first pass and nothing but a test would have caught. Stripping punctuation turned "1.2"
  // into "1 2", which summed to 3: a 2.5x-wrong weight, silently written, with every field on screen
  // looking filled and plausible. Exactly the class of failure the whole grammar exists to prevent,
  // arriving through the most innocuous line in it.
  it('keeps a decimal point that sits between two digits', () => {
    expect(normalise('1.2 kilograms')).toBe('1.2 kilograms')
    expect(classify('1.2 kilograms')).toMatchObject({ kind: 'weight', value: 1.2, grams: 1200 })
    // ...while a full stop that is real punctuation still goes.
    expect(normalise('three count.')).toBe('three count')
  })

  it('reads a spoken decimal digit by digit, not by summing the words', () => {
    expect(parseNumber(['one', 'point', 'two'])).toBeCloseTo(1.2, 5)
    expect(parseNumber(['one', 'point', 'two', 'five'])).toBeCloseTo(1.25, 5)
    expect(classify('one point two kilos')).toMatchObject({ kind: 'weight', value: 1.2, grams: 1200 })
    // "one point twenty" is not a number anyone means — refuse rather than interpret.
    expect(parseNumber(['one', 'point', 'twenty'])).toBeNull()
  })
})
