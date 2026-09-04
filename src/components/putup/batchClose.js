// src/components/putup/batchClose.js
// V5-KBCLOSE-001 — the pure half of "what happened to this batch?".
//
// Same seam as goingNow.js: anything that DECIDES lives here, anything that PAINTS lives in the
// sibling .jsx. Every function below is a pure function of a `v_kitchen_batch_current` row, a
// `preservation_log` row, or the cook's own typing — no clock, no locale, no fetch.
//
// ⚠ THE LINE THIS MODULE HOLDS (FOODSAFETY-RULING-V101, and the preservation seat's read of it):
//   The app RECORDS a close. It never scores it, colours it, gates it, compares it, or asserts that
//   the batch completed. "Went to plan" was rejected as a verdict the app cannot make — both
//   time-keyed clocks in the evidence base are conditioned on completion established by some other
//   means, and this surface is offered on batches with zero pH rows and zero recorded cue. Nothing
//   here touches acidification, shelf stability, or whether any reading is good. `cue_observed` is
//   free text, never a picklist, never validated, and is never read back into any decision — that is
//   what keeps it a record and not an assessment.
//
// ⚠ NEVER RENDER A RAW OUTCOME VALUE. `discarded_spoiled` contains `spoil`, which the shipped
// food-safety sweep matches over innerHTML — a `value="discarded_spoiled"`, a `data-outcome`, or a
// testid built by slugifying the enum reds a test on a MACHINE VALUE rather than on a claim. Every
// value therefore reaches the DOM through `outcomeLabel` (TOTAL, and its fallback is not the raw
// value) and every testid through `OUTCOME_SLUGS` (also total, and slug-checked in the tests).

// Client restatement of KITCHEN_UUID_RE (lambda/preservation/kitchenBatch.js:108). Restated rather
// than imported for the same reason startPatchViolatesPairing restates chk_kitchen_batch_start_pairing:
// a body that could never commit is caught here instead of arriving as an opaque 400.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// normalizeText, client side (kitchenBatch.js:113-117): trimmed, and '' means "nothing recorded".
function trimToNull(v) {
  if (v == null) return null
  const t = String(v).trim()
  return t === '' ? null : t
}

// ── the vocabulary ───────────────────────────────────────────────────────────────────────────────
// SIX outcomes, in the DDL's declaration order (chk_kitchen_batch_outcome), and the labels are FINAL
// — the panel re-wrote three of them and each rewrite is load-bearing:
//   put_up            "went to plan" deleted: that is the app asserting completion. Also "jarred" is
//                     factually wrong — 7 of 19 put-up methods produce no jar.
//   put_up_different  the shared "Put it up" stem stays, but the discriminator names the DEVIATION;
//                     the V100 pair collided on their first 12 characters and both wrapped at 390px.
//   consumed          "We ate it" carried the only pronoun in the set, asserting a joint act in a
//                     two-user household.
//   discarded_spoiled the label was BROADER than the value — "Threw it out" collected "too much" and
//                     "boring" into the only rejection signal the evidence base supports.
//   abandoned         widened to cover the non-spoilage discard the row above no longer collects.
export const CLOSE_OUTCOMES = Object.freeze([
  Object.freeze({ value: 'put_up', label: 'Put it up' }),
  Object.freeze({ value: 'put_up_different', label: 'Put it up — but not what I set out to make' }),
  Object.freeze({ value: 'consumed', label: 'Ate it' }),
  Object.freeze({ value: 'given_away', label: 'Gave it away' }),
  Object.freeze({ value: 'discarded_spoiled', label: 'It spoiled — threw it out' }),
  Object.freeze({ value: 'abandoned', label: 'Gave up on it' }),
])

// Testid segments. Deliberately NOT derived from the value or from the label: slugifying either
// would put `spoil` in the DOM, which is the exact machine-value leak the label table exists to
// prevent. Total over CLOSE_OUTCOMES, asserted in the tests.
export const OUTCOME_SLUGS = Object.freeze({
  put_up: 'kept',
  put_up_different: 'kept-different',
  consumed: 'ate',
  given_away: 'gave',
  discarded_spoiled: 'binned',
  abandoned: 'gaveup',
})

// The two-step split. "Did it make anything you kept?" is the one axis that matters and the only one
// the six values genuinely partition on — Hick's cost drops from log2(6) to log2(2)+log2(<=4), and
// the same six values still reach the wire.
const KEPT_VALUES = Object.freeze(['put_up', 'put_up_different'])

// NOT "Finish this batch": `finished` is a live, RE-ENTERABLE stage_kind (three of six documented
// candy recoveries re-enter after it), and every other prompt on this family is a question.
export const CLOSE_ACTION_LABEL = 'What happened to it?'
export const KEPT_QUESTION = 'Did it make anything you kept?'
export const CUE_QUESTION = 'How did you know it was done?'

// The stage row a close appends. DDL 0a:296 — "EVERY CONSEQUENTIAL TRANSITION IS DECIDED BY AN
// OBSERVED CUE, NOT A CLOCK … Recording only entered_at records the LESS authoritative half." For a
// dehydrate batch the published endpoint IS texture, not elapsed time.
export const CUE_STAGE_KIND = 'finished'

