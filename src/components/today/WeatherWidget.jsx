import React from 'react'
import Icon from '../Icon.jsx'
import { computeWateringScale, canRail, pillState } from '../../lib/wateringScale.js'
import { P, tokens, ICON, ICON_COLORS } from '../../lib/tokens.js'

// Weather widget — V200 Slice 6 reskin (V4-THEME-001). The watering-can scale
// (computeWateringScale/canRail/pillState) is byte-identical to LOCKED v1, as are the
// probability-gated rain note (DRG-WXPROB-001) and the freshness/stale/uncertain caveats.
// The V200 pass was PRESENTATION ONLY: hardcoded PAL hexes -> V200 tokens, the two side-by-side
// pills became stacked full-width lanes, a NET-NEW no-wrap derived headline was added, and the card
// shed its hard 330px width (now 100% / border-box, no 320px overflow).
//
// V4-WATERWHY-002 (2026-07-16): the "Why?" lane expander is REMOVED — explicit supersede of
// V3-WATERWHY-001 by Dave's call (see wateringScale.js header). The lane was a <button> whose ONLY
// job was toggling that panel, so it is now a plain <div>: no aria-expanded/aria-controls, no
// chevron, no reduced-motion transition. Each lane gained an aria-label stating its actual
// recommendation — previously the button's "Why this…" aria-label MASKED the rail from screen
// readers, so the intensity is now announced where it wasn't before. headlineFor() is untouched and
// remains WCAG-load-bearing. DrG (drgReasoning.js) stays the WHY surface; Today is the ACTION surface.
//   Tier 1: condition icon + highToday (bold) / tonightLow (medium), sun/moon minis, no labels.
//   Tier 2: two STACKED lanes [target icon] [label] [can rail | pause shape];
//           pot = containers, mound+sprout = in-ground. N filled cans of 3 = water at intensity N;
//           pause SHAPE = hold/skip (3-channel: count + text + color + shape). level>=0.5 -> sage "do",
//           level 0 -> gold-tint "wait". Headline + rain note restate the guidance (WCAG 1.4.10).
// Operational surface (Reward-UX V101 §7): semantic state color is appropriate; no reward-surface rules.
//
// V4-WEATHERWIDGETICONS-001 (2026-09-02) — icon debt. This file held ELEVEN hand-rolled SVGs with
// seven off-token stroke widths on the post-login home screen. Five now render through the shared
// <Icon>: the watering can (care.wateringCanFill), the hold shape (care.pause), the `clear`
// condition and the day-high mini (care.sun), and the rain-note mini (care.rainPct). Six stay
// inline and say why at their site — five of them because the whole ConditionIcon family occupies
// ONE slot and must stay internally consistent, and the only twins for its cloud members are mono
// LINE glyphs. Every surviving stroke is now an ICON token; fog's off-token 5 is gone entirely.
// COLOUR IS NEVER FLATTENED HERE: the gold sun keeps its ICON_COLORS regions, and every mono glyph
// is coloured by the CONSUMER (iconAnchors §6 — "the weather surface sets `color` per condition,
// so hue is never baked"), which is the same blue/gold/grey it painted before.

// V200 token surface — sage "do" family, gold-tint "wait" family, BLUE watering can (water != green).
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

// DRG-WXPROB-001 — probability-gate the INFORMATIONAL rain AMOUNT. (unchanged) The deterministic
// Open-Meteo precipitation_sum over-reports the expected amount when the chance is low; below this PoP
// threshold we suppress the amount and show only the chance. At/above it we show a probability-weighted
// amount. Presentation only — the stored hydrology numbers + watering lanes are untouched.
const RAIN_POP_DISPLAY_THRESHOLD = 30 // percent; tunable display gate for the rain-amount figure
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100

// One rail can. Was a 64-viewBox hand-roll with four off-token strokes (2.6/3.4/3.6/2.2), a
// module-level mutable counter minting a per-instance clipPath id, and a partial state faked by
// clipping the LEFT HALF of a solid can. care.wateringCanFill is the registry glyph drawn for
// exactly this job — §9's "ONE parametric glyph, water level driven by a --fill CSS var", not N
// pre-rendered assets — so a half can is now an actual half-full can. Colour stays on the consumer
// per iconAnchors §6: blue once there is water in it, border-grey when there is not, which is the
// same two hues and the same empty/filled read the hand-roll carried.
const Can = ({ fill = 1, color, ghost }) => (
  <Icon name="care.wateringCanFill" size={24} decorative
    style={{ color: fill === 0 ? ghost : color, '--fill': `${Math.round(fill * 100)}%` }} />
)

