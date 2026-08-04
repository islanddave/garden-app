import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useOverlayLocation } from '../context/OverlayContext.jsx'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { useKeyboardChromeSuppressed } from '../lib/keyboardChrome.js'
import { todayBand } from '../lib/todayBand.js'
import { SEVERITY_STYLES } from '../lib/waterDue.js'
import { PROJECTS_HIDDEN, TODAY_BAND_HIDDEN } from '../lib/featureFlags.js'

// Today bar — DRG-TODAY-003. The persistent, color-coded "what needs me today?" entry docked
// directly ABOVE the bottom nav, on every authenticated screen EXCEPT /today itself (redundant
// there). REPLACES the former expandable TodayBand tickler: same vertical slot, better delivery —
// one glanceable color-coded summary that taps through to the full Today home (/today) instead of
// expanding an inline list. Color reflects the day's load:
//   green  — all caught up (nothing waiting)
//   gold   — things waiting (due-today water, unseen projects)
//   terra  — urgent (water overdue; indoor seedlings escalate faster) + a specific callout
// Data: the actionable signals /api/dashboard already returns, merged + ranked + de-duped by the
// shared todayBand() helper (harvest-ready excluded per V3-HARVEST-001; flagged excluded per
// FLAG-REMOVAL 2026-06-10). OPERATIONAL surface (Reward-UX V101): ambient, in-context, no
// push/modal/sound/haptic/streak/badge. Refreshes on mount, on in-app navigation, and on
// app-foreground (visibilitychange/focus).

const BAND_HEIGHT = '56px'
const URGENT_STYLES = new Set([SEVERITY_STYLES.terra, SEVERITY_STYLES['terra-bold']])

// Derive the bar's color + copy tier from the ranked Today items. Exported for unit tests.
export function barState(visible, total) {
  if (total === 0) return { tier: 'clear', style: SEVERITY_STYLES.green, emoji: '✓' }
  const urgent = visible.find(it => URGENT_STYLES.has(it.style))
  if (urgent) return { tier: 'urgent', style: urgent.style, emoji: urgent.emoji, top: urgent }
  const top = visible[0]
  return { tier: 'waiting', style: SEVERITY_STYLES.gold, emoji: (top && top.emoji) || '', top }
}

export default function TodayBand() {
  const { fetch } = useApiFetch()
  const navigate = useNavigate()
  const location = useOverlayLocation()
  const [dash, setDash] = useState(null)
  const inflight = useRef(false)

  const load = useCallback(() => {
    // V4-HIDETODAYBAND-001: nothing renders, so nothing needs fetching. This also removes the bar's
    // refetch-on-every-in-app-navigation from every route it used to fire on.
    if (TODAY_BAND_HIDDEN) return
    if (inflight.current) return
    inflight.current = true
    fetch('/api/dashboard')
      .then(d => setDash(d ?? null))
      .catch(() => { /* supplementary glance — never surface a fetch error */ })
      .finally(() => { inflight.current = false })
  }, [fetch])

  useEffect(() => { load() }, [load, location.pathname])

  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') load() }
    window.addEventListener('focus', load)
    document.addEventListener('visibilitychange', onVis)
    return () => { window.removeEventListener('focus', load); document.removeEventListener('visibilitychange', onVis) }
  }, [load])

  const { visible, total } = todayBand(dash)
  const onToday = location.pathname === '/today'
  // V4-HIDETODAYBAND-001 (BD-002) — hidden, not removed. Routed through the SAME suppression path the
  // /today case already uses, so the inset var and the pixels stay in one commit (see below) and the
  // rollback is a single const in featureFlags.js. Deliberately NOT a guard at App.jsx's `<TodayBand />`
  // call site: unmounting would leave --today-band-height at whatever the last mount wrote instead of
  // explicitly zeroing it, and would take the component out of test coverage entirely.
  const hidden = TODAY_BAND_HIDDEN || onToday

  // V4-KBCHROME-001 — same ONE-predicate wiring as BottomNav: visibility (style prop, DOM
  // mutation pass) + the inset var (this layout effect, synchronously after, pre-paint) flip in
  // the SAME commit, so --today-band-height and the pixels never disagree for a frame.
  // useLayoutEffect (was useEffect) for exactly that guarantee; detector: lib/keyboardChrome.js.
  const kbSuppressed = useKeyboardChromeSuppressed()
  useLayoutEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--today-band-height', (hidden || kbSuppressed) ? '0px' : BAND_HEIGHT)
    return () => root.style.setProperty('--today-band-height', '0px')
  }, [hidden, kbSuppressed])

  if (hidden) return null

  const st = barState(visible, total)
  const label = st.tier === 'urgent' ? st.top.label : 'Today'
  // V4-PROJHIDE-001: the urgent callout's leading name is already planting-forward (V3-ATTN-001:
  // st.top.projectName holds the single actionable planting's name; it only falls back to the project/
  // container name for GROUPED rows, where st.top.plantId is null). When projects aren't user-facing,
  // keep the planting name but drop the project/container name from grouped rows (detail stands alone).
  // Flag OFF always renders the leading "{name} — " / ", {name}" exactly as before (byte-identical).
  const hideUrgentName = PROJECTS_HIDDEN && st.tier === 'urgent' && !st.top.plantId
  const detail =
    st.tier === 'urgent'
      ? `${hideUrgentName ? '' : `${st.top.projectName} — `}${st.top.detail}${total > 1 ? ` (+${total - 1} more)` : ''}`
      : st.tier === 'waiting'
        ? `${total} ${total === 1 ? 'thing needs' : 'things need'} a look`
        : "You're all caught up"
  const ariaState =
    st.tier === 'urgent' ? `${st.top.label}${hideUrgentName ? '' : `, ${st.top.projectName}`}, ${st.top.detail}`
    : st.tier === 'waiting' ? `${total} ${total === 1 ? 'item needs' : 'items need'} attention`
    : 'all caught up'

  return (
    <div style={{
      position: 'fixed', left: 0, right: 0, zIndex: 80,
      bottom: 'calc(var(--bottom-nav-height) + env(safe-area-inset-bottom))',
      pointerEvents: 'none',
      // V4-KBCHROME-001: hidden (not unmounted) while the soft keyboard is up. Operational
      // chrome, not a reward surface — plain visibility, no flourish (Reward UX V101/V102).
      visibility: kbSuppressed ? 'hidden' : 'visible',
    }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '0 12px 6px', pointerEvents: 'auto' }}>
        <button
          type="button"
          onClick={() => navigate('/today')}
          data-tier={st.tier}
          aria-label={`Today: ${ariaState}. Open your day.`}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, width: '100%',
            textAlign: 'left', padding: '8px 14px', minHeight: 48,
            backgroundColor: st.style.bg, border: `1.5px solid ${st.style.border}`,
            borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit',
            filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.12))',
          }}
        >
          <span aria-hidden="true" style={{ fontSize: '1.15rem', flexShrink: 0 }}>{st.emoji}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '0.62rem', color: P.mid, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{label}</div>
            <div style={{ fontWeight: 700, color: st.style.text, fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail}</div>
          </div>
          <span aria-hidden="true" style={{ fontSize: '0.95rem', color: P.mid, flexShrink: 0 }}>{'›'}</span>
        </button>
      </div>
    </div>
  )
}
