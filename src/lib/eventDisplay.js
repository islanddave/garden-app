// BUG-LOSSEVENTLABEL-001 (Dave 2026-09-29) — what an event row SAYS about itself.
//
// Every history surface rendered an untitled event as its stored token with the underscores
// swapped out. For almost every type that reads fine ("brought inside", "fruit set"). For the loss
// event it printed "failed": Dave logged 2 of 8 Mini Roses lost and the planting's log said
// "failed" — about a planting that is alive and well, in the one word that is also a planting
// STATUS ("Failed", constants.js PLANT_STATUSES). Wrong twice: too dramatic for a partial loss, and
// indistinguishable from the status.
//
// So the two plant-reduction types speak in the words Dave picked them by ("Plants lost"), with
// the count when the row carries one: "2 plants lost", "1 plant given away". Every other type keeps
// the de-snaked token exactly as before — this module changes what two types say, not the voice of
// the whole log.
//
// V5-LOSSTOKEN-001 then moved the STORED tokens themselves to `reduction_lost` /
// `reduction_given_away`. Every function here canonicalises first, so a row still stored under the
// legacy `failed` / `given_away` (before the backfill, or brought back by a restore) reads exactly
// like a new one.
import {
  LOSS_EVENT_TYPE,
  GIVEAWAY_EVENT_TYPE,
  REDUCTION_QTY_KEY,
  canonicalEventType,
  reductionReasonKey,
  reductionReasonLabel,
} from './eventTypes.js'

// [singular, plural], lower-case to sit among the lower-case tokens on the same list. The plural is
// pinned to EVENT_TYPE_META's picker label by eventDisplay.test.js, so the log and the picker can
// never name the same event two ways.
const REDUCTION_PHRASES = {
  [LOSS_EVENT_TYPE]: ['plant lost', 'plants lost'],
  [GIVEAWAY_EVENT_TYPE]: ['plant given away', 'plants given away'],
}

// The type alone, for chips, filters and kickers that have no row to count.
export function eventTypeText(type) {
  const t = canonicalEventType(String(type ?? ''))
  return REDUCTION_PHRASES[t]?.[1] ?? t.replace(/_/g, ' ')
}

// The positive whole count a reduction row carries, else null. The API requires it on both types
// (validators.js validateReduction), but a surface whose query leaves metadata out (the feed) or a
// hand-edited row must still render — as the uncounted phrase, never as "NaN plants lost".
export function reductionCount(ev) {
  if (!REDUCTION_PHRASES[canonicalEventType(ev?.event_type)]) return null
  const n = Number(ev?.metadata?.[REDUCTION_QTY_KEY])
  return Number.isInteger(n) && n > 0 ? n : null
}

// An event row's headline: the user's own title when there is one, else what happened.
export function eventTitle(ev) {
  if (ev?.title) return ev.title
  const n = reductionCount(ev)
  if (n == null) return eventTypeText(ev?.event_type)
  const [one, many] = REDUCTION_PHRASES[canonicalEventType(ev.event_type)]
  return `${n} ${n === 1 ? one : many}`
}

// Why the count went down ("Weather", "A friend"), or null for a row that is not a reduction or
// carries no reason.
export function reductionReasonText(ev) {
  const key = reductionReasonKey(ev?.event_type)
  const v = key ? ev?.metadata?.[key] : null
  return v ? reductionReasonLabel(v) : null
}
