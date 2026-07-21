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
