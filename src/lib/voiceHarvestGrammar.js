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

  // BUG-VOICENUMSUM-001, GUARD 1 OF 2 — A DIGIT LITERAL IS ATOMIC.
  // Dave has plantings NAMED after numbers (one is literally "1884"), and the utterance that reaches
  // here is everything before the trailing unit — so the NAME arrives as a number token sitting in
  // front of the quantity. "1884 two count" parsed as 1884 + 2 and SAVED 1886 count, reporting
  // success; "1884 165 grams" saved 2049 g. Neither trips MAX_PLAUSIBLE, so nothing downstream
  // catches it. A silent wrong save is the one outcome this grammar exists to prevent.
  // A spoken digit run like "231" is a COMPLETE number, and English never composes two of them
  // additively — "1884 two" is two numbers, not one. So a digit literal may be the whole sequence and
  // nothing else. The cost is that a mixed form like "5 hundred" is now refused rather than read as
  // 500; that is the safe direction (an `unparsed` costs one repeated phrase) and it is speculative
  // anyway, whereas the four failures above were MEASURED against Dave's real plantings.
  const valueToks = tokens.filter((t) => !FILLER.has(t))
  if (valueToks.length > 1 && valueToks.some((t) => /^\d+(\.\d+)?$/.test(t))) return null

  let total = 0
  let current = 0
  let seenAny = false
  let fraction = 0
  // BUG-VOICENUMSUM-001, GUARD 2 OF 2 — magnitude of the previous ADDITIVE component. See below.
  let lastAdd = null

  for (const tok of tokens) {
    if (FILLER.has(tok)) continue

    if (Object.prototype.hasOwnProperty.call(FRACTIONS, tok)) {
      const v = FRACTIONS[tok]
      if (lastAdd !== null && v >= lastAdd) return null
      fraction += v
      lastAdd = v
      seenAny = true
      continue
    }
    if (Object.prototype.hasOwnProperty.call(SCALES, tok)) {
      // "hundred" with nothing before it means one hundred ("a hundred grams").
      current = (current === 0 ? 1 : current) * SCALES[tok]
      if (SCALES[tok] >= 1000) { total += current; current = 0 }
      // A scale MULTIPLIES rather than adds, so it is not itself subject to the descent rule — but it
      // resets the ceiling for what may follow it: "two hundred thirty one" is 200 then 30 then 1.
      lastAdd = SCALES[tok]
      seenAny = true
      continue
    }
    if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, tok)) {
      const v = NUMBER_WORDS[tok]
      // BUG-VOICENUMSUM-001, GUARD 2 OF 2 — COMPONENTS MUST STRICTLY DESCEND.
      // A well-formed English cardinal falls monotonically: "twenty three" (20>3), "two hundred
      // thirty one" (200>30>1). "eighteen eighty four" does NOT — 18 then 80 ascends — because it is
      // a NAME read in year-form, not a cardinal. Summing it gave 18+80+4+2 = 104 count for
      // "eighteen eighty four two count", and 267 g for the weight form. Guard 1 cannot catch these:
      // there is no digit literal in the utterance at all, every token is a legitimate number word,
      // and only the ORDER reveals that two separate numbers were spoken.
      if (lastAdd !== null && v >= lastAdd) return null
      current += v
      lastAdd = v
      seenAny = true
      continue
    }
    if (/^\d+(\.\d+)?$/.test(tok)) {
      // Reachable only as the single value token — Guard 1 rejects a digit literal in any longer
      // sequence, and the whole-sequence fast path above already returned for the bare form.
      current += Number(tok)
      lastAdd = Number(tok)
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

// BUG-VOICENUMWORD-001 — the number words a NAME is spoken with, and ONLY the canonical spellings.
//
// Deliberately NOT NUMBER_WORDS. That map carries recogniser homophones (to/too/won/for/fore/ate/
// tree/oh) and its own comment scopes them explicitly: "it only ever fires immediately before a unit
// word". A planting name is not that slot. Folding them here would rewrite "tomato to table" into
// "tomato 2 table" and, worse, would do it in the branch where the chooser is already lost — so the
// homophones stay out, and `dozen` with them (nobody names a bed "dozen" and means 12).
const NAME_NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}

