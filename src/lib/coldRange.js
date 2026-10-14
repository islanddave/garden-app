// V5-WXCOLDBAND-001 — the forecast cold range beside Today's low ("as cold as 41°").
//
// The number is the WeatherNext 3 ensemble's cold end for tonight (the lowest hourly 10th percentile),
// sent from the owner's Mac each morning and served by GET /api/daily-plan as `cold_range`
// (lambda/daily-plan-read/coldRange.js). Display only: nothing alerts off it, no alert styling.
//
// Shown ONLY when all of these hold, otherwise nothing renders (a missed morning is a blank, never a
// wrong or old number):
//   * the payload carries a finite low_f and its night_date is the plan's date;
//   * the plan's date is today on this device (a cached or yesterday's plan shows no range);
//   * rounded, it is COLDER than the low the card prints. Equal or warmer adds nothing, and a cold end
//     printed above the low would read as a contradiction.
import { todayLocalISO } from './dateLocal.js'

export function coldRangeLow(coldRange, { planDate, lowShown, today = todayLocalISO() } = {}) {
  if (!coldRange || typeof coldRange !== 'object') return null
  const low = coldRange.low_f
  if (typeof low !== 'number' || !Number.isFinite(low)) return null
  if (!planDate || coldRange.night_date !== planDate || planDate !== today) return null
  const cold = Math.round(low) + 0          // + 0: a -0.4 low prints "0°", never "-0°"
  if (lowShown == null) return null
  const shown = Number(lowShown)
  if (!Number.isFinite(shown) || cold >= Math.round(shown)) return null
  return cold
}
