// todaySeen.js — the chill FIRST-SEEN memory of the redesigned Today (V5-TODAYREDESIGN-001 S5; plan-v2 §3,
// §11.1 C3). D5: "a chill-only plant opens [Protect tonight] only the first night it appears". triggers.js
// decides with it (firstNight); this file only keeps it.
//
// DEVICE-LOCAL, on purpose (§11.1 C3): Layer 1 is written only by an explicit tap (R7), and a first sighting is
// not one. The cost is stated in the plan: at most one extra auto-open per device.
//
// localStorage 'today-seen:<user>' = { season: 'YYYY-autumn' | 'YYYY-spring', chill: { <planting id, first 8>:
// 'YYYY-MM-DD' } }. A planting is marked on the first plan day it shows as a `protect` card here; the mark is
// never moved later. A new SEASON starts a fresh map (Jul–Dec autumn, Jan–Jun spring), so a tropical first seen
// last autumn opens Protect again on its first chill night in spring. Cleared at sign-out (clientPrefs.js lists
// the prefix). Best-effort throughout: unreadable, blocked or full storage reads as "never seen", which fails
// toward opening.
import { id8 } from '../../../lib/todayV2/triggers.js'

export const SEEN_PREFIX = 'today-seen:'

export function seenKey(userId) {
  return userId ? SEEN_PREFIX + encodeURIComponent(String(userId)) : null
}

// 'YYYY-MM-DD' → 'YYYY-autumn' (July–December) | 'YYYY-spring' (January–June); null for anything else.
export function seasonOf(day) {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(day ?? ''))
  return m ? `${m[1]}-${Number(m[2]) >= 7 ? 'autumn' : 'spring'}` : null
}

// -> { <id8>: 'YYYY-MM-DD' } for the season `day` falls in; {} when absent, unreadable, or another season.
export function readSeen(key, day) {
  if (!key) return {}
  try {
    const m = JSON.parse(localStorage.getItem(key) || 'null')
    if (!m || m.season !== seasonOf(day) || !m.chill || typeof m.chill !== 'object') return {}
    const out = {}
    for (const [k, v] of Object.entries(m.chill)) if (typeof v === 'string') out[k] = v
    return out
  } catch { return {} }
}

// Marks `day` for every planting id not yet seen this season. Returns true when it wrote.
export function markSeen(key, day, plantingIds) {
  const season = seasonOf(day)
  if (!key || !season) return false
  const chill = readSeen(key, day)
  let added = false
  for (const id of plantingIds || []) {
    const k = id8(id)
    if (k && chill[k] == null) { chill[k] = day; added = true }
  }
  if (!added) return false
  try { localStorage.setItem(key, JSON.stringify({ season, chill })) } catch { return false }
  return true
}
