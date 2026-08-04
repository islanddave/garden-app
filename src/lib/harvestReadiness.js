// V4-HARVESTSURF-001 — harvest-readiness predicate. PURE: every time input arrives as an argument
// (`etDoy`, and `days_since_last_harvest` already computed server-side in America/New_York). NO
// internal `new Date()` — jsdom tests would flake across a midnight boundary, and the reporting zone
// is the Lambda's, not the browser's.
//
// Evidence-only, never prediction: a candidate must already have ≥1 prior harvest (the server
// enforces that join). NULL means UNKNOWN and must NOT fire — a crop with no repeat_interval_days or
// no harvest_habit is silently skipped rather than nagged about.

// DOY window is a SUPPRESSOR, not a trigger. The CHECK constraint permits start > end, which means a
// wrap-around (Dec→Feb) window, so both orderings are handled. Absent window (both NULL) => no
// suppression. Asparagus is the motivating case: a readiness nudge after ~Jun 15 is actively harmful
// (cutting damages the crown), so out-of-window must be silent.
export function inHarvestWindow(doy, startDoy, endDoy) {
  if (startDoy == null || endDoy == null) return true
  if (!Number.isFinite(doy)) return false
  return startDoy <= endDoy
    ? doy >= startDoy && doy <= endDoy
    : doy >= startDoy || doy <= endDoy
}

const REPEATING_HABITS = new Set(['repeat', 'cut_and_come_again'])

// STALENESS CEILING (BD-001 / harvest-window crucible V100 §6.1, 2026-08-04).
// A candidate this far past its own cadence is evidence the MODEL is wrong about that plant — it has
// gone dormant, finished for the season, been pulled, or carries a mis-set repeat_interval_days — not
// evidence the plant is urgent. The distinction matters here more than anywhere else because
// rankHarvestReady sorts by overdue_ratio DESCENDING, so without a ceiling the model promotes its own
// least-trustworthy rows to the top of a 5-row band.
//
// The motivating row, measured on live prod data 2026-08-04: Wild Wineberry, repeat_interval_days=2,
// 21 days since the last pick => ratio 10.5, rank #1 of 18 candidates — on a bramble Dave had already
// closed out with a `status_change` to `dormant` on 07-31. Three of the top five were that class.
// With the ceiling the candidate set goes 18 -> 13 and the top five becomes Aster Blackberry (2.0),
// Purple Blush Tomatillo (1.67), Bush Early Girl (1.67), Sunray (1.33), Italian Parsley (1.08):
// five actively-producing plants, all picked in the last 4-13 days.
//
// 3 is a deliberately loose ceiling: it keeps a genuinely-missed pick (a 2-day cucumber left 5 days)
// while rejecting the order-of-magnitude rows. It is a CLIENT-side sanity bound and NOT a substitute
// for the server-side fix — `lambda/events/index.js` filters `status NOT IN ('failed','ended')`, so
// `dormant` still sails through into the payload and the row is only stopped here. The payload carries
// no `status` field, so a client-side dormant filter is not constructible. See the report.
export const MAX_OVERDUE_RATIO = 3

export function isReadyToPick(c, etDoy) {
  if (!c) return false
  const interval = c.repeat_interval_days
  if (interval == null || !Number.isFinite(Number(interval)) || Number(interval) <= 0) return false
  // 'single' is a terminal harvest — firing on it would nag forever.
  if (!REPEATING_HABITS.has(c.harvest_habit)) return false
  const days = c.days_since_last_harvest
  if (days == null || !Number.isFinite(Number(days))) return false
  // Clock-skew guard: a future-dated harvest yields a negative age and must never fire.
  if (Number(days) < 0) return false
  if (Number(days) < Number(interval)) return false
  // Staleness ceiling — see MAX_OVERDUE_RATIO. Placed AFTER the habit/interval/negative guards so the
  // NULL-means-UNKNOWN and `single`-is-terminal contracts still decide first and this only ever narrows.
  if (Number(days) / Number(interval) > MAX_OVERDUE_RATIO) return false
  return inHarvestWindow(etDoy, c.harvest_season_start_doy, c.harvest_season_end_doy)
}

export function overdueRatio(c) {
  const interval = Number(c?.repeat_interval_days)
  if (!Number.isFinite(interval) || interval <= 0) return 0
  return Number(c.days_since_last_harvest) / interval
}

// Eligible candidates, most-overdue first. Ties break on days_since (then name) so ordering is
// deterministic across renders.
export function rankHarvestReady(candidates, etDoy) {
  if (!Array.isArray(candidates)) return []
  return candidates
    .filter(c => isReadyToPick(c, etDoy))
    .map(c => ({ ...c, overdue_ratio: overdueRatio(c) }))
    .sort((a, b) =>
      b.overdue_ratio - a.overdue_ratio ||
      Number(b.days_since_last_harvest) - Number(a.days_since_last_harvest) ||
      String(a.name || '').localeCompare(String(b.name || '')))
}

export function lastPickedLabel(days) {
  const n = Number(days)
  if (!Number.isFinite(n)) return ''
  if (n === 0) return 'last picked today'
  if (n === 1) return 'last picked 1 day ago'
  return `last picked ${n} days ago`
}