/**
 * BUG-VOICENUMWORD-001 — spoken number WORDS → the digit string a planting is actually named with.
 *
 * Nine of Dave's live plantings carry digits in their name (1884, Super Sweet 100, Super Sweet 100
 * Rescue, Danvers 126 Carrot, Clemson Spineless 80, Chinese 5-Color, Alaska Mix Nasturtium 1, Cherry
 * Rescue 1, Fairway Orange Coleus Clone 1). Chrome dictates those digits as WORDS, so "eighteen
 * eighty four" reached a name stored as "1884" not at all — zero hits, and saying it again more
 * clearly never helps, because the recogniser was never wrong.
 *
 * THIS IS NOT parseNumber AND MUST NOT BE MERGED INTO IT. A name is read the way a YEAR is read: in
 * groups, CONCATENATED — "eighteen eighty four" is 18|84 = "1884", "one twenty six" is 1|26 = "126".
 * A cardinal is SUMMED — "two hundred thirty one" is 231. Running the cardinal parser over a name
 * yields 18+80+4 = 102, which is exactly how BUG-VOICENUMSUM-001 read it and is wrong in a different
 * direction. The two grammars share ONE rule and nothing else: the group boundary below.
 *
 * GROUP BOUNDARY: a group ends when the next word is NOT strictly smaller than the last one added to
 * it — the same monotonic property parseNumber now uses to reject an ascending sequence. That is why
 * "eighty four" stays one group (4 < 80) while "eighteen eighty" splits (80 >= 18).
 *
 * Edit distance cannot substitute for this. Session gardening-c2 measured its fuzzy scorer over these
 * exact cases against Dave's real 239 plantings: "eighteen eighty four" scores 0.353 against
 * *helichrysum*, nowhere near 1884. A bare digit name is unreachable from number words by any string
 * metric, because they share no characters — folding is the only mechanism that spans the gap.
 *
 * Returns the text with number-word runs folded; unchanged when there is nothing to fold.
 */
