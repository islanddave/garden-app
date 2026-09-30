// triggers.js — what may open a section of the redesigned Today by itself (V5-TODAYREDESIGN-001; plan-v2 §3,
// Dave's D5, §13 MF1). PURE. Evaluated ONCE, at the visit's ready point (openAtStart, called by TodayV2's
// start()); the result is a visit overlay, never saved to Layer 1 (§2.1). S4 built the Needs care half; S5 adds
// Protect tonight and Heads-up, the one ack rule all three share, and the one evaluation.
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
import { pickFrostLines, currentLows, FREEZE_BELOW_F } from '../frostAlertLine.js'

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

// ── THE ONE ACK RULE (MF1), shared by every section a trigger can open ─────────────────────────────────────
// A trigger descriptor is {t} (a Protect TIER) or {r} (a reason type, or a list of them: Needs care's
// never / hot / small, Heads-up's window / deadline). A close made while it held the section open stores it as
// the section's Layer 1 ack: {open:false, at:<plan_date>, ack:{t?, r?}}. The ack holds only while `at` is the
// plan day; the same day, the trigger re-opens the section only when it ESCALATES — a higher tier than the
// ack's (chill < frost < hardfreeze), or a reason type the ack does not name. No ack, an ack dated another day,
// or an open entry: the trigger opens.
// S7's validator must accept exactly this: `ack` absent or an object; `ack.t` ∈ TIER_RANK's keys; `ack.r` one
// string or an array of strings, each ∈ CARE_REASONS ∪ HEADSUP_REASONS (below).
export const TIER_RANK = { chill: 1, frost: 2, hardfreeze: 3 }
const typesOf = (r) => new Set([].concat(r ?? []).filter((x) => typeof x === 'string'))

export function reopens(trigger, entry, planDate) {
  if (!trigger) return false
  if (!entry || entry.open !== false || !entry.at || entry.at !== planDate || !entry.ack) return true
  const ack = entry.ack
  if (trigger.t != null && (TIER_RANK[trigger.t] || 0) > (TIER_RANK[ack.t] || 0)) return true
  if (trigger.r != null) {
    const acked = typesOf(ack.r)
    if ([...typesOf(trigger.r)].some((t) => !acked.has(t))) return true
  }
  return false
}

// Does the trigger open Needs care this visit, given its Layer 1 entry ({open, at, ack?}) for plan_date?
// (S4's name, kept: the one ack rule above.)
export function careOpens(trigger, entry, planDate) {
  return reopens(trigger, entry, planDate)
}

// ── PROTECT TONIGHT (D5 "frost nights") ────────────────────────────────────────────────────────────────────
// Protect exists when there is ≥ 1 active cold row (the engine's cold cards: level bring_in / optional / protect,
// engine.js coldFor). Its TIER, from tonight's low — the ONE low Today prints (agreedTonightLow when a frost line
// names tonight, else the plan low; never the watering scale):
//   hardfreeze  the low ≤ HARD_FREEZE_LOW_F (33°F, frostClass.js's tender/tropical HARD_FREEZE_LOW_F default —
//               src/__tests__/todayV2Triggers.test.js reads it there);
//   frost       the low < FREEZE_BELOW_F (40°F, the engine cue's "Freeze tonight" bar), a frost line naming
//               tonight (pickFrostLines with the plan's current lows — the line FrostAlertLine draws; a rehearsal,
//               a threshold imminent send and a warmed, retired advisory name nothing), or a `bring_in` card;
//   chill       a `protect` card (a tender planting at or under its own threshold);
//   none        `optional` cards only (40–44°F flowering nightshades): never opens.
// CHILL opens only on a protect planting's FIRST night on this device (today-seen, device-local, §11.1 C3): the
// tier stands, but the trigger needs one protect planting first seen on the plan day or never seen. A stale plan
// opens nothing.
export const HARD_FREEZE_LOW_F = 33

const finite = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v)) ? Number(v) : null

// The raw low the tier reads: `agreed` (agreedTonightLow(plan)) when a frost line names tonight, else the plan's.
export function tonightLowRaw(plan, agreed) {
  return agreed ? agreed.lowRaw : finite(plan?.weather?.tonightLow)
}

// A frost line names tonight: the same selection FrostAlertLine renders from.
export function frostNamesTonight(plan) {
  return pickFrostLines(plan?.alerts_sent, currentLows(plan)).tonight != null
}

