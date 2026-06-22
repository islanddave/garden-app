import React from 'react'
import { computeWateringScale, canRail, pillState, wateringReason } from '../../lib/wateringScale.js'

// Weather widget — LOCKED v1 (icon-first, slim), ported from the Tailwind design artifact
// (daily-plan-engine-build/weather-widget-redesign/WeatherWidget.jsx) to INLINE styles, because the
// app has no Tailwind (inline-style only). Visual + interaction language is the LOCKED spec V104:
//   Tier 1: condition icon + highToday (bold) / tonightLow (medium), sun/moon minis, no labels.
//   Tier 2: two pills [target icon] + [can rail | pause]; pot = containers, mound+sprout = in-ground.
//           N filled cans of 3 = water at intensity N; pause = hold/skip. level>=0.5 -> emerald "do",
//           level 0 -> coral "wait". The ONLY prose is the single rain note line.
// Operational surface (Reward-UX V101 §7): semantic state color is appropriate; no reward-surface rules.

const PAL = {
  cardBg: '#FFFDF7', cardBorder: '#EBE4D3',
  tempHi: '#2E2A22', tempLo: '#A29684', micro: '#A89C88',
  doBg: '#D6F7E6', doBorder: '#A7E7C6', doInk: '#055E45', doCan: '#2563EB', doGhost: '#A7C7F2',  // V3-WATERICON-001: watering can BLUE (water, not green) — also distinguishes the action can from the green location (pot/bed) icon
  waitBg: '#FCE3DC', waitBorder: '#F2C3B4', waitInk: '#9A3412',
}

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

const PotIcon = ({ color }) => (
  <svg width="23" height="23" viewBox="0 0 24 24" aria-label="containers" style={{ color }}>
    <rect x="4.6" y="7.4" width="14.8" height="2.7" rx="0.7" fill="currentColor" />
    <path d="M6 10.1 H18 L16.6 21 H7.4 Z" fill="currentColor" />
    <path d="M12 7.4 V4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    <path d="M12 6.2 Q8.8 4.6 9 7.4 Q11.6 7.6 12 6.2Z" fill="currentColor" />
    <path d="M12 6.2 Q15.2 4.6 15 7.4 Q12.4 7.6 12 6.2Z" fill="currentColor" />
  </svg>
)
const BedIcon = ({ color }) => (
  <svg width="23" height="23" viewBox="0 0 24 24" aria-label="in-ground beds" style={{ color }}>
    {/* sprout */}
    <path d="M12 14.5 V9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    <path d="M12 10.8 Q8.8 9.2 9 12 Q11.6 12.2 12 10.8Z" fill="currentColor" />
    <path d="M12 10.8 Q15.2 9.2 15 12 Q12.4 12.2 12 10.8Z" fill="currentColor" />
    {/* flat soil surface + a tilled furrow row (in the ground, not a mound) */}
    <path d="M3 15.5 H21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <path d="M4.5 18.6 H19.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.55" />
    <path d="M6.5 15.5 V18.6 M9.5 15.5 V18.6 M14.5 15.5 V18.6 M17.5 15.5 V18.6" stroke="currentColor" strokeWidth="1" opacity="0.4" />
  </svg>
)
const PauseIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-label="wait">
    <circle cx="12" cy="12" r="11" fill="#fff" stroke="#D98B6E" strokeWidth="1.6" />
    <rect x="8.4" y="7.6" width="2.8" height="8.8" rx="1" fill="#A6431F" />
    <rect x="12.8" y="7.6" width="2.8" height="8.8" rx="1" fill="#A6431F" />
  </svg>
)

