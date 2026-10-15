// src/lib/todayV2/sectionsWire.js — what the redesigned Today SENDS to the server for its remembered
// open/closed state, and what it does with the answer (V5-TODAYREDESIGN-001 S7; plan-v2 §2.1, §13 MF1). PURE.
//
// THE WIRE: PATCH /api/notifications/prefs, body { today_sections: { v:1, <section>: entry, … } }, ALONE. The
// critter Lambda merges it PER TOP-LEVEL KEY (stored || incoming): a section this body carries replaces that
// section's stored entry, and every other section's entry stays. So the client sends only the entries it has
// not had confirmed (the mirror's dirty keys), never the whole map.
//
// THE CONTRACT is the Lambda's (lambda/critter/validators.js todaySectionsError). This is the client's copy,
// used for one thing: an entry the server would refuse is never put on the wire, because the server refuses a
// body WHOLE and one bad entry would otherwise hold every good one back at every visit start. Such an entry
// stays on this device, dirty, and still decides this device's page. lambda/critter/todaySections.parity.test.js
// runs both copies over one table of bodies.
import { TIER_RANK, CARE_REASONS, HEADSUP_REASONS } from './triggers.js'

export const VERSION = 1
// The seven fixed sections, and one household section per member: 'hh-' + the first 8 characters of that
// member's Clerk sub (HouseholdSection.jsx householdKey) — '_' and capitals included.
export const SECTION_KEYS = ['glance', 'protect', 'headsup', 'care', 'harvest', 'putup', 'resting']
export const HH_KEY_RE = /^hh-[A-Za-z0-9_-]{1,8}$/
export const ACK_TIERS = Object.keys(TIER_RANK)
export const ACK_REASONS = [...CARE_REASONS, ...HEADSUP_REASONS]
export const MAX_KEYS = 24
export const MAX_CHARS = 4096

const DAY = /^\d{4}-\d{2}-\d{2}$/
const plainObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x)

export const wireKeyOk = (k) => SECTION_KEYS.includes(k) || HH_KEY_RE.test(k)

// Exactly {open, at} or {open:false, at, ack:{t?, r?}} — an ack records a close made while a trigger held the
// section open (MF1); its date is the entry's own `at`.
export function wireEntryOk(e) {
  if (!plainObject(e)) return false
  if (Object.keys(e).some((k) => k !== 'open' && k !== 'at' && k !== 'ack')) return false
  if (typeof e.open !== 'boolean' || typeof e.at !== 'string' || !DAY.test(e.at)) return false
  if (e.ack === undefined) return true
  if (e.open !== false || !plainObject(e.ack)) return false
  const { t, r } = e.ack
  if (Object.keys(e.ack).some((k) => k !== 't' && k !== 'r')) return false
  if (t === undefined && r === undefined) return false
  if (t !== undefined && !ACK_TIERS.includes(t)) return false
  if (r !== undefined) {
    const rs = Array.isArray(r) ? r : [r]
    if (!rs.length || rs.some((x) => !ACK_REASONS.includes(x)) || new Set(rs).size !== rs.length) return false
  }
  return true
}

// The whole today_sections value: would the server take it?
export function wireOk(ts) {
  if (!plainObject(ts) || ts.v !== VERSION) return false
  const keys = Object.keys(ts)
  if (keys.length > MAX_KEYS) return false
  const sections = keys.filter((k) => k !== 'v')
  if (!sections.length || sections.some((k) => !wireKeyOk(k) || !wireEntryOk(ts[k]))) return false
  return JSON.stringify(ts).length <= MAX_CHARS
}

// The body to send for a mirror ({ s, dirty }): its dirty entries the server would take, at most MAX_KEYS - 1
// of them, as { v:1, … } — or null when there is nothing to send.
export function pendingBody(mirror) {
  if (!mirror) return null
  const out = { v: VERSION }
  let n = 0
  for (const k of mirror.dirty || []) {
    if (n >= MAX_KEYS - 1) break
    const e = mirror.s?.[k]
    if (wireKeyOk(k) && wireEntryOk(e)) { out[k] = e; n++ }
  }
  return n && wireOk(out) ? out : null
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// A 200 for `sent`: the keys whose mirror entry is STILL what was sent stop being dirty. A key tapped again
// while the request was on the wire stays dirty — the server holds the older entry, so the newer one is sent next.
// -> the keys confirmed (possibly none).
export function confirmedKeys(mirror, sent) {
  if (!mirror || !sent) return []
  return Object.keys(sent).filter((k) => k !== 'v' && mirror.dirty.includes(k) && same(mirror.s[k], sent[k]))
}
