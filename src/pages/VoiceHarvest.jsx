// src/pages/VoiceHarvest.jsx — V5-HARVESTVOICEFLOW-001 (BD-068), the first USER-FACING slice.
//
// Dave, 2026-08-30: "I want to get to production the voice harvest flow. It can run as a parallel tab
// short term so that I don't lose the harvest ability should this fail somehow, but I need to start
// using it to see if it is going to work."
//
// PARALLEL, NOT INTEGRATED — and that is the entire risk design. Build plan V101's S3 put voice
// INSIDE the live weigh-in session on /log, which meant every defect in this flow was a defect in the
// form Dave depends on daily. This is a separate route with its own state, mounted from its own row
// in the + sheet. /log is not imported, not modified, and not reachable from here; if this surface
// misbehaves the recovery is to close it. That is why this ships without the
// HARVEST_VOICE_FLOW_ENABLED flag V101 specified: the flag existed to make a root mic provider
// escapable, and a route you can navigate away from is already escapable. There is no root provider
// here — the recogniser lives and dies with this component.
//
// WHAT IT REUSES rather than rebuilds:
//   lib/voiceHarvestGrammar.js  — classify(): command vs quantity vs weight vs search vs unparsed
//   lib/voiceCommitDebounce.js  — settle window, supersede, write cooldown, staleness bound
//   lib/comboboxInput.js        — looseKey/looseIncludes, the voice-forgiving matcher the picker uses
//   POST /api/events            — the same endpoint and the same harvest payload /log posts
// The grammar and the debouncer had run only inside the /admin probe until now. This is their first
// execution against real data.
//
// WHY THE RECOGNISER IS OPEN-CODED HERE and not shared with ContinuousVoiceProbe: the probe's value
// is that it is deliberately un-abstracted — it reports what Chrome dispatches, not what a wrapper
// says Chrome dispatched, and wrapping it would destroy the instrument. It cannot go through
// lib/transcribe.js either, for the reason V101 records: transcribe.js ends a session on `onend` with
// no restart, and its BUG-VOICEDUPE-003 fix pins onResult to never deliver a revised final — which is
// exactly the revision the debouncer's supersede rule needs, so behind that wrapper "231 grams" would
// commit as "231". The mic arbiter (S1) is the thing that should eventually own all five start-paths
// including this one; it is not built, so this component owns its own and releases it on unmount.
//
// THE SAFETY PROPERTIES, because "a silent wrong save is worse than a slow form" (Dave, BD-068):
//   * A save NEVER happens without a planting AND a quantity. A "next" that cannot save says so and
//     keeps the record intact — it does not advance over it. This is the failure V101 found in
//     /log's handleSubmit, which returned undefined on all 9 paths so save_and_advance could not
//     tell a refusal from a success.
//   * Every outcome is announced on THREE channels — a large banner, a distinct haptic, and a
//     permanent ledger row. BUG-VOICEFAILSILENT-001 (Dave, verbatim): "a silent fail is a lost log."
//     The strip counts BOTH halves ("12 saved · 3 not captured") because the banner is a single
//     overwritten slot: a refusal he did not glance at is erased by the next utterance, and the
//     count is the only surface that can still answer "did everything I said get logged?".
//   * The screen going dark takes all three channels at once, so a Screen Wake Lock is held for the
//     run (BUG-VOICESCREENSLEEP-001). It is a precondition for the line above, not an optimisation.
//   * Every committed row carries an Undo for the whole session, not just the last one.
//   * A save that FAILS releases the write cooldown, so saying "next" again actually retries rather
//     than being swallowed for 1500 ms as a transport duplicate.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { P } from '../lib/constants.js'
import { useApiFetch } from '../lib/api.js'
import { todayLocalISO } from '../lib/dateLocal.js'
import { looseKey, looseIncludes, splitCropAliases } from '../lib/comboboxInput.js'
import { useCropTypes } from '../hooks/useCropTypes.js'
import { fuzzyMatch } from '../lib/voiceFuzzyMatch.js'
import { fetchAliases, indexAliases, resolveAlias, teachAlias } from '../lib/voiceAliases.js'
import {
  buildValue, classify, classifyPartial, foldNumberWords, normalise, segmentCandidates,
  splitTrailingCommand, parseValueSequence,
} from '../lib/voiceHarvestGrammar.js'
import { recordVoiceEvent, recordVoiceMark } from '../lib/voiceDebug.js'
import { createCommitDebouncer } from '../lib/voiceCommitDebounce.js'
import { acquireMic, releaseMic } from '../lib/micArbiter.js'
import {
  hapticSaveCommitted, hapticSaveFailed, hapticDigitAccepted, hapticDigitRejected, hapticUndoApplied,
  hapticMatchUncertain,
} from '../lib/haptics.js'

// A HARD STOP, not a nag. An unbounded live mic is a recorder someone forgets, and this surface is
// reachable from the ordinary + menu rather than from /admin. Thirty minutes covers a real weigh-in
// (the outdoor fixture gate B6 asks for ≥20 utterances; the device re-arms ~5 sessions per 4
// utterances, so the re-arm cap is sized well above that) and restarting is one tap.
export const RUN_BUDGET = { restarts: 600, runMs: 30 * 60 * 1000, label: '30 minutes' }

