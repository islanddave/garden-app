// src/lib/todayV2/verdict.js — the redesigned Today's GLANCE CARD, as data (V5-TODAYREDESIGN-001 S3; plan-v2 §4
// "Glance card", §8 S3, §13 SF9 update). PURE: a plan in, sentences out — no React state, no clock, no network.
//
// THE HEADLINE is WeatherWidget's headlineFor, printed VERBATIM from the same two lane verdicts the card computes
// (computeWateringScale → pillState) and the same count V1 hands it (the plan's water_due length), so the glance
// and the card it opens into cannot disagree. A KNOWN empty water list never gets a watering imperative (§13 SF9
// update): that guard is headlineFor's own first line (BUG-WATERAUTUMNDEMAND-001), and NOTHING_DUE below names
// the sentence it returns.
//
// THE URGENT PHRASE, one at most, by precedence freeze > frost > hot:
//   freeze  tonight's low under FREEZE_BELOW_F (40°F), the engine cue's own "Freeze tonight" bar, read off the one
//           low the card, the cue and the frost line all print (agreedTonightLow when a frost line names
//           tonight, else the plan's) — the §3 `lowRaw`;
//   frost   a frost line names tonight (pickFrostLines with the plan's current lows, so a warmed, retired
//           advisory stays quiet), in the line's own words: "frost watch" for a radiative trip, "frost possible"
//           otherwise;
//   hot     the plan's hot day (engine: high ≥ 88°F).
//
// THE RAIN LINES are rainSentences with the four regime flags derived EXACTLY as WeatherWidget derives them —
// rainSentences' header: a second consumer that derives them differently prints different sentences.
import { computeWateringScale, pillState } from '../wateringScale.js'
import { headlineFor, forecastMissing, isStaleSnapshot, asOfLabel } from '../../components/today/WeatherWidget.jsx'
import { rainSentences } from '../rainSentences.js'
import { pickFrostLines, currentLows, FREEZE_BELOW_F } from '../frostAlertLine.js'
import { agreedTonightLow } from '../tonightLow.js'

export const NOTHING_DUE = 'Nothing due for watering today.'

function num(v) {
  if (typeof v !== 'number' && !(typeof v === 'string' && v.trim() !== '')) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// -> the verdict sentence. `plan` is the stored daily plan (plan.weather, plan.hydrology, plan.water_due).
export function glanceHeadline(plan) {
  const scale = computeWateringScale(plan?.hydrology || {}, plan?.weather || {})
  const containersDo = pillState(scale.containers) === 'do'
  const bedsDo = pillState(scale.beds) === 'do'
  const waterDueCount = Array.isArray(plan?.water_due) ? plan.water_due.length : 0
  return headlineFor(containersDo, bedsDo, waterDueCount)
}

// -> { kind: 'freeze'|'frost'|'hot', text } | null. `agreed` is agreedTonightLow(plan) when the page already has it.
export function urgentPhrase(plan, agreed) {
  if (!plan) return null
  const ag = agreed === undefined ? agreedTonightLow(plan) : agreed
  const lowRaw = ag ? ag.lowRaw : num(plan.weather?.tonightLow)
  if (lowRaw != null && lowRaw < FREEZE_BELOW_F) return { kind: 'freeze', text: 'freeze tonight' }
  const { tonight } = pickFrostLines(plan.alerts_sent, currentLows(plan))
  if (tonight) return { kind: 'frost', text: tonight.trip === 'radiative' ? 'frost watch tonight' : 'frost possible tonight' }
  if (plan.weather?.hot === true) return { kind: 'hot', text: 'hot today' }
  return null
}

// -> { rainNote, nextNote, gaugeMeasured } — rainSentences over the card's own flags (WeatherWidget.jsx, the
// `live` / `stale` / `uncertain` / `incomplete` / `showery` / `noForecast` block).
export function glanceRain({ hydrology, liveHydrology = null, generatedAt = null, planDate = null }) {
  const h = hydrology && typeof hydrology === 'object' ? hydrology : {}
  const live = !!(liveHydrology && (liveHydrology.today_precip_in != null || liveHydrology.tomorrow_precip_in != null))
  const stale = isStaleSnapshot(generatedAt, planDate)
  const uncertain = !!(h.status?.uncertainty?.flag) && !stale
  const incomplete = uncertain && h.status?.ok === false
  const showery = uncertain && !incomplete
  const noForecast = forecastMissing(h)
  return rainSentences({ hydrology: h, liveHydrology, live, uncertain, showery, noForecast, generatedAt })
}

// The closed card's stale marker (plan-v2 §4, §6.6): a plan served from the service worker's cache, or dated
// before today on this device, opens nothing (§3) and says how old it is. null when the plan is today's.
// `today` is the device's YYYY-MM-DD (todayLocalISO).
export function staleMarker({ planDate, generatedAt, fromCache = false, today }) {
  const at = asOfLabel(generatedAt)
  if (fromCache) return at ? `Offline · plan as of ${at}` : 'Offline · an earlier plan'
  if (!planDate || !today || planDate >= today) return null
  const lead = planDate === dayBefore(today) ? 'Yesterday’s plan' : 'An older plan'
  return at ? `${lead} · as of ${at}` : lead
}

function dayBefore(iso) {
  const d = new Date(`${iso}T12:00:00Z`)
  if (isNaN(d.getTime())) return null
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}
