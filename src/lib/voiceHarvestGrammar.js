// src/lib/voiceHarvestGrammar.js
//
// V5-HARVESTVOICEFLOW-001 (BD-068) — INVESTIGATION ARTIFACT, NOT A SHIPPED FEATURE.
//
// Dave's row is explicit that BD-068 is an investigation and that nothing may ship a half-flow off
// it. This module is therefore deliberately UNWIRED: nothing in src/ imports it except its own test
// file and the /admin/voice-debug probe. It exists because investigation question (2) — "can a
// spoken value-plus-unit like 'three count' or '231 grams' be split and mapped to the existing
// fields reliably, including homophones and to/two/too?" — cannot be answered by opinion. You answer
// it by writing the parser and running real utterances at it. The test file IS the finding.
//
// THE FLOW UNDER TEST (Dave's words, quoted in the ledger row because the shape is the requirement):
// say "cucumber" → pause while the input is searched → with the mic STILL ON say "three count" →
// "231 grams" → "next", where "next" saves and launches into the next planting chooser.
//
// WHAT THIS MODULE DECIDES, and the ONE hard rule behind all of it:
// A COMMAND MUST NEVER BE INFERRED FROM A PHRASE THAT COULD BE DATA. Dave's own stated worst case
// is "a silent wrong save is worse than a slow form", and `next` is a SAVE. So classification is
// deliberately asymmetric and conservative:
//   - a command matches only on an EXACT whole-utterance token match after normalisation;
//   - anything else falls through to data, and data that does not parse cleanly returns `unparsed`
//     rather than a guess.
// The cost of that asymmetry is that a mumbled "next" does nothing and Dave repeats himself. The
// cost of the opposite asymmetry is a harvest committed against the wrong planting with no one
// watching. Those are not comparable, so this does not treat them as a tunable.
//
// UNITS ARE NOT INVENTED HERE. Every unit this returns is a member of HARVEST_UNITS / WEIGHT_UNITS,
// which is a genuinely load-bearing feasibility finding rather than a convenience: the units Dave
// speaks out loud ("count", "grams") are already literally the app's own vocabulary, so the mapping
// is a rename, not a new taxonomy.
import { HARVEST_UNITS, WEIGHT_UNITS, MAX_PLAUSIBLE, MAX_PLAUSIBLE_WEIGHT_G } from './harvest-constants.js'

// Exact-match command vocabulary. Kept SMALL on purpose: every token added here is a word that can
// no longer be the whole of a search utterance.
//
// DISJOINTNESS — what is actually checked, corrected 2026-08-27. This previously claimed the set is
// "checked against the live crop and variety vocabulary by the test file". It is not: the test
// checks a hardcoded 28-name array. A crucible seat swept 2,742 distinct tokens across four bundled
// corpora and found no true collision (its one apparent hit, `repeat`, is a `harvest_habit` enum
// value, not a crop name), so disjointness HOLDS today — but it holds by luck of the current data,
// not by a guard. It cannot cover the uncoverable case at all: a PLANTING NAME is free text with no
// vocabulary file, so a planting Dave names "next" would collide with a save.
// The guard that would actually cover it belongs at the call site, not here: do not treat a
// whole-utterance command match as a command while the chooser's live result set contains an exact
// name match for that same text.
// FOUR VERBS WERE REMOVED 2026-08-27, not deferred. `undo`, `cancel`, `scratch that` and `repeat`
// all shipped classified-but-unwired, and two of them were actively dangerous:
//
//   `undo`/`cancel` -> `discard` is a SEMANTIC TRAP. After a save the row is committed server-side
//   and the form has reset, so the moment anyone says "undo" is the moment they just noticed a bad
//   save — and this would have discarded the NEXT, BLANK record while the mistake stayed saved.
//   The word that means "fix my mistake" did the opposite of the user's intent at the only moment
//   they would ever say it, and produced no error. The app already has the right mechanism
//   (`undoSessionRow`, a per-row undo on the harvest session ledger); when undo returns it must
//   point THERE, as its own slice with its own test.
//
//   `repeat` -> `read_back` contradicted the design's own non-goal: spoken read-back was explicitly
//   ruled out, yet saying "read it back" still classified as a command and did nothing.
//
// Removing them also widens the search vocabulary back — every token here is a word that can no
// longer be the whole of a spoken crop name.
export const COMMANDS = {
  next: 'save_and_advance',
  save: 'save',
  done: 'finish',
  stop: 'finish',
  clear: 'clear_field',
}

