// V4-APPBAR-001 — top-chrome gate. Root tabs (Today/Garden/DrG/Dashboard) replace the old green
// app-name TopBar with a V200 cream HEADER: a compact brand wordmark (left, -> home) + the utility
// cluster (right: Field/Desk mode toggle + Favorites). Restores a real, app-like top bar AND the
// root-tab mode toggle that vanished when the bar was gated down to a lone floating heart, without
// re-introducing the old full-width green bar. Detail/pushed routes AND the unauthenticated app keep
// the full TopBar so nothing becomes unreachable. Same 52px+inset height as TopBar, so every page's
// `calc(100dvh - 52px)` layout math and notch handling are unchanged (zero page edits).
import React from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { useMode } from '../context/ModeContext.jsx'
import { P, APP_NAME } from '../lib/constants.js'
import TopBar from './TopBar.jsx'

const ROOT_TABS = ['/today', '/garden', '/findings', '/dashboard']

export default function TopChrome() {
  const { user } = useAuth()
  const { pathname } = useLocation()
  const { mode, toggleMode, isField } = useMode()

  // Detail/pushed routes + unauthenticated -> unchanged full TopBar (Favorites + mode chip stay
  // reachable on detail screens; no regression).
  if (!user || !ROOT_TABS.includes(pathname)) return <TopBar />

  const modeLabel = isField ? 'Field' : 'Desk'
  const modeIcon  = isField ? '\u{1F33F}' : '\u{1F4BB}'
  const nextLabel = isField ? 'Desk' : 'Field'

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

      {/* Right utility cluster — Field/Desk mode toggle + Favorites. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <button
          type="button"
          onClick={toggleMode}
          data-testid="mode-chip"
          data-mode={mode}
          aria-label={`Mode: ${modeLabel}. Tap to switch to ${nextLabel}.`}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            color: P.greenDeep,
            backgroundColor: P.white,
            border: `1px solid ${P.border}`,
            borderRadius: 20,
            padding: '4px 10px',
            minHeight: 32,
            fontSize: '0.78rem',
            fontWeight: 600,
            whiteSpace: 'nowrap',
            cursor: 'pointer',
            fontFamily: 'inherit',
            lineHeight: 1.2,
          }}
        >
          <span aria-hidden="true">{modeIcon}</span>
          <span>{modeLabel}</span>
        </button>

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
          }}
        >
          {'♥'}
        </Link>
      </div>
    </header>
  )
}
