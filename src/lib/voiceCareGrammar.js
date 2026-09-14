// V5-VOICECARE-001 — spoken BULK care commands: "water all bag area",
// "fed all pasture in ground except zephyr, crimson sweet, king richard".
//
// PURE AND STATELESS, like voiceHarvestGrammar.js and for the same reason: the host owns every
// decision that needs memory or data. This file answers one question — "is this utterance a care
// command, and what are its parts?" — and resolves NOTHING. It does not know what plantings exist,
// so it cannot tell you whether "bag area" names anything or whether "zephyr" matched. Resolution,
// the count read-back and the write all live in the host.
//
// ── WHY VERB-FIRST, AND WHY THAT BREAKS AN EXISTING RULE ────────────────────────────────────────
//
// voiceHarvestGrammar's classify() matches a command ONLY on an exact WHOLE utterance — that rule is
// what stops a search term triggering a save ("next to the fence" does not fire). A care command
// deliberately breaks it: it is an utterance that merely STARTS with a reserved verb, with arbitrary
// text after it. That needs justifying rather than assuming, so it was measured
// (project-state/voice-divider-word-analysis-20260914.md): across the 849 live searchable tokens
// (163 crop_types slug/display_name/search_aliases + 494 plant_varieties.name, read from prod Neon)
// exactly ONE begins with a care verb — "Watermelon". `weed` appears only mid-token (Milkweed,
// Horseweed, Tweedia), which token-0 anchoring makes unreachable.
//
// NO TERMINAL DIVIDER WORD, by decision (Dave, 2026-09-14). The candidate he proposed, "go",
// collides with 36 of those 849 tokens (Begonia, Dragon Roll, French Tarragon, Gatherer's Gold …)
// and the search branch is substring-permissive, so each is a live path to selecting the wrong
// planting. "done" and "stop" are already bound to `finish`. More fundamentally the recogniser
// ALREADY delimits: Chrome ends a session at every pause (~20 re-arms in 54 s on the 2026-09-13
// device trace), so a terminal word duplicates a boundary we get free and adds a token that can be
// misheard. The utterance boundary is the delimiter.
//
// ── THE ASYMMETRY THAT SHAPES EVERY REFUSAL BELOW ───────────────────────────────────────────────
//
// Harvest voice may be permissive because a wrong harvest row is ONE row, visible in the session
// ledger and correctable. A bulk care command writes MANY rows and over-application is SILENT —
// watering the whole area when three were excluded looks exactly like success, because the excluded
// plants simply look watered. So this grammar refuses far more eagerly than classify() does, and
// every refusal carries a reason the host can say out loud.

import { BATCH_EVENT_TYPES } from './eventTypes.js'

// Spoken verb -> event_type. Past and present tense both, because he says either ("water all bag
// area", "fed all pasture"). Values MUST be batch-legal; CARE_VERB_TYPES_ARE_BATCH_LEGAL below is
// the assertion, and its test is the guard.
//
// moisture_check is ABSENT ON PURPOSE and must never be added. It sits in BATCH_EXCLUDED_TYPES
// because "none of these 500 need water" is a fabricated observation (careNeeded.js:34-37), and a
// spoken bulk command is exactly the bulk affordance that rule forbids.
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

// DERIVED, never hand-listed — the same rule eventTypes.js states for BATCH_EVENT_TYPES itself.
// A verb whose type is not batch-legal is a bug in this file, not a case to handle at runtime.
export const CARE_EVENT_TYPES = [...new Set(Object.values(CARE_VERBS))]
export const ILLEGAL_CARE_TYPES = CARE_EVENT_TYPES.filter((t) => !BATCH_EVENT_TYPES.includes(t))

// The exclusion opener. "except" is the word he used; "but not" and "apart from" are the two
// paraphrases most likely to come out instead. Multi-word forms are checked before single so
// "but not" cannot be read as a scope word followed by a separate "not".
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
 * Returns null for anything that is not one — a null here means "not my shape", NOT "invalid", so
 * the caller falls through to its ordinary handling exactly as before. A REFUSAL is different: it
 * returns { kind: 'care_refused', reason }, because the utterance clearly WAS a care command and
 * could not be trusted. Silence on those would be the lost-log failure this flow exists to prevent.
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

  // THE WATERMELON GUARD — the single measured verb-initial collision in the whole vocabulary.
  // "watermelon" is ONE token so token-0 anchoring already defeats it; this covers the one residual
  // exposure, Chrome splitting it as "water melon". A curated bound, not a heuristic, for the reason
  // COMMAND_NEAR_MISSES states: never a general rule that could swallow a crop.
  if (verb === 'water' && tokens[1] === 'melon') return null

  const eventType = CARE_VERBS[verb]
  const rest = tokens.slice(1).join(' ')

  // A BARE VERB IS NOT A COMMAND. "water" alone has no scope, and defaulting it to everything is the
  // over-application failure in its purest form. It is also exactly what a one-word mishear produces.
  if (!rest) return { kind: 'care_refused', reason: 'no-scope', transcript }

  // WORD-BOUNDARY MATCH, not space-padded indexOf. The first version used ` ${phrase} ` and so missed
  // the phrase at either end of the string — "water except zephyr" (no leading space) and "water all
  // bag area except" (no trailing space) both parsed as ordinary commands. Those are precisely the
  // two shapes that MUST refuse, so the bug turned the safety surface off entirely.
  let scope = rest
  let exclusionText = null
  for (const phrase of EXCEPT_PHRASES) {
    const m = rest.match(new RegExp(`(?:^|\\s)${phrase}(?:\\s|$)`))
    if (!m) continue
    scope = rest.slice(0, m.index).trim()
    exclusionText = rest.slice(m.index + m[0].length).trim()
    break
  }

  // "water except zephyr" — an exclusion with nothing to exclude FROM. Refused rather than read as
  // "everything except", which is the most destructive possible reading of a misheard utterance.
  if (!scope) return { kind: 'care_refused', reason: 'no-scope', transcript }

  // "water all bag area except" — he was cut off, or the names were lost to a session boundary, which
  // is routine rather than exceptional given Chrome ends a session at every pause. Applying the scope
  // without the exclusions is exactly the silent over-application this grammar exists to prevent: it
  // would water the three plants he just said to skip, and it would look like success.
  if (exclusionText === '') return { kind: 'care_refused', reason: 'empty-exclusion-list', transcript }

  // THE GRAMMAR CANNOT SPLIT AN UNPUNCTUATED LIST, and pretending otherwise is the failure mode here.
  // Chrome rarely punctuates speech, so "zephyr crimson sweet king richard" arrives as four bare
  // tokens that could be one name, two, three or four — "crimson sweet" is itself a two-word cultivar.
  // Splitting on whitespace would invent boundaries; refusing outright would reject his own example.
  // So: split on EXPLICIT separators only, and when there are none but the text is multi-word, hand
  // the raw text back with `ambiguousList` set and let the HOST resolve it against the real planting
  // names. Closed-set matching is the only thing that can split it, and the host is where that
  // knowledge lives — the same reframe that rescued rare cultivar names.
  let exclusions = []
  let ambiguousList = false
  if (exclusionText) {
    exclusions = exclusionText.split(LIST_SEPARATORS).map((s) => s.trim()).filter(Boolean)
    ambiguousList = exclusions.length === 1 && exclusionText.split(' ').length > 1
  }

  return { kind: 'care', eventType, verb, scope, exclusionText, exclusions, ambiguousList, transcript }
}
