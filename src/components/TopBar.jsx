import React from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
// import { useZone } from '../context/ZoneContext.jsx' // DISABLED pre-V2 (2026-05-22): zone pill commented out below
import { useMode } from '../context/ModeContext.jsx'
import { MODE } from '../lib/mode.js'
import { P, APP_NAME } from '../lib/constants.js'

// TopBar — sticky top bar.
// Layout (NAV-IA-1, V1.2a-3 Increment C / PR-C1, 2026-05-18):
//   left:  app name (clickable home → "Gardens at Home" banner)
//   right: mode chip · zone pill · Favorites star icon
// Sign Out moved from this component into BottomNav's More menu (with confirmation).
// "More" dropdown removed entirely.
//
// 2026-05-28 (Post-V2 UX overhaul Inc 2 Bite 2): added Field/Desk mode chip.
// Authenticated-only (mirrors favorites/zone pattern). Color-independent state
// (icon + text label + aria-label per Reward UX V100 §7 floor — color is NOT
// the sole signal). Tap to toggle. WCAG AA: cream text on a tonal cream-tinted
// pill against P.green background = sufficient contrast.

export default function TopBar() {
  const { user }       = useAuth()
  // const { activeZone } = useZone() // DISABLED pre-V2 (2026-05-22): zone pill commented out below
  const { mode, toggleMode, isField } = useMode()
  const location       = useLocation()

  const modeLabel = isField ? 'Field' : 'Desk'
  const modeIcon  = isField ? '🌿' : '💻'
  const nextLabel = isField ? 'Desk' : 'Field'

  return (
    <header style={{
      backgroundColor: P.green,
      paddingLeft: 16,
      paddingRight: 16,
      paddingTop: 'env(safe-area-inset-top)',
      // V3-ARCHIVE? no — V3-UI-001 (APPSHELL-SAFEAREA): height must GROW by the inset, not
      // absorb it. With a fixed 52px the inset padding ate into the bar and clipped its
      // content under the notch on standalone iOS. calc keeps a full 52px below the inset.
      height: 'calc(52px + env(safe-area-inset-top))',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      position: 'sticky',
      top: 0,
      zIndex: 80,
      boxSizing: 'border-box',
    }}>

      {/* App name / home link → "Gardens at Home" Dashboard */}
      <Link
        to={user ? '/dashboard' : '/'}
        style={{
          color: P.cream,
          textDecoration: 'none',
          fontWeight: 700,
          fontSize: '0.95rem',
          letterSpacing: '0.2px',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: '55%',
          flexShrink: 1,
        }}
      >
        {APP_NAME}
      </Link>

      {/* Right side controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>

        {/* Field/Desk mode chip — authenticated only. Tap to toggle.
            Bite 2 scaffold only: visible status (H1) so the toggle is
            discoverable; downstream bites (B3+) branch on `useMode()`. */}
        {user && (
          <button
            type="button"
            onClick={toggleMode}
            data-testid="mode-chip"
            data-mode={mode}
            aria-label={`Mode: ${modeLabel}. Tap to switch to ${nextLabel}.`}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              color: P.cream,
              backgroundColor: 'rgba(248,245,240,0.15)',
              border: '1px solid rgba(248,245,240,0.3)',
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
        )}

        {/* Zone / location switcher pill — TEMPORARILY DISABLED pre-V2 (2026-05-22, Dave directive).
             Hidden because zone selection is currently a no-op: activeZone is only displayed
             here, never used to filter dashboard/list data (nothing for the switch to do yet).
             Future enhancement — re-enable when zone-scoped filtering ships. The /zone route +
             ZonePicker page stay intact; only this entry-point link is hidden.
             TO RESTORE: uncomment this block AND the useZone import + activeZone destructure above.
        {user && (
          <Link
            to={`/zone?from=${encodeURIComponent(location.pathname)}`}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              color: '#c9a84c', // BUG-04: favorites nav star gold (matches FavoriteToggle favorited state)
              textDecoration: 'none',
              backgroundColor: 'rgba(248,245,240,0.15)',
              border: '1px solid rgba(248,245,240,0.3)',
              borderRadius: 20,
              padding: '4px 10px',
              fontSize: '0.78rem',
              fontWeight: activeZone ? 600 : 400,
              whiteSpace: 'nowrap',
            }}
          >
            📍 {activeZone ? activeZone.name : 'Everywhere'}
          </Link>
        )}
        */}

        {/* Favorites star icon — authenticated only, persistent shortcut to /favorites */}
        {user && (
          <Link
            to="/favorites"
            aria-label="Favorites"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#c9a84c', // BUG-04: favorites nav star gold (matches FavoriteToggle favorited state)
              textDecoration: 'none',
              backgroundColor: 'rgba(248,245,240,0.15)',
              border: '1px solid rgba(248,245,240,0.3)',
              borderRadius: 8,
              width: 36, height: 36,
              fontSize: '1.1rem',
              fontWeight: 700,
            }}
          >
            ★
          </Link>
        )}

        {/* Sign in — unauthenticated only */}
        {!user && (
          <Link
            to="/login"
            style={{
              color: P.cream,
              textDecoration: 'none',
              fontSize: '0.9rem',
              opacity: 0.9,
            }}
          >
            Sign in
          </Link>
        )}
      </div>
    </header>
  )
}