export function foldNumberWords(text) {
  const toks = normalise(text).split(' ').filter(Boolean)
  const out = []
  let groups = []
  let cur = null
  let lastAdd = null

  const closeGroup = () => {
    if (cur !== null) groups.push(String(cur))
    cur = null
    lastAdd = null
  }
  const flushRun = () => {
    closeGroup()
    if (groups.length) { out.push(groups.join('')); groups = [] }
  }

  for (const t of toks) {
    if (Object.prototype.hasOwnProperty.call(SCALES, t)) {
      cur = (cur === null ? 1 : cur) * SCALES[t]
      lastAdd = SCALES[t]
      continue
    }
    if (Object.prototype.hasOwnProperty.call(NAME_NUMBER_WORDS, t)) {
      const v = NAME_NUMBER_WORDS[t]
      if (lastAdd !== null && v >= lastAdd) closeGroup()
      cur = (cur === null ? 0 : cur) + v
      lastAdd = v
      continue
    }
    flushRun()
    out.push(t)
  }
  flushRun()
  return out.join(' ')
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
/**
 * A value and a canonical unit → the quantity/weight result the caller stores.
 *
 * WHICH AXIS. A mass unit is ambiguous by construction — 'g','kg','lb','oz' are in BOTH lists, and
 * Dave's flow says "three count" then "231 grams", i.e. the quantity axis takes the counting unit
 * and the weight axis takes the mass unit. So: mass unit -> weight, everything else -> quantity.
 * This resolves the ambiguity by VOCABULARY rather than by field order, which matters because a
 * continuous session cannot rely on the two utterances arriving in order.
 *
 * EXTRACTED FROM classify() rather than copied, and that is the point. BUG-VOICECOUNTSPLIT-001 adds
 * a SECOND way to reach a value — a number and a unit that arrived as two separate utterances —
 * and a second copy of the axis rule is a second place for `lb` to drift onto the wrong field.
 * There is one implementation and both callers reach it.
 *
 * Returns null for a unit in neither list, which classify() then falls through to `search`.
 */
export function buildValue(value, unit, transcript = '') {
  if (WEIGHT_UNITS.includes(unit)) {
    const grams = unit === 'g' ? value
      : unit === 'kg' ? value * 1000
      : unit === 'lb' ? value * 453.592
      : value * 28.3495
    return { kind: 'weight', value, unit, grams, implausible: grams > MAX_PLAUSIBLE_WEIGHT_G, transcript }
  }
  if (HARVEST_UNITS.includes(unit)) {
    return { kind: 'quantity', value, unit, implausible: value > (MAX_PLAUSIBLE[unit] ?? Infinity), transcript }
  }
  return null
}

/**
 * BUG-VOICECOUNTSPLIT-001 — the two HALVES of a value that arrived as separate utterances.
 *
 * THE DEFECT, measured on 2026-08-31 by replaying the real debouncer. Chrome sometimes ends the
 * recogniser session BETWEEN the number and the unit, and VoiceHarvest's `onend` flushes data
 * immediately (that asymmetry is deliberate and correct — see voiceCommitDebounce sessionEnd). So
 * "three count" arrives as "three" then "count", and each half is separately useless:
 *
 *   "three" -> classify() says `search`, because a bare number carries no unit. Against Dave's real
 *              239 live plantings the search branch is SUBSTRING-permissive, so "two" selects
 *              *Brentwood* Leaf Lettuce, "four" selects Marvel of *Four* Seasons, "2" selects
 *              Danvers 1*2*6 Carrot — the count is lost AND the chosen planting is silently
 *              replaced, so the following "next" saves against the wrong plant. v4.83.0's
 *              foldNumberWords widened this from 5 to 8 of 19 tested numbers (five -> Chinese
 *              5-Color, six and twelve -> Danvers 126).
 *   "count" -> `unparsed`/unit-without-number. Nothing at all.
 *
 * WHY A SEPARATE FUNCTION AND NOT A NEW classify() KIND. classify() is whole-utterance and
 * stateless, and it must stay that way — it is what makes a command match provable. Pairing halves
 * needs memory ACROSS utterances, which is host state. So the grammar answers only the stateless
 * question ("is this utterance nothing but a number, or nothing but a unit?") and the host owns the
 * holding. classify()'s contract is untouched.
 *
 * THE HOST MUST GATE THE NUMBER ON A PLANTING BEING SELECTED. Before a plant is chosen a bare
 * number can legitimately be a search; after one is chosen it can only be an amount. That gate is
 * what makes suppressing the search safe, and it is the caller's to enforce — stated here because
 * this function cannot see it.
 *
 * A MULTI-WORD NAME-SHAPED NUMBER IS DELIBERATELY NOT A NUMBER HERE. "eighteen eighty four" (the
 * planting named 1884) fails parseNumber's monotonic rule and so returns null from this function
 * too, falling through to the search branch where foldNumberWords already resolves it. The two
 * mechanisms do not overlap and must not.
 *
 * Returns { kind: 'number', value } | { kind: 'unit', unit } | null.
 */
export function classifyPartial(raw) {
  const text = normalise(raw)
  if (!text) return null
  // A command is a command. Checked first so a hold can never eat "next", "save" or "stop" — the
  // one class of utterance where being swallowed costs a save rather than a repeated word.
  if (Object.prototype.hasOwnProperty.call(COMMAND_PHRASES, text)) return null
  if (Object.prototype.hasOwnProperty.call(COMMANDS, text)) return null
  if (COMMAND_NEAR_MISSES.has(text)) return null

  const tokens = collapseAdjacentDupes(text.split(' ').filter(Boolean))
  const meaningful = tokens.filter((t) => !FILLER.has(t))
  if (meaningful.length === 0) return null

  // BARE UNIT — "count", "counts", "a count", "grams". Exactly one meaningful token and it is a unit.
  if (meaningful.length === 1
      && Object.prototype.hasOwnProperty.call(UNIT_ALIASES, meaningful[0])) {
    return { kind: 'unit', unit: UNIT_ALIASES[meaningful[0]] }
  }

  // BARE NUMBER — no unit anywhere in the utterance, and the whole thing parses as one cardinal.
  // The no-unit check is what keeps this from firing on something classify() already handles.
  if (meaningful.some((t) => Object.prototype.hasOwnProperty.call(UNIT_ALIASES, t))) return null
  const value = parseNumber(tokens)
  if (value == null || !(value > 0)) return null
  return { kind: 'number', value }
}

/**
 * V5-VOICEONEBREATH-001 — "Big Boy, two count, fifteen grams" as ONE utterance.
 *
 * Dave's flow was specified as separate utterances with pauses and he speaks it as a sentence. Today
 * that returns `unparsed`/ambiguous-number: classify() anchors on the LAST token being a unit and
 * requires everything before it to be a number, so a leading NAME disqualifies the whole phrase.
 *
 * THE REASON THIS IS NOT JUST "SPLIT ON THE UNITS", and the trap the ledger row names ("one-breath
 * parsing is exactly where a leading name-number does the most damage"): nine of Dave's live
 * plantings are NAMED with digits, and Chrome dictates those digits as words. In
 *
 *     eighteen eighty four | two | count | one sixty five | grams
 *
 * every token before "count" is a number word, so a backward walk cannot see where the NAME ends and
 * the COUNT begins. Taking the longest run that parses gives "eighty four two" = 86; taking the
 * shortest gives 2. Both are defensible from the string alone, and one of them is a silently wrong
 * harvest — which is precisely BUG-VOICENUMSUM-001 re-entered through a new door.
 *
 * SO THE STRING IS NOT ASKED TO DECIDE. This returns every split the grammar considers legal, in
 * NAME-LONGEST-FIRST order, and the caller resolves them against the live planting vocabulary —
 * closed-set selection, the same reframe that fixed V5-VOICEFUZZYMATCH-001. A candidate whose name
 * half matches exactly one planting is the answer; if none does, or if two disagree, the caller
 * refuses and asks for the parts separately. The grammar has no vocabulary and must not pretend to.
 *
 * Every candidate is `{ name, values }` where `values` are already built quantity/weight results.
 * A candidate is legal only when: the name is non-empty (a nameless phrase is classify()'s job and
 * is left alone), every number group parses cleanly on its own, and every unit resolves. One bad
 * group refuses the WHOLE utterance rather than yielding a partial record — a half-applied one-breath
 * sentence is a record that looks complete and is not.
 *
 * Returns [] for anything that is not a multi-part utterance, which is the overwhelming majority.
 */
export function segmentCandidates(raw) {
  const text = normalise(raw)
  if (!text) return []
  // A command is a command, checked first for the same reason classifyPartial checks it first.
  if (Object.prototype.hasOwnProperty.call(COMMAND_PHRASES, text)) return []
  if (Object.prototype.hasOwnProperty.call(COMMANDS, text)) return []
  if (COMMAND_NEAR_MISSES.has(text)) return []

  const tokens = collapseAdjacentDupes(text.split(' ').filter(Boolean))
  const unitAt = []
  for (let i = 0; i < tokens.length; i++) {
    if (Object.prototype.hasOwnProperty.call(UNIT_ALIASES, tokens[i])) unitAt.push(i)
  }
  if (unitAt.length === 0) return []
  // A unit must be the last token of its group; a trailing word after the final unit means this is
  // prose, not a record ("three count of cucumber" is not a shape anyone dictates).
  if (unitAt[unitAt.length - 1] !== tokens.length - 1) return []

  // GROUPS AFTER THE FIRST are fully determined — their number tokens are exactly what lies between
  // the previous unit and this one, with no choice to make. Any that fails to parse refuses the
  // whole utterance, because a partially-understood sentence must not become a partial record.
  const tailValues = []
  for (let g = 1; g < unitAt.length; g++) {
    const from = unitAt[g - 1] + 1
    const to = unitAt[g]
    const value = parseNumber(tokens.slice(from, to))
    if (value == null || !(value > 0)) return []
    const built = buildValue(value, UNIT_ALIASES[tokens[to]], text)
    if (!built) return []
    tailValues.push(built)
  }

  // THE FIRST GROUP is the only ambiguous one, because the name sits in front of it. Split points
  // are enumerated NAME-LONGEST-FIRST: the prior is that a speaker says as much of the name as they
  // can, so the shortest number run is the likeliest reading — but the caller, not this order,
  // decides, and it decides by asking the vocabulary.
  const u0 = unitAt[0]
  // NO NAME, NOTHING TO DISAMBIGUATE. If the entire run before the first unit parses as one clean
  // cardinal then there is no name in front of it — "two hundred thirty one grams" — and classify()
  // already reads it correctly. Without this guard the split enumeration happily offers a name of
  // "two hundred thirty" carrying a weight of 1 g, which is a wrong reading of a phrase that was
  // never ambiguous. Measured: it produced exactly that.
  if (parseNumber(tokens.slice(0, u0)) != null) return []

  const firstUnit = UNIT_ALIASES[tokens[u0]]
  const out = []
  for (let k = u0 - 1; k >= 1; k--) {
    const numToks = tokens.slice(k, u0)
    const value = parseNumber(numToks)
    if (value == null || !(value > 0)) continue
    const built = buildValue(value, firstUnit, text)
    if (!built) continue
    out.push({ name: tokens.slice(0, k).join(' '), values: [built, ...tailValues] })
  }
  return out
}

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
    const numToks = tokens.slice(0, lastIdx)
    const value = parseNumber(numToks)
    if (value == null) {
      // WHICH failure this was matters to the caller, because the two need opposite advice.
      // "grams" alone is a bare unit — the user says it when correcting a unit and the fix is to say
      // a number. "1884 two count" is the BUG-VOICENUMSUM-001 shape — the user said a planting NAME
      // and a quantity in one breath, and the fix is to split them. Reporting the second as
      // "unit-without-number" would be actively false: there were two numbers, not none. Without the
      // distinction the UI can only say "didn't catch that", and Dave repeats the same phrase forever
      // because nothing tells him the name is being read as part of the count.
      const numeric = (t) => /^\d/.test(t)
        || Object.prototype.hasOwnProperty.call(NUMBER_WORDS, t)
        || Object.prototype.hasOwnProperty.call(SCALES, t)
        || Object.prototype.hasOwnProperty.call(FRACTIONS, t)
      if (numToks.some(numeric)) {
        return { kind: 'unparsed', reason: 'ambiguous-number', transcript }
      }
      // A bare unit with no number ("grams") is a real thing people say when correcting a unit, but
      // this parser will not guess which number it belongs to.
      return { kind: 'unparsed', reason: 'unit-without-number', transcript }
    }
    if (value <= 0) return { kind: 'unparsed', reason: 'non-positive', transcript }

    const built = buildValue(value, unit, transcript)
    if (built) return built
  }

  // Everything else is a search term for the planting chooser — the one branch that is permissive,
  // and safely so: a wrong search shows the wrong list, which Dave sees and corrects, whereas a
  // wrong command or a wrong number is committed silently.
  return { kind: 'search', text, transcript }
}

