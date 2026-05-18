import React from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { useZone } from '../context/ZoneContext.jsx'
import { P, APP_NAME } from '../lib/constants.js'

// TopBar — sticky top bar.
// Layout (NAV-IA-1, V1.2a-3 Increment C / PR-C1, 2026-05-18):
//   left:  app name (clickable home → "Gardens at Home" banner)
//   right: zone pill · Favorites star icon (replaces previous "More" dropdown)
// Sign Out moved from this component into BottomNav's More menu (with confirmation).
// "More" dropdown removed entirely.

export default function TopBar() {
  const { user }       = useAuth()
  const { activeZone } = useZone()
  const location       = useLocation()

  return (
    <header style={{
      backgroundColor: P.green,
      paddingLeft: 16,
      paddingRight: 16,
      paddingTop: 'env(safe-area-inset-top)',
      height: '52px',
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

        {/* Zone pill — authenticated only */}
        {user && (
          <Link
            to={`/zone?from=${encodeURIComponent(location.pathname)}`}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              color: P.cream,
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

        {/* Favorites star icon — authenticated only, persistent shortcut to /favorites */}
        {user && (
          <Link
            to="/favorites"
            aria-label="Favorites"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: P.cream,
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
