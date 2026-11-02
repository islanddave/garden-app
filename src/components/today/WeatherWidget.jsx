import React from 'react'
import Icon from '../Icon.jsx'
import { computeWateringScale, canRail, pillState } from '../../lib/wateringScale.js'
import { P, tokens, ICON, ICON_COLORS } from '../../lib/tokens.js'
import { rainSentences, basisTimeLabel } from '../../lib/rainSentences.js'
import ColdRangeNote from './ColdRangeNote.jsx'

// Weather widget. The watering-can scale (computeWateringScale/canRail/pillState) is byte-identical
// to LOCKED v1, as are the probability-gated rain note and the stale/uncertain caveats' wording.
//   Tier 1: condition icon + highToday (bold) / tonightLow (medium), sun/moon minis, no labels.
//   Tier 2: two STACKED full-width lanes [target icon] [label] [can rail | pause shape];
//           pot = containers, mound+sprout = in-ground. N filled cans of 3 = water at intensity N;
//           pause SHAPE = hold/skip (3-channel: count + text + color + shape). level>=0.5 -> sage "do",
//           level 0 -> gold-tint "wait". Headline + rain note restate the guidance (WCAG 1.4.10).
// Operational surface (Reward-UX §7): semantic state color is appropriate; no reward-surface rules.
//
// There is no "Why?" lane expander: each lane is a plain <div> (not a <button>) whose aria-label
// states its actual recommendation. headlineFor() is WCAG-load-bearing. DrG (drgReasoning.js) is the
// WHY surface; Today is the ACTION surface.
//
// The stale/uncertain caveats are NOT gated on the live overlay. The overlay replaces ONE
// informational figure (the rain line); it refreshes neither the plan nor the weather pattern, so it
// must not silence statements about either. A stale gauge-vs-card gap was the failure shape: a
// current timestamp over a measurement frozen at plan generation, with the one caveat that explained
// the gap suppressed. The measured figure therefore carries its own `as of {time}` inline.
//
// Icons: the watering can (care.wateringCanFill), the hold shape (care.pause), the `clear`
// condition and the day-high mini (care.sun), and the rain-note mini (care.rainPct) render through
// the shared <Icon>. Six stay inline and say why at their site (five because the whole
// ConditionIcon family occupies ONE slot and must stay internally consistent, and the only twins
// for its cloud members are mono LINE glyphs). Every surviving stroke is an ICON token.
// COLOUR IS NEVER FLATTENED HERE: the gold sun keeps its ICON_COLORS regions, and every mono glyph
// is coloured by the CONSUMER (iconAnchors: the weather surface sets `color` per condition, so hue
// is never baked).

// Token surface: sage "do" family, gold-tint "wait" family, BLUE watering can (water != green).
const PAL = {
  cardBg: P.white, cardBorder: P.border,
  tempHi: P.dark, tempLo: P.mid, micro: P.light,
  // do lane — sage family
  doBg: P.greenPale, doBorder: P.greenLight, doInk: P.greenDeep,
  doCan: ICON_COLORS.dropBody, doGhost: P.border, // can fill BLUE; empty slots = border outline
  // wait lane — gold-tint (light gold bg, gold ink/border; >=4.5:1 on the tint)
  waitBg: '#fbf3df', waitBorder: P.gold, waitInk: P.gold,
  // warn (stale) = gold-tint warn tokens
  warnBg: '#fbf3df', warnBorder: P.gold, warnInk: P.gold,
}

// One rail can: care.wateringCanFill is the registry glyph drawn for this job (one parametric
// glyph, water level driven by a --fill CSS var), so a half can is an actual half-full can. Colour
// stays on the consumer: blue once there is water in it, border-grey when there is not.
const Can = ({ fill = 1, color, ghost }) => (
  <Icon name="care.wateringCanFill" size={24} decorative
    style={{ color: fill === 0 ? ghost : color, '--fill': `${Math.round(fill * 100)}%` }} />
)