const PotIcon = ({ color }) => <Icon name="care.containers" size={23} decorative style={{ color }} />
const BedIcon = ({ color }) => <Icon name="care.inground" size={23} decorative style={{ color }} />
// Pause SHAPE for level 0 — distinct glyph (not mere can-absence): 3-channel hold cue tinted to the gold-tint
// wait family so the shape + the "Hold" text + the gold color all read the same verdict.
// The two bars are care.pause now; the ring that gives the mark its mass against a 3-can rail is
// CSS rather than a hand-drawn <circle>, so the visual is unmoved and the off-token 1.6 stroke
// became the ICON.minStroke token it was already numerically equal to. aria-hidden, not labelled:
// the lane above is role="img" with the full verdict in its name, so descendants are presentational
// and the old aria-label="hold" never reached the a11y tree in the first place.
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
// scaled by viewBox/size. Every stroke that survives in this family is this constant — it replaces
// the hand-picked 4 (clear), 3 (partly cloudy), 3 (rain) and 5 (fog).
const WX_VIEWBOX = 64, WX_SIZE = 44
const WX_STROKE = +(ICON.strokeHero * WX_VIEWBOX / WX_SIZE).toFixed(2)

// WMO weather code -> condition glyph (44px). Coarse buckets cover the Conway range; unknown -> overcast.
//
// V4-WEATHERWIDGETICONS-001 — `clear` routes to the registry, the other five deliberately do not,
// and the reason is that this is ONE SLOT rendering one member per day. care.sun is a
// color-candidate whose regions resolve to the very ICON_COLORS this file was already painting with,
// so swapping it changes nothing a user could see. The only twins the cloud members have —
// care.cloud and event.rain — are mono LINE glyphs, and rendered side by side against these solid
// fills (measured, not assumed) they are markedly lighter. Routing one of six would put a solid
// cloud in this slot on Tuesday and an outline cloud on Wednesday, which is worse than either
// uniform choice; and rain/snow are TWO-hue (green cloud + blue water), which a single currentColor
// cannot carry at all. Levelling these up properly means filled colour VARIANTS on care.cloud and
// event.rain in the house data-region/colorFills pattern — a shared-registry change that belongs in
// its own row, not a silent downgrade taken here because a mono twin happened to exist.
function ConditionIcon({ code = 3 }) {
  const c = Number(code)
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
  // Fog's three bars were the one member drawn as STROKES, at an off-token 5. They were never a
  // line read — they are this family's mass, the job every sibling does with a fill — so they are
  // rects at the identical geometry rather than a stroke retuned to WX_STROKE, which would have
  // thinned the only glyph here that has nothing else to carry it.
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

// V3-WXFRESH-001 — honest presentation (unchanged). Frozen nightly snapshot, NOT a live reading.
// EXPORTED 2026-07-31 so Today's care list can stamp its basis time in the SAME copy grammar. A
// second vocabulary for "how old is this" would add cognitive load rather than remove it.
export function asOfLabel(generatedAt) {
  if (!generatedAt) return null
  const d = new Date(generatedAt)
  if (isNaN(d.getTime())) return null
  const f = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...opts }).format(d)
  return `${f({ month: 'short', day: 'numeric' })} · ${f({ hour: 'numeric', minute: '2-digit' })}`
}
// DRG-WXSTATION-002 (V200 §3 "surface source on Today") — turn the hardcoded "Open-Meteo" attribution into
// the truth. `st` is the stored plan's `hydrology.station` provenance bag written by handler.js:389 from
// station.mergeStationHydrology/mergeStationWeather; it is ABSENT entirely when no WS-2902 binds to the
// Space (handler only spreads the key when prov has entries), which is the degrade path: return null, the
// caller keeps the pre-existing copy, and we never invent a provenance we were not told.
//
// Forecast is ALWAYS part of the picture when the gauge is contributing — a rain gauge cannot report
// tomorrow_/upcoming_ (V200 B2) and those fields drive both the rain note and the lanes — so the gauge case
// is "rain gauge + forecast", never a bare "rain gauge" that would over-claim the forecast half.
//
// Deliberately NOT surfaced here (Jen-invisible rule): station_mac, station_age_min, station_fresh,
// today_remaining_basis/_from_hour/_fallback, station_temp_f, microclimate_offset, low_source, and the raw
// enum values themselves. Those are engine internals and belong in the admin-gated Garden Activity view.
export function hydrologySourceLabel(st) {
  if (!st) return null
  const gauged = st.recent_source === 'station' || st.today_source === 'station' || st.today_source === 'station+forecast'
  if (gauged) return 'rain gauge + forecast'
  // No gauge contribution. Say so, and say why — a silent fallback is the defect this exists to remove.
  // 'stale' means the station stopped reporting; 'warmup' means it is reporting but has no lookback yet.
  // Calling warmup "offline" would be a false statement about the hardware, so the two do not share copy.
  if (st.recent_source !== 'forecast' && st.today_source !== 'forecast') return null // nothing usable — claim nothing
  if (st.station_uncertainty === 'stale') return 'forecast · gauge offline'
  if (st.station_uncertainty === 'warmup') return 'forecast · gauge warming up'
  return 'forecast'
}
function isStaleSnapshot(generatedAt, planDate) {
  if (!generatedAt || !planDate) return false
  const d = new Date(generatedAt)
  if (isNaN(d.getTime())) return false
  const genEtDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  return genEtDate < planDate
}
function liveTimeLabel(refreshedAt) {
  if (!refreshedAt) return 'just now'
  const d = new Date(refreshedAt)
  if (isNaN(d.getTime())) return 'just now'
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(d)
}

