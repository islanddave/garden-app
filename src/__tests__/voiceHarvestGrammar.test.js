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
  COMMAND_NEAR_MISSES, foldNumberWords,
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

  // WHAT THE DEVICE ACTUALLY HEARD, which is NOT what Dave said — and until this test existed,
  // deleting `counts: 'count'` from UNIT_ALIASES reddened ZERO of these 47 tests (measured). The
  // suite pinned the spoken forms and left the heard forms covered only by a different file. Two of
  // four phrases in the real run arrived in a form the strict map would have rejected, so these are
  // the load-bearing aliases, not the aspirational ones.
  it('parses the forms Chrome ACTUALLY emitted, not the ones Dave spoke', () => {
    expect(classify('three counts')).toMatchObject({ kind: 'quantity', value: 3, unit: 'count' })
    expect(classify('231 G')).toMatchObject({ kind: 'weight', value: 231, unit: 'g' })
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

// Removed 2026-08-27 on the boss pass. `undo`/`cancel`/`scratch that` pointed `discard` at the
// CURRENT form, so the moment someone said "undo" after a bad save it would have discarded the next
// blank record while the mistake stayed saved. `repeat` contradicted the no-read-back non-goal.
// Pinned as absent so they cannot drift back in unwired — and so that when `undo` returns, it is
// obvious it must be re-added deliberately, pointing at undoSessionRow.
describe('verbs deliberately NOT in the vocabulary', () => {
  it.each(['undo', 'cancel', 'scratch that', 'repeat', 'read it back'])('treats %j as data, not a command', (u) => {
    expect(classify(u).kind).not.toBe('command')
  })

  it('exposes no discard or read_back verb at all', () => {
    const verbs = new Set([...Object.values(COMMANDS), ...Object.values(COMMAND_PHRASES)])
    expect(verbs.has('discard')).toBe(false)
    expect(verbs.has('read_back')).toBe(false)
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

  // POSITIVE sweep. The previous version guarded with `if (r.unit)`, so an alias that stopped
  // resolving was silently skipped and the assertion still passed — it was structurally unable to
  // catch a dead alias, which is how the `counts` mutant survived. Every alias must now RESOLVE,
  // and resolve to a unit the server CHECK accepts.
  it('every alias resolves, and only to units the app and its server CHECK accept', () => {
    for (const alias of Object.keys(UNIT_ALIASES)) {
      const r = classify(`two ${alias}`)
      expect(r.unit, `alias "${alias}" resolved to nothing`).toBeTruthy()
      expect([...HARVEST_UNITS, ...WEIGHT_UNITS], `alias "${alias}"`).toContain(r.unit)
    }
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

// BUG-VOICENUMSUM-001 — MEASURED on Dave's real plantings during his first live run of /log/voice,
// 2026-08-30. Nine of his live plantings carry digits in the NAME (one is literally "1884"), and the
// utterance that reaches parseNumber is everything before the trailing unit — so the name arrived as
// a number token sitting in front of the quantity and was SUMMED into it.
//
// Every one of these four SAVED and REPORTED SUCCESS on prod v4.76.0. None trips MAX_PLAUSIBLE.count
// (10,000), so no downstream check could have caught them. This is the exact outcome the ledger row
// for this flow names as unacceptable — "a silent wrong save is worse than a slow form" — reached
// through a parser that was correct for every utterance anyone thought to test.
describe('BUG-VOICENUMSUM-001 — a planting NAMED after a number must not join the count', () => {
  it.each([
    ['1884 two count', 1886],
    ['eighteen eighty four two count', 104],
    ['1884 165 grams', 2049],
    ['eighteen eighty four 165 grams', 267],
  ])('refuses %j instead of silently saving %i', (utterance, wouldHaveSaved) => {
    const r = classify(utterance)
    expect(r.kind).toBe('unparsed')
    // The point is not merely that it refuses — it is that it never again produces THAT number.
    expect(r.value).toBeUndefined()
    expect(r).not.toMatchObject({ value: wouldHaveSaved })
  })

  it('says WHICH failure it was, because the two need opposite advice', () => {
    // "grams" alone -> say a number. "1884 two count" -> say the name and the amount separately.
    // Collapsing both into unit-without-number would be false: there were two numbers, not none.
    expect(classify('1884 two count')).toMatchObject({ reason: 'ambiguous-number' })
    expect(classify('grams')).toMatchObject({ reason: 'unit-without-number' })
  })

  it('rejects the token sequences directly, not just through classify', () => {
    expect(parseNumber(['1884', 'two'])).toBeNull()          // guard 1: digit literal is atomic
    expect(parseNumber(['1884', '165'])).toBeNull()          // guard 1: two digit literals
    expect(parseNumber(['eighteen', 'eighty', 'four'])).toBeNull()  // guard 2: 18 then 80 ascends
    expect(parseNumber(['eighteen', 'eighty', 'four', 'two'])).toBeNull()
  })

  // NON-VACUITY. Two independent guards do the work here and each must be shown to be load-bearing
  // ON ITS OWN, or a later simplification drops one and the suite stays green. Guard 1 (digit
  // atomicity) cannot see "eighteen eighty four" — there is no digit in it. Guard 2 (strict descent)
  // cannot see "1884 two" — 2 IS smaller than 1884, so the sequence descends perfectly.
  it('needs BOTH guards — neither one covers the other case', () => {
    expect(parseNumber(['eighteen', 'eighty', 'four'])).toBeNull()  // only guard 2 catches this
    expect(parseNumber(['1884', 'two'])).toBeNull()                 // only guard 1 catches this
  })

  // The guards must not have cost anything. Every legal form below parsed correctly BEFORE the fix
  // and must still — a guard that buys safety by refusing valid speech has just moved the failure.
  it.each([
    [['twelve'], 12], [['a', 'dozen'], 12], [['two', 'hundred', 'thirty', 'one'], 231],
    [['a', 'hundred'], 100], [['twenty', 'five'], 25], [['one', 'thousand'], 1000],
    [['half'], 0.5], [['half', 'a'], 0.5], [['two', 'and', 'a', 'half'], 2.5],
    [['1.5'], 1.5], [['231'], 231],
  ])('still parses the legal form %j as %s', (tokens, expected) => {
    expect(parseNumber(tokens)).toBeCloseTo(expected, 5)
  })

  it('leaves the whole of Dave\'s stated flow working', () => {
    expect(classify('three count')).toMatchObject({ kind: 'quantity', value: 3, unit: 'count' })
    expect(classify('231 grams')).toMatchObject({ kind: 'weight', value: 231, grams: 231 })
    expect(classify('two hundred thirty one grams')).toMatchObject({ kind: 'weight', value: 231 })
    expect(classify('1.2 kilograms')).toMatchObject({ kind: 'weight', value: 1.2 })
  })
})

// BUG-VOICENUMWORD-001 — the other half of the same live run. Saying a digit-named planting out loud
// produced number WORDS, which reached a name stored as digits not at all: zero hits, and repeating
// it more clearly never helped because the recogniser was never wrong.
describe('BUG-VOICENUMWORD-001 — folding spoken number words to the digits in a name', () => {
  // All nine of Dave's digit-carrying plantings, in the form the recogniser emits them.
  it.each([
    ['eighteen eighty four', '1884'],
    ['super sweet one hundred', 'super sweet 100'],
    ['danvers one twenty six carrot', 'danvers 126 carrot'],
    ['clemson spineless eighty', 'clemson spineless 80'],
    ['chinese five color', 'chinese 5 color'],
    ['alaska mix nasturtium one', 'alaska mix nasturtium 1'],
    ['cherry rescue one', 'cherry rescue 1'],
    ['fairway orange coleus clone one', 'fairway orange coleus clone 1'],
  ])('folds %j to %j', (spoken, expected) => {
    expect(foldNumberWords(spoken)).toBe(expected)
  })

  // A NAME is read in groups and CONCATENATED; a cardinal is SUMMED. Same words, different answer —
  // which is why this is a separate function and must never be merged into parseNumber.
  it('reads a name in year-form, not as a cardinal sum', () => {
    expect(foldNumberWords('eighteen eighty four')).toBe('1884')   // 18|84 concatenated
    expect(parseNumber(['eighteen', 'eighty', 'four'])).toBeNull() // NOT 102
  })

  it('leaves text with no number words untouched', () => {
    expect(foldNumberWords('cucumber')).toBe('cucumber')
    expect(foldNumberWords('sungold cherry tomato')).toBe('sungold cherry tomato')
  })

  // The homophone entries in NUMBER_WORDS are scoped by their own comment to the slot immediately
  // before a unit word. A name is not that slot, so folding must not reach them — otherwise a search
  // for "tomato to table" silently becomes "tomato 2 table" in the branch where the chooser is
  // ALREADY lost and least able to show the user what happened.
  it.each(['to', 'too', 'won', 'for', 'fore', 'ate', 'tree', 'oh', 'dozen'])(
    'does NOT fold the homophone %j', (word) => {
      expect(foldNumberWords(`tomato ${word} table`)).toBe(`tomato ${word} table`)
    })
})

// V5-HARVESTVOICEFLOW-001 — measured on Dave's Android, 2026-08-28 probe run, round-trip OFF.
// He spoke "next" nine times: eight were heard and committed as save_and_advance via tick, and one
// came back as "text". Before this guard that classified as `search "text"` and committed via
// sessionEnd — no save, no advance, and a search he did not ask for. ~11% on the only device that
// matters, and a wrong ACTION rather than a no-op.
describe('near-miss of a command word — refuse rather than search', () => {
  it('routes the measured mishear to unparsed, not to a search', () => {
    expect(classify('text')).toMatchObject({ kind: 'unparsed', reason: 'near-command' })
  })

  it('does NOT map the mishear onto the command', () => {
    // Deliberate: mapping a low-confidence hearing onto a WRITE is the dangerous direction, and
    // this file's own search branch says so — "a wrong command or a wrong number is committed
    // silently". Refusing costs one repeated word; guessing costs a wrong row.
    expect(classify('text').kind).not.toBe('command')
  })

  // THE LOAD-BEARING TEST IN THIS BLOCK. The obvious general fix is "reject anything within edit
  // distance 1 of a command word". That is UNSAFE and this is why: sage ←1→ save, and sage is a
  // crop Dave grows (2 cultivars, 2 live plantings on prod 2026-08-28). A distance rule would
  // swallow a legitimate search. If someone later replaces the curated set with a metric, this
  // reddens.
  it('still searches for words that are one letter from a command', () => {
    expect(classify('sage')).toMatchObject({ kind: 'search', text: 'sage' })
    expect(classify('top')).toMatchObject({ kind: 'search', text: 'top' })
    expect(classify('nest')).toMatchObject({ kind: 'search', text: 'nest' })
    expect(classify('bone')).toMatchObject({ kind: 'search', text: 'bone' })
  })

  it('never lets a near-miss entry shadow a real command or a unit', () => {
    // A curated list is only safe while its entries are not real vocabulary. Enforce that rather
    // than trusting whoever adds the next entry.
    for (const w of COMMAND_NEAR_MISSES) {
      expect(Object.prototype.hasOwnProperty.call(COMMANDS, w)).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(COMMAND_PHRASES, w)).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(UNIT_ALIASES, w)).toBe(false)
    }
  })

  it('leaves the eight correctly-heard commands from the same run untouched', () => {
    // Non-vacuity: the guard must not have cost anything. This is the utterance it sits next to.
    expect(classify('next')).toMatchObject({ kind: 'command', command: 'save_and_advance' })
  })
})