const PotIcon = ({ color }) => <Icon name="care.containers" size={23} decorative style={{ color }} />
const BedIcon = ({ color }) => <Icon name="care.inground" size={23} decorative style={{ color }} />
// Pause SHAPE for level 0: a distinct glyph (not mere can-absence), a 3-channel hold cue tinted to
// the gold-tint wait family so the shape + the "Hold" text + the gold color all read the same
// verdict. The ring that gives the mark its mass against a 3-can rail is CSS; the stroke is the
// ICON.minStroke token. aria-hidden, not labelled: the lane above is role="img" with the full
// verdict in its name, so descendants are presentational.
const PauseIcon = ({ color }) => (
  <span aria-hidden="true" style={{
    width: 24, height: 24, boxSizing: 'border-box', borderRadius: '50%',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: PAL.warnBg, border: `${ICON.minStroke}px solid ${color}`, color,
  }}>
    <Icon name="care.pause" size={20} decorative />
  </span>
)

// The condition slot ships at 44px and its glyphs are authored in a 64 viewBox. Icon.jsx's rule for
// size >= 32 is ICON.strokeHero DEVICE px, so the 64-space equivalent of that one token is the token
// scaled by viewBox/size. Every stroke that survives in this family is this constant.
const WX_VIEWBOX = 64, WX_SIZE = 44
const WX_STROKE = +(ICON.strokeHero * WX_VIEWBOX / WX_SIZE).toFixed(2)

// WMO weather code -> condition glyph (44px). Coarse buckets cover the Conway range; unknown -> overcast.
//
// `clear` routes to the registry, the other five deliberately do not: this is ONE SLOT rendering
// one member per day. care.sun is a color-candidate whose regions resolve to the very ICON_COLORS
// this file paints with, so swapping it changes nothing visible. The only twins the cloud members
// have (care.cloud and event.rain) are mono LINE glyphs, markedly lighter than these solid fills;
// routing one of six would put a solid cloud in this slot on Tuesday and an outline cloud on
// Wednesday. Rain/snow are also TWO-hue (green cloud + blue water), which a single currentColor
// cannot carry. Levelling these up properly means filled colour VARIANTS on care.cloud and
// event.rain in the data-region/colorFills pattern, a shared-registry change.
//
// "unknown" includes a stored null, not only an absent key. fetchNWS starts the cosmetic Open-Meteo
// call at `code = null` and keeps it on a timeout, a network error or an HTML 503, and
// engine.generatePlan stores it verbatim. A `{ code = 3 }` default covers undefined only, so a null
// would reach Number(null) === 0 (WMO "clear sky") and a failed fetch would draw a sun titled
// "clear". `??` sends null down the same overcast path as an absent code; a real 0 is still clear.
export function ConditionIcon({ code }) {
  const c = Number(code ?? 3)
  if (c === 0 || c === 1) return <Icon name="care.sun" size={WX_SIZE} title="clear" />
  if (c === 2) return (
    <svg width={WX_SIZE} height={WX_SIZE} viewBox={`0 0 ${WX_VIEWBOX} ${WX_VIEWBOX}`} aria-label="partly cloudy">
      <circle cx="24" cy="24" r="9" fill={ICON_COLORS.sunBody} />
      <g stroke={ICON_COLORS.sunRays} strokeWidth={WX_STROKE} strokeLinecap="round"><path d="M24 8v5M8 24h5M13 13l3 3" /></g>
      <path d="M22 50 Q15 50 15 44 Q15 38 22 38 Q23 31 32 31 Q40 31 41 38 Q49 38 49 45 Q49 50 44 50 Z" fill={P.greenLight} />
    </svg>
  )
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return (
    <svg width={WX_SIZE} height={WX_SIZE} viewBox={`0 0 ${WX_VIEWBOX} ${WX_VIEWBOX}`} aria-label="rain">
      <path d="M16 40 Q8 40 8 32 Q8 25 15 24 Q16 15 26 15 Q34 15 36 23 Q44 22 46 30 Q53 30 53 37 Q53 40 49 40 Z" fill={P.greenLight} />
      <g stroke={ICON_COLORS.dropBody} strokeWidth={WX_STROKE} strokeLinecap="round"><path d="M20 46l-2 6M30 46l-2 6M40 46l-2 6" /></g>
    </svg>
  )
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return (
    <svg width={WX_SIZE} height={WX_SIZE} viewBox={`0 0 ${WX_VIEWBOX} ${WX_VIEWBOX}`} aria-label="snow">
      <path d="M16 40 Q8 40 8 32 Q8 25 15 24 Q16 15 26 15 Q34 15 36 23 Q44 22 46 30 Q53 30 53 37 Q53 40 49 40 Z" fill={P.greenLight} />
      <g fill={ICON_COLORS.dropBody}><circle cx="20" cy="50" r="2" /><circle cx="32" cy="52" r="2" /><circle cx="44" cy="50" r="2" /></g>
    </svg>
  )
  // Fog's three bars are rects, not strokes: they are this family's mass, the job every sibling does
  // with a fill, so they keep their geometry rather than a stroke retuned to WX_STROKE, which would
  // thin the only glyph here that has nothing else to carry it.
  if (c >= 45 && c <= 48) return (
    <svg width={WX_SIZE} height={WX_SIZE} viewBox={`0 0 ${WX_VIEWBOX} ${WX_VIEWBOX}`} aria-label="fog">
      <g fill={P.greenLight}>
        <rect x="9.5" y="23.5" width="45" height="5" rx="2.5" />
        <rect x="7.5" y="33.5" width="49" height="5" rx="2.5" />
        <rect x="11.5" y="43.5" width="41" height="5" rx="2.5" />
      </g>
    </svg>
  )
  return (
    <svg width={WX_SIZE} height={WX_SIZE} viewBox={`0 0 ${WX_VIEWBOX} ${WX_VIEWBOX}`} aria-label="overcast">
      <path d="M16 44 Q8 44 8 36 Q8 29 15 28 Q16 19 26 19 Q34 19 36 27 Q44 26 46 34 Q53 34 53 41 Q53 44 49 44 Z" fill={P.greenLight} />
      <path d="M22 50 Q15 50 15 44 Q15 38 22 38 Q23 31 32 31 Q40 31 41 38 Q49 38 49 45 Q49 50 44 50 Z" fill={P.greenLight} />
    </svg>
  )
}

