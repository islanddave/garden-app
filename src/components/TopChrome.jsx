// V4-APPBAR-001 — top-chrome gate. Root tabs (Today/Garden/DrG/Dashboard) replace the old green
// app-name TopBar with a V200 HEADER: a compact brand wordmark (left, -> home) + Favorites (right)
// on a soft PEACH surface (terra family) so the bar reads as a distinct, polished header instead of
// vanishing into the cream body. The wordmark anchors the bar so Favorites is a header action, not a
// lone floating heart. Detail/pushed routes AND the unauthenticated app keep the full TopBar so
// nothing becomes unreachable. Same 52px+inset height as TopBar, so every page's
// `calc(100dvh - 52px)` layout math and notch handling are unchanged (zero page edits).
// (Field/Desk mode toggle intentionally NOT here — it lives in Settings, per Dave 2026-07-01.)
// Surface = peach #f9e3d6 / border #edc7b3 (Dave pick 2026-07-01). Saved alternate he also liked:
// light-blue bg #e4eff9 / border #c6dcef (water/weather-adjacent) — kept for a future swap.
import React from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { P, APP_NAME } from '../lib/constants.js'
import TopBar from './TopBar.jsx'

const ROOT_TABS = ['/today', '/garden', '/findings', '/dashboard']
const HEADER_BG = '#f9e3d6'      // V200 peach header surface (terra family)
const HEADER_BORDER = '#edc7b3'  // peach hairline (bottom rule + heart ring)

export default function TopChrome() {
  const { user } = useAuth()
  const { pathname } = useLocation()

  // Detail/pushed routes + unauthenticated -> unchanged full TopBar (Favorites + mode chip stay
  // reachable on detail screens; no regression).
  if (!user || !ROOT_TABS.includes(pathname)) return <TopBar />

  return (
    <header
      style={{
        height: 'calc(52px + env(safe-area-inset-top))',
        paddingTop: 'env(safe-area-inset-top)',
        paddingLeft: 16,
        paddingRight: 16,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        position: 'sticky',
        top: 0,
        zIndex: 80,
        backgroundColor: HEADER_BG,
        borderBottom: `1px solid ${HEADER_BORDER}`,
        boxSizing: 'border-box',
      }}
    >
      {/* Brand wordmark -> home. Distinct hierarchy from each screen's own page <h1>. */}
      <Link
        to="/dashboard"
        style={{
          color: P.greenDeep,
          textDecoration: 'none',
          fontWeight: 700,
          fontSize: '0.95rem',
          letterSpacing: '0.2px',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        {APP_NAME}
      </Link>

      {/* Favorites — the persistent root-tab shortcut, anchored by the wordmark. */}
      <Link
        to="/favorites"
        aria-label="Favorites"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 36, height: 36,
          borderRadius: '50%',
          backgroundColor: P.white,
          border: `1px solid ${HEADER_BORDER}`,
          color: '#c9a84c',
          textDecoration: 'none',
          fontSize: '1.1rem',
          fontWeight: 700,
          boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
          flexShrink: 0,
        }}
      >
        {'♥'}
      </Link>
    </header>
  )
}
