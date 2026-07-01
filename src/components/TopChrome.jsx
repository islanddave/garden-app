// V4-APPBAR-001 — top-chrome gate. Root tabs (Today/Garden/DrG/Dashboard) replace the old green
// app-name TopBar with a V200 cream HEADER: a compact brand wordmark (left, -> home) + Favorites
// (right). The wordmark anchors the bar so Favorites reads as a real header action, not a lone
// floating heart; no full-width green bar. Detail/pushed routes AND the unauthenticated app keep the
// full TopBar so nothing becomes unreachable. Same 52px+inset height as TopBar, so every page's
// `calc(100dvh - 52px)` layout math and notch handling are unchanged (zero page edits).
// (Field/Desk mode toggle intentionally NOT here — it lives in Settings, per Dave 2026-07-01.)
import React from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { P, APP_NAME } from '../lib/constants.js'
import TopBar from './TopBar.jsx'

const ROOT_TABS = ['/today', '/garden', '/findings', '/dashboard']

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
        backgroundColor: P.cream,
        borderBottom: `1px solid ${P.border}`,
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

      {/* Favorites — the persistent root-tab shortcut, now anchored by the wordmark. */}
      <Link
        to="/favorites"
        aria-label="Favorites"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 36, height: 36,
          borderRadius: '50%',
          backgroundColor: P.white,
          border: `1px solid ${P.border}`,
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
