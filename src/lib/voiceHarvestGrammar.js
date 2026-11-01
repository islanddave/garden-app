// src/lib/voiceHarvestGrammar.js
//
// Spoken harvest grammar (BD-068 investigation, V5-HARVESTVOICEFLOW-001). Deliberately UNWIRED: only its
// test file and the /admin/voice-debug probe import it. The tests are the finding on whether a spoken
// value-plus-unit ("three count", "231 grams") maps reliably onto the existing fields.
//
// Flow under test: say a crop name, pause while the picker searches, then (mic still on) a count, a
// weight, and "next", which saves and opens the next planting chooser.
//
// Hard rule: A COMMAND MUST NEVER BE INFERRED FROM A PHRASE THAT COULD BE DATA, because `next` is a SAVE
// and a silent wrong save is worse than a slow form. So:
//   - a command matches only on an EXACT whole-utterance token match after normalisation;
//   - anything else is data, and data that does not parse cleanly returns `unparsed`, never a guess.
// A mumbled "next" then does nothing and is repeated; the opposite asymmetry commits a harvest against
// the wrong planting with no one watching.
//
// Units are not invented here: every unit returned is a member of HARVEST_UNITS / WEIGHT_UNITS.
import { HARVEST_UNITS, WEIGHT_UNITS, MAX_PLAUSIBLE, MAX_PLAUSIBLE_WEIGHT_G } from './harvest-constants.js'

// Exact-match command vocabulary. Kept SMALL on purpose: every token here can no longer be the whole of
// a search utterance.
//
// Disjointness from crop and variety names holds today only because of the current data; nothing
// checks it against the live vocabulary. A PLANTING NAME is free text, so one named "next" would
// collide with a save. The real guard belongs at the call site: do not treat a whole-utterance command
// match as a command while the chooser's live results contain an exact name match for the same text.
//
// `undo`, `cancel`, `scratch that` and `repeat` are deliberately absent:
//   - `undo`/`cancel` -> `discard` is a semantic trap. After a save the row is committed and the form
//     has reset, so "undo" would discard the NEXT, BLANK record while the mistake stayed saved. Undo
//     must point at `undoSessionRow` (per-row undo on the session ledger), as its own slice.
//   - `repeat` -> `read_back` contradicted the design's non-goal of spoken read-back.
export const COMMANDS = {
  next: 'save_and_advance',
  save: 'save',
  done: 'finish',
  stop: 'finish',
  clear: 'clear_field',
}

// Multi-word command phrases, matched exactly like the single tokens above.
export const COMMAND_PHRASES = {
  'start over': 'clear_field',
  'next one': 'save_and_advance',
  'save and next': 'save_and_advance',
}

// Recogniser mishears of a COMMAND word, routed to `unparsed` instead of falling through to search.
// A mishear that fell to search performed a DIFFERENT action (it committed) and looked like it worked,
// unlike a dropped word, which does nothing and is repeated.
//
// `unparsed` and not save_and_advance: mapping a mishear onto a write is the dangerous direction, and a
// near-miss is where confidence is lowest.
//
// Not an edit-distance rule, which would swallow legitimate searches (save/sage, a crop type;
// stop/top; done/bone/dose/dune; next/nest/neat). This is a curated list of OBSERVED mishears, like
// NUMBER_WORDS below. Add an entry only when a device log shows it, and never a word that could be a
// crop, a variety or a unit.
export const COMMAND_NEAR_MISSES = new Set([
  'text', // mishear of "next" (Android Chrome)
])

// Spoken unit -> canonical unit. HARVEST_UNITS (quantity axis) and WEIGHT_UNITS (weight axis) overlap
// on the mass units; the unit, not field order, decides the axis (see buildValue).
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

// Number words 0-20 plus tens, plus recogniser homophones of numbers (to/too, for, tree...). These are
// NOT general homophone handling: each entry fires only where a number was spoken and the next token
// is a unit, which is why "for 4" is safe here and reckless in free text.
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

// Fractional words, for "half a pound" / "a quarter pound". Anything else falls through to unparsed
// rather than being approximated.
const FRACTIONS = { half: 0.5, quarter: 0.25, third: 1 / 3 }

