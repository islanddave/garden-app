import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useOverlayLocation } from '../context/OverlayContext.jsx'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { todayBand } from '../lib/todayBand.js'
import { SEVERITY_STYLES } from '../lib/waterDue.js'

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

  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--today-band-height', onToday ? '0px' : BAND_HEIGHT)
    return () => root.style.setProperty('--today-band-height', '0px')
  }, [onToday])

  if (onToday) return null

  const st = barState(visible, total)
  const label = st.tier === 'urgent' ? st.top.label : 'Today'
  const detail =
    st.tier === 'urgent'
      ? `${st.top.projectName} — ${st.top.detail}${total > 1 ? ` (+${total - 1} more)` : ''}`
      : st.tier === 'waiting'
        ? `${total} ${total === 1 ? 'thing needs' : 'things need'} a look`
        : "You're all caught up"
  const ariaState =
    st.tier === 'urgent' ? `${st.top.label}, ${st.top.projectName}, ${st.top.detail}`
    : st.tier === 'waiting' ? `${total} ${total === 1 ? 'item needs' : 'items need'} attention`
    : 'all caught up'

  return (
    <div style={{
      position: 'fixed', left: 0, right: 0, zIndex: 80,
      bottom: 'calc(var(--bottom-nav-height) + env(safe-area-inset-bottom))',
      pointerEvents: 'none',
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
