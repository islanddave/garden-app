// Watering-severity single source of truth (L-075). Extracted verbatim from Dashboard.jsx
// so the Dashboard WaterMeTile and the Garden-tab Today strip render IDENTICAL severity
// tiers. daysOver = time past next_water_at; indoor seedlings escalate faster (dry out sooner).
import { P } from './constants.js'

export const SEVERITY_STYLES = {
  green:        { bg: P.greenPale, border: P.greenLight, text: P.green },
  gold:         { bg: P.warn,      border: P.warnBorder, text: '#7a5c00' },
  terra:        { bg: '#fde8e0',   border: P.terra,      text: P.terra },
  'terra-bold': { bg: '#fcd7c4',   border: P.terra,      text: '#7a2a10' },
}

export function severityTier(nextWaterAtIso, locationType) {
  const daysOver = (Date.now() - new Date(nextWaterAtIso).getTime()) / 86400000
  if (locationType === 'indoor_seedling' && daysOver >= 1) return 'terra-bold'
  if (daysOver >= 3) return 'terra-bold'
  if (daysOver >= 1) return 'terra'
  return 'gold'
}

// Compact overdue label for the Garden Today strip. The dashboard water_due query only
// returns rows with next_water_at < NOW(), so daysOver >= 0 always.
export function overdueLabel(nextWaterAtIso) {
  const daysOver = Math.floor((Date.now() - new Date(nextWaterAtIso).getTime()) / 86400000)
  if (daysOver <= 0) return 'due today'
  if (daysOver === 1) return '1 day overdue'
  return daysOver + ' days overdue'
}
