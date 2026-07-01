// V4-APPBAR-001 — top-chrome gate. Root tabs (Today/Garden/DrG/Dashboard) drop the green app-name
// app-bar for a minimal strip carrying only the contained-heart Favorites entry (V200 spec: "no top
// app-bar on root tabs; app name removed — wasted mobile space"). Detail/pushed routes AND the
// unauthenticated app keep the full TopBar (app name/home, mode chip, Favorites, Sign in) so nothing
// becomes unreachable and no pushed screen loses its top affordance. Same 52px+inset height as TopBar,
// so every page's `calc(100dvh - 52px)` layout math and notch handling are unchanged (zero page edits).
import React from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { P } from '../lib/constants.js'
import TopBar from './TopBar.jsx'

const ROOT_TABS = ['/today', '/garden', '/findings', '/dashboard']

export default function TopChrome() {
  const { user } = useAuth()
  const { pathname } = useLocation()

  // Detail/pushed routes + unauthenticated → unchanged full TopBar (no regression, Favorites + mode
  // chip stay reachable on detail screens).
  if (!user || !ROOT_TABS.includes(pathname)) return <TopBar />

  // Root tab → minimal strip: no app-name bar, just the contained-heart Favorites entry (top-right).
  return (
    <header
      style={{
        height: 'calc(52px + env(safe-area-inset-top))',
        paddingTop: 'env(safe-area-inset-top)',
        paddingLeft: 16,
        paddingRight: 16,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        position: 'sticky',
        top: 0,
        zIndex: 80,
        backgroundColor: P.cream,
        boxSizing: 'border-box',
      }}
    >
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
        ♥
      </Link>
    </header>
  )
}