export function protectTier({ lowRaw, frostTonight = false, levels = [] }) {
  if (lowRaw != null && lowRaw <= HARD_FREEZE_LOW_F) return 'hardfreeze'
  if ((lowRaw != null && lowRaw < FREEZE_BELOW_F) || frostTonight || levels.includes('bring_in')) return 'frost'
  if (levels.includes('protect')) return 'chill'
  return null
}

// A planting's first night on this device: never seen, or first seen on this plan day. `seen` is the device's
// { <planting id, first 8 chars>: 'YYYY-MM-DD' } for the season (todaySeen.js).
export const id8 = (id) => String(id ?? '').slice(0, 8)
export function firstNight(seen, plantingId, planDate) {
  const d = seen ? seen[id8(plantingId)] : undefined
  return d == null || d === planDate
}

// The visit's trigger descriptor for Protect ({t: tier}), or null. `rows` = the cold rows Protect shows, each
// carrying the engine card's `level` and its `plantingId`.
export function protectTrigger({ rows, lowRaw, frostTonight = false, seen = null, planDate, stale = false }) {
  if (stale || !Array.isArray(rows) || !rows.length) return null
  const t = protectTier({ lowRaw, frostTonight, levels: rows.map((r) => r.level) })
  if (!t) return null
  if (t === 'chill' && !rows.some((r) => r.level === 'protect' && firstNight(seen, r.plantingId, planDate))) return null
  return { t }
}

// The tender threshold a `protect` card names, parsed from the clause its engine text ends in — engine.js coldFor
// `tender tropical — bring in tonight (low ${low}°F ≤ ${pb}°F)`, the clause withoutLowClause (tonightLow.js)
// strips. A card with no such clause (bring_in, optional) names none: null, and the row says nothing about it.
const THRESHOLD = /≤ (\d+)°F\)$/
export function protectThreshold(text) {
  const m = THRESHOLD.exec(String(text ?? ''))
  return m ? Number(m[1]) : null
}

// ── HEADS-UP (D5 "storage deadlines") ────────────────────────────────────────────────────────────────────
// Opens on the FIRST day a lifting window opens (`window`) and on the last DEADLINE_DAYS days before its deadline,
// the deadline day included (`deadline`). Reads /api/plants and the DEVICE date (StorageDeadlineAlert's
// storageDeadlineGroups, whose groups carry checkFromISO / deadlineISO / daysUntil), never the plan — so a stale
// plan does not silence it. The grace phase (past the deadline) is shown, never opened.
export const HEADSUP_REASONS = ['window', 'deadline']
export const DEADLINE_DAYS = 2

export function headsupReasons(groups, todayISO) {
  const on = new Set()
  for (const g of groups || []) {
    if (!g || g.phase !== 'check') continue
    if (g.checkFromISO && g.checkFromISO === todayISO) on.add('window')
    if (typeof g.daysUntil === 'number' && g.daysUntil >= 0 && g.daysUntil <= DEADLINE_DAYS) on.add('deadline')
  }
  return HEADSUP_REASONS.filter((r) => on.has(r))
}

export function headsupTrigger(groups, todayISO) {
  const types = headsupReasons(groups, todayISO)
  return types.length ? { r: types.length === 1 ? types[0] : types } : null
}

// ── THE ONE EVALUATION, at the visit's ready point ──────────────────────────────────────────────────────────
// The sections a trigger may open, in their fixed order; each present one opens as a visit overlay when its
// trigger fires and its Layer 1 entry does not hold it closed (reopens). Nothing else is ever opened here — the
// glance, Harvest, Put-Up, Resting, a household section — whatever descriptor is passed for it.
// -> { overlay: {key:'open'}, triggers: {key: descriptor} } — the descriptors that opened a section, which a
// close made while the overlay holds it open records as its ack.
export const TRIGGER_SECTIONS = ['protect', 'headsup', 'care']

export function openAtStart({ present, triggers, resolve, planDate }) {
  const overlay = {}, fired = {}
  for (const key of TRIGGER_SECTIONS) {
    const t = triggers ? triggers[key] : null
    if (!t || !(present || []).includes(key)) continue
    if (!reopens(t, resolve ? resolve(key) : null, planDate)) continue
    overlay[key] = 'open'
    fired[key] = t
  }
  return { overlay, triggers: fired }
}
