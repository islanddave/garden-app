import React from 'react'
import Icon from '../Icon.jsx'
import { computeWateringScale, canRail, pillState } from '../../lib/wateringScale.js'
import { P, tokens, ICON_COLORS } from '../../lib/tokens.js'

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

let _cid = 0
function Can({ fill = 1, color, ghost }) {
  const cid = `can-clip-${_cid++}`
  const Outline = (
    <g fill="none" stroke={ghost} strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round">
      <path d="M20 28 H46 L43 49 Q42.5 52 39 52 H27 Q23.5 52 23 49 Z" />
      <path d="M23 28 L43 28 L41 23 L25 23 Z" />
      <path d="M20 33 L8 22 L11 18 L23 28 Z" />
      <path d="M5 25 L14 16" />
      <path d="M26 23 Q33 9 46 21" />
    </g>
  )
  const Solid = (
    <g>
      <path d="M20 28 H46 L43 49 Q42.5 52 39 52 H27 Q23.5 52 23 49 Z" fill={color} />
      <path d="M23 28 L43 28 L41 23 L25 23 Z" fill={color} />
      <path d="M20 33 L8 22 L11 18 L23 28 Z" fill={color} />
      <path d="M5 25 L14 16" fill="none" stroke={color} strokeWidth="3.4" strokeLinecap="round" />
      <path d="M26 23 Q33 9 46 21" fill="none" stroke={color} strokeWidth="3.6" strokeLinecap="round" />
      <path d="M7 31 L4 35 M11 33 L9 38 M14 34 L13 39" fill="none" stroke={color}
        strokeWidth="2.2" strokeLinecap="round" opacity="0.55" />
    </g>
  )
  return (
    <svg width="24" height="24" viewBox="0 0 64 64" aria-hidden="true">
      {fill === 0 ? Outline : fill >= 1 ? Solid : (
        <>{Outline}<clipPath id={cid}><rect x="0" y="0" width="32" height="64" /></clipPath>
          <g clipPath={`url(#${cid})`}>{Solid}</g></>
      )}
    </svg>
  )
}

const PotIcon = ({ color }) => <Icon name="care.containers" size={23} decorative style={{ color }} />
const BedIcon = ({ color }) => <Icon name="care.inground" size={23} decorative style={{ color }} />
// Pause SHAPE for level 0 — distinct glyph (not mere can-absence): 3-channel hold cue tinted to the gold-tint
// wait family so the shape + the "Hold" text + the gold color all read the same verdict.
const PauseIcon = ({ color }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-label="hold" style={{ color }}>
    <circle cx="12" cy="12" r="11" fill={PAL.warnBg} stroke="currentColor" strokeWidth="1.6" />
    <rect x="8.4" y="7.6" width="2.8" height="8.8" rx="1" fill="currentColor" />
    <rect x="12.8" y="7.6" width="2.8" height="8.8" rx="1" fill="currentColor" />
  </svg>
)

// WMO weather code -> condition glyph (44px). Coarse buckets cover the Conway range; unknown -> overcast.
function ConditionIcon({ code = 3 }) {
  const c = Number(code)
  if (c === 0 || c === 1) return (
    <svg width="44" height="44" viewBox="0 0 64 64" aria-label="clear">
      <circle cx="32" cy="32" r="12" fill={ICON_COLORS.sunBody} />
      <g stroke={ICON_COLORS.sunRays} strokeWidth="4" strokeLinecap="round">
        <path d="M32 6v8M32 50v8M6 32h8M50 32h8M13 13l6 6M45 45l6 6M51 13l-6 6M19 45l-6 6" />
      </g>
    </svg>
  )
  if (c === 2) return (
    <svg width="44" height="44" viewBox="0 0 64 64" aria-label="partly cloudy">
      <circle cx="24" cy="24" r="9" fill={ICON_COLORS.sunBody} />
      <g stroke={ICON_COLORS.sunRays} strokeWidth="3" strokeLinecap="round"><path d="M24 8v5M8 24h5M13 13l3 3" /></g>
      <path d="M22 50 Q15 50 15 44 Q15 38 22 38 Q23 31 32 31 Q40 31 41 38 Q49 38 49 45 Q49 50 44 50 Z" fill={P.greenLight} />
    </svg>
  )
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return (
    <svg width="44" height="44" viewBox="0 0 64 64" aria-label="rain">
      <path d="M16 40 Q8 40 8 32 Q8 25 15 24 Q16 15 26 15 Q34 15 36 23 Q44 22 46 30 Q53 30 53 37 Q53 40 49 40 Z" fill={P.greenLight} />
      <g stroke={ICON_COLORS.dropBody} strokeWidth="3" strokeLinecap="round"><path d="M20 46l-2 6M30 46l-2 6M40 46l-2 6" /></g>
    </svg>
  )
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return (
    <svg width="44" height="44" viewBox="0 0 64 64" aria-label="snow">
      <path d="M16 40 Q8 40 8 32 Q8 25 15 24 Q16 15 26 15 Q34 15 36 23 Q44 22 46 30 Q53 30 53 37 Q53 40 49 40 Z" fill={P.greenLight} />
      <g fill={ICON_COLORS.dropBody}><circle cx="20" cy="50" r="2" /><circle cx="32" cy="52" r="2" /><circle cx="44" cy="50" r="2" /></g>
    </svg>
  )
  if (c >= 45 && c <= 48) return (
    <svg width="44" height="44" viewBox="0 0 64 64" aria-label="fog">
      <g stroke={P.greenLight} strokeWidth="5" strokeLinecap="round"><path d="M12 26h40M10 36h44M14 46h36" /></g>
    </svg>
  )
  return (
    <svg width="44" height="44" viewBox="0 0 64 64" aria-label="overcast">
      <path d="M16 44 Q8 44 8 36 Q8 29 15 28 Q16 19 26 19 Q34 19 36 27 Q44 26 46 34 Q53 34 53 41 Q53 44 49 44 Z" fill={P.greenLight} />
      <path d="M22 50 Q15 50 15 44 Q15 38 22 38 Q23 31 32 31 Q40 31 41 38 Q49 38 49 45 Q49 50 44 50 Z" fill={P.greenLight} />
    </svg>
  )
}