// Honest presentation: a frozen nightly snapshot, NOT a live reading. Exported so Today's care list
// can stamp its basis time in the SAME copy grammar; a second vocabulary for "how old is this"
// would add cognitive load rather than remove it.
export function asOfLabel(generatedAt) {
  if (!generatedAt) return null
  const d = new Date(generatedAt)
  if (isNaN(d.getTime())) return null
  const f = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...opts }).format(d)
  return `${f({ month: 'short', day: 'numeric' })} · ${f({ hour: 'numeric', minute: '2-digit' })}`
}
// Turns the "Open-Meteo" attribution into the truth. `st` is the stored plan's `hydrology.station`
// provenance bag (station.mergeStationHydrology/mergeStationWeather); it is ABSENT entirely when no
// WS-2902 binds to the Space, which is the degrade path: return null, the caller keeps the
// pre-existing copy, and we never invent a provenance we were not told.
//
// Forecast is ALWAYS part of the picture when the gauge is contributing: a rain gauge cannot report
// tomorrow_/upcoming_ and those fields drive both the rain note and the lanes, so the gauge case is
// "rain gauge + forecast", never a bare "rain gauge" that would over-claim the forecast half. The
// exception is when the forecast came back EMPTY (see forecastMissing): there is no forecast half to
// claim, so the caller passes `forecast: false` and the gauge is named alone.
//
// Deliberately NOT surfaced here: station_mac, station_age_min, station_fresh,
// today_remaining_basis/_from_hour/_fallback, station_temp_f, microclimate_offset, low_source, and
// the raw enum values themselves. Those are engine internals and belong in the admin-gated Garden
// Activity view.
export function hydrologySourceLabel(st, { forecast = true } = {}) {
  if (!st) return null
  const gauged = st.recent_source === 'station' || st.today_source === 'station' || st.today_source === 'station+forecast'
  if (gauged) return forecast ? 'rain gauge + forecast' : 'rain gauge'
  // No gauge contribution. Say so, and say why: a silent fallback is the defect. 'stale' means the
  // station stopped reporting; 'warmup' means it is reporting but has no lookback yet. Calling
  // warmup "offline" would be a false statement about the hardware, so the two do not share copy.
  if (st.recent_source !== 'forecast' && st.today_source !== 'forecast') return null // nothing usable — claim nothing
  if (st.station_uncertainty === 'stale') return 'forecast · gauge offline'
  if (st.station_uncertainty === 'warmup') return 'forecast · gauge warming up'
  return 'forecast'
}
// The caveat for the OTHER thing engine.hydrologyStatus flags. The flag is raised for a showery
// regime (status.ok true: the figures exist and can still move) AND for missing precip data
// (status.ok false: some figures do not exist). "Showery pattern" for both would, on a
// forecast-outage day, assert a weather pattern nobody had forecast.
// "The watering call above" is the two lanes, so the sentence is keyed on what THEY read:
// wateringScale.measuredWater = recent_precip_in + today_observed_in. The gauge is named when it
// supplied either (station.mergeStationHydrology: recent_source 'station', or today_observed_in, which
// only a fresh gauge sets); that includes a gauge still warming up, whose today reading the lanes count
// although the engine's list does not (windowPrecip is null without recent). With neither, the lanes and
// the engine count no rain at all. "Didn't fully" covers a whole outage and a partial one alike.
export function incompleteForecastCopy(hydrology) {
  const lead = 'The rain forecast didn’t fully come through for today’s plan'
  if (hydrology?.station?.recent_source === 'station' || Number.isFinite(hydrology?.today_observed_in)) {
    return `${lead}. The watering call above still counts what the rain gauge measured.`
  }
  if (Number.isFinite(hydrology?.recent_precip_in)) return `${lead}. The watering call above still counts recent rain.`
  return `${lead}, so the watering call above doesn’t count on any rain.`
}
// Did the forecast fetch return NOTHING that this snapshot shows? The incomplete banner
// (incompleteForecastCopy, above) says so in words; this keeps the stamp and the rain line beside it
// from saying otherwise. On an error body (fetchPrecip -> null) the card would otherwise still print
// "· Open-Meteo" with no gauge bound, and with one "rain gauge + forecast" plus "none more
// expected", the last read off the 0 that station.mergeStationHydrology writes for today's remainder
// when there is no forecast to subtract from (station.test.js "no forecast to add"). That 0 is an
// absence, not a forecast of a dry evening.
// Gated on the engine's own incomplete verdict (hydrologyStatus ok:false), so a complete snapshot
// never moves. Then "nothing" means: none of the fields only a forecast can supply, and no figure
// the provenance bag credits to the forecast; or, with no bag, no rain figure at all (every one of
// them would have been Open-Meteo's). A PARTIAL forecast is not missing: whatever did arrive keeps
// its source.
// Keyed on the figures, never on today_remaining_basis/_fallback: a complete snapshot with no hourly
// block carries the same 'wholeday'/'no_hourly' pair, and its "none more expected" is a real
// forecast statement.
const FORECAST_ONLY = ['today_pop', 'tomorrow_precip_in', 'tomorrow_pop', 'upcoming_precip_in']
export function forecastMissing(hydrology) {
  if (hydrology?.status?.ok !== false) return false
  if (FORECAST_ONLY.some((k) => Number.isFinite(hydrology[k]))) return false
  const st = hydrology.station
  if (st && typeof st === 'object') {
    return !(st.recent_source === 'forecast' || st.today_source === 'forecast' || st.today_source === 'station+forecast'
      || st.today_remaining_basis === 'hourly')
  }
  return !Number.isFinite(hydrology.recent_precip_in) && !Number.isFinite(hydrology.today_precip_in)
}
function isStaleSnapshot(generatedAt, planDate) {
  if (!generatedAt || !planDate) return false
  const d = new Date(generatedAt)
  if (isNaN(d.getTime())) return false
  const genEtDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  return genEtDate < planDate
}
// The V2 glance card derives the rain line's `uncertain` flag exactly as this card does.
export { isStaleSnapshot }
// basisTimeLabel (src/lib/rainSentences.js, the ET time half of asOfLabel's grammar) plus the 'just
// now' fallback: one formatter for the stamp and the rain line, not two.
function liveTimeLabel(refreshedAt) {
  return basisTimeLabel(refreshedAt) || 'just now'
}

