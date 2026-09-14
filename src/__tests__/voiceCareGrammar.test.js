// V5-VOICECARE-001 — the bulk care grammar.
//
// WHAT THESE TESTS ARE FOR. A bulk care command writes MANY rows and over-application is SILENT:
// watering the whole area when three were excluded is indistinguishable from success, because the
// excluded plants simply look watered. So the cases that matter here are not the happy path — they
// are the shapes that must REFUSE, and the shapes that must not be read as care commands at all.
import { describe, it, expect } from 'vitest'
import { classifyCareCommand, CARE_VERBS, CARE_EVENT_TYPES, ILLEGAL_CARE_TYPES } from '../lib/voiceCareGrammar.js'
import { BATCH_EVENT_TYPES, BATCH_EXCLUDED_TYPES } from '../lib/eventTypes.js'

describe('CARE_VERBS — every verb maps to a batch-legal event type', () => {
  it('maps nothing that BATCH_EXCLUDED_TYPES forbids', () => {
    // THE GUARD THAT MATTERS MOST IN THIS FILE. A spoken bulk command IS a bulk affordance, so a
    // verb mapping to an excluded type would route around a rule enforced everywhere else. Derived
    // from eventTypes.js rather than hand-listed, so adding a bad verb turns this red on its own.
    expect(ILLEGAL_CARE_TYPES).toEqual([])
    for (const t of CARE_EVENT_TYPES) expect(BATCH_EVENT_TYPES).toContain(t)
  })

  it('never offers moisture_check, by name', () => {
    // Called out separately from the derived check because this one has a REASON rather than a rule:
    // "none of these 500 need water" is a fabricated observation (careNeeded.js:34-37). If
    // moisture_check were ever made batch-legal upstream, the derived test above would go quiet and
    // this one would still fail — which is the point of stating it twice.
    expect(BATCH_EXCLUDED_TYPES).toContain('moisture_check')
    expect(Object.values(CARE_VERBS)).not.toContain('moisture_check')
  })
})

describe('classifyCareCommand — what IS a care command', () => {
  it('reads verb, scope and event type from a plain command', () => {
    const r = classifyCareCommand('water all bag area')
    expect(r.kind).toBe('care')
    expect(r.eventType).toBe('watering')
    expect(r.scope).toBe('all bag area')
    expect(r.exclusions).toEqual([])
  })

  it('accepts past tense — he says "fed", not "feed"', () => {
    expect(classifyCareCommand('fed all pasture in ground').eventType).toBe('fertilizing')
  })

  it("parses Dave's verbatim exclusion example", () => {
    const r = classifyCareCommand('fed all pasture in ground except zephyr, crimson sweet, king richard')
    expect(r.kind).toBe('care')
    expect(r.scope).toBe('all pasture in ground')
    expect(r.exclusions).toEqual(['zephyr', 'crimson sweet', 'king richard'])
  })

  it('splits on "and" as well as commas', () => {
    const r = classifyCareCommand('water all bag area except zephyr and crimson sweet')
    expect(r.exclusions).toEqual(['zephyr', 'crimson sweet'])
    expect(r.ambiguousList).toBe(false)
  })

  it('FLAGS an unpunctuated list as ambiguous instead of inventing boundaries', () => {
    // Chrome rarely punctuates speech, so this is the common shape, not the edge one. "zephyr crimson
    // sweet king richard" could be one name or four — "crimson sweet" is itself a two-word cultivar.
    // Splitting on whitespace would invent boundaries the words do not carry; only closed-set matching
    // against the real plantings can split it, and that knowledge lives in the host. So the grammar
    // hands back the raw text and says it does not know.
    const r = classifyCareCommand('water all bag area except zephyr crimson sweet king richard')
    expect(r.kind).toBe('care')
    expect(r.ambiguousList).toBe(true)
    expect(r.exclusionText).toBe('zephyr crimson sweet king richard')
    expect(r.exclusions).toEqual(['zephyr crimson sweet king richard'])
  })

  it('a single-word exclusion is NOT ambiguous', () => {
    // Non-vacuity for the flag: if it were set on everything, the host could never trust it and would
    // have to re-derive the question itself.
    const r = classifyCareCommand('water all bag area except zephyr')
    expect(r.ambiguousList).toBe(false)
    expect(r.exclusions).toEqual(['zephyr'])
  })

  it('accepts the paraphrases most likely to come out instead of "except"', () => {
    for (const p of ['but not', 'apart from', 'other than', 'excluding', 'except for']) {
      const r = classifyCareCommand(`water all bag area ${p} zephyr`)
      expect(r.kind, p).toBe('care')
      expect(r.scope, p).toBe('all bag area')
      expect(r.exclusions, p).toEqual(['zephyr'])
    }
  })
})