// ── V5-VOICEONEBREATH-002 / BUG-VOICETRAILCMD-001 ────────────────────────────────────────────────
//
// SPLIT A TRAILING COMMAND OFF A COMPLETE RECORD. Dave's actual cadence is one breath —
// "cucumber, three count, two thirty one grams, next" — and until now that sentence did not merely
// fail to save, it was DESTRUCTIVE. Measured on this file before the fix:
//
//   "cucumber three count 231 grams"       -> segmentCandidates: name=cucumber, 3 count, 231 g  ✓
//   "cucumber three count 231 grams next"  -> classify: SEARCH, segmentCandidates: NONE          ✗
//   "231 grams next"                       -> classify: SEARCH                                   ✗
//
// The one-breath reader in VoiceHarvest is hooked on `unparsed`, so appending "next" flipped the
// classification to `search`, skipped the reader entirely, and ran a planting search for the literal
// string "cucumber three count 231 grams next". The count and the weight were silently discarded.
// That is why "next" reads as "not heard at all" — it is not a recogniser problem in that case, and
// no amount of re-speaking it helps, because the phrase is being consumed by the search branch.
//
// WHY THIS DOES NOT REOPEN THE HOLE classify() CLOSES. classify()'s whole-utterance rule exists so a
// SEARCH TERM can never trigger a save — its examples are "next to the fence" and "cucumber next".
// Both still refuse here, because the split is gated on the HEAD ALREADY BEING A RECORD:
//   - "next to the fence" — trailing token is "fence", not a command. No split.
//   - "cucumber next"     — head "cucumber" carries no value, so it is a search, not a record. No split.
// Only a head that independently parses as name+values or as a bare quantity/weight may carry a
// trailing command. A save still cannot be conjured out of prose.
//
// A TRAILING NEAR-MISS APPLIES THE RECORD AND REFUSES THE COMMAND. "231 grams text" (the measured
// 1-in-9 Android mishear of "next") returns the head with `command: null`. The values are kept —
// they were spoken clearly and throwing them away is the lost-log failure this page exists to
// prevent — while the save is refused, which is the same asymmetry COMMAND_NEAR_MISSES already
// encodes: a wrong search is visible and correctable, a wrong commit is silent.
export function splitTrailingCommand(raw) {
  const text = normalise(raw)
  if (!text) return null
  // A whole-utterance command is not a split: classify() owns it and must keep owning it.
  if (Object.prototype.hasOwnProperty.call(COMMAND_PHRASES, text)) return null
  if (Object.prototype.hasOwnProperty.call(COMMANDS, text)) return null
  if (COMMAND_NEAR_MISSES.has(text)) return null

  const tokens = text.split(' ').filter(Boolean)
  if (tokens.length < 2) return null

  // Longest trailing phrase first, so "save and next" is not read as a bare trailing "next".
  let head = null
  let command
  let nearCommand = false
  for (let take = 3; take >= 1; take--) {
    if (take >= tokens.length) continue
    const tail = tokens.slice(tokens.length - take).join(' ')
    if (take > 1 && Object.prototype.hasOwnProperty.call(COMMAND_PHRASES, tail)) {
      head = tokens.slice(0, tokens.length - take).join(' '); command = COMMAND_PHRASES[tail]; break
    }
    if (take === 1 && Object.prototype.hasOwnProperty.call(COMMANDS, tail)) {
      head = tokens.slice(0, tokens.length - 1).join(' '); command = COMMANDS[tail]; break
    }
    if (take === 1 && COMMAND_NEAR_MISSES.has(tail)) {
      head = tokens.slice(0, tokens.length - 1).join(' '); command = null; nearCommand = true; break
    }
  }
  if (head == null || !head) return null

  // THE GATE. The head must already be a record on its own terms — never a search, never prose.
  const headKind = classify(head).kind
  const isRecord = headKind === 'quantity' || headKind === 'weight'
    || segmentCandidates(head).length > 0
    || parseValueSequence(head) != null
  if (!isRecord) return null

  return { head, command, nearCommand, transcript: String(raw ?? '') }
}