// Multi-word command phrases, matched exactly like the single tokens above. "scratch that" earns its
// place because it is what people actually say mid-dictation; it is not a synonym anyone would utter
// as a crop name.
export const COMMAND_PHRASES = {
  'start over': 'clear_field',
  'next one': 'save_and_advance',
  'save and next': 'save_and_advance',
}

// V5-HARVESTVOICEFLOW-001 — recogniser mishears of a COMMAND word, routed to `unparsed` rather than
// falling through to the search branch.
//
// MEASURED, not anticipated. Dave ran the continuous probe on his Android 2026-08-28 (round-trip
// simulation OFF, so the timings are clean): he spoke "next" nine times, eight were heard correctly
// and committed as save_and_advance via tick, and ONE came back as "text" — which is not a command,
// so classify() returned `search "text"` and it committed via sessionEnd. That is an ~11% rate on
// the only device that matters, and the failure is worse than a dropped word: a dropped command does
// nothing and you repeat it, whereas this performs a DIFFERENT action and looks like it worked.
//
// WHY unparsed AND NOT save_and_advance. Mapping a mishear onto a write is the dangerous direction,
// and this file already says so at the search branch: "a wrong search shows the wrong list, which
// Dave sees and corrects, whereas a wrong command or a wrong number is committed silently." A
// near-miss is exactly the case where confidence is lowest, so it must not commit a row. `unparsed`
// is the honest "didn't catch that" and costs one repeated word.
//
// WHY NOT AN EDIT-DISTANCE RULE, which is the obvious general fix and is UNSAFE HERE:
//   save ←1→ SAGE  — a crop type Dave grows (2 cultivars, 2 live plantings on prod).
//   stop ←1→ top,  done ←1→ bone/dose/dune,  next ←1→ nest/neat.
// A distance-1 rule would swallow a legitimate search for sage. So this is a curated list of
// OBSERVED mishears, exactly the pattern NUMBER_WORDS below already follows and for the same stated
// reason — "these are NOT general-purpose homophone handling". Add an entry only when a device log
// shows it, and never add a word that could be a crop, a variety or a unit.
export const COMMAND_NEAR_MISSES = new Set([
  'text', // "next", observed 1/9 on Android Chrome, 2026-08-28 probe run
])

// Spoken-unit → canonical unit. Both directions of the harvest vocabulary live here: HARVEST_UNITS
// (the quantity axis) and WEIGHT_UNITS (the measured-weight axis) overlap on the mass units, and
// which axis an utterance lands on is decided by the unit, not by field order — see classify().
export const UNIT_ALIASES = {
  gram: 'g', grams: 'g', gramme: 'g', grammes: 'g', g: 'g',
  kilogram: 'kg', kilograms: 'kg', kilo: 'kg', kilos: 'kg', kg: 'kg', kgs: 'kg',
  pound: 'lb', pounds: 'lb', lb: 'lb', lbs: 'lb',
  ounce: 'oz', ounces: 'oz', oz: 'oz',
  count: 'count', counts: 'count', each: 'count', piece: 'count', pieces: 'count',
  bunch: 'bunch', bunches: 'bunch',
  cup: 'cup', cups: 'cup',
  head: 'head', heads: 'head',
}

// Number words 0-20 + tens, plus the homophones Dave named explicitly ("to/two/too") and the ones
// that recur in the same position. These are NOT general-purpose homophone handling: each entry is a
// word that a recogniser plausibly emits where a NUMBER was spoken, in a slot where the following
// token is a unit. "for 4" is safe here for the same reason it would be reckless in free text — it
// only ever fires immediately before a unit word.
const NUMBER_WORDS = {
  zero: 0, oh: 0,
  one: 1, won: 1,
  two: 2, to: 2, too: 2,
  three: 3, tree: 3,
  four: 4, for: 4, fore: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8, ate: 8,
  nine: 9,
  ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  dozen: 12,
}

const SCALES = { hundred: 100, thousand: 1000 }

// Fractional words, for "half a pound" / "a quarter pound". Deliberately only the two that occur in
// kitchen/garden speech; anything else falls through to unparsed rather than being approximated.
const FRACTIONS = { half: 0.5, quarter: 0.25, third: 1 / 3 }

// Filler that carries no value and would otherwise break an otherwise-clean parse. "a" and "an" are
// the load-bearing ones ("a dozen", "half a pound").
const FILLER = new Set(['a', 'an', 'and', 'of', 'the', 'about', 'roughly', 'like', 'um', 'uh'])