// Filler that carries no value and would otherwise break a clean parse. "a" and "an" are load-bearing
// ("a dozen", "half a pound").
const FILLER = new Set(['a', 'an', 'and', 'of', 'the', 'about', 'roughly', 'like', 'um', 'uh'])

// Lowercase, strip punctuation, collapse whitespace. Chrome inserts commas and full stops into
// dictated numbers ("231, grams"), which a naive split would read as a non-number.
//
// A full stop or comma BETWEEN TWO DIGITS is a decimal point and is preserved. Stripping it turned
// "1.2 kilograms" into "1 2 kilograms", which parseNumber summed to 3 kg: a silently wrong weight.
export function normalise(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/(\d)[.,](\d)/g, '$1<dec>$2')   // park a real decimal separator
    .replace(/[.,!?;:]/g, ' ')
    .replace(/<dec>/g, '.')                   // and restore it
    .replace(/\s+/g, ' ')
    .trim()
}

// The recogniser has shipped a single spoken word DOUBLED ("Chinese Chinese", BUG-VOICEDUPE-00x), and
// continuous mode re-runs the transcript layer per utterance, so this parser does not trust the
// transcript to be clean. Collapsing an immediate token repeat is safe only because no legal utterance
// here repeats a token adjacently. Do not reuse it as a general text transform.
export function collapseAdjacentDupes(tokens) {
  const out = []
  for (const t of tokens) if (out[out.length - 1] !== t) out.push(t)
  return out
}

// Word-sequence -> number ("two hundred thirty one", "twelve", "1.2", "231"). Returns null unless the
// sequence is cleanly ONE number, never a partial or best-guess value: a wrong quantity that looks
// right is the failure this flow must avoid.
export function parseNumber(tokens) {
  if (tokens.length === 0) return null

  // Digit form, including decimals, is taken verbatim when the WHOLE sequence is one digit token.
  if (tokens.length === 1 && /^\d+(\.\d+)?$/.test(tokens[0])) return Number(tokens[0])

  // Spoken decimal ("one point two kilos"): the recogniser emits the word "point". The fractional side
  // is read digit by digit ("one point two five" -> 1.25); summing it like the integer side gives 1.7.
  const pointAt = tokens.findIndex(t => t === 'point' || t === 'decimal')
  if (pointAt >= 0) {
    const whole = parseNumber(tokens.slice(0, pointAt))
    const fracToks = tokens.slice(pointAt + 1).filter(t => !FILLER.has(t))
    if (whole == null || !Number.isInteger(whole) || fracToks.length === 0) return null
    let digits = ''
    for (const t of fracToks) {
      if (/^\d+$/.test(t)) { digits += t; continue }
      const n = NUMBER_WORDS[t]
      // Only single digits are legal after the point; refuse "one point twenty" rather than invent a
      // reading.
      if (n == null || n > 9) return null
      digits += String(n)
    }
    const value = Number(`${whole}.${digits}`)
    return Number.isFinite(value) ? value : null
  }

  // BUG-VOICENUMSUM-001, GUARD 1 OF 2: A DIGIT LITERAL IS ATOMIC.
  // Plantings can be NAMED with numbers (e.g. "1884"), and the name arrives as a number token in front
  // of the quantity: "1884 two count" would sum to 1886 and save. That is below MAX_PLAUSIBLE, so
  // nothing downstream catches it. English never composes two numbers additively, so a digit literal
  // may be the whole sequence and nothing else. A mixed form like "5 hundred" is refused, the safe
  // direction (an `unparsed` costs one repeated phrase).
  const valueToks = tokens.filter((t) => !FILLER.has(t))
  if (valueToks.length > 1 && valueToks.some((t) => /^\d+(\.\d+)?$/.test(t))) return null

  let total = 0
  let current = 0
  let seenAny = false
  let fraction = 0
  // Guard 2 state: magnitude of the previous ADDITIVE component.
  let lastAdd = null
  // V5-VOICEVOCAB-001, GUARD 3 state: the previous token when it was itself a number WORD, else null.
  let prevWord = null

  for (const tok of tokens) {
    if (FILLER.has(tok)) continue

    if (Object.prototype.hasOwnProperty.call(FRACTIONS, tok)) {
      const v = FRACTIONS[tok]
      if (lastAdd !== null && v >= lastAdd) return null
      fraction += v
      lastAdd = v
      prevWord = null
      seenAny = true
      continue
    }
    if (Object.prototype.hasOwnProperty.call(SCALES, tok)) {
      // "hundred" with nothing before it means one hundred ("a hundred grams").
      current = (current === 0 ? 1 : current) * SCALES[tok]
      if (SCALES[tok] >= 1000) { total += current; current = 0 }
      // A scale multiplies, so the descent rule does not apply to it, but it resets the ceiling for what
      // follows ("two hundred thirty one" is 200, then 30, then 1).
      lastAdd = SCALES[tok]
      prevWord = null
      seenAny = true
      continue
    }
    if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, tok)) {
      const v = NUMBER_WORDS[tok]
      // BUG-VOICENUMSUM-001, GUARD 2 OF 2: COMPONENTS MUST STRICTLY DESCEND.
      // A well-formed cardinal falls monotonically ("twenty three", "two hundred thirty one").
      // "eighteen eighty four" ascends (18 then 80): it is a NAME read in year-form, and summing it
      // saved 104 count. Guard 1 cannot catch it (no digit literal, every token a real number word);
      // only the ORDER shows that two numbers were spoken.
      if (lastAdd !== null && v >= lastAdd) return null
      // V5-VOICEVOCAB-001, GUARD 3: TWO NUMBER WORDS IN A ROW ADD ONLY AS TENS + UNITS.
      // Descending is necessary, not sufficient: "ten five" and "five two" descend, so guard 2 summed
      // them, and a bare number now saves as an amount ("ten five" then "next" wrote 15 count). English
      // composes two adjacent number words one way, tens then units ("twenty five"); any other pair is
      // two numbers said together, and this parser returns one number or nothing. A scale multiplies and
      // starts a fresh group.
      if (prevWord !== null && !(prevWord >= 20 && prevWord <= 90 && prevWord % 10 === 0 && v >= 1 && v <= 9)) {
        return null
      }
      current += v
      lastAdd = v
      prevWord = v
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

// BUG-VOICENUMWORD-001: the number words a NAME is spoken with, canonical spellings ONLY.
//
// Deliberately NOT NUMBER_WORDS: its homophones (to/too/won/for/fore/ate/tree/oh) only fire before a
// unit, and a planting name is not that slot. Folding them would rewrite "tomato to table" into
// "tomato 2 table". `dozen` stays out too (nobody names a bed "dozen" and means 12).
const NAME_NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}