// WMO weather code -> condition glyph (44px). Spec next-step #3: author the key map before ship.
// Coarse buckets cover the Conway range; unknown codes fall back to overcast.
function ConditionIcon({ code = 3 }) {
  const c = Number(code)
  if (c === 0 || c === 1) return (
    <svg width="44" height="44" viewBox="0 0 64 64" aria-label="clear">
      <circle cx="32" cy="32" r="12" fill="#E3A92B" />
      <g stroke="#E3A92B" strokeWidth="4" strokeLinecap="round">
        <path d="M32 6v8M32 50v8M6 32h8M50 32h8M13 13l6 6M45 45l6 6M51 13l-6 6M19 45l-6 6" />
      </g>
    </svg>
  )
  if (c === 2) return (
    <svg width="44" height="44" viewBox="0 0 64 64" aria-label="partly cloudy">
      <circle cx="24" cy="24" r="9" fill="#E3A92B" />
      <g stroke="#E3A92B" strokeWidth="3" strokeLinecap="round"><path d="M24 8v5M8 24h5M13 13l3 3" /></g>
      <path d="M22 50 Q15 50 15 44 Q15 38 22 38 Q23 31 32 31 Q40 31 41 38 Q49 38 49 45 Q49 50 44 50 Z" fill="#C7D2B8" />
    </svg>
  )
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return (
    <svg width="44" height="44" viewBox="0 0 64 64" aria-label="rain">
      <path d="M16 40 Q8 40 8 32 Q8 25 15 24 Q16 15 26 15 Q34 15 36 23 Q44 22 46 30 Q53 30 53 37 Q53 40 49 40 Z" fill="#AEBE9C" />
      <g stroke="#7FA8D8" strokeWidth="3" strokeLinecap="round"><path d="M20 46l-2 6M30 46l-2 6M40 46l-2 6" /></g>
    </svg>
  )
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return (
    <svg width="44" height="44" viewBox="0 0 64 64" aria-label="snow">
      <path d="M16 40 Q8 40 8 32 Q8 25 15 24 Q16 15 26 15 Q34 15 36 23 Q44 22 46 30 Q53 30 53 37 Q53 40 49 40 Z" fill="#C9D3DE" />
      <g fill="#8FA3B8"><circle cx="20" cy="50" r="2" /><circle cx="32" cy="52" r="2" /><circle cx="44" cy="50" r="2" /></g>
    </svg>
  )
  if (c >= 45 && c <= 48) return (
    <svg width="44" height="44" viewBox="0 0 64 64" aria-label="fog">
      <g stroke="#B7C0B0" strokeWidth="5" strokeLinecap="round"><path d="M12 26h40M10 36h44M14 46h36" /></g>
    </svg>
  )
  return (
    <svg width="44" height="44" viewBox="0 0 64 64" aria-label="overcast">
      <path d="M16 44 Q8 44 8 36 Q8 29 15 28 Q16 19 26 19 Q34 19 36 27 Q44 26 46 34 Q53 34 53 41 Q53 44 49 44 Z" fill="#AEBE9C" />
      <path d="M22 50 Q15 50 15 44 Q15 38 22 38 Q23 31 32 31 Q40 31 41 38 Q49 38 49 45 Q49 50 44 50 Z" fill="#C7D2B8" />
    </svg>
  )
}

// V3-WXFRESH-001 — honest presentation. The figures below are a FROZEN nightly snapshot (the engine runs
// ~2AM ET), NOT a live reading; for convective weather the real number can move several-fold by midday.
// Surface an as-of stamp (date ALWAYS shown — a silently-disabled cron can leave a multi-day-old snapshot)
// + source label, and warn when the snapshot predates the plan's own ET date (a nightly run was missed).
function asOfLabel(generatedAt) {
  if (!generatedAt) return null
  const d = new Date(generatedAt)
  if (isNaN(d.getTime())) return null
  const f = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...opts }).format(d)
  return `${f({ month: 'short', day: 'numeric' })} \u00b7 ${f({ hour: 'numeric', minute: '2-digit' })}`
}
function isStaleSnapshot(generatedAt, planDate) {
  if (!generatedAt || !planDate) return false
  const d = new Date(generatedAt)
  if (isNaN(d.getTime())) return false
  const genEtDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  return genEtDate < planDate
}