// Lowercase, strip punctuation, collapse whitespace. Punctuation matters because Chrome's recogniser
// inserts commas and full stops into dictated numbers ("231, grams") and a naive split would then
// see "231," as a non-number.
//
// A FULL STOP BETWEEN TWO DIGITS IS A DECIMAL POINT AND IS PRESERVED. Found by the test suite, not
// by inspection: the first version of this function stripped it unconditionally, so "1.2 kilograms"
// normalised to "1 2 kilograms", parseNumber summed the pair, and the utterance came back as THREE
// kilograms — a silently wrong weight, off by 2.5x, with every field looking filled and plausible.
// That is precisely the failure mode this grammar exists to make impossible, reached through the
// most innocuous line in the file. The same guard covers the comma as a decimal separator, which the
// recogniser also emits.
export function normalise(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/(\d)[.,](\d)/g, '$1<dec>$2')   // park a real decimal separator
    .replace(/[.,!?;:]/g, ' ')
    .replace(/<dec>/g, '.')                   // and restore it
    .replace(/\s+/g, ' ')
    .trim()
}

// BUG-VOICEDUPE-00x class: the recogniser has three times shipped a single spoken word DOUBLED
// ("Chinese" -> "Chinese Chinese"). The fix landed in the transcript layer, but continuous mode
// re-runs that machinery per utterance for a whole session, so this parser refuses to depend on the
// transcript being clean. Collapsing an IMMEDIATE whole-token repeat is safe in this grammar
// specifically because no legal utterance here repeats a token adjacently: no unit doubles, no
// command doubles, and no crop in the vocabulary is a doubled word. It is NOT safe as a general
// text transform and is not exported as one.
export function collapseAdjacentDupes(tokens) {
  const out = []
  for (const t of tokens) if (out[out.length - 1] !== t) out.push(t)
  return out
}

// Word-sequence → number. Handles "two hundred thirty one", "twelve", "1.2", "231".
// Returns null when the sequence is not cleanly a number — never a partial or best-guess value,
// because a wrong quantity that looks right is the failure this whole flow has to avoid.
export function parseNumber(tokens) {
  if (tokens.length === 0) return null

  // Digit form, including decimals, is taken verbatim when the WHOLE sequence is one digit token.
  if (tokens.length === 1 && /^\d+(\.\d+)?$/.test(tokens[0])) return Number(tokens[0])

  // SPOKEN DECIMAL — "one point two kilos". Handled explicitly rather than left to fall through to
  // null: it is a natural way to say a weight and the recogniser emits the word "point" rather than
  // a separator, so without this the utterance is refused and Dave has to rephrase mid-flow. The
  // fractional side is read DIGIT BY DIGIT ("one point two five" -> 1.25), which is how the number
  // is actually spoken; summing those tokens the way the integer side does would give 1.7.
  const pointAt = tokens.findIndex(t => t === 'point' || t === 'decimal')
  if (pointAt >= 0) {
    const whole = parseNumber(tokens.slice(0, pointAt))
    const fracToks = tokens.slice(pointAt + 1).filter(t => !FILLER.has(t))
    if (whole == null || !Number.isInteger(whole) || fracToks.length === 0) return null
    let digits = ''
    for (const t of fracToks) {
      if (/^\d+$/.test(t)) { digits += t; continue }
      const n = NUMBER_WORDS[t]
      // Only single digits are legal after the point; "one point twenty" is not a number anyone
      // means, so refuse rather than invent an interpretation.
      if (n == null || n > 9) return null
      digits += String(n)
    }
    const value = Number(`${whole}.${digits}`)
    return Number.isFinite(value) ? value : null
  }

  let total = 0
  let current = 0
  let seenAny = false
  let fraction = 0

  for (const tok of tokens) {
    if (FILLER.has(tok)) continue

    if (Object.prototype.hasOwnProperty.call(FRACTIONS, tok)) {
      fraction += FRACTIONS[tok]
      seenAny = true
      continue
    }
    if (Object.prototype.hasOwnProperty.call(SCALES, tok)) {
      // "hundred" with nothing before it means one hundred ("a hundred grams").
      current = (current === 0 ? 1 : current) * SCALES[tok]
      if (SCALES[tok] >= 1000) { total += current; current = 0 }
      seenAny = true
      continue
    }
    if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, tok)) {
      current += NUMBER_WORDS[tok]
      seenAny = true
      continue
    }
    if (/^\d+(\.\d+)?$/.test(tok)) {
      current += Number(tok)
      seenAny = true
      continue
    }
    // Any token that is neither filler, number, scale nor fraction disqualifies the whole sequence.
    return null
  }

  if (!seenAny) return null
  const value = total + current + fraction
  return Number.isFinite(value) ? value : null
}