// NET-NEW — derive the no-wrap headline sentence from the two lane verdicts.
//
// BUG-TODAYWATER-001 honesty guard (2026-08-12, Dave's call). `waterDueCount` is the length of the
// SAME plan's water_due list, rendered by <CareNeeded> two components below this headline. Today has
// carried two independently-thresholded watering models since the widget shipped — this one zeroes
// both lanes at wetNow >= 0.8 with NO PoP gate, the engine suppresses at 1.0" gated on PoP >= 60 —
// so any morning landing between them printed the ABSOLUTE sentence "All set — no watering needed
// today." directly above a full watering list. It happened on 2026-08-03 (0.98") and again on
// 2026-08-08 (0.99" over 78 listed plantings); the 0.02-class near-miss is what Dave actually sees.
//
// This guard does not adjudicate which model is right — the harmonization does that. It only forbids
// the one sentence that is unconditionally FALSE while the list is non-empty. Deliberately scoped to
// the both-hold branch: the other three sentences are lane advice, not a claim about the whole page.
// Copy is length-budgeted for a 390px Android viewport (the visible line is nowrap + ellipsis; the
// full sentence ships as sr-only text, so the a11y contract is never the truncated one).
function headlineFor(containersDo, bedsDo, waterDueCount = 0) {
  if (containersDo && bedsDo) return 'Water both — containers and beds today.'
  if (containersDo && !bedsDo) return 'Water containers, skip the beds today.'
  if (!containersDo && bedsDo) return 'Water the beds, hold containers.'
  if (waterDueCount > 0) return `Rain may cover today's list — ${waterDueCount} still due.`
  return 'All set — no watering needed today.'
}

