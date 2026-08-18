// Watering-severity single source of truth (L-075). Extracted verbatim from Dashboard.jsx
// so the Dashboard WaterMeTile and the Garden-tab Today strip render IDENTICAL severity
// tiers. daysOver = time past next_water_at; indoor seedlings escalate faster (dry out sooner).
import { P } from './constants.js'

export const SEVERITY_STYLES = {
  green:        { bg: P.greenPale, border: P.greenLight, text: P.green },
  gold:         { bg: P.warn,      border: P.warnBorder, text: '#7a5c00' },
  terra:        { bg: '#fde8e0',   border: P.terra,      text: P.terra },
  'terra-bold': { bg: '#fcd7c4',   border: P.terra,      text: P.bannerInk },
}

// BUG-CADENCEONEDAY-001 — a one-day cadence has no "overdue" state to be in. On a weekly plant
// "3 days overdue" means the gap is 43% longer than the plant wants; on a daily plant it means the
// calendar advanced three days, which is a fact about Tuesday, not about the plant. 82 of 228 live
// plantings resolve to 1 (correctly, for ~54 of them — the cultivar profiles say "grow bags likely
// daily summer" in their own words), so escalating every one of them a tier per elapsed day turns a
// met-eight-days-running cadence into an 80-row backlog. The number stays; the backlog framing goes.
export const DAILY_INTERVAL_DAYS = 1
export function isDailyCadence(intervalDays) { return intervalDays === DAILY_INTERVAL_DAYS }

// `intervalDays` is OPTIONAL on both functions below: callers that don't know the cadence (the
// Dashboard WaterMeTile groups per PROJECT, where plantings legitimately mix intervals, so there is
// no single interval to pass) get byte-identical behaviour to before.
export function severityTier(nextWaterAtIso, locationType, intervalDays) {
  // Pinned at gold — the "needed today" tier — and never escalating on elapsed days alone. The
  // last-watered fact is not lost: it rides in the label/band text, as a fact rather than a demand.
  if (isDailyCadence(intervalDays)) return 'gold'
  const daysOver = (Date.now() - new Date(nextWaterAtIso).getTime()) / 86400000
  if (locationType === 'indoor_seedling' && daysOver >= 1) return 'terra-bold'
  if (daysOver >= 3) return 'terra-bold'
  if (daysOver >= 1) return 'terra'
  return 'gold'
}

// Compact overdue label for the Garden Today strip. The dashboard water_due query only
// returns rows with next_water_at < NOW(), so daysOver >= 0 always.
export function overdueLabel(nextWaterAtIso, intervalDays) {
  if (isDailyCadence(intervalDays)) return 'due today'
  const daysOver = Math.floor((Date.now() - new Date(nextWaterAtIso).getTime()) / 86400000)
  if (daysOver <= 0) return 'due today'
  if (daysOver === 1) return '1 day overdue'
  return daysOver + ' days overdue'
}
