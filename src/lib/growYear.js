// growYear.js — V4-HARVESTVIEW-001 S4. THE shared grow-year derivation. Consolidates the two
// previously duplicated copies (Harvests.jsx + useHarvestSnapshot.js) — never mint another copy
// (design §2b: one shared helper). Season = grow-year, Nov 1 – Oct 31; "2026 season" = the season
// ENDING Oct 2026 (canon harvest-view §4 label convention).
//
// ET-safe BY CONSTRUCTION: day keys are parsed with string math, never `new Date('YYYY-MM-DD')` —
// that form parses as UTC midnight, which is the previous evening in America/New_York, so an
// Oct 31 / Nov 1 boundary date lands in the WRONG grow-year (design §2b hardening). Date inputs are
// first projected into the harvest zone via etDay (Intl-based), then handled as day keys.
import { etDay } from './harvestSummary.js'

export const HARVEST_TZ = 'America/New_York'

// 'YYYY-MM-DD' -> grow-year (Nov/Dec belong to the FOLLOWING year's season). null on junk — a
// caller must branch, never receive NaN.
export function growYearOfDayKey(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dayKey ?? ''))
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  if (mo < 1 || mo > 12) return null
  return mo >= 11 ? y + 1 : y
}

// The grow-year "now" falls in, judged on the ET day of the instant — not the device-local one.
export function currentGrowYear(d = new Date(), timeZone = HARVEST_TZ) {
  return growYearOfDayKey(etDay(d, timeZone))
}

// Half-open day-key span of a grow-year: [start, end). String-comparable against day/week keys.
export function growYearSpan(year) {
  return { start: `${year - 1}-11-01`, end: `${year}-11-01` }
}

// Grow-year sheet universe: CONTINUOUS range from the earliest harvest's grow-year up to the
// current one, newest first. Includes empty seasons on purpose — an empty season renders the honest
// empty state, and a continuous range neutralizes the ISO-week Nov-boundary omission and the
// overwinter first_pick gap (design §2b). No data -> just the current season (All time stays a chip,
// never a sheet row).
export function growYearOptions(minDayKey, current) {
  const min = growYearOfDayKey(minDayKey)
  if (min == null || min >= current) return [current]
  const out = []
  for (let y = current; y >= min; y--) out.push(y)
  return out
}