/**
 * BUG-VOICENUMWORD-001: spoken number WORDS -> the digit string a planting is named with. Chrome
 * dictates name digits as words ("eighteen eighty four" for a planting named "1884"), so the name was
 * unreachable.
 *
 * NOT parseNumber, AND MUST NOT BE MERGED INTO IT. A name is read like a YEAR: in groups,
 * CONCATENATED ("eighteen eighty four" = 18|84 = "1884"). A cardinal is SUMMED (231), and running the
 * cardinal parser over a name gives 102. The grammars share one rule, the group boundary: a group ends
 * when the next word is NOT strictly smaller than the last one added ("eighty four" is one group,
 * "eighteen eighty" splits).
 *
 * Edit distance cannot substitute: a bare digit name shares no characters with its number words, so
 * folding is the only mechanism that spans the gap.
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
 * V5-VOICEVOCAB-001: is this phrase made of NOTHING BUT numbers (digit literals, NAME_NUMBER_WORDS,
 * scales)? Such a phrase ("2", "1884", "eighteen eighty four") may match a planting name by EXACT
 * equality only, never by the substring or fuzzy layers: "2" is a substring of Danvers 126, and
 * offering it as a name switched the crop in a one-breath utterance. The NUMBER_WORDS homophones
 * (to/for/tree) are not numbers here: "peach tree" is a name.
 */
export function isNumberPhrase(raw) {
  const toks = normalise(raw).split(' ').filter(Boolean)
  return toks.length > 0 && toks.every((t) => /^\d+(\.\d+)?$/.test(t)
    || Object.prototype.hasOwnProperty.call(NAME_NUMBER_WORDS, t)
    || Object.prototype.hasOwnProperty.call(SCALES, t))
}

