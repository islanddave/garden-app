// V5-VOICECARE-001: spoken BULK care commands, e.g. "water all bag area" and "fed all pasture in ground
// except zephyr, crimson sweet, king richard".
//
// PURE AND STATELESS, like voiceHarvestGrammar.js and for the same reason: the host owns every decision
// that needs memory or data. This file answers one question, "is this utterance a care command, and what
// are its parts?", and resolves NOTHING: it does not know what plantings exist, so it cannot say whether
// "bag area" names anything or whether "zephyr" matched. Resolution, the count read-back and the write
// live in the host.
//
// ── WHY VERB-FIRST, AND WHY THAT BREAKS AN EXISTING RULE ────────────────────────────────────────
//
// voiceHarvestGrammar's classify() matches a command ONLY on an exact WHOLE utterance, which stops a
// search term triggering a save ("next to the fence" does not fire). A care command deliberately breaks
// that: it is an utterance that merely STARTS with a reserved verb, followed by arbitrary text. That was
// measured (project-state/voice-divider-word-analysis-20260914.md): across the 849 live searchable
// tokens (crop types and variety names) exactly ONE begins with a care verb, "Watermelon". `weed`
// appears only mid-token (Milkweed, Horseweed, Tweedia), which token-0 anchoring makes unreachable.
//
// NO TERMINAL DIVIDER WORD, by decision. A candidate like "go" collides with 36 of those 849 tokens
// (Begonia, Dragon Roll, French Tarragon, ...) and the search branch is substring-permissive, so each is
// a live path to selecting the wrong planting. "done" and "stop" are already bound to `finish`. And the
// recogniser ALREADY delimits: Chrome ends a session at every pause, so a terminal word duplicates a
// free boundary and adds a token that can be misheard. The utterance boundary is the delimiter.
//
// ── THE ASYMMETRY THAT SHAPES EVERY REFUSAL BELOW ───────────────────────────────────────────────
//
// Harvest voice may be permissive because a wrong harvest row is ONE row, visible in the session ledger
// and correctable. A bulk care command writes MANY rows and over-application is SILENT (watering the
// whole area when three were excluded looks exactly like success, because the excluded plants simply
// look watered). So this grammar refuses far more eagerly than classify() does, and every refusal
// carries a reason the host can say out loud.

import { BATCH_EVENT_TYPES } from './eventTypes.js'

// Spoken verb -> event_type, past and present tense both. Values MUST be batch-legal: ILLEGAL_CARE_TYPES
// below must be empty, and voiceCareGrammar.test.js is the guard.
//
// moisture_check is ABSENT ON PURPOSE and must never be added. It sits in BATCH_EXCLUDED_TYPES because
// "none of these 500 need water" is a fabricated observation (see MOISTURE_CHECK_EVENT in careNeeded.js),
// and a spoken bulk command is exactly the bulk affordance that rule forbids.
export const CARE_VERBS = {
  water: 'watering',
  watered: 'watering',
  watering: 'watering',
  feed: 'fertilizing',
  fed: 'fertilizing',
  feeding: 'fertilizing',
  fertilize: 'fertilizing',
  fertilized: 'fertilizing',
  mulch: 'mulched',
  mulched: 'mulched',
  weed: 'weeded',
  weeded: 'weeded',
}

// DERIVED, never hand-listed (the rule eventTypes.js states for BATCH_EVENT_TYPES itself). A verb whose
// type is not batch-legal is a bug in this file, not a case to handle at runtime.
export const CARE_EVENT_TYPES = [...new Set(Object.values(CARE_VERBS))]
export const ILLEGAL_CARE_TYPES = CARE_EVENT_TYPES.filter((t) => !BATCH_EVENT_TYPES.includes(t))

// The exclusion opener: "except" plus the paraphrases most likely to come out instead. Multi-word forms
// are checked before single so "but not" cannot be read as a scope word followed by a separate "not".
const EXCEPT_PHRASES = ['apart from', 'other than', 'but not', 'except for', 'except', 'excluding']