// Placeholders, keyed off `kind` (KITCHEN_BATCH_KINDS). Examples of an OBSERVATION, never a
// threshold and never a completion test — the field is free text and nothing reads it back.
const CUE_PLACEHOLDERS = Object.freeze({
  ferment: 'bubbling stopped',
  dehydrate: 'snapped clean',
  candy: 'translucent through',
  cure: 'firm all the way through',
  infuse: 'tasted strong enough',
  age: 'smelled the way I wanted',
  other: 'what made you call it?',
})
const CUE_PLACEHOLDER_FALLBACK = 'what made you call it?'

export function cuePlaceholder(kind) {
  return CUE_PLACEHOLDERS[kind] ?? CUE_PLACEHOLDER_FALLBACK
}

// The fallback a stale bundle renders for a value the server learned after it shipped. It is NOT the
// raw value — echoing the enum is precisely the leak this table exists to stop — and it is NOT a
// guess at what the newer value means.
export const OUTCOME_FALLBACK_LABEL = 'Closed'

const OUTCOME_LABELS = Object.freeze(
  Object.fromEntries(CLOSE_OUTCOMES.map(o => [o.value, o.label])),
)

// TOTAL by construction: every input maps to a string, and no input maps to itself.
export function outcomeLabel(value) {
  return OUTCOME_LABELS[value] ?? OUTCOME_FALLBACK_LABEL
}

export function outcomesForKept(kept) {
  return CLOSE_OUTCOMES.filter(o => KEPT_VALUES.includes(o.value) === !!kept)
}

export function outcomeKeepsSomething(value) {
  return KEPT_VALUES.includes(value)
}

// ── the wire ─────────────────────────────────────────────────────────────────────────────────────
// The body for POST /api/kitchen-batches/:id/close. Idiom: startChipPatch / phStagePatch in
// goingNow.js — a pure builder that returns null rather than a body that could never commit.
//
// ⚠ `cue` IS ACCEPTED AND IS DELIBERATELY NOT ON THIS BODY. validateClose
// (kitchenBatch.js:449-461) whitelists exactly outcome / outcome_note / output_preservation_log_ids
// and has NO unknown-key rejection — an unrecognised key is dropped in silence and the route still
// answers 200. So a `cue_observed` sent here would look saved and would not be. It travels as its own
// `finished` stage row instead (cueStagePatch below), which is a route that demonstrably stores it
// and which the DDL sanctions on an open batch and on a closed one alike.
export function closePatch({ outcome, note, cue, outputIds } = {}) {
  if (!OUTCOME_LABELS[outcome]) return null
  // A non-string cue is a caller bug, not a user input — refuse the whole close rather than commit
  // half of the cook's intent.
  if (cue != null && typeof cue !== 'string') return null

  const body = { outcome }
  const trimmedNote = trimToNull(note)
  if (trimmedNote != null) body.outcome_note = trimmedNote

  if (outputIds != null) {
    if (!Array.isArray(outputIds)) return null
    const ids = [...new Set(outputIds)]
    if (ids.some(id => !UUID_RE.test(String(id)))) return null
    // Absent and [] both mean "link nothing" (kitchenBatch.js:456,464), so the empty case sends no
    // key at all — the batch PUT next door is a MERGE and this family sends only what it means.
    if (ids.length > 0) body.output_preservation_log_ids = ids
  }
  return body
}

// The body for POST /api/kitchen-batches/:id/stages. Null when the cook typed nothing — an absent
// cue is an ordinary, permanent, acceptable state and must never manufacture an empty row.
export function cueStagePatch(cue) {
  const text = trimToNull(cue)
  if (text == null) return null
  return { stage_kind: CUE_STAGE_KIND, cue_observed: text }
}

// ── the jars ─────────────────────────────────────────────────────────────────────────────────────
// chk_preservation_log_one_provenance: a jar comes from a batch OR from one harvest, never both. A
// jar carrying harvest_log_id can never take a batch_id, and the whole close statement rolls back if
// one is sent — so the picker refuses it rather than letting the cook discover it as a 400 that also
// silently did not close the batch.
//
// batch_id is the second gate and it depends on BUG-JARSTEAL-001's projectRow fix landing (L1): the
// column is not on the read surface today, so `row.batch_id` reads `undefined` and this degrades to
// "linkable", which is the shipped behaviour. It does not degrade to a wrong REFUSAL.
export function jarIsLinkable(row) {
  if (!row) return false
  return row.harvest_log_id == null && row.batch_id == null
}

// The reason, rendered inline on the disabled row. Absence is unattributable; a disabled row with a
// stated reason is diagnosable — and no shipped surface can relink a harvest-linked jar, so the cook
// who cannot find their jar needs to be told why, not shown a shorter list.
export function jarBlockReason(row, batchId = null) {
  if (!row) return null
  if (row.batch_id != null) {
    return batchId != null && row.batch_id === batchId
      ? 'already linked to this batch'
      : 'already linked to another batch'
  }
  if (row.harvest_log_id != null) return 'already linked to one harvest'
  return null
}

// ── reading a closed batch back ──────────────────────────────────────────────────────────────────
// Label only, never a date: a locale date here would make this module zone-dependent, and the two CI
// lanes (UTC and America/New_York) have to agree by construction. The caller renders the date.
export function describeOutcome(batch) {
  if (!batch || batch.outcome == null) return null
  return outcomeLabel(batch.outcome)
}