/**
 * Classify one utterance from a continuous recognition session.
 *
 * Returns one of:
 *   { kind: 'command',  command, transcript }
 *   { kind: 'quantity', value, unit, transcript }        unit ∈ HARVEST_UNITS
 *   { kind: 'weight',   value, unit, grams, transcript } unit ∈ WEIGHT_UNITS
 *   { kind: 'search',   text, transcript }               free text for the picker
 *   { kind: 'unparsed', reason, transcript }
 *
 * `implausible` is set (rather than the result being rejected) when the value parses but exceeds the
 * server's own CHECK bound: the caller should confirm rather than discard, because the likeliest
 * cause is a misheard digit and the user is standing right there able to say it again.
 */
export function classify(raw) {
  const transcript = String(raw ?? '')
  const text = normalise(transcript)
  if (!text) return { kind: 'unparsed', reason: 'empty', transcript }

  // COMMANDS FIRST, EXACT WHOLE-UTTERANCE ONLY. A phrase is a command iff the entire normalised
  // utterance is a command token/phrase — "next" fires, "next to the fence" does not, and neither
  // does "cucumber next". This is the rule that keeps a save from being triggered by a search term.
  if (Object.prototype.hasOwnProperty.call(COMMAND_PHRASES, text)) {
    return { kind: 'command', command: COMMAND_PHRASES[text], transcript }
  }
  if (Object.prototype.hasOwnProperty.call(COMMANDS, text)) {
    return { kind: 'command', command: COMMANDS[text], transcript }
  }

  // NEAR-MISS OF A COMMAND — refuse rather than search. Placed immediately after the exact command
  // checks so a real command can never be intercepted, and before everything else so the mishear
  // cannot be re-read as a search term. See COMMAND_NEAR_MISSES for the device measurement and for
  // why this is a curated list rather than an edit-distance rule (save ←1→ sage, a crop Dave grows).
  if (COMMAND_NEAR_MISSES.has(text)) {
    return { kind: 'unparsed', reason: 'near-command', transcript }
  }

  const tokens = collapseAdjacentDupes(text.split(' ').filter(Boolean))

  // VALUE + UNIT. The unit is found as the LAST token that is a known unit alias; everything before
  // it must parse cleanly as a number. Anchoring on the trailing unit rather than scanning for a
  // leading number is what makes "two hundred thirty one grams" work without a grammar.
  const lastIdx = tokens.length - 1
  const unitTok = tokens[lastIdx]
  const unit = Object.prototype.hasOwnProperty.call(UNIT_ALIASES, unitTok) ? UNIT_ALIASES[unitTok] : null

  if (unit) {
    const value = parseNumber(tokens.slice(0, lastIdx))
    if (value == null) {
      // A bare unit with no number ("grams") is a real thing people say when correcting a unit, but
      // this parser will not guess which number it belongs to.
      return { kind: 'unparsed', reason: 'unit-without-number', transcript }
    }
    if (value <= 0) return { kind: 'unparsed', reason: 'non-positive', transcript }

    // WHICH AXIS. A mass unit is ambiguous by construction — 'g','kg','lb','oz' are in BOTH lists,
    // and Dave's flow says "three count" then "231 grams", i.e. the quantity axis takes the counting
    // unit and the weight axis takes the mass unit. So: mass unit -> weight, everything else ->
    // quantity. This resolves the ambiguity by VOCABULARY rather than by field order, which matters
    // because a continuous session cannot rely on the two utterances arriving in order.
    if (WEIGHT_UNITS.includes(unit)) {
      const grams = unit === 'g' ? value
        : unit === 'kg' ? value * 1000
        : unit === 'lb' ? value * 453.592
        : value * 28.3495
      return {
        kind: 'weight', value, unit, grams,
        implausible: grams > MAX_PLAUSIBLE_WEIGHT_G,
        transcript,
      }
    }
    if (HARVEST_UNITS.includes(unit)) {
      return {
        kind: 'quantity', value, unit,
        implausible: value > (MAX_PLAUSIBLE[unit] ?? Infinity),
        transcript,
      }
    }
  }

  // Everything else is a search term for the planting chooser — the one branch that is permissive,
  // and safely so: a wrong search shows the wrong list, which Dave sees and corrects, whereas a
  // wrong command or a wrong number is committed silently.
  return { kind: 'search', text, transcript }
}