// V3-WXFRESH-001 — honest presentation (unchanged). Frozen nightly snapshot, NOT a live reading.
function asOfLabel(generatedAt) {
  if (!generatedAt) return null
  const d = new Date(generatedAt)
  if (isNaN(d.getTime())) return null
  const f = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...opts }).format(d)
  return `${f({ month: 'short', day: 'numeric' })} · ${f({ hour: 'numeric', minute: '2-digit' })}`
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
function headlineFor(containersDo, bedsDo) {
  if (containersDo && bedsDo) return 'Water both — containers and beds today.'
  if (containersDo && !bedsDo) return 'Water containers, skip the beds today.'
  if (!containersDo && bedsDo) return 'Water the beds, hold containers.'
  return 'All set — no watering needed today.'
}

export default function WeatherWidget({
  weather = { tonightLow: 50, highToday: 78, code: 3, hot: false },
  hydrology = { recent_precip_in: 0.05, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0.74, tomorrow_pop: 63, rain_coming: true },
  generatedAt = null,
  planDate = null,
  liveHydrology = null,
  refreshedAt = null,
}) {
  const scale = computeWateringScale(hydrology, weather)

  // DRG-WXROLL-001 — intraday freshness (unchanged). Live precip overlays the INFORMATIONAL rain figure +
  // stamp ONLY; the watering recommendation (lanes/scale) STAYS on the nightly hydrology.
  const live = !!(liveHydrology && (liveHydrology.today_precip_in != null || liveHydrology.tomorrow_precip_in != null))
  const asOf = asOfLabel(generatedAt)
  const liveAt = live ? liveTimeLabel(refreshedAt) : null
  const stale = !live && isStaleSnapshot(generatedAt, planDate)
  const uncertain = !live && !!(hydrology && hydrology.status && hydrology.status.uncertainty && hydrology.status.uncertainty.flag) && !stale

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
  const headline = headlineFor(containersDo, bedsDo)

  // A full-width stacked lane: [leading target icon] [label flex:1 min-width:0] [3-can rail OR pause shape].
  // V4-WATERWHY-002: non-interactive (was a <button> only to toggle the removed Why panel). The
  // aria-label states the recommendation the rail encodes visually, so the intensity reaches screen
  // readers — the old button's "Why this…" label overrode its children and hid it. minHeight 44 is
  // kept: it's the lane's visual rhythm, not a tap target.
  const Lane = ({ level, Target, label }) => {
    const isDo = pillState(level) === 'do'
    const c = isDo
      ? { bg: PAL.doBg, br: PAL.doBorder, ink: PAL.doInk, can: PAL.doCan, ghost: PAL.doGhost }
      : { bg: PAL.waitBg, br: PAL.waitBorder, ink: PAL.waitInk }
    const cans = Math.round(level)
    return (
      <div
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
          <svg width="13" height="13" viewBox="0 0 24 24" style={{ marginTop: 3 }} aria-label="day high"><circle cx="12" cy="12" r="5" fill={ICON_COLORS.sunBody} /><g stroke={ICON_COLORS.sunRays} strokeWidth="2" strokeLinecap="round"><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></g></svg>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 1, lineHeight: 1, marginLeft: 2 }}>
          <span style={{ fontWeight: 600, letterSpacing: '-0.02em', fontSize: 23, color: PAL.tempLo }}>{weather.tonightLow}&deg;</span>
          <svg width="11" height="11" viewBox="0 0 24 24" style={{ marginTop: 2 }} aria-label="night low"><path d="M20 14.5A8 8 0 1 1 10.5 4 6.3 6.3 0 0 0 20 14.5Z" fill={P.mid} /></svg>
        </div>
      </div>

      {/* NET-NEW no-wrap derived headline. Full sentence in the a11y tree (aria-label); visible text is
          truncated + aria-hidden so it never double-announces. Lanes + rain note restate it (WCAG 1.4.10). */}
      <div aria-label={headline} style={{ marginTop: tokens.space.sm }}>
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
          <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 16a5 5 0 0 1 .5-9.9A6 6 0 0 1 19 8a4 4 0 0 1-.5 8Z" fill={ICON_COLORS.dropBody} opacity="0.55" /><g stroke={ICON_COLORS.dropBody} strokeWidth="2" strokeLinecap="round"><path d="M9 19l-1 2M13 19l-1 2M17 19l-1 2" /></g></svg>
          {rainNote}
        </div>
      )}

      {live ? (
        <div style={{ marginTop: tokens.space.sm, textAlign: 'center', fontSize: tokens.type.xs, color: PAL.micro }}>
          Updated {liveAt} &middot; live
        </div>
      ) : asOf ? (
        <div style={{ marginTop: tokens.space.sm, textAlign: 'center', fontSize: tokens.type.xs, color: PAL.micro }}>
          As of {asOf} &middot; Open-Meteo
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