// COMMAS SURVIVE normalise, unlike in voiceHarvestGrammar, because here they are DATA: they are the
// only reliable boundary in a spoken list of names. Everything else punctuation-shaped still goes.
const LIST_SEPARATORS = /\s*(?:,|\band\b)\s*/

function normalise(raw) {
  return String(raw ?? '').toLowerCase().replace(/[^\p{L}\p{N},\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Classify an utterance as a bulk care command.
 *
 * Returns null for anything that is not one: null means "not my shape", NOT "invalid", so the caller
 * falls through to its ordinary handling. A REFUSAL is different, { kind: 'care_refused', reason },
 * because the utterance clearly WAS a care command and could not be trusted. Silence on those would be
 * the lost-log failure this flow exists to prevent.
 *
 *   { kind: 'care', eventType, verb, scope, exclusions[], transcript }
 *   { kind: 'care_refused', reason, transcript }
 *   null
 */
export function classifyCareCommand(raw) {
  const transcript = String(raw ?? '')
  const text = normalise(transcript)
  if (!text) return null

  const tokens = text.split(' ').filter(Boolean)
  const verb = tokens[0]
  if (!Object.prototype.hasOwnProperty.call(CARE_VERBS, verb)) return null

  // THE WATERMELON GUARD, the single measured verb-initial collision in the vocabulary. "watermelon" is
  // ONE token so token-0 anchoring already defeats it; this covers Chrome splitting it as "water melon".
  // A curated bound, not a heuristic, for the reason COMMAND_NEAR_MISSES states: never a general rule that
  // could swallow a crop.
  if (verb === 'water' && tokens[1] === 'melon') return null

  const eventType = CARE_VERBS[verb]
  const rest = tokens.slice(1).join(' ')

  // A BARE VERB IS NOT A COMMAND. "water" alone has no scope, and defaulting it to everything is the
  // over-application failure in its purest form; it is also what a one-word mishear produces.
  if (!rest) return { kind: 'care_refused', reason: 'no-scope', transcript }

  // WORD-BOUNDARY MATCH, not space-padded indexOf: padding misses the phrase at either end of the string,
  // and "water except zephyr" and "water all bag area except" are precisely the two shapes that MUST refuse.
  let scope = rest
  let exclusionText = null
  for (const phrase of EXCEPT_PHRASES) {
    const m = rest.match(new RegExp(`(?:^|\\s)${phrase}(?:\\s|$)`))
    if (!m) continue
    scope = rest.slice(0, m.index).trim()
    exclusionText = rest.slice(m.index + m[0].length).trim()
    break
  }

  // "water except zephyr": an exclusion with nothing to exclude FROM. Refused rather than read as
  // "everything except", the most destructive reading of a misheard utterance.
  if (!scope) return { kind: 'care_refused', reason: 'no-scope', transcript }

  // "water all bag area except": the speaker was cut off, or the names were lost to a session boundary
  // (routine, since Chrome ends a session at every pause). Applying the scope without the exclusions is
  // the silent over-application this grammar exists to prevent: it would water the plants that were to be
  // skipped, and look like success.
  if (exclusionText === '') return { kind: 'care_refused', reason: 'empty-exclusion-list', transcript }

  // THE GRAMMAR CANNOT SPLIT AN UNPUNCTUATED LIST. Chrome rarely punctuates, so "zephyr crimson sweet king
  // richard" arrives as four bare tokens that could be one name, two, three or four ("crimson sweet" is
  // itself a two-word cultivar). Splitting on whitespace would invent boundaries; refusing outright would
  // reject the natural example. So: split on EXPLICIT separators only, and when there are none but the
  // text is multi-word, hand the raw text back with `ambiguousList` set for the HOST to resolve against the
  // real planting names (closed-set matching, the same reframe that rescued rare cultivar names).
  let exclusions = []
  let ambiguousList = false
  if (exclusionText) {
    exclusions = exclusionText.split(LIST_SEPARATORS).map((s) => s.trim()).filter(Boolean)
    ambiguousList = exclusions.length === 1 && exclusionText.split(' ').length > 1
  }

  return { kind: 'care', eventType, verb, scope, exclusionText, exclusions, ambiguousList, transcript }
}