export default function WeatherWidget({
  weather = { tonightLow: 50, highToday: 78, code: 3, hot: false },
  hydrology = { recent_precip_in: 0.05, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0.74, tomorrow_pop: 63, rain_coming: true },
  generatedAt = null,
  planDate = null,
}) {
  const scale = computeWateringScale(hydrology, weather)
  const reason = wateringReason(hydrology, weather)
  const [whyLane, setWhyLane] = React.useState(null)
  // Prefer TODAY's rain in the note when there is any (the case the old widget missed); else tomorrow.
  const todayIn = hydrology.today_precip_in ?? 0
  const showToday = todayIn > 0
  const rainIn = showToday ? todayIn : (hydrology.tomorrow_precip_in ?? hydrology.upcoming_precip_in ?? 0)
  const rainPop = showToday ? (hydrology.today_pop ?? 0) : (hydrology.tomorrow_pop ?? 0)
  const rainWhen = showToday ? 'today' : 'tomorrow'
  const asOf = asOfLabel(generatedAt)
  const stale = isStaleSnapshot(generatedAt, planDate)

  const Pill = ({ level, Target, laneKey }) => {
    const state = pillState(level)
    const c = state === 'do'
      ? { bg: PAL.doBg, br: PAL.doBorder, ink: PAL.doInk, can: PAL.doCan, ghost: PAL.doGhost }
      : { bg: PAL.waitBg, br: PAL.waitBorder, ink: PAL.waitInk }
    const open = whyLane === laneKey
    return (
      <button type="button"
        onClick={() => setWhyLane(w => (w === laneKey ? null : laneKey))}
        aria-expanded={open}
        aria-label={`Why this ${laneKey === 'beds' ? 'in-ground bed' : 'container'} recommendation`}
        style={{
          flex: 1, borderRadius: 13, display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: 8, padding: '8px 10px', background: c.bg, cursor: 'pointer', font: 'inherit',
          border: `${open ? 2 : 1}px solid ${open ? PAL.doCan : c.br}`,
        }}>
        <Target color={c.ink} />
        {state === 'do' ? (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3 }}>
            {canRail(level).map((f, i) => <Can key={i} fill={f} color={c.can} ghost={c.ghost} />)}
          </div>
        ) : <PauseIcon />}
      </button>
    )
  }

  return (
    <div style={{
      width: 330, maxWidth: '100%', margin: '0 auto', borderRadius: 18, padding: '12px 14px',
      background: PAL.cardBg, border: `1px solid ${PAL.cardBorder}`, fontFamily: 'Inter, system-ui, sans-serif',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <ConditionIcon code={weather.code} />
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 1, lineHeight: 1 }}>
          <span style={{ fontWeight: 800, letterSpacing: '-0.02em', fontSize: 36, color: PAL.tempHi }}>{weather.highToday}&deg;</span>
          <svg width="13" height="13" viewBox="0 0 24 24" style={{ marginTop: 3 }} aria-label="day high"><circle cx="12" cy="12" r="5" fill="#E3A92B" /><g stroke="#E3A92B" strokeWidth="2" strokeLinecap="round"><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></g></svg>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 1, lineHeight: 1, marginLeft: 2 }}>
          <span style={{ fontWeight: 600, letterSpacing: '-0.02em', fontSize: 23, color: PAL.tempLo }}>{weather.tonightLow}&deg;</span>
          <svg width="11" height="11" viewBox="0 0 24 24" style={{ marginTop: 2 }} aria-label="night low"><path d="M20 14.5A8 8 0 1 1 10.5 4 6.3 6.3 0 0 0 20 14.5Z" fill="#A8B0BC" /></svg>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
        <Pill level={scale.containers} Target={PotIcon} laneKey="containers" />
        <Pill level={scale.beds} Target={BedIcon} laneKey="beds" />
      </div>

      {whyLane && (
        <div role="region" aria-label="watering explanation" style={{
          marginTop: 8, borderRadius: 11, padding: '9px 11px', textAlign: 'left',
          background: '#FBF7EE', border: `1px solid ${PAL.cardBorder}`,
        }}>
          <div style={{ fontWeight: 700, fontSize: 12, color: PAL.tempHi, marginBottom: 4 }}>
            {reason[whyLane].verdict}
          </div>
          <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, lineHeight: 1.45, color: PAL.tempLo }}>
            {reason[whyLane].lines.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        </div>
      )}

      {rainIn > 0 && (
        <div style={{ marginTop: 8, textAlign: 'center', fontSize: 11.5, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, color: PAL.micro }}>
          <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 16a5 5 0 0 1 .5-9.9A6 6 0 0 1 19 8a4 4 0 0 1-.5 8Z" fill="#B9C6D6" /><g stroke="#7FA8D8" strokeWidth="2" strokeLinecap="round"><path d="M9 19l-1 2M13 19l-1 2M17 19l-1 2" /></g></svg>
          {rainIn.toFixed(2)}&Prime; rain expected {rainWhen} &middot; {rainPop}%
        </div>
      )}

      {asOf && (
        <div style={{ marginTop: 8, textAlign: 'center', fontSize: 10.5, color: PAL.micro }}>
          As of {asOf} &middot; Open-Meteo
        </div>
      )}
      {stale && (
        <div style={{
          marginTop: 6, textAlign: 'center', fontSize: 10.5, lineHeight: 1.35,
          color: PAL.waitInk, background: PAL.waitBg, border: `1px solid ${PAL.waitBorder}`,
          borderRadius: 9, padding: '5px 8px',
        }}>
          &#9888; This is an older snapshot &mdash; today&rsquo;s forecast hasn&rsquo;t refreshed yet, so numbers may be out of date.
        </div>
      )}
    </div>
  )
}