// Derives the no-wrap headline sentence from the two lane verdicts.
//
// Honesty guard: `waterDueCount` is the length of the SAME plan's water_due list, rendered by
// <CareNeeded> below this headline. Today carries two independently-thresholded watering models
// (this one zeroes both lanes at wetNow >= 0.8 with NO PoP gate; the engine suppresses at 1.0" gated
// on PoP >= 60), so a morning landing between them would print the ABSOLUTE sentence "All set — no
// watering needed today." directly above a full watering list.
//
// This guard does not adjudicate which model is right. It only forbids the one sentence that is
// unconditionally FALSE while the list is non-empty. Scoped to the both-hold branch: the other
// three sentences are lane advice, not a claim about the whole page.
// Copy is length-budgeted for a 390px Android viewport (the visible line is nowrap + ellipsis; the
// full sentence ships as sr-only text, so the a11y contract is never the truncated one).
function headlineFor(containersDo, bedsDo, waterDueCount = 0) {
  if (containersDo && bedsDo) return 'Water both — containers and beds today.'
  if (containersDo && !bedsDo) return 'Water containers, skip the beds today.'
  if (!containersDo && bedsDo) return 'Water the beds, hold containers.'
  if (waterDueCount > 0) return `Rain may cover today's list — ${waterDueCount} still due.`
  return 'All set — no watering needed today.'
}
// The V2 glance card prints this verdict verbatim.
export { headlineFor }

