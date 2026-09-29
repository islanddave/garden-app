// triggers.js — what may open a section of the redesigned Today by itself (V5-TODAYREDESIGN-001; plan-v2 §3,
// Dave's D5, §13 MF1). PURE. Evaluated ONCE, at the visit's ready point; the result is a visit overlay, never
// saved to Layer 1 (§2.1). S4 builds the Needs care half; S5 adds Protect tonight and Heads-up here.
//
// NEEDS CARE (D5 "urgent watering" — routine watering NEVER opens it). Reasons, over the ACTIVE rows:
//   never  an active never-watered (no_history) row;
//   hot    the plan's day is hot (plan.weather.hot, the engine's highToday ≥ 88°F) AND an active water row is
//          a container (in_ground false);
//   small  an active water_due row in a small, fast-drying vessel (tray cell, soil block, solo cup — the
//          engine's SMALL_VESSEL_TYPES, by /api/plants container_type; a failed /api/plants means false).
// A STALE plan (served from the offline cache, or not dated today) opens nothing.
//
// MF1 — the ack is DATE-SCOPED. Closing Needs care while a trigger holds it open records
// {open:false, at:<plan_date>, ack:{r}}: that close holds for the rest of that plan day, and only a NEW
// reason type re-opens it the same day. An ack dated another day, or a close with no ack, holds nothing.
// `r` is one reason type ('small') or, when several fired together, a list of them.
import { SMALL_VESSEL_TYPES } from './spots.js'

export const CARE_REASONS = ['never', 'hot', 'small']

export function careReasons({ rows, plan }) {
  const never = [], small = []
  let container = false
  for (const r of rows || []) {
    if (r.need === 'no_history') never.push(r.key)
    if (r.need === 'water_due' && SMALL_VESSEL_TYPES.has(r.containerType)) small.push(r.key)
    if ((r.need === 'water_due' || r.need === 'no_history') && !r.inGround) container = true
  }
  const hot = plan?.weather?.hot === true && container
  return { never, hot, small }
}

export const reasonTypes = (reasons) => CARE_REASONS.filter((t) => (t === 'hot' ? reasons?.hot === true : (reasons?.[t]?.length || 0) > 0))

// The visit's trigger descriptor for Needs care (what an ack records), or null when nothing fires.
export function careTrigger(reasons, { stale = false } = {}) {
  if (stale) return null
  const types = reasonTypes(reasons)
  if (!types.length) return null
  return { r: types.length === 1 ? types[0] : types }
}

const ackTypes = (ack) => new Set([].concat(ack?.r ?? []).filter((t) => CARE_REASONS.includes(t)))

// Does the trigger open Needs care this visit, given its Layer 1 entry ({open, at, ack?}) for plan_date?
export function careOpens(trigger, entry, planDate) {
  if (!trigger) return false
  if (!entry || entry.open !== false || !entry.at || entry.at !== planDate || !entry.ack) return true
  const acked = ackTypes(entry.ack)
  return [].concat(trigger.r).some((t) => !acked.has(t))
}