describe('classifyCareCommand — what is NOT a care command', () => {
  it('returns null for an ordinary utterance so nothing else changes', () => {
    // null means "not my shape", so every existing path behaves exactly as before. Non-vacuity for
    // the whole feature: if this returned a refusal instead, it would hijack normal dictation.
    expect(classifyCareCommand('suyo long')).toBeNull()
    expect(classifyCareCommand('231 grams')).toBeNull()
    expect(classifyCareCommand('next')).toBeNull()
    expect(classifyCareCommand('')).toBeNull()
  })

  it('does not fire on a verb that is not the FIRST token', () => {
    // Token-0 anchoring is what makes the 849-token measurement hold. "Milkweed" and friends contain
    // a verb mid-token and must stay ordinary search terms.
    expect(classifyCareCommand('common milkweed')).toBeNull()
    expect(classifyCareCommand('tweedia')).toBeNull()
    expect(classifyCareCommand('ausilio thin skin italian')).toBeNull()
  })

  it('WATERMELON is a crop, not a watering command', () => {
    // The single measured verb-initial collision across all 849 live tokens. One token is already
    // safe by anchoring; the guard covers Chrome splitting it as "water melon".
    expect(classifyCareCommand('watermelon')).toBeNull()
    expect(classifyCareCommand('water melon')).toBeNull()
    expect(classifyCareCommand('watermelon crimson sweet')).toBeNull()
  })

  it('still reads a real watering command that merely mentions a melon later', () => {
    // Non-vacuity for the guard above: it must bound on tokens[1], not on the word appearing at all,
    // or it would silently swallow a legitimate command over a melon bed.
    const r = classifyCareCommand('water all melon beds')
    expect(r.kind).toBe('care')
    expect(r.scope).toBe('all melon beds')
  })
})

describe('classifyCareCommand — the refusals, which are the safety surface', () => {
  it('refuses a bare verb rather than defaulting to everything', () => {
    // "water" alone is what a one-word mishear produces, and defaulting it to the whole garden is
    // over-application in its purest form.
    expect(classifyCareCommand('water')).toMatchObject({ kind: 'care_refused', reason: 'no-scope' })
  })

  it('refuses an exclusion with nothing to exclude FROM', () => {
    // "water except zephyr" must never be read as "everything except zephyr" — the most destructive
    // available reading of a misheard utterance.
    expect(classifyCareCommand('water except zephyr'))
      .toMatchObject({ kind: 'care_refused', reason: 'no-scope' })
  })

  it('refuses a truncated exclusion list instead of applying the scope', () => {
    // THE CASE THIS GRAMMAR EXISTS FOR. Chrome ends sessions at pauses, so "… except" losing its
    // names is a routine event, not an edge case. Applying the scope would water the three plants he
    // just said to skip, and it would look like success.
    expect(classifyCareCommand('water all bag area except'))
      .toMatchObject({ kind: 'care_refused', reason: 'empty-exclusion-list' })
  })

  it('a refusal still identifies itself as a care utterance, so the host can say why', () => {
    // A refusal that returned null would fall through to the search branch and quietly run a planting
    // search for "water all bag area except" — a silent fail, which is the one outcome ruled out.
    const r = classifyCareCommand('water all bag area except')
    expect(r).not.toBeNull()
    expect(r.kind).toBe('care_refused')
    expect(r.transcript).toBe('water all bag area except')
  })
})