// ── V5-VOICEONEBREATH-002 — the NAMELESS value sequence ──────────────────────────────────────────
//
// "three count, two thirty one grams" with a planting ALREADY SELECTED. This is the exact complement
// of segmentCandidates(): that function refuses a run with no name in front of it, deliberately and
// for a measured reason (without the guard it offered a name of "two hundred thirty" carrying 1 g).
// So the nameless case had no reader at all and classify() returned `unparsed: ambiguous-number` —
// meaning that even WITHOUT a trailing "next", saying the count and the weight in one breath lost
// both. Dave's cadence makes this the common case, not the edge one: he says the crop, pauses, then
// says the two numbers together, and Chrome ends the session at the pause — so the utterance that
// reaches us is routinely the nameless one.
//
// The parse is unambiguous precisely BECAUSE there is no name: every unit closes a group, and every
// group's number run is exactly what lies between the previous unit and this one. Nothing is being
// guessed. Refuse the whole utterance if any group fails, for the same reason segmentCandidates
// does — a partially-understood sentence must not become a partial record.
export function parseValueSequence(raw) {
  const text = normalise(raw)
  if (!text) return null
  const tokens = collapseAdjacentDupes(text.split(' ').filter(Boolean))
  const unitAt = []
  for (let i = 0; i < tokens.length; i++) {
    if (Object.prototype.hasOwnProperty.call(UNIT_ALIASES, tokens[i])) unitAt.push(i)
  }
  // Two or more groups only. A single group is classify()'s quantity/weight branch and must stay
  // there so its implausibility warning, haptic and announcement are not duplicated here.
  if (unitAt.length < 2) return null
  if (unitAt[unitAt.length - 1] !== tokens.length - 1) return null
  // NO NAME is the precondition, not an accident: the run before the first unit must itself be a
  // clean cardinal. If it is not, a name is present and segmentCandidates owns the utterance.
  if (parseNumber(tokens.slice(0, unitAt[0])) == null) return null

  const values = []
  let from = 0
  for (const to of unitAt) {
    const value = parseNumber(tokens.slice(from, to))
    if (value == null || !(value > 0)) return null
    const built = buildValue(value, UNIT_ALIASES[tokens[to]], text)
    if (!built) return null
    values.push(built)
    from = to + 1
  }
  // One value per axis. "two count three count" is a correction spoken badly, not two quantities,
  // and silently keeping the last would commit a number Dave did not mean to be final.
  if (new Set(values.map((v) => v.kind)).size !== values.length) return null
  return values
}
