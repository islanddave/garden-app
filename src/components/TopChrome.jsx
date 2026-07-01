// V4-APPBAR-001 — top-chrome gate. Root tabs (Today/Garden/DrG/Dashboard) render an 88px SEARCH-FIRST
// V200 header on the peach surface: top row = brand wordmark (-> home) + Favorites; bottom row = the
// universal-search launcher (-> /search) with a voice affordance. Search is the header's reason to
// exist (the missing piece that made earlier versions feel empty). Detail/pushed routes + the
// unauthenticated app keep the full TopBar so nothing becomes unreachable. Height is 88px+inset on root
// tabs; the 4 root pages' min-height math is updated to match. The search launcher is intentionally
// translucent (peach shows through muted, Dave). Next slice: a daily-rotating "first-class" garden photo
// behind the peach (V4-APPBANNER). Field/Desk toggle lives in Settings (Dave), not here.
// Peach surface #f9e3d6 / border #edc7b3. Saved alt Dave liked: light-blue #e4eff9 / #c6dcef.
import React from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { P, APP_NAME } from '../lib/constants.js'
import TopBar from './TopBar.jsx'

const ROOT_TABS = ['/today', '/garden', '/findings', '/dashboard']
const HEADER_BG = '#f9e3d6'
const HEADER_BORDER = '#edc7b3'

export default function TopChrome() {
  const { user } = useAuth()
  const { pathname } = useLocation()
  if (!user || !ROOT_TABS.includes(pathname)) return <TopBar />

  return (
    <header
      style={{
        height: 'calc(88px + env(safe-area-inset-top))',
        paddingTop: 'env(safe-area-inset-top)',
        paddingLeft: 14,
        paddingRight: 14,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 8,
        position: 'sticky',
        top: 0,
        zIndex: 80,
        backgroundColor: HEADER_BG,
        borderBottom: `1px solid ${HEADER_BORDER}`,
        boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Link to="/dashboard" style={{ color: P.greenDeep, textDecoration: 'none', fontWeight: 700, fontSize: '0.9rem', letterSpacing: '0.2px', whiteSpace: 'nowrap' }}>
          {APP_NAME}
        </Link>
        <Link
          to="/favorites"
          aria-label="Favorites"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 30, height: 30, borderRadius: '50%',
            backgroundColor: 'rgba(255,255,255,0.85)', border: `1px solid ${HEADER_BORDER}`,
            color: '#c9a84c', textDecoration: 'none', fontSize: '1rem', fontWeight: 700,
          }}
        >
          {'♥'}
        </Link>
      </div>

      <Link
        to="/search"
        aria-label="Search your garden"
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          height: 36, padding: '0 12px', borderRadius: 20,
          backgroundColor: 'rgba(255,255,255,0.58)',
          border: '1px solid rgba(255,255,255,0.75)',
          textDecoration: 'none', boxSizing: 'border-box',
        }}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={P.greenDeep} strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <span style={{ color: '#6b6259', fontSize: '0.85rem', flex: 1 }}>Search your garden</span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={P.greenDeep} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><line x1="12" y1="18" x2="12" y2="21" />
        </svg>
      </Link>
    </header>
  )
}
