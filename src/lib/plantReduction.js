// src/lib/plantReduction.js
// V4-LOSSUI-001 — the client half of the plant-reduction contract V4-LOSSEVENT-001 shipped.
//
// PURE, and in src/lib/ deliberately: vitest.config.ts's coverage.include covers src/lib/** but not
// src/pages/**, so a validator living inside EventNew.jsx would be invisible to the coverage
// ratchet — the same reasoning that put dismissLayers.js here rather than in App.jsx.
//
// WHAT THIS MIRRORS, AND WHAT IT DELIBERATELY DOES NOT.
//
// It mirrors the two REQUIREDNESS rules from lambda/events/validators.js validateReduction: an
// integer quantity of at least 1, and a reason drawn from the vocabulary for that event type. Those
// are mirrored because the server answers them with a 400 whose message friendlyError() flattens to
// "Something didn't look right" — useless beside a form with two empty fields. Refusing before the
// POST puts the message next to the field it is about.
//
// It does NOT mirror the over-reduction refusal. "7 against 5 remaining" is answered by a 409 from
// the events Lambda (code REDUCTION_EXCEEDS_REMAINING) and that is the ONLY authority on it: the
// client's idea of how many are left comes from a plants list fetched at mount, which a second
// device — or Dave's own earlier reduction in another tab — can have moved since. Pre-refusing on
// that number would block a legitimate save on stale data, and CLAMPING to it is expressly what
// V4-LOSSEVENT-001 refused (a clamped row is indistinguishable from a correct one afterwards). The
// remaining count is rendered as INFORMATION beside the field; the refusal is the server's.
import {
  REDUCTION_QTY_KEY,
  REDUCTION_REASON_KEY_BY_TYPE,
  REDUCTION_REASONS_BY_KEY,
  isPlantReductionEventType,
} from './eventTypes.js'

export const REDUCTION_QTY_ERROR = 'How many? Enter a whole number, at least 1.'

// Per-type because the two vocabularies are separated at the storage layer and the copy should not
// pretend otherwise — "pick a reason" over a giveaway row would be asking for a loss reason.
export const REDUCTION_REASON_ERRORS = {
  failed: 'Pick what happened to them.',
  given_away: 'Pick where they went.',
}

export function reductionReasonError(eventType) {
  return REDUCTION_REASON_ERRORS[eventType] ?? 'Pick a reason.'
}

// The vocabulary this event type's chip row renders. Empty for every non-reduction type, so the
// panel is driven by the same map the server validates against rather than by a `=== 'failed'`.
export function reductionReasonsFor(eventType) {
  const key = REDUCTION_REASON_KEY_BY_TYPE[eventType]
  return key ? REDUCTION_REASONS_BY_KEY[key] : []
}

// Returns an error string for display, or null when the panel is satisfied. `qty` arrives as the
// raw input string — the field is type=text (see the panel for why), so coercion happens HERE and
// only here.
export function validateReductionInput(eventType, { qty, reason } = {}) {
  if (!isPlantReductionEventType(eventType)) return null
  const raw = String(qty ?? '').trim()
  const n = Number(raw)
  // Number('') is 0 and Number(' ') is 0, so the empty check cannot be folded into the range check.
  if (raw === '' || !Number.isFinite(n) || !Number.isInteger(n) || n < 1) return REDUCTION_QTY_ERROR
  if (!reductionReasonsFor(eventType).includes(reason)) return reductionReasonError(eventType)
  return null
}

// The metadata the POST carries. Returns {} for every non-reduction type, so the caller spreads it
// unconditionally — the same no-op-by-predicate shape readReductionPlan uses on the server.
//
// The quantity is coerced to a NUMBER here. validateReduction is strict (`typeof qty !== 'number'`
// rejects the string "3"), which is deliberate on its side and means the string this form holds
// must not reach the wire.
export function buildReductionMetadata(eventType, { qty, reason } = {}) {
  if (!isPlantReductionEventType(eventType)) return {}
  return {
    [REDUCTION_QTY_KEY]: Number(String(qty ?? '').trim()),
    [REDUCTION_REASON_KEY_BY_TYPE[eventType]]: reason,
  }
}