/**
 * A value and a canonical unit -> the quantity/weight result the caller stores.
 *
 * The axis is decided by VOCABULARY, not field order: mass units ('g', 'kg', 'lb', 'oz') are in BOTH
 * lists, and a continuous session cannot rely on utterances arriving in order. Mass unit -> weight,
 * everything else -> quantity. One implementation shared by classify() and the split-utterance paths,
 * so the axis rule cannot drift.
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
 * BUG-VOICECOUNTSPLIT-001: the two HALVES of a value that arrived as separate utterances.
 *
 * Chrome sometimes ends the recogniser session BETWEEN number and unit, and VoiceHarvest's `onend`
 * flushes data immediately (deliberate; see voiceCommitDebounce sessionEnd), so "three count" arrives
 * as "three" then "count". "three" alone is a `search`, and the search branch is substring-permissive
 * ("two" matches Brentwood Leaf Lettuce, "2" matches Danvers 126), so the count is lost AND the chosen
 * planting is silently replaced, and the following "next" saves against the wrong plant. "count" alone
 * is `unparsed`.
 *
 * A separate function, not a classify() kind: classify() is whole-utterance and stateless, which is
 * what makes a command match provable. Pairing halves needs memory across utterances, which is host
 * state, so the grammar answers only the stateless question (nothing but a number, or nothing but a
 * unit) and the host owns the holding.
 *
 * THE HOST MUST GATE THE NUMBER ON A PLANTING BEING SELECTED: before a plant is chosen a bare number
 * can legitimately be a search. This function cannot see that gate.
 *
 * A multi-word name-shaped number ("eighteen eighty four") is deliberately NOT a number here: it fails
 * parseNumber's monotonic rule and falls through to the search branch, where foldNumberWords resolves
 * it. The two mechanisms must not overlap.
 *
 * Returns { kind: 'number', value } | { kind: 'unit', unit } | null.
 */