function ctor() {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

// BUG-VOICESCREENSLEEP-001 — one reader for "is this document hidden", because four separate places
// now branch on it and they must not disagree. Both spellings are consulted: `visibilityState` is
// the one the spec defines the platform behaviour against and the one a test can redefine, `hidden`
// is the shorthand, and an environment where they disagree should be treated as hidden either way.
function isHidden() {
  if (typeof document === 'undefined') return false
  return document.visibilityState === 'hidden' || document.hidden === true
}

// What a planting can be called out loud. Crop type is included for the reason V4-SEARCHCROPTYPE-001
// shipped for, in Dave's words: "I don't always remember spelling — is it charentais? charantais? —
// but I know it is a cantaloupe." Speaking makes that worse, not better: a recogniser has no chance
// on a cultivar name it has never heard, and every chance on "cucumber".
// The `src` column every voiceDebug entry from this page carries, so a log that also contains
// transcribe.js or probe entries can be read back to the surface that produced it.
const VOICE_DEBUG_SRC = 'voiceharvest'

// How many candidate buttons the "Which one?" card renders. Exported so the test asserts against the
// same number the UI caps at rather than a copy of it that can drift out from under it.
export const CANDIDATE_LIMIT = 8

// One-line rendering of a classify() result for the debug log. EXPORTED AND PURE so the log format
// is testable without a recogniser. Quotes the transcript on every branch: the whole point of the
// capture is to pair what was heard with what was done, and a decision line without the words is
// only half a datum.
export function describeResult(r) {
  if (!r || !r.kind) return '?'
  const said = JSON.stringify(String(r.transcript ?? ''))
  switch (r.kind) {
    case 'quantity':
    case 'weight':  return `${r.kind} ${r.value} ${r.unit}${r.implausible ? ' IMPLAUSIBLE' : ''}${r.joined ? ' JOINED' : ''} <- ${said}`
    case 'command':  return `command ${r.command} <- ${said}`
    case 'search':   return `search ${JSON.stringify(String(r.text ?? ''))} <- ${said}`
    case 'unparsed': return `unparsed ${r.reason || '?'} <- ${said}`
    default:         return `${r.kind} <- ${said}`
  }
}

// V4-SEARCHCROPTYPE-001, the VOICE leg. The three typed client filters (whole-garden search, the
// /log picker, the variety picker) got crop type as a first-class term; this surface is the fourth,
// and the one where it matters most — a recogniser has no chance on a cultivar name it has never
// heard and every chance on "cucumber".
//
// THE SLUG IS THE WHOLE CROP-TYPE TERM, and a `display_name` term was BUILT AND THEN REMOVED here
// rather than never considered. It was measured to be a near-duplicate: display_name is the Title
// Case of the slug for every type in the vocabulary ('bunching_onion' / "Bunching Onion"), looseKey
// lowercases both, and the tokeniser agreement in voiceFuzzyMatch.js already reaches the multi-word
// slug from its spoken form. The non-vacuity check is what caught it — with the crop-type vocabulary
// deliberately failed, "bunching onion" STILL selected the right planting, so the term the fetch paid
// for was carrying nothing. It cost a third network dependency on mount for that. Reverted; the
// evidence is in the lane report. Re-adding it needs a crop type whose display name is not its
// de-snake-cased slug, and there is not one today.
//
// OPS-CROPTYPEALIASCLIENT-001 — AND THE ALIAS, which is what finally answers the acceptance sentence
// this whole feature was built from: "I know it is a cantaloupe." Charentais sits under crop type
// 'melon', display 'Melon', and no crop type anywhere is NAMED cantaloupe — the word lives only in
// `crop_types.search_aliases`. Whole-garden search has matched that column server-side since
// v4-croptypealias-001 (lambda/dashboard/handlers.js:1117) and NO client could, because
// /api/varieties/crop-types did not select it. It does now, so the sentence holds on the server leg
// and on all four client filters — voice, whole-garden search, the /log picker and the variety
// picker. (The paragraph this replaces predicted the fix as "one column in that SELECT plus a term
// here", and that is exactly what it was.)
//
// `crop_aliases` is attached to the row by the page, not read from the payload: ?view=picker carries
// the crop-type SLUG and nothing else crop-shaped, and the alias text comes from the separate
// vocabulary fetch. A row without it — no vocabulary loaded, or a crop type with no aliases, which
// is most of them — yields exactly the three terms it always did.
export function plantingAliases(p) {
  return [p?.name, p?.variety_ref?.name, p?.variety_ref?.crop_type_slug, ...(p?.crop_aliases ?? [])]
    .filter(Boolean).map(String)
}

// EXPORTED AND PURE so the matcher is testable without a recogniser, a network or a DOM. Returns
// every planting any of whose aliases contains the spoken text, with exact alias matches promoted —
// "cucumber" must select a planting actually NAMED cucumber ahead of "Cucumber Beetle Trap Crop".
export function matchPlantings(plantings, spoken) {
  const needle = looseKey(spoken)
  if (!needle) return []
  const hits = plantings.filter((p) => plantingAliases(p).some((a) => looseIncludes(a, spoken)))
  const exact = hits.filter((p) => plantingAliases(p).some((a) => looseKey(a) === needle))
  return exact.length ? exact : hits
}

// BUG-VOICECOUNTSPLIT-001, residual case C — is this bare number the WHOLE NAME of a live planting?
//
// The hold that fixed the count split gates on a planting being selected, and it must: after a plant
// is chosen a bare number can only be an amount. Except when the number IS the plant. Saying "1884"
// to switch to the planting literally named 1884 stopped working, while the word form "eighteen
// eighty four" still resolves (it fails parseNumber's monotonic rule, so it never reaches the hold).
// One utterance form of one planting became unreachable; the other kept working. That asymmetry is
// the defect.
//
// TWO BOUNDS, AND BOTH ARE THE SAFETY ARGUMENT rather than convenience:
//   * KEY EQUALITY, NOT looseIncludes. The class the hold exists to stop is SUBSTRING reselection —
//     "two" inside *Brentwood*, "four" inside Marvel of *Four* Seasons, "2" inside Danvers 1*2*6.
//     Whole-key equality cannot be satisfied by a proper substring, so none of those can reach this.
//     Measured on Dave's real 239 live plantings: every number in that class has exact-hits = 0.
//   * DIGITS ONLY. A digit literal is what the recogniser emits for a name that is digits. Allowing
//     word forms would put "three" one badly-named planting away from silently switching crops mid
//     record, which is the expensive direction. Measured on the same 239: zero number-WORD utterances
//     key-match any alias, so the bound costs nothing today and caps what it can cost later.
//
// Blast radius, measured not reasoned: of the digit utterances 1..3000, exactly four key-matched a
// live alias — 184, 1184, 1844 and 1884 — all four resolving to the one planting named 1884. Three
// of those four were an artefact of `looseKey` collapsing runs of repeated characters, which is
// right for doubled letters and wrong for digit runs (BUG-LOOSEKEYREPEAT-001). With that collapse
// removed only 1884 itself key-matches, so the reachable set gets STRICTLY SMALLER and this bound
// gets tighter, never looser — the safety argument above does not depend on which side of that fix
// you read it from. Nothing under 184 fires either way, so no plausible spoken count is reachable by
// this at all.
export function namesAPlantingExactly(plantings, spoken) {
  const needle = looseKey(spoken)
  if (!needle || !/^\d+$/.test(needle)) return false
  return (plantings ?? []).some((p) => plantingAliases(p).some((a) => looseKey(a) === needle))
}

// BUG-VOICENUMWORD-001 — the same STRICT matcher, re-run with spoken number words folded to the
// digits a planting is actually named with ("eighteen eighty four" → "1884"). Returns [] when there
// was nothing to fold, so the caller can tell "no numbers in this phrase" from "folded and missed".
//
// WHY NOT IN looseKey, which is where it would be tidiest. `looseKey` is shared by three surfaces —
// this matcher, PlantingSelect (the /log picker) and VarietyPicker — so folding inside it would reach
// all three INCLUDING TYPED queries, and typing "1884" would start returning eighteen-eighty-four
// rows on the form Dave uses every day. This is a defect of the RECOGNISER, not of matching: nobody
// types "eighteen eighty four". Keeping the fold on the voice path is the same principle that put
// this whole flow on a parallel route — a voice defect must not become a defect in the form the
// harvest depends on.
function matchFolded(plantings, spoken) {
  const folded = foldNumberWords(spoken)
  if (folded === normalise(String(spoken ?? ''))) return []
  return matchPlantings(plantings, folded)
}

// V5-VOICEFUZZYMATCH-001 — the rescue, and WHERE it sits is the whole safety argument.
//
// It runs ONLY when matchPlantings returns empty. Every utterance that resolves today resolves
// identically after this change — the strict matcher is untouched and still answers first, so this
// can only turn a "nothing matched" into something. That is the same shape as the voice rescue
// VarietyPicker already ships (V4-PICKERVOICE-001 QA-G3: voice-only, empty-result-only, one shot),
// and it is deliberate reuse of a pattern Dave has already used in production rather than a new one.
//
// It cannot reach a command or a number: classify() decides those before the search branch is ever
// entered, and this is called from inside that branch. The grammar's own note says the search branch
// is the permissive one because "a wrong search shows the wrong list, which Dave sees and corrects".
//
// Returns the SAME shape the caller already handles plus a `rescued` marker, so a fuzzy hit is
// announced as a correction instead of passing itself off as a clean match.
// FOUR LAYERS, IN THIS ORDER, and the order is the whole safety argument:
//   1. strict   — exact/substring. Unchanged and still first, so every utterance that resolves today
//                 resolves identically.
//   2. learned  — a mishearing Dave has already corrected by hand (V5-VOICEALIAS-001).
//   3. folded   — spoken number words read as the digits in a name (BUG-VOICENUMWORD-001).
//   4. fuzzy    — closed-set scoring, for a mishearing nobody has taught yet.
// LEARNED BEATS FUZZY DELIBERATELY. Fuzzy is a guess that is right 77% of the time on adversarial
// input; an alias is a fact a human asserted. No score outranks that. Placing learned SECOND rather
// than first is equally deliberate: a strict match needs no rescue, and letting an alias shadow an
// exact name match would let one bad teach make a real planting unreachable.
//
// FOLDED SITS BETWEEN THEM, and both boundaries are deliberate:
//   * ABOVE FUZZY, because a fold is DERIVABLE — "eighteen eighty four" is 1884 by rule, not by
//     resemblance. Edit distance cannot reach it at all (measured: it scores 0.353 against
//     *helichrysum*), so letting a guess answer first would be strictly worse.
//   * BELOW LEARNED, because the layer-order principle above is about CONFIDENCE, not mechanism: a
//     correction a human actually made outranks one a rule derived. A fold is still an inference
//     about what was meant, and if Dave or Jen has explicitly taught this phrase, their word wins.
//     Aliases are user-scoped precisely because two people's recognisers mishear differently, and a
//     universal rule must not silently overrule one person's correction of their own device.
export function matchPlantingsWithRescue(plantings, spoken, aliasIndex = null) {
  const strict = matchPlantings(plantings, spoken)
  if (strict.length) return { hits: strict, rescued: null }

  const learned = resolveAlias(aliasIndex, spoken, plantings)
  if (learned.length) return { hits: learned, rescued: 'learned' }

  // Announced via a truthy `rescued` like any other non-strict outcome: Dave said words and got
  // digits back, so the caller quotes the heard text alongside the match. A fold that stayed silent
  // would look exactly like a clean match and hide the one step worth seeing.
  const folded = matchFolded(plantings, spoken)
  if (folded.length === 1) return { hits: folded, rescued: 'folded' }
  if (folded.length > 1) return { hits: folded, rescued: null }

  const res = fuzzyMatch(plantings, spoken, plantingAliases, looseKey)
  if (res.kind === 'one') return { hits: [res.planting], rescued: res.alias }
  if (res.kind === 'many') return { hits: res.hits.map((h) => h.planting), rescued: null }
  return { hits: [], rescued: null }
}

// V5-VOICEONEBREATH-001 — pick the ONE reading of a one-breath sentence that the live planting
// vocabulary actually supports, or none.
//
// `segmentCandidates` deliberately refuses to choose: for "eighteen eighty four two count" the
// string alone cannot say whether the count is 2, 6 or 86, because every token before the unit is a
// number word and the planting really is named 1884. The vocabulary can. This is closed-set
// selection again — the same reframe that fixed V5-VOICEFUZZYMATCH-001 — applied to the split point
// instead of to the spelling.
//
// EXACTNESS IS THE TIEBREAK, and it is needed rather than decorative. Measured on Dave's real names:
// "super sweet one hundred three count" yields BOTH "super sweet one hundred" (folds to the exact
// alias "super sweet 100") and "super sweet one" (folds to "super sweet 1", which is a SUBSTRING of
// the same planting) — one planting, two readings, counts of 3 and 103. Preferring the exact alias
// resolves it the way a human would; without that rule this correct sentence would be refused.
// It is the same promotion matchPlantings already applies internally, reused rather than reinvented.
//
// REFUSES ON A GENUINE TIE. If two survivors of equal strength disagree about the planting or the
// values, no reading is chosen — the caller falls through to "say the parts separately". A wrong
// harvest committed silently is the one outcome this flow is not allowed to have, and a one-breath
// sentence is where it is most reachable.
export function resolveOneBreath(plantings, candidates, aliasIndex = null) {
  const survivors = []
  for (const c of candidates) {
    const { hits } = matchPlantingsWithRescue(plantings, c.name, aliasIndex)
    if (hits.length !== 1) continue
    const keys = [looseKey(c.name), looseKey(foldNumberWords(c.name))]
    const exact = plantingAliases(hits[0]).some((a) => keys.includes(looseKey(a)))
    survivors.push({ ...c, planting: hits[0], exact })
  }
  if (survivors.length === 0) return null
  const strong = survivors.filter((s) => s.exact)
  const pool = strong.length ? strong : survivors
  const first = pool[0]
  // Agreement, not arrival order. Two readings that land on the same planting AND the same values
  // are the same answer reached twice and are safe to accept; anything else is a real ambiguity.
  const sameValues = (a, b) => a.length === b.length
    && a.every((v, i) => v.kind === b[i].kind && v.value === b[i].value && v.unit === b[i].unit)
  const agreed = pool.every((s) => s.planting.id === first.planting.id && sameValues(s.values, first.values))
  return agreed ? first : null
}

// THE GUARD THE GRAMMAR ASKS FOR AT THE CALL SITE, in its own words: "do not treat a whole-utterance
// command match as a command while the chooser's live result set contains an exact name match for
// that same text." A planting name is free text with no vocabulary file, so the grammar cannot check
// disjointness itself — a planting Dave named "Next" would otherwise be unselectable and would fire a
// save every time he said it. Only an EXACT alias match demotes a command; a partial one must not,
// or "save" would stop working the moment he grew something called Savoy.
export function resolveCommandCollision(result, plantings) {
  if (!result || result.kind !== 'command') return result
  const spoken = String(result.transcript ?? '')
  const key = looseKey(spoken)
  if (!key) return result
  const collides = plantings.some((p) => plantingAliases(p).some((a) => looseKey(a) === key))
  return collides ? { kind: 'search', text: spoken, transcript: spoken } : result
}

const TONE = {
  ok:   { bg: P.greenPale, border: P.green,       fg: P.dark },
  warn: { bg: P.warn,      border: P.warnBorder,  fg: P.dark },
  fail: { bg: P.alert,     border: P.alertBorder, fg: P.dark },
  idle: { bg: P.white,     border: P.border,      fg: P.light },
}

// V5-HARVESTONEDOOR-001 — `embedded` is set only by HarvestLog, the combined harvest page, which
// supplies its own title and the voice/manual selector. It suppresses this page's own <h1> and
// intro paragraph and nothing else: every behaviour below is identical in both postures, so there
// is no embedded-only code path to test separately. Default false keeps the standalone /log/voice
// route (now a redirect, but still reachable in tests and from a stale bookmark) byte-identical.
export default function VoiceHarvest({ embedded = false } = {}) {
  const { fetch: apiFetch } = useApiFetch()

  // OPS-CROPTYPEALIASCLIENT-001 — the raw picker payload, and the crop-type vocabulary it is
  // decorated with below. Held apart because they arrive from two independent fetches and either may
  // land first; the memo re-derives whenever either does.
  const [rawPlantings, setRawPlantings] = useState([])
  const { cropTypes } = useCropTypes()
  const [loadError, setLoadError] = useState(null)
  const [running, setRunning]     = useState(false)
  const micTokenRef               = useRef(null)
  const [supported]               = useState(() => !!ctor())

  const [selected, setSelected]     = useState(null)
  const [candidates, setCandidates] = useState([])
  // The phrase that matched NOTHING, kept on screen so it stays teachable. Distinct from `candidates`
  // because the two render different affordances: a short list to confirm, versus a search box to
  // resolve from scratch.
  const [unmatched, setUnmatched]   = useState(null)
  const [qty, setQty]               = useState(null)     // { value, unit }
  const [heldNum, setHeldNum]       = useState(null)     // BUG-VOICECOUNTSPLIT-001 — number awaiting its unit
  const [weight, setWeight]         = useState(null)     // { value, unit }
  const [rows, setRows]             = useState([])       // committed harvests, newest last
  const [heard, setHeard]           = useState(null)     // the pending, not-yet-settled utterance
  const [status, setStatus]         = useState({ tone: 'idle', text: 'Tap Start, then say a crop.' })
  const [endsAt, setEndsAt]         = useState(null)
  // BUG-VOICESCREENSLEEP-001 — whether the screen is being held awake, said out loud rather than
  // assumed. A wake lock can be refused (low battery, insecure context, no API at all) and a refusal
  // that presents as a success is the same silent fail this page exists to close.
  const [screenNote, setScreenNote] = useState(null)

  // The recogniser and the run's own bookkeeping. Refs, not state: the recogniser callbacks fire
  // outside React's render cycle and must read CURRENT values, never the ones closed over at arm().
  const recRef      = useRef(null)
  const debRef      = useRef(null)
  const tickRef     = useRef(null)
  const wallRef     = useRef(null)
  const restartsRef = useRef(0)
  const stopRef     = useRef(false)
  // BUG-VOICESCREENSLEEP-001. `wakeRef` is the live WakeLockSentinel or null; `hiddenRef` records
  // that THIS run was interrupted by the page hiding, so the interruption is announced once rather
  // than once per event that notices it (Chrome's own `aborted`, our visibilitychange listener and
  // `onend` can all arrive for the same screen timeout). `runningRef` exists because the visibility
  // listener fires outside React's render cycle and must read the current run state.
  const wakeRef     = useRef(null)
  const hiddenRef   = useRef(false)
  const runningRef  = useRef(false)
  // BUG-VOICEFAILSILENT-001 R4 — how many cues the platform REFUSED since the last report.
  const refusedRef  = useRef(0)

  // THE RECORD UNDER CONSTRUCTION, mirrored into refs. `setState` updaters are not a synchronous
  // read — a ref is the only synchronous truth — and the save path has to know, at the instant the
  // "next" commits, exactly what is on screen. Reading state here would save the previous record.
  const selectedRef = useRef(null)
  const qtyRef      = useRef(null)
  const weightRef   = useRef(null)
  const plantingsRef = useRef([])
  // V5-VOICEALIAS-001. `aliasRef` is the learned-mishearing index, consulted between strict and fuzzy.
  // `unmatchedRef` is the phrase that produced whatever the user is currently looking at — the thing
  // a tap would TEACH. It has to be a ref for the same reason the record slots are: the tap handler
  // must read what was actually heard, not what the last render closed over.
  const aliasRef    = useRef(null)
  const unmatchedRef = useRef(null)
  // BUG-VOICECOUNTSPLIT-001 — a number whose unit has not arrived yet. A REF because the recogniser
  // callbacks that read it fire outside React's render cycle and must see the value the previous
  // utterance wrote, not the one their closure captured; `heldNum` is the render-visible mirror so
  // the half-finished value is never invisible on screen.
  const heldNumRef  = useRef(null)
  useEffect(() => { selectedRef.current = selected }, [selected])
  useEffect(() => { qtyRef.current = qty }, [qty])
  useEffect(() => { weightRef.current = weight }, [weight])
  // OPS-CROPTYPEALIASCLIENT-001 — DECORATE THE ROWS, don't thread a map through the matchers.
  //
  // plantingAliases() is consumed by six call sites, four of them exported pure helpers that take
  // `plantings` and nothing else (matchPlantings, namesAPlantingExactly, resolveOneBreath,
  // resolveCommandCollision) plus fuzzyMatch, which takes it as an injected function. Adding a
  // vocabulary parameter would have to travel through every one of those signatures and their tests,
  // and any call site that forgot it would silently match less than its neighbour — the exact drift
  // the shared cropTypeTerms() helper exists to prevent on the typed surfaces. Attaching the terms to
  // the ROW instead means every layer (strict, learned, folded, fuzzy, one-breath, the teach picker's
  // own filter) sees them without knowing they exist.
  //
  // The slug stays on the row and is still a term in its own right, so a planting whose crop type is
  // missing from the vocabulary — or the whole vocabulary failing to load — matches exactly what it
  // matched before. display_name is deliberately NOT added: it was built, measured to be the Title
  // Case of the slug for every type in the vocabulary, and reverted (see the note on plantingAliases).
  // Aliases are the opposite case — "cantaloupe" shares no characters with "melon", which is why this
  // fetch now carries something the slug cannot.
  const plantings = useMemo(() => {
    const bySlug = new Map((cropTypes ?? []).map((c) => [c.slug, c]))
    return rawPlantings.map((p) => {
      const aliases = splitCropAliases(bySlug.get(p?.variety_ref?.crop_type_slug)?.search_aliases)
      return aliases.length ? { ...p, crop_aliases: aliases } : p
    })
  }, [rawPlantings, cropTypes])
  useEffect(() => { plantingsRef.current = plantings }, [plantings])
  useEffect(() => { runningRef.current = running }, [running])

  const say = useCallback((tone, text) => setStatus({ tone, text }), [])

  // BUG-VOICEFAILSILENT-001 R4 — FIRE A CUE AND READ WHETHER IT LANDED.
  //
  // `haptic()` already returns true only when the platform accepted the vibration (haptics.js), and
  // every call site on this page threw that answer away. Chrome refuses on a hidden document and
  // drops the request outright when the ringer is on silent — which is precisely the pocketed-phone
  // case the whole vocabulary was designed for, so the channel can be dead exactly when it is the
  // only one left. Counting the refusals is what makes the design honest about its own reach.
  //
  // ONLY AN EXPLICIT `false` COUNTS. That is the module's documented refusal value; anything else,
  // including a test double that returns nothing, is not evidence the platform said no.
  const cue = useCallback((fire) => { if (fire() === false) refusedRef.current += 1 }, [])

  // BUG-VOICEFAILSILENT-001 R3 — THE CHANNEL THAT SURVIVES NOT LOOKING.
  //
  // `status` is one slot and `say()` replaces it, so a refusal is erased by the next utterance that
  // parses cleanly: "Nothing matched" then "3 count" reads green, and the failure is gone before he
  // glances. Dave's own worst case is reachable in two utterances. A miss row is appended for every
  // outcome the app ANNOUNCES AS A FAILURE, so the strip's header can answer the only question that
  // matters at the end of a session — "did everything I said get logged?".
  //
  // AN AMBIGUOUS MATCH IS DELIBERATELY NOT A MISS. It leaves a candidate list on screen and is
  // normally resolved by the next utterance; counting it would inflate "not captured" with things
  // that were captured a second later, and a count that overstates is a count he stops reading.
  const noteMiss = useCallback((text) => {
    setRows((r) => [...r, { kind: 'miss', text, at: Date.now() }])
  }, [])

  // R4's other half. Reported when the document next becomes VISIBLE, because that is the first
  // moment the report can be read — and because the refusals it is reporting were mostly caused by
  // the document being hidden in the first place. Returns the count so the caller can decide whether
  // to spend the banner on it. It is a NOTE, not a miss: nothing was lost, a channel was, and
  // folding it into "not captured" would make that number mean two different things.
  const reportRefusedCues = useCallback(() => {
    const n = refusedRef.current
    if (!n) return 0
    refusedRef.current = 0
    setRows((r) => [...r, {
      kind: 'note', at: Date.now(),
      text: `Your phone did not buzz for ${n} cue${n === 1 ? '' : 's'} — this list is the record of them.`,
    }])
    return n
  }, [])

  // ── BUG-VOICESCREENSLEEP-001 ────────────────────────────────────────────────────────────────────
  //
  // On Chrome Android the screen turning off kills the capture AND every non-visual cue in one event,
  // and it is the most likely way a hands-free run actually dies. Sourced from Chromium rather than
  // assumed: speech_recognition.cc aborts recognition unconditionally under #if BUILDFLAG(IS_ANDROID)
  // when the page hides, vibration_controller.cc returns false from navigator.vibrate on a hidden
  // document and re-checks it per pulse, hidden-tab timer throttling stalls the settle-window tick
  // below, and the banner is on a dark screen. The page had no handling at all: it swallowed the one
  // signal the platform emits for this ('aborted', treated as routine) and then re-armed a mic Chrome
  // would abort again, burning the restart budget until it reported "session limit reached".
  //
  // FEATURE-DETECTED, AND A REFUSAL IS SAID OUT LOUD. Wake Lock is absent in some browsers and in any
  // insecure context, and it can be refused at request time (low battery). Its absence must degrade,
  // never throw — but it must also never be assumed to have held, because the whole cue stack is
  // downstream of it.
  const requestWakeLock = useCallback(async () => {
    const wl = typeof navigator !== 'undefined' ? navigator.wakeLock : null
    if (!wl || typeof wl.request !== 'function') {
      setScreenNote('This browser will not hold the screen awake — listening stops when it sleeps.')
      return
    }
    try {
      wakeRef.current = await wl.request('screen')
      setScreenNote('Screen held awake while listening.')
    } catch (err) {
      wakeRef.current = null
      setScreenNote(`The screen may sleep — ${err?.message || 'the wake lock was refused'}. Listening stops if it does.`)
    }
  }, [])

  const releaseWakeLock = useCallback(() => {
    const sentinel = wakeRef.current
    wakeRef.current = null
    setScreenNote(null)
    // release() is async and rejects if the sentinel is already gone; neither outcome is worth a
    // banner, and a teardown must not be able to throw.
    if (sentinel) { try { sentinel.release()?.catch?.(() => {}) } catch { /* already released */ } }
  }, [])

  // Detach BEFORE aborting, for the reason the unmount path does: a teardown still dispatches, and a
  // final arriving after we have decided to stop would commit into a session nobody is watching.
  const releaseRecogniser = useCallback(() => {
    const rec = recRef.current
    recRef.current = null
    if (!rec) return
    rec.onstart = null; rec.onresult = null; rec.onerror = null; rec.onend = null; rec.onnomatch = null
    try { rec.abort() } catch { /* already gone */ }
  }, [])

  // ONE announcement per interruption. Chrome's `aborted`, our visibilitychange listener and `onend`
  // can each notice the same screen timeout, and three miss rows for one event would make the count
  // this row exists to provide untrustworthy. The haptic is fired even though a hidden document is
  // exactly where Chrome refuses it — the refusal is then counted and reported by R4, which is more
  // honest than not trying and is the only way the report can be true.
  const noteScreenSleep = useCallback(() => {
    if (hiddenRef.current) return false
    hiddenRef.current = true
    recordVoiceMark(VOICE_DEBUG_SRC, 'hidden')
    cue(hapticSaveFailed)
    noteMiss('The screen went off — listening stopped there, and anything said after it was not captured.')
    return true
  }, [cue, noteMiss])

  useEffect(() => {
    let live = true
    // ?view=picker — the narrow projection (V4-PICKERPAYLOAD-001). This page is now its THIRD
    // consumer and the census in lambda/plants/grid-view.test.js is extended to say so. Fields read
    // here: id, name, archived_at, variety_ref.{name,crop_type_slug,default_unit}. All present.
    apiFetch('/api/plants?view=picker')
      .then((r) => { if (live) setRawPlantings((r?.plants ?? r ?? []).filter((p) => !p.archived_at)) })
      .catch((e) => { if (live) setLoadError(e?.message || 'Could not load your plantings') })

    // V5-VOICEALIAS-001 — learned mishearings, fetched ALONGSIDE the plantings rather than gating
    // them. fetchAliases never rejects (it fails soft to []), and this deliberately sets no
    // loadError: a chooser that refuses to start because a cache of corrections could not load is
    // worse than one that has forgotten a few. Losing this degrades the page to its v4.78.0
    // behaviour — strict, then fuzzy — which is a working page.
    fetchAliases(apiFetch).then((rows) => { if (live) aliasRef.current = indexAliases(rows) })

    return () => { live = false }
  }, [apiFetch])

  const clearRecord = useCallback(() => {
    setSelected(null); setCandidates([]); setUnmatched(null); setQty(null); setWeight(null)
    selectedRef.current = null; qtyRef.current = null; weightRef.current = null
    unmatchedRef.current = null
    // A held number belongs to the record being cleared. Carrying it into the NEXT planting would
    // let a count spoken for one crop attach itself to another — the silent wrong save this flow
    // exists to prevent, reached by the back door.
    heldNumRef.current = null; setHeldNum(null)
  }, [])

  // V5-VOICEALIAS-001 — THE TEACH. One handler for every manual pick, so a correction is learned
  // from the candidate list and from the search box identically; two paths would mean one of them
  // silently never taught.
  //
  // SELECTION HAPPENS FIRST AND UNCONDITIONALLY. The user's actual job is logging a harvest, and the
  // teach is a side benefit — so a failed teach must never cost them the pick they just made. The
  // record is set before the network call and is not rolled back if it fails.
  //
  // A FAILED TEACH IS SAID OUT LOUD, unlike the failed alias READ, which is swallowed. The asymmetry
  // is the point: someone correcting the app has already been let down once, and a teach that
  // silently did nothing would let them believe it was fixed and meet the same failure tomorrow.
  const pickPlanting = useCallback(async (p) => {
    const phrase = unmatchedRef.current
    setSelected(p); selectedRef.current = p
    setCandidates([]); setUnmatched(null)
    const label = p.name || p.variety_ref?.name
    say('ok', `${label} — now say the count or the weight.`)

    const varietyId = p?.variety_ref?.id
    // Nothing to learn when the phrase already resolved strictly, and nothing to learn it AGAINST
    // when the picker payload carried no variety (a planting with no cultivar reference).
    if (!phrase || !varietyId) { unmatchedRef.current = null; return }
    unmatchedRef.current = null
    try {
      await teachAlias(apiFetch, { heardText: phrase, varietyId })
      // Update the live index immediately rather than waiting for a refetch, so saying it again in
      // THIS session already resolves — the correction has to be visibly true at once or the user
      // has no way to tell it worked.
      const next = new Map(aliasRef.current ?? [])
      next.set(looseKey(phrase), varietyId)
      aliasRef.current = next
      say('ok', `${label} — learned “${phrase}”. Now say the count or the weight.`)
    } catch (err) {
      say('warn', `${label} selected, but I could not remember “${phrase}” — ${err?.message || 'the save failed'}.`)
    }
  }, [apiFetch, say])

  // ── the save ────────────────────────────────────────────────────────────────────────────────────
  // Returns nothing and throws nothing: every outcome is a banner, a haptic and (on success) a row.
  // `token` is the debouncer's commit timestamp, which is how a failed write releases the cooldown
  // that a successful one armed — without it, Dave's natural retry is swallowed for 1500 ms.
  const saveRecord = useCallback(async (token) => {
    const plant = selectedRef.current
    const q = qtyRef.current
    const w = weightRef.current

    // REFUSE LOUDLY AND KEEP THE RECORD. Advancing over an unsaveable record is how a picking gets
    // silently lost, which is the one failure mode this flow is least allowed to have.
    if (!plant || !q) {
      const missing = !plant && !q ? 'a crop and a quantity' : !plant ? 'a crop' : 'a quantity'
      cue(hapticSaveFailed)
      say('fail', `Not saved — still need ${missing}. Say it, then "next".`)
      noteMiss(`Not saved — still need ${missing}.`)
      debRef.current?.invalidateLastWrite(token)
      return
    }

    const label = plant.name || plant.variety_ref?.name || 'planting'
    try {
      const res = await apiFetch('/api/events', {
        method: 'POST',
        body: JSON.stringify({
          // NULL BY DESIGN. The container is derived server-side (deriveEventProjectId), the same
          // rule dev 1f567ae applied to plantings — "no client should be expected to supply one".
          project_id: null,
          event_type: 'harvest',
          event_date: todayLocalISO(),
          notes: null,
          private_notes: null,
          quantity: null,           // harvests use the structured panel; the freetext field is nulled
          plant_id: plant.id,
          // BUG-EVENTPUBFALSE-001 — `is_public` is deliberately NOT SENT, and the fix was a DELETION
          // rather than a flip to `true`. V4-PUBHIDE-001 is "default everything to true on all create
          // paths"; the Lambda implements exactly that with `body.is_public ?? true`
          // (lambda/events/index.js:3118) — and `false ?? true` is `false`, so an explicit false beats
          // the default all the way to the row. This page sent one on every harvest, so a voice-logged
          // row was excluded from the public garden page by `AND is_public IS TRUE`
          // (lambda/projects/index.js:194) with no UI to notice or undo it: V4-PUBHIDE-001 removed
          // every is_public toggle. 16 rows were repaired by a system sweep on 2026-08-30 and the
          // producer was left alone; this is that producer. Sending `true` would work today and drift
          // the moment the default changes — staying SILENT is the pattern, which is why the key is
          // absent and this comment stands in its place (EventNew.jsx:1746-1749 says the same).
          has_photo: false,
          metadata: { harvest_input_source: 'voice' },   // C8 — see the note below
          harvest: {
            quantity: Number(q.value),
            unit: q.unit,
            quality_rating: null,
            ...(w ? { weight: Number(w.value), weight_unit: w.unit } : {}),
          },
        }),
      })
      // THE KEY THE API ACTUALLY RETURNS. lambda/events/index.js:3890 answers `resp(201, {
      // ...newEvent, … })` where newEvent is the event_log row (`:3495`), so the id is a TOP-LEVEL
      // `id` — there is no `eventId` key and no nested `event` object anywhere in lambda/events.
      // This read was `res?.eventId ?? res?.event?.id`, so it resolved to null on every real
      // response, the Undo button (`{!r.undone && r.eventId && …}`) never rendered on device, and
      // this page's own "every committed row carries an Undo" was false in production. Its test was
      // green because the fixture had been written to match the client instead of the producer.
      // `eventId` is kept as a tail read only because CaptureFlow.jsx:443 tolerates both shapes.
      const eventId = res?.id ?? res?.eventId ?? null
      cue(hapticSaveCommitted)
      // BUG-VOICEWEIGHTLESSNOTE-001 — A WEIGHTLESS SAVE SAYS SO. 1,079 of 1,080 prod harvests carry a
      // weight, so a row with none is far likelier to be a capture failure than an intention: the
      // weight utterance was misheard, or the session boundary ate it, and the save announced plain
      // success anyway. A NOTE, NEVER A GATE — the row is explicit that a genuine count-only harvest
      // must still save cleanly, so this changes no payload, blocks nothing and keeps the `ok` tone
      // (it DID save). The note travels into the ledger row rather than only the banner, because the
      // banner is the channel that gets overwritten and this is exactly a thing to reconcile later.
      const said = `${q.value} ${q.unit}${w ? ` · ${w.value} ${w.unit}` : ' · no weight was said'}`
      say('ok', `Saved ${label} — ${said}`)
      setRows((r) => [...r, { kind: 'save', eventId, label, said, at: Date.now() }])
      clearRecord()
    } catch (err) {
      // The row did not land. Say so on every channel, keep the record so nothing is retyped, and
      // release the cooldown so "next" is a real retry.
      cue(hapticSaveFailed)
      say('fail', `NOT SAVED — ${err?.message || 'the save failed'}. Say "next" to try again.`)
      noteMiss(`NOT SAVED — ${err?.message || 'the save failed'}.`)
      debRef.current?.invalidateLastWrite(token)
    }
  }, [apiFetch, clearRecord, cue, noteMiss, say])

  const undoRow = useCallback(async (idx) => {
    const row = rows[idx]
    if (!row?.eventId) return
    try {
      await apiFetch(`/api/events/${row.eventId}`, { method: 'DELETE' })
      cue(hapticUndoApplied)
      setRows((r) => r.map((x, i) => (i === idx ? { ...x, undone: true } : x)))
      say('warn', `Removed ${row.label} — ${row.said}`)
    } catch (err) {
      cue(hapticSaveFailed)
      say('fail', `Could not remove that row — ${err?.message || 'the delete failed'}`)
    }
  }, [apiFetch, cue, rows, say])

  // ── one settled utterance ───────────────────────────────────────────────────────────────────────
  const applyOneUtterance = useCallback((raw, meta) => {
    let result = resolveCommandCollision(raw, plantingsRef.current)

    // ── BUG-VOICECOUNTSPLIT-001: rejoin a value Chrome split across two utterances ────────────────
    //
    // Chrome ends the recogniser session mid-phrase, so "three count" reaches us as "three" then
    // "count". The debouncer's supersede rule already rejoins the two when they land inside ONE
    // session; it cannot when a session boundary falls between them, because `onend` flushes data
    // immediately — deliberately, and correctly, since a data commit is not destructive.
    //
    // THIS IS STRICTLY ADDITIVE, in the same sense the fuzzy rescue is. Both halves are already a
    // failure or a hazard today: the unit half is `unparsed`, and the number half falls into the
    // permissive search branch where — measured against Dave's real 239 live plantings — "two"
    // silently reselects Brentwood Leaf Lettuce and "four" Marvel of Four Seasons, so the following
    // "next" saves against a plant he never named. No utterance that resolves correctly today
    // reaches this code: classify() answers a complete phrase before it is ever consulted.
    // BUG-VOICEFAILSILENT-001 — the number this utterance THREW AWAY, carried to the announcement.
    // Null on every path that keeps or applies it; set only where the pairing ends unfinished.
    let dropped = null
    const partial = classifyPartial(result.transcript)
    if (partial?.kind === 'unit' && heldNumRef.current != null) {
      const joined = buildValue(heldNumRef.current, partial.unit, result.transcript)
      heldNumRef.current = null; setHeldNum(null)
      // Falls through to the ordinary quantity/weight branches rather than applying the value here:
      // the implausibility warning, the haptic and the announcement must be identical whether the
      // phrase arrived whole or in halves, and a second copy of them is a second thing to drift.
      if (joined) result = { ...joined, joined: true }
    } else if (partial?.kind === 'number' && selectedRef.current
               && !namesAPlantingExactly(plantingsRef.current, result.transcript)) {
      // GATED ON A PLANTING BEING SELECTED, which is what makes suppressing the search safe: before
      // a plant is chosen a bare number can legitimately be a search term, and after one is chosen
      // it can only be an amount. A second number simply replaces the first — saying "three" then
      // "fifteen" means he corrected himself.
      //
      // AND GATED OFF A NUMBER THAT IS A WHOLE PLANTING NAME (case C). That utterance is not an
      // amount, it is the crop, so it falls through to the ordinary search branch rather than being
      // handled here — no second copy of the selection, the announcement, or the teach bookkeeping.
      // The bound is whole-key equality on a digit literal, which by construction cannot readmit the
      // substring reselection this gate exists to stop; see namesAPlantingExactly.
      heldNumRef.current = partial.value; setHeldNum(partial.value)
      cue(hapticDigitAccepted)
      recordVoiceMark(VOICE_DEBUG_SRC, 'decision', `held-number ${partial.value} <- ${JSON.stringify(String(result.transcript ?? ''))}`)
      say('warn', `${partial.value} — now say the unit: “count”, or “grams”.`)
      return
    } else if (heldNumRef.current != null) {
      // Any other utterance ends the pairing. The number is NOT applied on its own: a value with no
      // unit is exactly the shape of a silent wrong save, and saveRecord already refuses loudly
      // ("still need a quantity") if "next" arrives here, which is the honest outcome.
      //
      // BUG-VOICEFAILSILENT-001 — but DISCARDING it silently is not. Measured: "Suyo Long", "three",
      // "Brentwood" switched the plant and the 3 simply vanished, with the status line reading like
      // an ordinary clean selection. Dropping it is right; doing so without saying it is the defect,
      // because A SILENT FAIL IS A LOST LOG — he says "next" believing a count he spoke is in there.
      // Carried out as a note on the announcement this utterance was going to make anyway, exactly
      // as the rejoin's "(heard in two parts)" is: `say` REPLACES the status line, so a second call
      // here would be overwritten by the selection message before it could ever be read.
      dropped = heldNumRef.current
      heldNumRef.current = null; setHeldNum(null)
      // R3 — and a PERMANENT row, because the note below rides on a banner the next utterance
      // overwrites. A count he spoke and the app threw away is the definition of a lost log.
      noteMiss(`Dropped ${dropped} — no unit was said after it.`)
    }
    const dropNote = dropped != null ? ` (dropped ${dropped} — no unit was said)` : ''

    // ── V5-VOICEONEBREATH-001: the whole record in one sentence ──────────────────────────────────
    //
    // "Big Boy, two count, fifteen grams" — which is how Dave actually speaks, against a flow that
    // was specified as three separate utterances. HOOKED ONLY ON `unparsed`, which is what makes it
    // additive in the strictest sense available: an utterance reaching here already produced nothing
    // but "Didn't catch that", so there is no behaviour to regress. classify() answers first and
    // always; this only picks up what it declined.
    if (result.kind === 'unparsed') {
      const one = resolveOneBreath(
        plantingsRef.current, segmentCandidates(result.transcript), aliasRef.current,
      )
      if (one) {
        // A DIFFERENT planting means a NEW record, so the old one is cleared rather than merged.
        // Merging would let a weight spoken for the previous crop survive onto this one — the
        // record would look complete and be wrong, which is the failure mode this page is built
        // around. The same planting is a correction and keeps whatever axis was not restated.
        if (selectedRef.current?.id !== one.planting.id) clearRecord()
        heldNumRef.current = null; setHeldNum(null)
        setSelected(one.planting); selectedRef.current = one.planting
        setCandidates([]); setUnmatched(null); unmatchedRef.current = null
        for (const v of one.values) {
          const next = { value: v.value, unit: v.unit }
          if (v.kind === 'weight') { setWeight(next); weightRef.current = next }
          else { setQty(next); qtyRef.current = next }
        }
        const label = one.planting.name || one.planting.variety_ref?.name
        const said = one.values.map((v) => `${v.value} ${v.unit}`).join(' · ')
        const implausible = one.values.some((v) => v.implausible)
        cue(hapticDigitAccepted)
        recordVoiceMark(VOICE_DEBUG_SRC, 'decision', `one-breath ${label} ${said} <- ${JSON.stringify(String(result.transcript ?? ''))}`)
        // Read back in full, for the same reason a fuzzy rescue is: the app chose a split point the
        // words did not settle, so Dave sees the reading it picked before "next" commits it.
        say(implausible || dropped != null ? 'warn' : 'ok', `${label} — ${said}${implausible ? ' — that looks high. Say it again to correct it.' : ''}${dropNote}`)
        return
      }

      // BOTH AMOUNTS, NO NAME — "three count, two thirty one grams" with the planting already
      // chosen. segmentCandidates() refuses a nameless run by design, so this shape had no reader
      // at all and lost BOTH values. It is Dave's common case rather than an edge one: he says the
      // crop, pauses, then says the numbers together, and Chrome ends the session at that pause.
      //
      // GATED ON A PLANTING BEING SELECTED. Without one there is nothing to attach the values to,
      // and a bare number before a plant is chosen may legitimately be a search — the same rule
      // the grammar states at the search branch and BUG-VOICEBARENUMNOSEL-001 documents.
      const seq = selectedRef.current ? parseValueSequence(result.transcript) : null
      if (seq && seq.length) {
        for (const v of seq) {
          const next = { value: v.value, unit: v.unit }
          if (v.kind === 'weight') { setWeight(next); weightRef.current = next }
          else { setQty(next); qtyRef.current = next }
        }
        const said = seq.map((v) => `${v.value} ${v.unit}`).join(' · ')
        const implausible = seq.some((v) => v.implausible)
        cue(hapticDigitAccepted)
        recordVoiceMark(VOICE_DEBUG_SRC, 'decision', `value-sequence ${said} <- ${JSON.stringify(String(result.transcript ?? ''))}`)
        // Read back both axes: the utterance set two fields at once, so a mishearing of either is
        // only visible if both are spoken back before "next" commits them.
        say(implausible || dropped != null ? 'warn' : 'ok', `${said}${implausible ? ' — that looks high. Say it again to correct it.' : ''}${dropNote}`)
        return
      }
    }

    // The RAW event stream alone cannot answer BUG-VOICECOUNTSPLIT-001: two runs can deliver the
    // same words and diverge on what the app made of them. This is the other half of the pair — one
    // line per SETTLED utterance saying which branch it took, so "three counts -> quantity 3 count"
    // and "three -> search" are distinguishable in the log without re-deriving the grammar by hand.
    recordVoiceMark(VOICE_DEBUG_SRC, 'decision', describeResult(result))

    if (result.kind === 'search') {
      // `rescued` is the alias a FUZZY match landed on, or null when the strict matcher answered.
      // It exists to be said out loud: a rescue that stays silent is a guess wearing the costume of a
      // clean match, and this flow's rule is that every outcome is announced. Dave hears which words
      // were swapped, so a wrong rescue is caught before "next" rather than after the save.
      const { hits, rescued } = matchPlantingsWithRescue(
        plantingsRef.current, result.text, aliasRef.current,
      )
      // What a tap would teach. Recorded for EVERY non-strict outcome — a total miss, an ambiguous
      // list, and a fuzzy rescue alike — because all three are cases where the user is about to tell
      // us what they actually meant. Cleared on a strict match: there is nothing to learn from a
      // phrase that already resolved exactly.
      unmatchedRef.current = rescued === null && hits.length === 1 ? null : result.text
      if (hits.length === 0) {
        cue(hapticDigitRejected)
        // A FAILED RE-SELECTION MUST NOT LEAVE THE OLD CROP SELECTED (BUG-VOICEFAILSILENT-001).
        // Measured sequence: "Suyo Long" selects, "Marketmore" is misheard and matches nothing, the
        // banner says so — and then "three count" and "next" each overwrite that one message, and
        // the row lands against Suyo Long announced as a clean success. The failure was told once
        // and buried twice. This is the SAME harm as the bare-number reselect this release fixes,
        // reached by another route: a save against a plant the user never confirmed.
        //
        // Clearing the SELECTION only, not the record. The count and weight stay, so re-saying the
        // name is one utterance and nothing already spoken is lost; and until a name lands, the
        // existing "still need a crop" refusal in saveRecord makes `next` fail loudly instead of
        // committing. Chosen over marking it stale or blocking the save because it needs no new
        // state to drift and it reuses a refusal that is already tested.
        setSelected(null); selectedRef.current = null
        // The phrase survives into the candidate-less state so the manual picker below can still
        // teach it. Without this, a total miss — the case most worth learning from — is the one case
        // that cannot be taught.
        setCandidates([])
        setUnmatched(result.text)
        say('fail', `Nothing matched “${result.text}”. Say it again, or pick it below to teach me.${dropNote}`)
        noteMiss(`Nothing matched “${result.text}”.`)
        return
      }
      setUnmatched(null)
      if (hits.length === 1) {
        // BUG-VOICEFAILSILENT-001 — A GUESS MUST NOT FEEL LIKE A MATCH. This branch auto-selects on a
        // single hit whether the strict matcher answered or the fuzzy/learned/folded rescue scored
        // its way there. The banner already says which ("Heard X — matched Y"); the hand could not
        // tell, so a rescue onto the WRONG plant delivered the success cue and the next "next" wrote
        // a harvest against it. `rescued` is exactly the flag that distinguishes them, and it was
        // already being computed for the banner — the cue just was not reading it.
        if (rescued !== null) cue(hapticMatchUncertain)
        else cue(hapticDigitAccepted)
        setSelected(hits[0]); selectedRef.current = hits[0]
        setCandidates([])
        // NO DEFAULT QUANTITY IS SEEDED HERE, and that is a correction rather than an omission.
        // This branch briefly pre-filled `{ value: 1, unit: variety_ref.default_unit }` so a weighed
        // crop would be "complete" from the weight alone. Caught in the browser harness, not in a
        // test: it made the record LOOK complete, so saying "Suyo Long" then "next" — with no count
        // ever spoken — saved a harvest of 1 count that Dave never said, and announced it as a
        // success. That is exactly the silent wrong save this whole flow exists to make impossible.
        //
        // It also bought nothing. The grammar only parses a quantity from a number carrying a
        // trailing unit ("three count"), so a bare "three" returns `unparsed` either way — the
        // default unit had no utterance it could rescue. A quantity now exists only if it was said.
        const chosen = hits[0].name || hits[0].variety_ref?.name
        say(dropped != null ? 'warn' : 'ok', (rescued
          // The heard text is quoted back verbatim so the swap is legible at a glance. Without the
          // "heard X" half, a rescue of the WRONG planting reads exactly like a correct match.
          ? `Heard “${result.text}” — matched ${chosen}. Say the count, or say it again to change it.`
          : `${chosen} — now say the count or the weight.`) + dropNote)
        return
      }
      cue(hapticDigitRejected)
      // AMBIGUOUS IS ALSO UNCONFIRMED, so the previous crop goes here too. A list on screen is a
      // question, not an answer — until one is tapped the user has chosen nothing, and leaving the
      // old plant selected behind the list is the same silent-wrong-save route as the miss above.
      setSelected(null); selectedRef.current = null
      // THE WHOLE HIT LIST, not the eight that fit. The render caps the buttons; holding the full
      // list here is what lets the card say how many it is hiding, and a cap the user can see is a
      // different thing from a truncation they cannot. A crop-type utterance reaches 46 live tomato
      // plantings and 38 of them used to leave no trace on screen at all.
      setCandidates(hits)
      say('warn', `${hits.length} match “${result.text}” — say more of the name, or tap one.${dropNote}`)
      return
    }

    // A JOINED VALUE IS ANNOUNCED AS ONE, for the same reason a fuzzy rescue is: the app assembled
    // it from two utterances rather than hearing it, and a rejoin that stays silent is a guess
    // wearing the costume of a clean parse. Dave sees "3 count (heard in two parts)" and can correct
    // it before "next" instead of after the save.
    const joinNote = result.joined ? ' (heard in two parts)' : ''

    if (result.kind === 'quantity') {
      cue(hapticDigitAccepted)
      const next = { value: result.value, unit: result.unit }
      setQty(next); qtyRef.current = next
      say(result.implausible || dropped != null ? 'warn' : 'ok',
        result.implausible ? `${result.value} ${result.unit}${joinNote} — that looks high. Say it again to correct it.${dropNote}`
          : `${result.value} ${result.unit}${joinNote}${dropNote}`)
      return
    }

    if (result.kind === 'weight') {
      cue(hapticDigitAccepted)
      const next = { value: result.value, unit: result.unit }
      setWeight(next); weightRef.current = next
      say(result.implausible || dropped != null ? 'warn' : 'ok',
        result.implausible ? `${result.value} ${result.unit}${joinNote} — that looks high. Say it again to correct it.${dropNote}`
          : `${result.value} ${result.unit}${joinNote}${dropNote}`)
      return
    }

    if (result.kind === 'command') {
      if (result.command === 'save_and_advance' || result.command === 'save') {
        saveRecord(meta?.atMs)
        return
      }
      if (result.command === 'clear_field') {
        cue(hapticDigitAccepted)
        clearRecord()
        say('warn', 'Cleared. Say a crop to start the next one.')
        return
      }
      if (result.command === 'finish') {
        stopRef.current = true
        try { recRef.current?.stop() } catch { /* already stopping */ }
        say('warn', 'Stopped listening.')
        return
      }
    }

    // unparsed — INCLUDING a near-miss of a command word. The grammar routes "text" (a measured 1-in-9
    // mishear of "next") here rather than to search, precisely so it cannot perform a different
    // action that looks like it worked. Costs one repeated word; says so out loud.
    //
    // `ambiguous-number` (BUG-VOICENUMSUM-001) needs its OWN sentence, not the generic one. It fires
    // when the utterance carried more than one number — the shape you get saying a planting NAMED
    // after a number together with the amount ("1884 two count"). A bare "Didn't catch that" is a
    // dead end there: the recogniser heard him perfectly, so he repeats it more clearly, gets the
    // same refusal, and has no way to discover that the name is being read as part of the count.
    cue(hapticDigitRejected)
    const hint = result.reason === 'near-command' ? ' — say "next" again'
      : result.reason === 'ambiguous-number' ? ' — say the planting, then the amount separately'
      : ''
    say('warn', `Didn't catch that${hint}.${dropNote}`)
    // THE HEARD TEXT GOES IN THE ROW, not just the refusal. Recovery from a mishear means knowing
    // WHAT it heard — "Didn't catch that ← "text"" is actionable minutes later; "Didn't catch that"
    // alone asks him to remember which of forty utterances it was.
    noteMiss(`Didn't catch that — heard “${String(result.transcript ?? '')}”.`)
  }, [clearRecord, cue, noteMiss, saveRecord, say])

  // ── V5-VOICEONEBREATH-002: a trailing command rides on the record it follows ────────────────────
  //
  // "cucumber, three count, two thirty one grams, next" in ONE breath, which is how Dave asked for
  // it and how he already speaks. Before this, appending "next" did not merely fail to save — it
  // flipped classify() from `unparsed` to `search`, which skipped the one-breath reader entirely and
  // ran a planting search for the whole literal sentence. The count and the weight were discarded in
  // silence. That is the real answer to "next is often not heard at all": in that shape it was never
  // a recogniser miss, so repeating it more clearly could never help.
  //
  // The split is refused unless the head is ALREADY a record on its own terms, so "cucumber next"
  // and "next to the fence" still cannot conjure a save — see splitTrailingCommand for the gate.
  // A trailing MISHEARD command ("231 grams text") applies the record and refuses the save: the
  // values were spoken clearly and dropping them is the lost-log failure this page exists around,
  // while committing on a near-miss is the silent-wrong-write it exists around even harder.
  const applyCommitted = useCallback((raw, meta) => {
    // The debouncer hands us a CLASSIFIED RESULT, not a string — it calls classify() itself to
    // decide the commit path. So the split reads `transcript`, and the head is re-classified before
    // it goes downstream, because applyOneUtterance's whole contract is "a result object".
    const heard = typeof raw === 'string' ? raw : String(raw?.transcript ?? '')
    const split = splitTrailingCommand(heard)
    if (!split) { applyOneUtterance(raw, meta); return }

    recordVoiceMark(VOICE_DEBUG_SRC, 'decision',
      `trailing-command ${split.command ?? 'near-miss'} <- ${JSON.stringify(heard)}`)
    // The head runs through the ORDINARY path, so every announcement, haptic, implausibility warning
    // and debug row is the one that utterance would have produced on its own. A second copy of that
    // logic here is a second thing to drift.
    applyOneUtterance(classify(split.head), { ...(meta ?? {}), fromTrailingSplit: true })

    if (split.nearCommand) {
      cue(hapticDigitRejected)
      say('warn', 'Kept that. Didn\'t catch the last word — say "next" again.')
      noteMiss(`Kept the amount; didn't catch the command — heard “${heard}”.`)
      return
    }
    if (split.command === 'save_and_advance' || split.command === 'save') { saveRecord(meta?.atMs); return }
    if (split.command === 'clear_field') { cue(hapticDigitAccepted); clearRecord(); say('warn', 'Cleared. Say a crop to start the next one.'); return }
    if (split.command === 'finish') {
      stopRef.current = true
      try { recRef.current?.stop() } catch { /* already stopping */ }
      say('warn', 'Stopped listening.')
    }
  }, [applyOneUtterance, clearRecord, cue, noteMiss, saveRecord, say])

  // ── the recogniser ──────────────────────────────────────────────────────────────────────────────
  const scheduleTickRef = useRef(null)
  const scheduleTick = useCallback(() => {
    if (tickRef.current) { clearTimeout(tickRef.current); tickRef.current = null }
    const deb = debRef.current
    if (!deb) return
    const due = deb.dueAt()
    if (due == null) return
    tickRef.current = setTimeout(() => {
      tickRef.current = null
      debRef.current?.tick(Date.now())
      scheduleTickRef.current?.()
    }, Math.max(0, due - Date.now()))
  }, [])
  useEffect(() => { scheduleTickRef.current = scheduleTick }, [scheduleTick])

  const arm = useCallback(() => {
    const C = ctor()
    if (!C) { say('fail', 'This browser has no speech recognition.'); setRunning(false); return }
    const rec = new C()
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1
    rec.lang = 'en-US'
    recRef.current = rec

    // BUG-VOICECOUNTSPLIT-001 — this page was the ONLY mic surface with no raw capture, which is why
    // the count defect had to be diagnosed by replaying a simulation instead of by reading what
    // Dave's phone actually did. The recorder is the same one BUG-VOICEDUPE-002 already ships
    // (`src/lib/voiceDebug.js`): flag-gated in localStorage, off by default, and every entry point
    // returns on the flag check BEFORE touching the event, so a disabled recorder never reads the
    // live SpeechRecognitionResultList. Recorded FIRST in the handler, before the debouncer sees the
    // event, so the log shows what the browser delivered rather than what survived our own filtering.
    rec.onstart = () => { recordVoiceMark(VOICE_DEBUG_SRC, 'start') }

    // OPS-VOICENOMATCH-001 — the one failure class where the engine tells us plainly that it heard
    // speech and could not make anything of it. It was unwired, so "the recogniser gave up on that
    // phrase" was indistinguishable from "he said nothing" in both the UI and the trace, and a
    // platform seat sourced from Chromium establishes that it DOES fire on Chrome Android
    // (SpeechRecognitionImpl.java maps ERROR_NO_MATCH → a distinct `nomatch` event) — correcting the
    // received wisdom that it never fires. That makes wiring it load-bearing rather than defensive:
    // unhandled, it is evidence lost on every occurrence.
    //
    // ROUTED TO THE SOFT-REJECT FAMILY, not to the terminal-error one. `nomatch` arrives with a null
    // results list and does NOT end capture, so it is F6-shaped ("say it again"), not F1-shaped ("the
    // mic is dead") — three channels, same as every other refusal, but claiming the mic died when it
    // did not would be its own dishonesty.
    rec.onnomatch = () => {
      recordVoiceMark(VOICE_DEBUG_SRC, 'nomatch')
      cue(hapticDigitRejected)
      say('warn', 'Heard something but could not make it out — say it again.')
      noteMiss('Heard something but could not make it out.')
    }

    rec.onresult = (ev) => {
      recordVoiceEvent(VOICE_DEBUG_SRC, ev)
      const results = ev.results || []
      for (let i = ev.resultIndex || 0; i < results.length; i++) {
        const r = results[i]
        if (!r || !r[0] || !r.isFinal) continue
        debRef.current?.final(r[0].transcript || '', Date.now())
        scheduleTick()
      }
    }
    // BUG-VOICEFAILSILENT-001 — MIC DEATH IS THE ONE EVENT WITH UNBOUNDED LOSS, and it was the one
    // event with no haptic. Every branch below stops capture for good, and the only cue was a banner
    // on a screen he is not looking at: he keeps talking into a dead recogniser and loses every
    // utterance until he happens to glance down. `saveFailed` is reused rather than given its own
    // symbol — to the hand these carry the identical message ("stop, something you believe is
    // happening is not"), the screen already says which, and a seventh symbol buys nothing.
    //
    // These fire from an async callback, so Chrome may refuse the vibration for want of user
    // activation (haptics.js ACTIVATION RISK). That is exactly why the banner stays: this is a second
    // channel on the worst failure, not a replacement for the first.
    rec.onerror = (ev) => {
      recordVoiceMark(VOICE_DEBUG_SRC, 'error', ev?.error)
      const e = ev?.error
      if (e === 'not-allowed' || e === 'service-not-allowed') {
        stopRef.current = true
        cue(hapticSaveFailed)
        say('fail', 'Microphone permission was refused. Allow the mic, then tap Start.')
        noteMiss('The microphone was refused — capture stopped there.')
      } else if (e === 'audio-capture') {
        stopRef.current = true
        cue(hapticSaveFailed)
        say('fail', 'No microphone available.')
        noteMiss('No microphone available — capture stopped there.')
      } else if (e === 'aborted' && isHidden()) {
        // BUG-VOICESCREENSLEEP-001 — 'aborted' IS ordinary when WE aborted (stop, unmount, the
        // visibility release below), and it is NOT ordinary when the page is hidden and we did not
        // ask. That is Chrome ending the session because the screen went off, which it does
        // unconditionally on Android, and it is the single most likely way a hands-free run dies.
        // Swallowing it as routine is what let `onend` re-arm into the dark.
        noteScreenSleep()
      }
      // 'no-speech', and a VISIBLE 'aborted', are ordinary in a continuous session — onend re-arms.
    }
    rec.onend = () => {
      // Marked BEFORE sessionEnd() flushes, because the session boundary IS the evidence in
      // BUG-VOICECOUNTSPLIT-001: whether the boundary lands between "three" and "count" is the
      // whole difference between the count registering and vanishing, and a log that records the
      // flush without the boundary cannot tell those two runs apart.
      recordVoiceMark(VOICE_DEBUG_SRC, 'end')
      // A DATA utterance flushes at the session boundary; a WRITE deliberately does not, and waits
      // out the settle window on a tick. That asymmetry is the whole reason a bare "next" can be
      // superseded by "next to the fence" instead of having already saved.
      debRef.current?.sessionEnd(Date.now())
      scheduleTick()
      if (stopRef.current) { releaseWakeLock(); setRunning(false); return }
      // BUG-VOICESCREENSLEEP-001 — NEVER RE-ARM AGAINST A HIDDEN DOCUMENT. Chrome aborts the session
      // on every hide, so the old loop re-armed a mic that could not hear, aborted again, and burned
      // the 600-restart budget until it reported "session limit reached" — a message describing a
      // time budget for a failure that was nothing of the kind. `running` deliberately stays true:
      // the user never tapped Stop, their intent is unchanged, and the visibility handler re-arms
      // the moment the page comes back — which is also the first moment anyone could read a button.
      if (isHidden()) { noteScreenSleep(); return }
      if (restartsRef.current >= RUN_BUDGET.restarts) {
        releaseWakeLock()
        setRunning(false)
        cue(hapticSaveFailed)
        say('warn', 'Stopped — session limit reached. Tap Start to carry on.')
        noteMiss('Stopped — session limit reached.')
        return
      }
      restartsRef.current += 1
      // Gesture-free re-arm. Measured on Dave's Android 2026-08-27: 16–133 ms, no permission
      // re-prompt. If it ever throws, hands-free is off the table and the message says so plainly
      // rather than leaving a dead mic that looks live.
      try { rec.start() } catch {
        releaseWakeLock()
        setRunning(false)
        cue(hapticSaveFailed)
        say('fail', 'The mic could not restart on its own. Tap Start to keep going.')
        noteMiss('The mic could not restart on its own — capture stopped there.')
      }
    }
    try { rec.start() } catch {
      releaseWakeLock()
      setRunning(false)
      cue(hapticSaveFailed)
      say('fail', 'The mic would not start. Tap Start again.')
      noteMiss('The mic would not start.')
    }
  }, [cue, noteMiss, noteScreenSleep, releaseWakeLock, say, scheduleTick])

  const start = useCallback(() => {
    stopRef.current = false
    restartsRef.current = 0
    hiddenRef.current = false
    runningRef.current = true
    setRunning(true)
    // S1 — the hold spans the RUN, not the recogniser. arm() builds a fresh one on every re-arm
    // (15-22 ms apart), so a per-recogniser hold would open a window on each one in which a picker
    // on another surface could take the mic mid-sentence. Evicting DETACHES before aborting, via
    // releaseRecogniser, so a final in flight cannot commit into a run we have already abandoned —
    // and it is announced, because a capture flow that goes quiet is indistinguishable from a dead
    // mic (BUG-VOICEFAILSILENT-001).
    micTokenRef.current = acquireMic('VoiceHarvest', () => {
      stopRef.current = true
      runningRef.current = false
      if (wallRef.current) { clearTimeout(wallRef.current); wallRef.current = null }
      setEndsAt(null)
      releaseRecogniser()
      releaseWakeLock()
      setRunning(false)
      cue(hapticSaveFailed)
      say('warn', 'Another microphone took over — capture stopped.')
      noteMiss('Another microphone took over.')
    })
    setRows((r) => r)   // the ledger persists across a stop/start within the visit
    say('ok', 'Listening — say a crop.')
    // BUG-VOICESCREENSLEEP-001 — asked for HERE rather than in an effect, because this is the tap:
    // the request is a user-gesture descendant and the sentinel it returns is what keeps the whole
    // cue stack alive. Deliberately not awaited — a slow or refused lock must not delay the mic, and
    // the outcome lands on the persistent screen note either way.
    requestWakeLock()

    // A FRESH DEBOUNCER PER RUN. resetSession() would clear duplicate-suppression memory while a
    // pending utterance from the previous run might still be held, which its own docstring warns
    // hosts against. A new instance has no history to mis-clear.
    debRef.current = createCommitDebouncer({
      onCommit: applyCommitted,
      onPending: (r) => setHeard(r),
      onSuppressed: (r, reason) => {
        // A swallowed command with no signal is indistinguishable from a dead mic. Say which.
        // Only STALE leaves a miss row: a cooldown suppression means the save happened once and
        // correctly, so counting it as "not captured" would be false.
        if (reason === 'cooldown') say('warn', 'Heard "next" twice in a moment — saved once.')
        else if (reason === 'stale') {
          say('warn', 'That "next" went stale and was not saved. Say it again.')
          noteMiss('A "next" went stale and did not save.')
        }
      },
    })

    arm()
    const until = Date.now() + RUN_BUDGET.runMs
    setEndsAt(until)
    wallRef.current = setTimeout(() => {
      stopRef.current = true
      try { recRef.current?.stop() } catch { /* ignore */ }
      // The SIBLING of the restart-budget stop in onend, and cued the same way for the same reason:
      // the run ends on a timer while he is mid-sentence in a bed, which is the shape of the loss
      // this whole cue exists for. The user-initiated stop() below stays silent — he just tapped it.
      cue(hapticSaveFailed)
      say('warn', `Stopped after ${RUN_BUDGET.label}. Tap Start to carry on.`)
      noteMiss(`Stopped after ${RUN_BUDGET.label}.`)
      releaseWakeLock()
    }, RUN_BUDGET.runMs)
  }, [applyCommitted, arm, cue, noteMiss, releaseWakeLock, requestWakeLock, say])

  const stop = useCallback(() => {
    stopRef.current = true
    hiddenRef.current = false
    if (wallRef.current) { clearTimeout(wallRef.current); wallRef.current = null }
    setEndsAt(null)
    try { recRef.current?.stop() } catch { /* ignore */ }
    // Released here as well as in onend: a stop() that throws, or one with no recogniser to stop,
    // must not leave the screen pinned awake for the rest of the visit.
    releaseWakeLock()
    say('idle', 'Stopped.')
  }, [releaseWakeLock, say])

  // RELEASE THE MIC ON UNMOUNT, however the page is left. abort() rather than stop(): stop() is the
  // graceful shutdown that asks the engine to FINALISE, and a final dispatched into an unmounted
  // component would commit against nothing.
  useEffect(() => () => {
    stopRef.current = true
    if (wallRef.current) clearTimeout(wallRef.current)
    if (tickRef.current) clearTimeout(tickRef.current)
    releaseRecogniser()
    releaseWakeLock()
    releaseMic(micTokenRef.current)
    micTokenRef.current = null
    debRef.current = null
  }, [releaseRecogniser, releaseWakeLock])

  // S1 — hand the mic back whenever the run stops, HOWEVER it stopped: the user's tap, the
  // wall-clock budget, the restart budget, or any error path. There are six sites that set
  // stopRef.current = true and they do not share an exit, so keying on the state they all converge
  // on is the only single point that covers them. Not an acquire — mounting this page must not take
  // the mic; only tapping Start may.
  useEffect(() => {
    if (running) return
    releaseMic(micTokenRef.current)
    micTokenRef.current = null
  }, [running])

  // ── BUG-VOICESCREENSLEEP-001: the only event that tells us the run was interrupted ──────────────
  //
  // A screen wake lock is released BY THE PLATFORM whenever the document hides — that is spec
  // behaviour, not a bug — so coming back always needs a fresh request; a lock acquired once and
  // assumed to persist is a lock that stops working the first time he takes a call.
  //
  // Registered unconditionally rather than only while running, so the R4 refused-cue report can be
  // delivered on the next visible moment even if the run has already ended.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const onVisibility = () => {
      if (isHidden()) {
        wakeRef.current = null          // already released by the platform; nothing of ours to free
        if (!runningRef.current) return
        // Release the mic rather than leave one armed behind a dark screen. On Android Chrome has
        // already aborted it; on every other platform this is what stops a live recogniser that
        // nobody can see is running.
        releaseRecogniser()
        noteScreenSleep()
        return
      }
      if (runningRef.current) requestWakeLock()
      const resumed = hiddenRef.current
      if (resumed) {
        hiddenRef.current = false
        // The miss row was written when the interruption happened; this is the recovery. Re-arming
        // without a fresh tap is the same gesture-free re-arm `onend` already does — sticky user
        // activation from the Start tap survives for the document's lifetime — and it is what makes
        // "the screen went off" a recoverable event rather than the end of the weigh-in.
        if (runningRef.current) {
          arm()
          say('warn', 'The screen went off — listening stopped. Listening again now.')
        }
      }
      const refused = reportRefusedCues()
      // The banner is one slot: the resume message is the more urgent of the two, and the refused-cue
      // report is durable in the strip either way, so it only takes the banner when nothing else needs it.
      if (refused && !resumed) {
        say('warn', `Your phone did not buzz for ${refused} cue${refused === 1 ? '' : 's'} — check the list below.`)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [arm, noteScreenSleep, releaseRecogniser, reportRefusedCues, requestWakeLock, say])

  const tone = TONE[status.tone] ?? TONE.idle
  const savedCount = rows.filter((r) => r.kind === 'save' && !r.undone).length
  const missCount  = rows.filter((r) => r.kind === 'miss').length
  // BUG-VOICEFAILSILENT-001 R3 — ONE LINE THAT ANSWERS THE ONLY QUESTION HE HAS AT THE END OF A BED.
  // "12 saved · 3 not captured" is the reconciliation surface this flow has never had: the banner
  // said each of those three things once and was overwritten, so without a count the misses are
  // unrecoverable by design. The second half appears only when there IS one — a bare "12 saved"
  // stays the shape of the old label on a clean session rather than adding "· 0 not captured"
  // noise to every glance.
  const totalLabel = useMemo(() => {
    if (!savedCount && !missCount) return null
    const saved = `${savedCount} saved`
    return missCount ? `${saved} · ${missCount} not captured` : saved
  }, [savedCount, missCount])

  const card = { background: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: 12, marginBottom: 12 }

  return (
    <div style={{ padding: 16, maxWidth: 680, margin: '0 auto' }} data-testid="voice-harvest">
      {!embedded && (
        <h1 style={{ fontSize: '1.15rem', fontWeight: 700, color: P.dark, margin: '0 0 4px' }}>
          Harvest by voice
        </h1>
      )}
      {/* The pointer to the other surface is REWRITTEN, not just relocated. It used to read "the
          normal harvest form is untouched under Log an event", which was a direction to a different
          menu; the manual form is now one tap away in the selector above, so the sentence names
          that instead. Embedded or not, the copy has to describe the doors that actually exist. */}
      <p style={{ fontSize: '0.82rem', color: P.light, lineHeight: 1.5, margin: '0 0 14px' }}>
        Say the crop, then the count, then the weight, then <strong>“next”</strong> to save and start
        the following one.{' '}
        {embedded ? 'Prefer to type it? Switch to Manual above.' : 'The manual harvest form is under Log a harvest.'}
      </p>

      {!supported && (
        <div style={{ ...card, background: P.alert, borderColor: P.alertBorder }} role="alert">
          This browser has no speech recognition. Use Log an event instead.
        </div>
      )}
      {loadError && (
        <div style={{ ...card, background: P.alert, borderColor: P.alertBorder }} role="alert">
          {loadError}
        </div>
      )}

      {/* THE LOUD CHANNEL. aria-live so it is announced, role=status so it never steals focus, and
          large enough to read at arm's length with wet hands — this is the surface that has to make
          a failed capture impossible to miss (BUG-VOICEFAILSILENT-001). */}
      <div
        data-testid="voice-harvest-status"
        role="status"
        aria-live="assertive"
        style={{
          ...card, background: tone.bg, borderColor: tone.border, color: tone.fg,
          fontSize: '1.05rem', fontWeight: 600, lineHeight: 1.4, minHeight: 62,
          display: 'flex', alignItems: 'center',
        }}
      >
        {status.text}
      </div>

      {/* The record under construction. Rendered as three named slots rather than a sentence, so a
          missing one is visible as a gap instead of having to be inferred from prose. */}
      <div style={card} data-testid="voice-harvest-record">
        <Slot label="Crop"     value={selected ? (selected.name || selected.variety_ref?.name) : null} />
        {/* Every value in these three slots was SPOKEN. Nothing is pre-filled and nothing carries a
            default, so a slot reading "—" means the words have not been said yet — which is the only
            reading that lets a glance at this card be trusted. */}
        {/* A HELD NUMBER IS SHOWN IN THE QUANTITY SLOT, not hidden until its unit lands. It is not a
            quantity yet and must not read as one — hence the explicit "needs a unit" rather than a
            bare number, which would look exactly like a filled slot and reintroduce the
            looks-complete-but-isn't failure this card was built to make impossible. */}
        <Slot label="Quantity"
              value={qty ? `${qty.value} ${qty.unit}`
                : heldNum != null ? `${heldNum} … needs a unit` : null} />
        <Slot label="Weight"   value={weight ? `${weight.value} ${weight.unit}` : null} />
        <div style={{ marginTop: 6, fontSize: '0.78rem', color: P.light, fontStyle: 'italic' }} data-testid="voice-harvest-heard">
          hearing: {heard ? (heard.transcript || '—') : '—'}
        </div>
      </div>

      {candidates.length > 0 && (
        <div style={card} data-testid="voice-harvest-candidates">
          <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: 6, color: P.dark }}>
            {/* THE CAP IS SAID OUT LOUD. The list is capped at CANDIDATE_LIMIT buttons because a
                crop-type utterance can match 46 plantings and an endless scroll is not a chooser —
                but a cap with nothing on screen admitting it is indistinguishable from "these are
                all of them", which is how a plant that IS in the list reads as absent. Naming the
                total keeps the truncation visible; the ordering and the ranking are untouched. */}
            Which one?
            {candidates.length > CANDIDATE_LIMIT
              ? <span style={{ fontWeight: 400, color: P.light }}>
                  {` showing ${CANDIDATE_LIMIT} of ${candidates.length} — say more of the name`}
                </span>
              : null}
          </div>
          {candidates.slice(0, CANDIDATE_LIMIT).map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => pickPlanting(c)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', minHeight: 44, padding: '10px 12px',
                marginBottom: 6, borderRadius: 8, border: `1px solid ${P.border}`, background: P.cream,
                fontSize: '0.95rem', fontFamily: 'inherit', color: P.dark, cursor: 'pointer',
              }}
            >
              {c.name || c.variety_ref?.name}
              {c.variety_ref?.crop_type_slug ? <span style={{ color: P.light }}> · {c.variety_ref.crop_type_slug}</span> : null}
            </button>
          ))}
        </div>
      )}

      {/* THE TEACH SURFACE, and the reason the whole learning layer can work at all. Before this,
          a phrase that matched NOTHING left no way to say what it meant — which made the case most
          worth learning from the one case that could not be taught. Typing here is the escape hatch
          from a name the recogniser will never get right, AND the moment the correction is captured. */}
      {unmatched && (
        <TeachPicker
          phrase={unmatched}
          plantings={plantings}
          onPick={pickPlanting}
          onDismiss={() => { setUnmatched(null); unmatchedRef.current = null }}
        />
      )}

      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <button
          type="button"
          onClick={running ? stop : start}
          disabled={!supported}
          data-testid="voice-harvest-toggle"
          style={{
            flex: 1, minHeight: 56, borderRadius: 10, border: 'none',
            background: running ? P.terra : P.green, color: P.white,
            fontSize: '1.05rem', fontWeight: 700, fontFamily: 'inherit',
            cursor: supported ? 'pointer' : 'not-allowed', opacity: supported ? 1 : 0.5,
          }}
        >
          {running ? 'Stop listening' : 'Start listening'}
        </button>
      </div>
      {running && endsAt && (
        <p style={{ fontSize: '0.75rem', color: P.light, margin: '0 0 12px' }}>
          The mic stops on its own after {RUN_BUDGET.label}.
        </p>
      )}
      {/* BUG-VOICESCREENSLEEP-001 — whether the screen is being held awake, stated rather than
          assumed. A wake lock that was refused and a wake lock that is holding look identical from
          inside the app, and everything else on this page depends on which it is. */}
      {screenNote && (
        <p data-testid="voice-harvest-screen" style={{ fontSize: '0.75rem', color: P.light, margin: '0 0 12px' }}>
          {screenNote}
        </p>
      )}

      <div style={card} data-testid="voice-harvest-ledger">
        <div style={{ fontSize: '0.85rem', fontWeight: 700, color: P.dark, marginBottom: 6 }}>
          {totalLabel ?? 'Nothing saved yet'}
        </div>
        {rows.map((r, i) => (r.kind === 'save' ? (
          <div
            key={`${r.at}-${i}`}
            data-testid="voice-harvest-row"
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0',
              borderTop: i === 0 ? 'none' : `1px solid ${P.border}`,
              opacity: r.undone ? 0.45 : 1,
              textDecoration: r.undone ? 'line-through' : 'none',
            }}
          >
            <span style={{ flex: 1, fontSize: '0.9rem', color: P.dark }}>
              {r.label} <span style={{ color: P.light }}>· {r.said}</span>
            </span>
            {!r.undone && r.eventId && (
              <button
                type="button"
                onClick={() => undoRow(i)}
                aria-label={`Undo ${r.label} ${r.said}`}
                style={{
                  minHeight: 44, padding: '0 14px', borderRadius: 8,
                  border: `1px solid ${P.border}`, background: P.white,
                  fontSize: '0.85rem', fontFamily: 'inherit', color: P.terra, cursor: 'pointer',
                }}
              >
                Undo
              </button>
            )}
          </div>
        ) : (
          // A MISS ROW, and a REFUSED-CUE NOTE, in the same strip as the saves — because the strip is
          // the only thing on this page that is still true a minute later, and a reconciliation
          // surface that lists only the successes cannot reconcile anything. Informational: never
          // blocking, never dismissable, no micro-decision, no focus steal. A note is styled like a
          // miss but is NOT counted in the header — nothing was lost, a channel was.
          <div
            key={`${r.at}-${i}`}
            data-testid={r.kind === 'note' ? 'voice-harvest-note' : 'voice-harvest-miss'}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0',
              borderTop: i === 0 ? 'none' : `1px solid ${P.border}`,
            }}
          >
            <span style={{ flex: 1, fontSize: '0.85rem', color: P.light, fontStyle: 'italic' }}>
              {r.text}
            </span>
          </div>
        )))}
      </div>
    </div>
  )
}