export default function WeatherWidget({
  weather = { tonightLow: 50, highToday: 78, code: 3, hot: false },
  hydrology = { recent_precip_in: 0.05, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0.74, tomorrow_pop: 63, rain_coming: true },
  generatedAt = null,
  planDate = null,
  liveHydrology = null,
  refreshedAt = null,
  waterDueCount = 0,
}) {
  const scale = computeWateringScale(hydrology, weather)

  // DRG-WXROLL-001 — intraday freshness (unchanged). Live precip overlays the INFORMATIONAL rain figure +
  // stamp ONLY; the watering recommendation (lanes/scale) STAYS on the nightly hydrology.
  const live = !!(liveHydrology && (liveHydrology.today_precip_in != null || liveHydrology.tomorrow_precip_in != null))
  const asOf = asOfLabel(generatedAt)
  const liveAt = live ? liveTimeLabel(refreshedAt) : null
  const stale = !live && isStaleSnapshot(generatedAt, planDate)
  const uncertain = !live && !!(hydrology && hydrology.status && hydrology.status.uncertainty && hydrology.status.uncertainty.flag) && !stale

  // DRG-WXSTATION-002 — provenance rides on the NIGHTLY hydrology (the live overlay is a client-side
  // Open-Meteo fetch and carries none), so read it off `hydrology` regardless of the live branch.
  // Absent bag -> the pre-existing hardcoded copy, unchanged; present bag -> whatever it actually says.
  const stationProv = (hydrology && typeof hydrology.station === 'object' && hydrology.station) || null
  const sourceLabel = stationProv ? hydrologySourceLabel(stationProv) : 'Open-Meteo'

  const rainSrc = live ? liveHydrology : hydrology
  const todayIn = rainSrc.today_precip_in ?? 0
  const todayPop = rainSrc.today_pop ?? 0
  const showToday = todayIn > 0 || ((uncertain || live) && todayPop >= 50)
  const rainIn = showToday ? todayIn : (rainSrc.tomorrow_precip_in ?? rainSrc.upcoming_precip_in ?? 0)
  const rainPop = showToday ? todayPop : (rainSrc.tomorrow_pop ?? 0)
  const rainWhen = showToday ? 'today' : 'tomorrow'
  const rainAmtWeighted = round2(rainIn * rainPop / 100)
  const rainNote = uncertain
    ? (rainIn >= 0.1
        ? `~${rainIn.toFixed(2)}″ ${rainWhen} · ${rainPop}% — could climb`
        : `${rainPop}% chance ${rainWhen} · little so far, could climb`)
    : (rainPop < RAIN_POP_DISPLAY_THRESHOLD
        ? `${rainPop}% chance of rain ${rainWhen}`
        : `${rainAmtWeighted.toFixed(2)}″ rain expected ${rainWhen} · ${rainPop}%`)

  // Derived headline (NET-NEW). Both lane verdicts -> one no-wrap sentence; the lanes + rain note restate it.
  const containersDo = pillState(scale.containers) === 'do'
  const bedsDo = pillState(scale.beds) === 'do'
  const headline = headlineFor(containersDo, bedsDo, waterDueCount)

  // A full-width stacked lane: [leading target icon] [label flex:1 min-width:0] [3-can rail OR pause shape].
  // V4-WATERWHY-002: non-interactive (was a <button> only to toggle the removed Why panel).
  //
  // role="img" is REQUIRED here, not decoration. A bare <div aria-label> is prohibited ARIA: a
  // role-less div maps to role=generic, generic cannot be named, and the label is IGNORED — with the
  // children aria-hidden that renders the whole lane silent. (Shipped exactly that to dev in 2851779
  // and caught it in the pre-promote regression pass; an a11y-tree dump showed ZERO roles and the
  // words "Containers"/"In-ground beds" absent entirely.) role="img" supports naming and announces
  // the lane as one atomic unit, which is what it is: icon + rail are a single graphic.
  // BEWARE: getByLabelText matches the ATTRIBUTE and passes even when the name never reaches the
  // a11y tree — assert these lanes with getByRole('img', { name }), which is the real contract.
  // minHeight 44 is kept: it's the lane's visual rhythm, not a tap target.
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
    <div style={{
      width: '100%', maxWidth: '100%', boxSizing: 'border-box', margin: '0 auto',
      borderRadius: tokens.radius.card, padding: tokens.space.md,
      background: PAL.cardBg, border: `1px solid ${PAL.cardBorder}`, fontFamily: 'Inter, system-ui, sans-serif',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <ConditionIcon code={weather.code} />
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 1, lineHeight: 1 }}>
          <span style={{ fontWeight: 800, letterSpacing: '-0.02em', fontSize: 36, color: PAL.tempHi }}>{weather.highToday}&deg;</span>
          {/* Same gold sun as the `clear` condition, so it is the same registry entry. The label now
              actually reaches the a11y tree: <Icon title> emits role="img", where the hand-rolled
              svg carried a bare aria-label that role=graphics-document cannot be named by — this
              mini and its moon sibling had been silent, the WATERWHY blackout shape.
              16, NOT the hand-roll's 13. The hand-roll inked its rays at 1.08 device px, which is
              BELOW ICON.minStroke — normalising to the 2.0 floor at 13px closes the aperture between
              disc and rays and the mark reads as an asterisk beside the numeral. Rendered at 13/14/
              15/16/18/20 on cream before picking: 16 is the first size where it reads as a sun. The
              moon opposite stays 11 — it is a single crescent with no counter-space to lose. */}
          <Icon name="care.sun" size={16} title="day high" style={{ marginTop: 3 }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 1, lineHeight: 1, marginLeft: 2 }}>
          <span style={{ fontWeight: 600, letterSpacing: '-0.02em', fontSize: 23, color: PAL.tempLo }}>{weather.tonightLow}&deg;</span>
          {/* Crescent moon — the one glyph in this file with NO registry twin of any kind. care.tempLow
              is the nearest key by meaning and it is a thermometer with a falling arrow, a different
              object entirely, so pointing at it would be a redraw wearing a swap's clothes. Kept
              inline as a genuine single-use mark; it is a bare fill, so there is no stroke here to
              be off-token. Drawing a care.moon is the follow-up if the weather family ever grows. */}
          <svg width="11" height="11" viewBox="0 0 24 24" style={{ marginTop: 2 }} role="img" aria-label="night low"><path d="M20 14.5A8 8 0 1 1 10.5 4 6.3 6.3 0 0 0 20 14.5Z" fill={P.mid} /></svg>
        </div>
      </div>

      {/* NET-NEW no-wrap derived headline. The visible line is ellipsis-truncated, so it is NOT a
          faithful alternative — the full sentence ships as visually-hidden TEXT and the truncated
          copy is aria-hidden, so it never double-announces.
          Was `<div aria-label={headline}>` wrapping an aria-hidden child, whose comment claimed the
          sentence was "in the a11y tree (aria-label)". It was not: aria-label on a role-less div is
          ignored (role=generic can't be named), so this headline had been SILENT since V200 Slice 6.
          Pre-existing, not from V4-WATERWHY-002 — but that cut removed the Why panel that used to
          carry the guidance, making this the load-bearing restatement surface (WCAG 1.4.10). It has
          to actually work now. Real text in the DOM beats ARIA naming for a sentence. */}
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

      {(rainIn > 0 || uncertain || live) && (
        <div style={{ marginTop: tokens.space.sm, textAlign: 'center', fontSize: tokens.type.xs, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, color: PAL.micro }}>
          {/* care.rainPct is drawn for this exact line: its registry note calls it "the FORECAST twin
              of event.rain … one drop under a raised cloud reads as 'some chance', three streaks read
              as 'it is raining'", and every sentence this glyph sits beside is a forecast. Single-hue
              blue before and after — the hand-roll's cloud was the same dropBody at 0.55 opacity. */}
          <Icon name="care.rainPct" size={13} decorative style={{ color: ICON_COLORS.dropBody }} />
          {rainNote}
        </div>
      )}

      {live ? (
        <div style={{ marginTop: tokens.space.sm, textAlign: 'center', fontSize: tokens.type.xs, color: PAL.micro }}>
          {/* DRG-WXSTATION-002 — with a gauge on site the live overlay is forecast-ONLY (client Open-Meteo),
              so a bare "live" would let a predicted figure read as a measured one directly under a stamp
              that says "rain gauge" the rest of the day. That masquerade is the BUG-RAINACTUAL-001 defect
              class. Qualified only when a gauge exists to be confused with; no station -> copy unchanged. */}
          Updated {liveAt} &middot; {stationProv ? 'live forecast' : 'live'}
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
          &#9888; This is an older snapshot &mdash; today&rsquo;s forecast hasn&rsquo;t refreshed yet, so numbers may be out of date.
        </div>
      )}
      {uncertain && (
        <div style={{
          marginTop: 6, textAlign: 'center', fontSize: tokens.type.xs, lineHeight: 1.35,
          color: PAL.warnInk, background: PAL.warnBg, border: `1px solid ${PAL.warnBorder}`,
          borderRadius: 9, padding: '5px 8px',
        }}>
          &#9888; Showery pattern &mdash; these amounts are a pre-dawn snapshot and can change through the day. The watering call above already plays it safe.
        </div>
      )}
    </div>
  )
}