export default function WeatherWidget({
  weather = { tonightLow: 50, highToday: 78, code: 3, hot: false },
  hydrology = { recent_precip_in: 0.05, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0.74, tomorrow_pop: 63, rain_coming: true },
  generatedAt = null,
  planDate = null,
  liveHydrology = null,
  refreshedAt = null,
  waterDueCount = 0,
  lowShown = null,
  coldRange = null,
  headline: headlineShown = null,
  coldRangePhrase = undefined,
}) {
  // `lowShown` is DISPLAY ONLY: the night-low figure below prints it when set (Today passes the one
  // low it prints for tonight, src/lib/tonightLow.js). It never reaches the watering scale; the
  // lanes are the nightly plan's verdict, and a display change must not move care.
  const scale = computeWateringScale(hydrology, weather)

  // Intraday freshness: live precip overlays the INFORMATIONAL rain figure + stamp ONLY; the
  // watering recommendation (lanes/scale) STAYS on the nightly hydrology.
  const live = !!(liveHydrology && (liveHydrology.today_precip_in != null || liveHydrology.tomorrow_precip_in != null))
  const asOf = asOfLabel(generatedAt)
  const liveAt = live ? liveTimeLabel(refreshedAt) : null
  // Neither caveat is gated on `live`: `stale` is about the PLAN (a previous-day generation still
  // driving the lanes and the measured totals) and `uncertain` is the engine's verdict on the
  // WEATHER PATTERN, which a showery day has whatever time you read it. A client-side forecast fetch
  // refreshes neither. `stale` still wins over `uncertain`: one banner, not two. The other two
  // readers of `uncertain` (`showToday` and the rain-line render gate) already OR it with `live`.
  const stale = isStaleSnapshot(generatedAt, planDate)
  const uncertain = !!(hydrology?.status?.uncertainty?.flag) && !stale
  // The flag covers two different states, so split it by what it means. `incomplete` is
  // hydrologyStatus's missing-data verdict (ok:false), `showery` is everything else it flags. Only
  // showery may drive the "could climb" note or open the rain line on its own: on an incomplete
  // snapshot there is nothing to hedge, and the line would print a chance floored from null.
  const incomplete = uncertain && hydrology?.status?.ok === false
  const showery = uncertain && !incomplete

  // Provenance rides on the NIGHTLY hydrology (the live overlay is a client-side Open-Meteo fetch
  // and carries none), so read it off `hydrology` regardless of the live branch. Absent bag -> the
  // pre-existing hardcoded copy; present bag -> whatever it actually says.
  const stationProv = (hydrology && typeof hydrology.station === 'object' && hydrology.station) || null
  // An empty forecast is named by nobody: the gauge alone when it contributed, otherwise nothing.
  // Not gated on `stale` or `live`: a previous-day snapshot names its sources as truly as today's
  // does, and the live stamp never shows this.
  const noForecast = forecastMissing(hydrology)
  const sourceLabel = stationProv ? hydrologySourceLabel(stationProv, { forecast: !noForecast }) : (noForecast ? null : 'Open-Meteo')

  // The rain line and the following-day line are composed in src/lib/rainSentences.js (shared with
  // the V2 glance card). rainNote comes back null while its display gate is shut; gaugeMeasured also
  // qualifies the live stamp below.
  const { rainNote, nextNote, gaugeMeasured } = rainSentences({ hydrology, liveHydrology, live, uncertain, showery, noForecast, generatedAt })

  // Derived headline. Both lane verdicts -> one no-wrap sentence; the lanes + rain note restate it.
  const containersDo = pillState(scale.containers) === 'do'
  const bedsDo = pillState(scale.beds) === 'do'
  // `headline` is DISPLAY ONLY, like `lowShown`: the V2 glance card passes the verdict its closed
  // state prints (verdict.js glanceHeadline), so opening the card never changes the sentence. Absent
  // (V1), the sentence is computed here.
  const headline = headlineShown || headlineFor(containersDo, bedsDo, waterDueCount)

  // A full-width stacked lane: [leading target icon] [label flex:1 min-width:0] [3-can rail OR pause shape].
  // Non-interactive.
  //
  // role="img" is REQUIRED here, not decoration. A bare <div aria-label> is prohibited ARIA: a
  // role-less div maps to role=generic, generic cannot be named, and the label is IGNORED; with the
  // children aria-hidden that renders the whole lane silent. role="img" supports naming and announces
  // the lane as one atomic unit, which is what it is: icon + rail are a single graphic.
  // BEWARE: getByLabelText matches the ATTRIBUTE and passes even when the name never reaches the
  // a11y tree; assert these lanes with getByRole('img', { name }), which is the real contract.
  // minHeight 44 is the lane's visual rhythm, not a tap target.
  const Lane = ({ level, Target, label }) => {
    const isDo = pillState(level) === 'do'
    const c = isDo
      ? { bg: PAL.doBg, br: PAL.doBorder, ink: PAL.doInk, can: PAL.doCan, ghost: PAL.doGhost }
      : { bg: PAL.waitBg, br: PAL.waitBorder, ink: PAL.waitInk }
    const cans = Math.round(level)
    return (
      <div
        role="img"
        aria-label={isDo ? `${label}: water — ${cans} of 3 cans` : `${label}: hold, no water needed today`}
        style={{
          width: '100%', boxSizing: 'border-box', minHeight: 44,
          borderRadius: tokens.radius.badge, display: 'flex', alignItems: 'center',
          gap: tokens.space.sm, padding: `${tokens.space.xs}px ${tokens.space.sm}px`,
          background: c.bg, textAlign: 'left',
          border: `1px solid ${c.br}`,
        }}>
        <Target color={c.ink} />
        <span aria-hidden="true" style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: tokens.type.sm, color: c.ink }}>{label}</span>
        <span aria-hidden="true" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
          {isDo ? (
            <span style={{ display: 'flex', alignItems: 'flex-end', gap: 3 }}>
              {canRail(level).map((f, i) => <Can key={i} fill={f} color={c.can} ghost={c.ghost} />)}
            </span>
          ) : <PauseIcon color={c.ink} />}
        </span>
      </div>
    )
  }

  return (
    // Region anchor for the Today layout gate's ordered census (testid, not heading text, so a copy
    // rename reds the census rather than emptying it).
    <div data-testid="today-weather" style={{
      width: '100%', maxWidth: '100%', boxSizing: 'border-box', margin: '0 auto',
      borderRadius: tokens.radius.card, padding: tokens.space.md,
      background: PAL.cardBg, border: `1px solid ${PAL.cardBorder}`, fontFamily: 'Inter, system-ui, sans-serif',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <ConditionIcon code={weather.code} />
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 1, lineHeight: 1 }}>
          <span style={{ fontWeight: 800, letterSpacing: '-0.02em', fontSize: 36, color: PAL.tempHi }}>{weather.highToday}&deg;</span>
          {/* Same gold sun as the `clear` condition, so it is the same registry entry. <Icon title>
              emits role="img", so the label reaches the a11y tree (a bare aria-label on an svg
              cannot name it).
              16, NOT 13: a 13px render normalises the rays to the 2.0 stroke floor, which closes
              the aperture between disc and rays so the mark reads as an asterisk beside the
              numeral; 16 is the first size where it reads as a sun. The moon opposite stays 11: it
              is a single crescent with no counter-space to lose. */}
          <Icon name="care.sun" size={16} title="day high" style={{ marginTop: 3 }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 1, lineHeight: 1, marginLeft: 2 }}>
          <span data-testid="weather-night-low" style={{ fontWeight: 600, letterSpacing: '-0.02em', fontSize: 23, color: PAL.tempLo }}>{lowShown ?? weather.tonightLow}&deg;</span>
          {/* Crescent moon: the one glyph in this file with NO registry twin of any kind. care.tempLow
              is the nearest key by meaning but it is a thermometer with a falling arrow, a different
              object entirely. Kept inline as a genuine single-use mark; it is a bare fill, so there
              is no stroke to be off-token. Drawing a care.moon is the follow-up if the weather
              family ever grows. */}
          <svg width="11" height="11" viewBox="0 0 24 24" style={{ marginTop: 2 }} role="img" aria-label="night low"><path d="M20 14.5A8 8 0 1 1 10.5 4 6.3 6.3 0 0 0 20 14.5Z" fill={P.mid} /></svg>
        </div>
        {/* The forecast's cold end, only when it is colder than the low above. */}
        {/* `coldRangePhrase`: the V2 glance card's "could reach"; absent (V1), the note's own words. */}
        <ColdRangeNote coldRange={coldRange} planDate={planDate} lowShown={lowShown ?? weather.tonightLow} phrase={coldRangePhrase} />
      </div>

      {/* No-wrap derived headline. The visible line is ellipsis-truncated, so it is NOT a faithful
          alternative: the full sentence ships as visually-hidden TEXT and the truncated copy is
          aria-hidden, so it never double-announces. aria-label on a role-less div is ignored
          (role=generic can't be named), so real text in the DOM is what makes this headline reach
          the a11y tree; it is the load-bearing restatement surface (WCAG 1.4.10). */}
      <div style={{ marginTop: tokens.space.sm }}>
        <span style={{
          position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
          overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
        }}>{headline}</span>
        <div aria-hidden="true" style={{
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%',
          fontWeight: 700, fontSize: tokens.type.sm, color: PAL.tempHi,
        }}>{headline}</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.xs, marginTop: tokens.space.sm }}>
        <Lane level={scale.containers} Target={PotIcon} label="Containers" />
        <Lane level={scale.beds} Target={BedIcon} label="In-ground beds" />
      </div>

      {/* The line's display gate (and why each of its five reasons opens it) lives beside the sentence in
          rainSentences: a shut gate returns rainNote null. */}
      {rainNote && (
        <div style={{ marginTop: tokens.space.sm, textAlign: 'center', fontSize: tokens.type.xs, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, color: PAL.micro }}>
          {/* care.rainPct is drawn for this exact line: its registry note calls it "the FORECAST twin
              of event.rain … one drop under a raised cloud reads as 'some chance', three streaks read
              as 'it is raining'", and every sentence this glyph sits beside is a forecast. Single-hue
              blue. */}
          <Icon name="care.rainPct" size={13} decorative style={{ color: ICON_COLORS.dropBody }} />
          {rainNote}
        </div>
      )}
      {/* Its own gate: the following day's rain can matter on a card whose own day is dry and quiet,
          which is exactly when the line above stays shut. */}
      {nextNote && (
        <div data-testid="weather-next-rain" style={{ marginTop: tokens.space.xs, textAlign: 'center', fontSize: tokens.type.xs, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, color: PAL.micro }}>
          <Icon name="care.rainPct" size={13} decorative style={{ color: ICON_COLORS.dropBody }} />
          {nextNote}
        </div>
      )}

      {live ? (
        <div style={{ marginTop: tokens.space.sm, textAlign: 'center', fontSize: tokens.type.xs, color: PAL.micro }}>
          {/* With a gauge on site the live overlay is forecast-ONLY (client Open-Meteo), so a bare
              "live" would let a predicted figure read as a measured one directly under a stamp that
              says "rain gauge" the rest of the day. Qualified only when a gauge exists to be confused
              with (`stationProv`) or when the card shows a measured "fallen" figure
              (`gaugeMeasured`), whether or not the provenance bag came through; no station -> copy
              unchanged. */}
          Updated {liveAt} &middot; {stationProv || gaugeMeasured ? 'live forecast' : 'live'}
        </div>
      ) : asOf ? (
        <div style={{ marginTop: tokens.space.sm, textAlign: 'center', fontSize: tokens.type.xs, color: PAL.micro }}>
          As of {asOf}{sourceLabel ? <> &middot; {sourceLabel}</> : null}
        </div>
      ) : null}
      {stale && (
        <div style={{
          marginTop: 6, textAlign: 'center', fontSize: tokens.type.xs, lineHeight: 1.35,
          color: PAL.warnInk, background: PAL.warnBg, border: `1px solid ${PAL.warnBorder}`,
          borderRadius: 9, padding: '5px 8px',
        }}>
          {/* What has not refreshed is the PLAN, so the banner names it: the lanes and the
              fallen/expected totals are read off a previous day's generation. It does not claim the
              forecast is stale, which is false when the live overlay is on, so it is true on both
              branches. */}
          &#9888; This is an older snapshot &mdash; today&rsquo;s plan hasn&rsquo;t refreshed yet, so the watering call and rain totals may be out of date.
        </div>
      )}
      {showery && (
        <div style={{
          marginTop: 6, textAlign: 'center', fontSize: tokens.type.xs, lineHeight: 1.35,
          color: PAL.warnInk, background: PAL.warnBg, border: `1px solid ${PAL.warnBorder}`,
          borderRadius: 9, padding: '5px 8px',
        }}>
          {/* The caveat survives because the showery uncertainty is real regardless of when the plan
              ran; it makes no claim about when the plan was generated. */}
          &#9888; Showery pattern &mdash; these amounts can still change through the day. The watering call above already plays it safe.
        </div>
      )}
      {incomplete && (
        <div style={{
          marginTop: 6, textAlign: 'center', fontSize: tokens.type.xs, lineHeight: 1.35,
          color: PAL.warnInk, background: PAL.warnBg, border: `1px solid ${PAL.warnBorder}`,
          borderRadius: 9, padding: '5px 8px',
        }}>
          {/* Same slot and precedence as the showery caveat (stale still outranks it), different
              claim: see incompleteForecastCopy. */}
          &#9888; {incompleteForecastCopy(hydrology)}
        </div>
      )}
    </div>
  )
}