// V5-VOICEALIAS-001 — resolve a phrase the recogniser mangled beyond matching, and teach it.
//
// A PLAIN TEXT INPUT, NOT the PlantingSelect combobox, and that is a deliberate refusal to reuse.
// PlantingSelect owns its own microphone (comboboxInput's SPEAK mode), and mounting it here would
// put a second recogniser on a page that already has one running continuously — the exact collision
// the unbuilt S1 mic arbiter exists to prevent. This is a filter over the plantings already in
// memory: no fetch, no mic, no combobox machinery.
//
// TYPING IS THE POINT. The user reaches this because speech failed, so the input opens with the
// keyboard available rather than suppressed — the opposite default from the voice-first pickers.
function TeachPicker({ phrase, plantings, onPick, onDismiss }) {
  const [q, setQ] = useState('')
  const matches = useMemo(() => {
    const query = q.trim()
    if (!query) return []
    return plantings
      .filter((p) => plantingAliases(p).some((a) => looseIncludes(a, query)))
      .slice(0, 8)
  }, [q, plantings])

  return (
    <div
      data-testid="voice-harvest-teach"
      style={{
        background: P.white, border: `1px solid ${P.border}`, borderRadius: 10,
        padding: 12, marginBottom: 12,
      }}
    >
      <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: 2, color: P.dark }}>
        What did you mean by “{phrase}”?
      </div>
      <div style={{ fontSize: '0.78rem', color: P.light, marginBottom: 8, lineHeight: 1.4 }}>
        Type it and pick one — I’ll remember that “{phrase}” means that from now on.
      </div>
      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Start typing a crop or variety"
        aria-label={`What did you mean by ${phrase}`}
        style={{
          width: '100%', minHeight: 44, padding: '8px 10px', boxSizing: 'border-box',
          borderRadius: 8, border: `1px solid ${P.border}`, fontSize: '1rem',
          fontFamily: 'inherit', color: P.dark, background: P.cream, marginBottom: 8,
        }}
      />
      {matches.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => onPick(m)}
          style={{
            display: 'block', width: '100%', textAlign: 'left', minHeight: 44, padding: '10px 12px',
            marginBottom: 6, borderRadius: 8, border: `1px solid ${P.border}`, background: P.cream,
            fontSize: '0.95rem', fontFamily: 'inherit', color: P.dark, cursor: 'pointer',
          }}
        >
          {m.name || m.variety_ref?.name}
          {m.variety_ref?.crop_type_slug
            ? <span style={{ color: P.light }}> · {m.variety_ref.crop_type_slug}</span> : null}
        </button>
      ))}
      <button
        type="button"
        onClick={onDismiss}
        style={{
          minHeight: 44, padding: '0 14px', borderRadius: 8, border: `1px solid ${P.border}`,
          background: P.white, fontSize: '0.85rem', fontFamily: 'inherit', color: P.light,
          cursor: 'pointer',
        }}
      >
        Skip — just say it again
      </button>
    </div>
  )
}

function Slot({ label, value }) {
  return (
    <div style={{ display: 'flex', gap: 10, padding: '4px 0', fontSize: '0.95rem' }}>
      <span style={{ width: 76, flex: '0 0 auto', color: P.light }}>{label}</span>
      <span style={{ color: value ? P.dark : P.light, fontWeight: value ? 600 : 400 }}>
        {value ?? '—'}
      </span>
    </div>
  )
}
