// src/lib/voiceDebugTap.js — BUG-VOICECOUNTSPLIT-001 decision-context tap for /log/voice.
//
// WHY THIS EXISTS, given /log/voice already records. dev ae83521 wired the page's RAW event stream
// and a one-line `decision` mark per settled utterance into src/lib/voiceDebug.js. Both are
// necessary and neither is sufficient for the open count defects, because a classify() result says
// what the WORDS were read as and says nothing about the STATE they were read against — and every
// remaining defect on this page turns on exactly that state:
//
//   • "three" holds a number only when a planting is already selected (VoiceHarvest.jsx:464). With
//     no planting it falls into the search branch, where — against Dave's real plantings — a bare
//     number silently reselects a plant. Those two runs produce the SAME `decision` line and
//     opposite outcomes, so the existing log cannot tell them apart.
//   • A held number is cleared by any unrelated utterance (VoiceHarvest.jsx:474-479) with no mark at
//     all, so a count that vanished leaves no trace of when it was dropped.
//   • classifyPartial() is consulted on every utterance but is only recorded on the one branch where
//     it returns `number` — the `unit`-join and `null` cases are invisible.
//
// So this module records, once per settled utterance, the INPUT STATE: was a planting selected and
// which one, is a number held, what is already on the record, and what classifyPartial made of the
// phrase. Read against the `decision` line that follows it and the `outcome` line after that, the
// six actions the flow can take are all legible without re-deriving the grammar by hand:
//
//   ctx sel=- held=-       + decision search "three"          -> a bare number went SEARCHING
//   ctx sel=#42 held=-     + decision quantity 3 count        -> value APPLIED
//   ctx sel=#42 held=-     + outcome warn "3 — now say…"      -> number HELD
//   ctx sel=#42 held=3     + decision unparsed near-command   -> the hold was DROPPED
//   ctx sel=#42 held=- qty=3 count + outcome ok "Saved …"     -> SAVE/advance
//
// and the qty/wt fields of the NEXT ctx line are the after-state of the previous utterance, so a
// value that was announced but never landed is visible as a delta that did not happen.
//
// STORAGE AND PRIVACY: none of its own. Every entry goes through recordVoiceMark() into the one
// existing localStorage key, under the same flag, the same 600-entry cap and the same never-uploaded
// rule as the raw capture. This module deliberately adds no key, no server call and no new retention
// behaviour — the transcripts it quotes are Dave's speech and are already in that log verbatim.
//
// INERT WHEN OFF is inherited but NOT free: recordVoiceMark checks the flag, yet its arguments are
// evaluated first, so formatting eagerly would run classifyPartial and build strings on every
// utterance of every run with the recorder off. Each tap therefore checks the flag ITSELF before it
// formats anything. Pinned by src/__tests__/voiceDebugTap.test.js.

import { isVoiceDebugEnabled, recordVoiceMark } from './voiceDebug.js'
import { classifyPartial } from './voiceHarvestGrammar.js'

// The same `src` column dev ae83521 stamps on this page's raw events, so a ctx line and the result
// events it explains sort together in one log that also holds transcribe.js and probe entries.
export const VOICE_TAP_SRC = 'voiceharvest'

const NONE = '-'

// Identity, not just label. Two plantings can share a name and the defect under investigation is the
// WRONG one being selected, so the id is the part that settles it.
export function describePlanting(p) {
  if (!p) return NONE
  const label = p.name || p.variety_ref?.name || ''
  return `#${p.id ?? '?'}${label ? ' ' + JSON.stringify(String(label)) : ''}`
}

export function describeValue(v) {
  if (!v || v.value == null) return NONE
  return `${v.value} ${v.unit ?? '?'}`
}

// `null` is a real answer here and is recorded as one: classifyPartial returns it for a command, a
// filler-only phrase, and anything carrying a unit already — the cases where a hold correctly did
// not happen. Reading "partial=-" as "not consulted" would invert the diagnosis.
export function describePartial(partial) {
  if (!partial || !partial.kind) return NONE
  if (partial.kind === 'number') return `number:${partial.value}`
  if (partial.kind === 'unit') return `unit:${partial.unit}`
  return String(partial.kind)
}

/**
 * One line of pre-decision state. `result` is the classify() result the debouncer settled on
 * (VoiceHarvest passes it straight through), `state` the ref values at that instant — read as refs
 * and not as render state, because the callback runs outside React's cycle and the previous
 * utterance's write is the one that matters.
 */
export function formatContext(result, state) {
  const s = state || {}
  const transcript = String(result?.transcript ?? '')
  let partial = null
  // classifyPartial is pure, but it is another lane's grammar and a debug tap is never allowed to
  // throw into a mic handler.
  try { partial = classifyPartial(transcript) } catch { partial = null }
  return [
    `sel=${describePlanting(s.selected)}`,
    `held=${s.held == null ? NONE : String(s.held)}`,
    `qty=${describeValue(s.qty)}`,
    `wt=${describeValue(s.weight)}`,
    `partial=${describePartial(partial)}`,
    `classify=${result?.kind ?? '?'}${result?.reason ? ':' + result.reason : ''}`,
    `<- ${JSON.stringify(transcript)}`,
  ].join(' ')
}

export function tapVoiceContext(result, state) {
  if (!isVoiceDebugEnabled()) return false
  return recordVoiceMark(VOICE_TAP_SRC, 'ctx', formatContext(result, state))
}

/**
 * The announcement, which on this page IS the resulting action: every branch of applyCommitted and
 * saveRecord ends in exactly one say(), by the flow's own rule that no outcome is silent. Tapping it
 * captures the save result — committed, refused for a missing crop or quantity, or failed at the
 * network — which the classify result cannot express, since all three follow `command save_advance`.
 */
export function formatOutcome(tone, text) {
  return `${String(tone ?? '?')} ${JSON.stringify(String(text ?? ''))}`
}

export function tapVoiceOutcome(tone, text) {
  if (!isVoiceDebugEnabled()) return false
  return recordVoiceMark(VOICE_TAP_SRC, 'outcome', formatOutcome(tone, text))
}

/**
 * `onnomatch` — the one lifecycle event dev ae83521 left unwired. Chrome fires it rarely, which is
 * the reason to record it rather than a reason not to: a run where speech was spoken and no result
 * arrived is currently indistinguishable from a run where nothing was said, and the number half of a
 * split count going missing is exactly that shape. Its ABSENCE from a captured trace is evidence too.
 */
export function tapVoiceNoMatch(detail) {
  if (!isVoiceDebugEnabled()) return false
  return recordVoiceMark(VOICE_TAP_SRC, 'nomatch', detail == null ? null : detail)
}