export function classifyPartial(raw) {
  const text = normalise(raw)
  if (!text) return null
  // Commands first, so a hold can never swallow "next", "save" or "stop" (that costs a save, not a
  // repeated word).
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
 * V5-VOICEONEBREATH-001: "Big Boy, two count, fifteen grams" as ONE utterance. classify() anchors on
 * the LAST token being a unit and requires everything before it to be a number, so a leading NAME made
 * it `unparsed`/ambiguous-number.
 *
 * NOT JUST "SPLIT ON THE UNITS". Plantings named with digits are dictated as number words, so in
 *
 *     eighteen eighty four | two | count | one sixty five | grams
 *
 * a backward walk cannot see where the NAME ends and the COUNT begins. The longest parsing run gives
 * "eighty four two" = 86, the shortest gives 2, and one of them is a silently wrong harvest
 * (BUG-VOICENUMSUM-001 through a new door).
 *
 * So the string is not asked to decide. This returns every split the grammar considers legal, in
 * NAME-LONGEST-FIRST order, and the caller resolves them against the live planting vocabulary
 * (closed-set selection, as in V5-VOICEFUZZYMATCH-001). A candidate whose name half matches exactly one
 * planting is the answer; if none does, or two disagree, the caller refuses and asks for the parts
 * separately. The grammar has no vocabulary and must not pretend to.
 *
 * Every candidate is `{ name, values }` with `values` already built quantity/weight results. A
 * candidate is legal only when the name is non-empty (a nameless phrase is classify()'s job), every
 * number group parses cleanly on its own, and every unit resolves. One bad group refuses the WHOLE
 * utterance: a half-applied sentence is a record that looks complete and is not.
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

  // GROUPS AFTER THE FIRST are fully determined: their number tokens are exactly what lies between the
  // previous unit and this one. Any that fails to parse refuses the whole utterance.
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

  // THE FIRST GROUP is the only ambiguous one, because the name sits in front of it. Split points are
  // enumerated NAME-LONGEST-FIRST (a speaker says as much of the name as they can), but the caller
  // decides, by asking the vocabulary.
  const u0 = unitAt[0]
  // NO NAME, NOTHING TO DISAMBIGUATE. If everything before the first unit parses as one clean cardinal
  // ("two hundred thirty one grams"), there is no name and classify() already reads it correctly.
  // Without this guard the enumeration offers a name of "two hundred thirty" carrying 1 g.
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

/**
 * Classify one utterance from a continuous recognition session. Whole-utterance and stateless.
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
 * cause is a misheard digit.
 */
export function classify(raw) {
  const transcript = String(raw ?? '')
  const text = normalise(transcript)
  if (!text) return { kind: 'unparsed', reason: 'empty', transcript }

  // COMMANDS FIRST, EXACT WHOLE-UTTERANCE ONLY. A phrase is a command iff the entire normalised
  // utterance is a command token/phrase: "next" fires, "next to the fence" and "cucumber next" do not.
  // This keeps a save from being triggered by a search term.
  if (Object.prototype.hasOwnProperty.call(COMMAND_PHRASES, text)) {
    return { kind: 'command', command: COMMAND_PHRASES[text], transcript }
  }
  if (Object.prototype.hasOwnProperty.call(COMMANDS, text)) {
    return { kind: 'command', command: COMMANDS[text], transcript }
  }

  // NEAR-MISS OF A COMMAND: refuse rather than search. Checked right after the exact command checks (a
  // real command can never be intercepted) and before everything else (the mishear cannot be re-read
  // as a search term). See COMMAND_NEAR_MISSES for why this is a curated list.
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
      // The two failures need opposite advice. "grams" alone is a bare unit: say a number. "1884 two
      // count" is the BUG-VOICENUMSUM-001 shape, a planting NAME plus a quantity in one breath: split
      // them. Calling it "unit-without-number" would be false (there were two numbers), and the UI could
      // only say "didn't catch that".
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
// SPLIT A TRAILING COMMAND OFF A COMPLETE RECORD. One-breath speech ("cucumber, three count, two
// thirty one grams, next") is DESTRUCTIVE without this split: appending "next" makes classify() return
// SEARCH instead of `unparsed`, which skips the one-breath reader and runs a planting search for the whole
// string, silently discarding the count and weight. Re-speaking never helps.
//
// This does not reopen the hole classify()'s whole-utterance rule closes (a SEARCH TERM must never
// trigger a save), because the split is gated on the HEAD ALREADY BEING A RECORD:
//   - "next to the fence": trailing token is "fence", not a command. No split.
//   - "cucumber next": head carries no value, so it is a search. No split.
// Only a head that independently parses as name+values or as a bare quantity/weight may carry a
// trailing command.
//
// A trailing NEAR-MISS applies the record and refuses the command ("231 grams text" returns the head
// with `command: null`): spoken values are kept, the save is refused, the same asymmetry as
// COMMAND_NEAR_MISSES.
// The command a final ENDS with, if any, and how many tokens it takes. Longest trailing phrase first,
// so "save and next" is not read as a bare trailing "next". A command that is the whole utterance is
// not a trailing one (`take` must leave a head), because classify() owns that case.
function trailingCommandOf(tokens) {
  for (let take = 3; take >= 1; take--) {
    if (take >= tokens.length) continue
    const tail = tokens.slice(tokens.length - take).join(' ')
    if (take > 1 && Object.prototype.hasOwnProperty.call(COMMAND_PHRASES, tail)) {
      return { take, command: COMMAND_PHRASES[tail], nearCommand: false }
    }
    if (take === 1 && Object.prototype.hasOwnProperty.call(COMMANDS, tail)) {
      return { take, command: COMMANDS[tail], nearCommand: false }
    }
    if (take === 1 && COMMAND_NEAR_MISSES.has(tail)) return { take, command: null, nearCommand: true }
  }
  return null
}

const isWholeCommand = (text) => Object.prototype.hasOwnProperty.call(COMMAND_PHRASES, text)
  || Object.prototype.hasOwnProperty.call(COMMANDS, text)
  || COMMAND_NEAR_MISSES.has(text)

export function splitTrailingCommand(raw) {
  const text = normalise(raw)
  if (!text) return null
  // A whole-utterance command is not a split: classify() owns it and must keep owning it.
  if (isWholeCommand(text)) return null

  const tokens = text.split(' ').filter(Boolean)
  if (tokens.length < 2) return null

  const tail = trailingCommandOf(tokens)
  if (!tail) return null
  const head = tokens.slice(0, tokens.length - tail.take).join(' ')
  const { command, nearCommand } = tail

  // THE GATE. The head must already be a record on its own terms — never a search, never prose.
  const headKind = classify(head).kind
  const isRecord = headKind === 'quantity' || headKind === 'weight'
    || segmentCandidates(head).length > 0
    || parseValueSequence(head) != null
  // OR A RECORD SAID WITHOUT (ALL OF) ITS UNITS: "165 next", "suyo long 2 165 next" (V5-VOICEVOCAB-001).
  // Marked `bare`: whether such a head IS a record depends on state this function cannot see (is a
  // planting selected? which reading does the vocabulary support?), so the page routes a bare head ONLY
  // through its one-breath reader, never down the old split path (which would search the head and then
  // save whatever record was standing). The mark is also what the commit debouncer reads: a one-breath
  // final that writes claims the same one-write cooldown as a bare "next", so a re-delivered final
  // (BUG-VOICEDUPE-001..005) cannot save twice. "cucumber next" and "next to the fence" still refuse: a
  // head with no number has no reading.
  const bare = !isRecord && (oneBreathReadings(raw)?.readings.length ?? 0) > 0
  if (!isRecord && !bare) return null

  return { head, command, nearCommand, transcript: String(raw ?? ''), ...(bare ? { bare: true } : {}) }
}

// ── V5-VOICEVOCAB-001 (lane D4): a one-breath record said WITHOUT (all of) its units ───────────────
//
// "planting 2 165" for "planting 2 count 165 grams". BUG-VOICETWOBARENUM-001 handles it when the parts
// arrive as separate finals; this handles one final. Without it such a final was a planting SEARCH that
// matched nothing, cleared the crop and dropped the numbers, and "ten five" was held as 15 and saved.
//
// A final is `[name] values [command]`, values being one or two GROUPS (a number with or without a
// unit), at least one WITHOUT a unit (an all-unit final belongs to segmentCandidates /
// parseValueSequence / classify). The name/values boundary is the hazard: some plantings carry a digit
// or number word in an alias (1884, Super Sweet 100, Danvers 126), so "super sweet 100 3 200" is either
// "super sweet 100" + 3, 200 or "super sweet" + 100, 3, 200. As in segmentCandidates, every split point
// is returned and the CALLER decides against the vocabulary and the current selection; this function
// has neither.
//
// Returns null when the final is not this shape (no number at its end; an all-unit record; a lone
// number with no name and no command, which classifyPartial owns). Otherwise:
//   { head, nameless, command, nearCommand, readings: [{ name, groups: [{ value, unit, text }] }],
//     badRun, overfull }
// `nameless`: the whole head is numbers (a refusal must not clear the crop). `badRun`: a number-word
// run that is not ONE cardinal ("ten five"), refused by the caller rather than summed. `overfull`: a
// nameless head with more amounts than a record has slots ("2 165 7").
const RUN_WORD = (t) => Object.prototype.hasOwnProperty.call(NAME_NUMBER_WORDS, t)
  || Object.prototype.hasOwnProperty.call(SCALES, t)
const DIGIT_TOKEN = (t) => /^\d+(\.\d+)?$/.test(t)

// Read tokens as consecutive value groups, NUMBER [UNIT]. A digit literal is one number (guard 1); a
// run of number words must be ONE cardinal or the whole run is `bad`. Anything else → null.
function parseValueRun(toks) {
  const groups = []
  let i = 0
  while (i < toks.length) {
    let j
    let value
    if (DIGIT_TOKEN(toks[i])) {
      value = Number(toks[i]); j = i + 1
    } else if (RUN_WORD(toks[i])) {
      j = i + 1
      while (j < toks.length
        && (RUN_WORD(toks[j]) || (toks[j] === 'and' && j + 1 < toks.length && RUN_WORD(toks[j + 1])))) j++
      value = parseNumber(toks.slice(i, j))
      if (value == null) return { bad: true }
    } else {
      return null
    }
    if (!(value > 0)) return null
    let unit = null
    if (j < toks.length && Object.prototype.hasOwnProperty.call(UNIT_ALIASES, toks[j])) {
      unit = UNIT_ALIASES[toks[j]]; j++
    }
    groups.push({ value, unit, text: toks.slice(i, j).join(' ') })
    i = j
  }
  return { groups }
}

export function oneBreathReadings(raw) {
  const text = normalise(raw)
  if (!text || isWholeCommand(text)) return null
  const all = text.split(' ').filter(Boolean)
  const tail = trailingCommandOf(all)
  const head = tail ? all.slice(0, all.length - tail.take) : all
  // The doubled-word defect (BUG-VOICEDUPE-00x) is collapsed for WORDS only. Two equal numbers stay
  // two tokens: whether they are one number heard twice is decided below, as a value, not as text.
  const toks = []
  for (const t of head) {
    const prev = toks[toks.length - 1]
    if (prev === t && !DIGIT_TOKEN(t) && !RUN_WORD(t)) continue
    toks.push(t)
  }

  // The value tail: the longest suffix made of numbers, number words, units and an "and" inside a
  // number-word run. The name, if any, is everything before some split point inside it.
  let s = toks.length
  while (s > 0) {
    const t = toks[s - 1]
    if (DIGIT_TOKEN(t) || RUN_WORD(t) || Object.prototype.hasOwnProperty.call(UNIT_ALIASES, t)) { s--; continue }
    if (t === 'and' && s >= 2 && RUN_WORD(toks[s - 2]) && s < toks.length && RUN_WORD(toks[s])) { s--; continue }
    break
  }
  if (s === toks.length) return null
  // One number and nothing else is a held number, and classifyPartial already owns it — including
  // with filler in front ("a hundred", "about 165").
  if (!tail && classifyPartial(toks.join(' '))?.kind === 'number') return null

  // Filler carries no identity, so it is never part of a name: "a hundred next" is nameless, and
  // "suyo long about 165" names Suyo Long.
  const nameOf = (k) => {
    const n = toks.slice(0, k)
    while (n.length && FILLER.has(n[n.length - 1])) n.pop()
    while (n.length && FILLER.has(n[0])) n.shift()
    return n.join(' ')
  }
  const readings = []
  let badRun = false
  let overfull = false
  for (let k = s; k < toks.length; k++) {
    const run = parseValueRun(toks.slice(k))
    if (!run) continue
    if (run.bad) { badRun = true; continue }
    // The same bare number twice in a row is ONE number (BUG-VOICETWOBARENUM-001's equality rule for
    // separate finals, applied inside one final): a doubled "165" is not a count and a weight.
    const groups = []
    for (const g of run.groups) {
      const prev = groups[groups.length - 1]
      if (prev && prev.unit == null && g.unit == null && prev.value === g.value) continue
      groups.push(g)
    }
    if (!groups.some((g) => g.unit == null)) continue          // all units: the existing readers own it
    // A record has two slots. Three amounts in one breath do not say which one is extra, so the
    // nameless form is flagged for a refusal rather than read by guessing which to drop.
    if (groups.length > 2) { if (k === s && nameOf(s) === '') overfull = true; continue }
    const axes = groups.filter((g) => g.unit).map((g) => buildValue(g.value, g.unit)?.kind)
    if (axes.some((a) => !a) || new Set(axes).size !== axes.length) continue
    readings.push({ name: nameOf(k), groups })
  }
  if (!readings.length && !badRun && !overfull) return null
  return {
    head: toks.join(' '), nameless: nameOf(s) === '',
    command: tail?.command ?? null, nearCommand: !!tail?.nearCommand,
    readings, badRun, overfull,
  }
}

// The words NUMBER_WORDS maps to a number only because a recogniser mishears them — "to" for two,
// "tree" for three. They are names in their own right ("Peach tree"), so the one-breath reader never
// counts them as numbers; the caller uses this to notice when one sits where a number could have been.
export const NUMBER_HOMOPHONES = { won: 1, to: 2, too: 2, tree: 3, for: 4, fore: 4, ate: 8 }

// ── V5-VOICEONEBREATH-002: the NAMELESS value sequence ───────────────────────────────────────────
//
// "three count, two thirty one grams" with a planting ALREADY SELECTED: the complement of
// segmentCandidates(), which refuses a run with no name in front of it. Without this reader classify()
// returned `unparsed: ambiguous-number`, losing both values when count and weight are said in one
// breath (the common case: Chrome ends the session at the pause after the crop name).
//
// The parse is unambiguous precisely BECAUSE there is no name: every unit closes a group, and each
// group's number run is what lies between the previous unit and this one. Any failing group refuses
// the whole utterance, as in segmentCandidates.
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
