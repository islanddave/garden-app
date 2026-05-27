import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { todayBand } from '../lib/todayBand.js'

// Today band — the persistent global "what needs me now?" module docked directly ABOVE the bottom
// nav, present on every authenticated screen (canonical E-3 / design §4: the push>pull front door
// that replaced the dropped-from-nav Dashboard). Merges the actionable signals /api/dashboard
// returns (watering overdue + flagged issues + harvest-ready + long-unseen) via the shared
// todayBand() helper. OPERATIONAL ALERT, not a reward surface: ambient, in-context, no
// push/modal/sound/haptic; recent-activity excluded. Collapsed by default = one compact row (the
// single most-urgent item, 1-tap to log) + a count chip; tap the chip to reveal the full <=5 list
// (C5 cap). Renders NOTHING when nothing needs attention (ADHD: no empty clutter). Refreshes on
// mount, on in-app navigation (reflect a just-logged action), and on app-foreground
// (visibilitychange/focus) — Gap-1: refresh on foreground, never silently reorder a list mid-read.

const BAND_HEIGHT = '60px'

export default function TodayBand() {
  const { fetch } = useApiFetch()
  const navigate = useNavigate()
  const location = useLocation()
  const [dash, setDash] = useState(null)
  const [open, setOpen] = useState(false)
  const inflight = useRef(false)

  const load = useCallback(() => {
    if (inflight.current) return
    inflight.current = true
    fetch('/api/dashboard')
      .then(d => setDash(d ?? null))
      .catch(() => { /* supplementary glance — never surface a fetch error */ })
      .finally(() => { inflight.current = false })
  }, [fetch])

  // mount + on in-app navigation (so a just-logged action is reflected)
  useEffect(() => { load() }, [load, location.pathname])
  // collapse the expanded list on navigation
  useEffect(() => { setOpen(false) }, [location.pathname])

  // app-foreground refresh (canonical Gap-1)
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') load() }
    window.addEventListener('focus', load)
    document.addEventListener('visibilitychange', onVis)
    return () => { window.removeEventListener('focus', load); document.removeEventListener('visibilitychange', onVis) }
  }, [load])

  const { visible, more, total } = todayBand(dash)

  // reserve exactly the collapsed band height in the app layout — only when present
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--today-band-height', total > 0 ? BAND_HEIGHT : '0px')
    return () => root.style.setProperty('--today-band-height', '0px')
  }, [total])

  if (total === 0) return null
  const top = visible[0]
  const hasToggle = more > 0 || total > 1

  return (
    <div style={{
      position: 'fixed', left: 0, right: 0, zIndex: 80,
      bottom: 'calc(var(--bottom-nav-height) + env(safe-area-inset-bottom))',
      pointerEvents: 'none',
    }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '0 12px 6px', pointerEvents: 'auto' }}>
        {open && (
          <div role="list" aria-label="Needs attention today" style={{
            display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 6,
            maxHeight: '50dvh', overflowY: 'auto',
            filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.14))',
          }}>
            {visible.map(it => <Row key={it.key} it={it} onAct={() => navigate(it.to)} />)}
            {more > 0 && (
              <div style={{ fontSize: '0.72rem', color: P.light, textAlign: 'center', padding: '4px 0' }}>
                + {more} more in your garden
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.12))' }}>
          {!open && <Row it={top} onAct={() => navigate(top.to)} grow />}
          {hasToggle && (
            <button
              type="button"
              onClick={() => setOpen(o => !o)}
              aria-expanded={open}
              aria-label={open ? 'Collapse needs-attention list' : `Show all ${total} items that need attention`}
              style={{
                flex: open ? 1 : '0 0 auto', minHeight: 48, minWidth: 64,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                padding: '0 16px', backgroundColor: P.white, border: `1.5px solid ${P.border}`,
                borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
                fontSize: '0.78rem', fontWeight: 700, color: P.mid,
              }}
            >
              {open ? 'Close' : `+${total - 1} more`}
              <span aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Row({ it, onAct, grow }) {
  return (
    <button
      type="button"
      onClick={onAct}
      aria-label={`${it.label}: ${it.projectName} — ${it.detail}. Tap to log.`}
      style={{
        flex: grow ? 1 : 'auto', display: 'flex', alignItems: 'center', gap: 10,
        width: '100%', textAlign: 'left', padding: '8px 12px', minHeight: 48,
        backgroundColor: it.style.bg, border: `1.5px solid ${it.style.border}`,
        borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
      }}
    >
      <span aria-hidden="true" style={{ fontSize: '1.05rem', flexShrink: 0 }}>{it.emoji}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.66rem', color: P.mid, fontWeight: 700, letterSpacing: '0.02em' }}>{it.label.toUpperCase()}</div>
        <div style={{ fontWeight: 700, color: it.style.text, fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.projectName}</div>
      </div>
      <span style={{ fontSize: '0.72rem', color: P.mid, flexShrink: 0 }}>{it.detail} ›</span>
    </button>
  )
}
