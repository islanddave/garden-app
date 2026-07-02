// V4-APPBAR-002 — header information architecture by route CLASS.
// Supersedes V4-APPBAR-001's ROOT_TABS-only allowlist. One header is ALWAYS present; its variant
// is a function of the route class (lib/routeClass.js):
//   root    -> 88px search-first peach header (brand + Favorites + universal-search launcher)
//   capture -> slim immersive bar (Back + optional title, no search/favorites) for /capture, /field
//   detail  -> TopBar WITH a Back affordance (pushed pages) — mode chip + Favorites still reachable
//   unauth  -> TopBar (minimal; brand + Sign in)
// Unknown routes default to 'detail', so a new route can never silently lose its header (the old
// allowlist's silent-drop bug — the /capture double-bar). Peach #f9e3d6 / border #edc7b3.
//
// V4-APPBANNER-001 — daily-rotating curated garden photo behind the peach, ROOT variant ONLY.
// Layer stack: solid peach base (identical fallback when the image is absent/failed/Save-Data)
//   -> photo (decorative: aria-hidden, empty alt, pointer-events none)
//   -> peach gradient scrim (near-solid over the wordmark row + safe-area/status-bar region,
//      breathing mid-band, near-solid again at the bottom border; peach-on-peach = invisible
//      while the photo is unloaded, so there is no flash)
//   -> controls (frosted search field + heart, wordmark as ink on the scrim).
// SCRIM stops mirror scripts/banner_contrast.py STOPS — change BOTH together (contrast gate).
// Pick is deterministic per local day (lib/pickBanner.js); recomputes only on visibilitychange
// so a resumed PWA gets the new day without mid-session swaps.
import React, { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { P, APP_NAME } from '../lib/constants.js'
import TopBar from './TopBar.jsx'
import { getRouteClass, CAPTURE_TITLES } from '../lib/routeClass.js'
import { pickBanner } from '../lib/pickBanner.js'
import { BANNERS } from '../lib/bannerManifest.js'

const HEADER_BG = '#f9e3d6'
const HEADER_BORDER = '#edc7b3'
const SCRIM = 'linear-gradient(180deg, rgba(249,227,214,0.92) 0%, rgba(249,227,214,0.85) 45%, rgba(249,227,214,0.42) 70%, rgba(249,227,214,0.60) 97%, rgba(249,227,214,0.92) 100%)'
const FROST = { backgroundColor: 'rgba(255,255,255,0.82)', backdropFilter: 'blur(12px) saturate(1.1)', WebkitBackdropFilter: 'blur(12px) saturate(1.1)' }

export default function TopChrome() {
  const { user } = useAuth()
  const { pathname } = useLocation()
  const [dayKey, setDayKey] = useState(() => new Date().toDateString())
  const [bannerReady, setBannerReady] = useState(false)
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') setDayKey(new Date().toDateString()) }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  const banner = useMemo(() => pickBanner(new Date(dayKey), BANNERS), [dayKey])

  const cls = getRouteClass(pathname, { user })

  if (cls === 'capture') return <CaptureBar title={CAPTURE_TITLES[pathname] ?? null} />
  if (cls !== 'root') return <TopBar showBack={cls === 'detail'} />

  const saveData = typeof navigator !== 'undefined' && navigator.connection?.saveData
  const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  const showBanner = banner && !saveData

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
        overflow: 'hidden',
      }}
    >
      {showBanner && (
        <img
          aria-hidden="true"
          alt=""
          src={banner.src}
          data-testid="header-banner"
          onLoad={() => setBannerReady(true)}
          onError={() => setBannerReady(false)}
          style={{
            position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
            objectFit: 'cover', objectPosition: banner.position || 'center',
            zIndex: 0, pointerEvents: 'none',
            opacity: bannerReady ? 1 : 0,
            transition: reduceMotion ? 'none' : 'opacity 250ms ease',
          }}
        />
      )}
      {showBanner && (
        <div
          aria-hidden="true"
          data-testid="header-banner-scrim"
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', background: SCRIM, zIndex: 0, pointerEvents: 'none' }}
        />
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'relative', zIndex: 1 }}>
        <Link to="/dashboard" style={{ color: P.greenDeep, textDecoration: 'none', fontWeight: 700, fontSize: '0.9rem', letterSpacing: '0.2px', whiteSpace: 'nowrap' }}>
          {APP_NAME}
        </Link>
        <Link
          to="/favorites"
          aria-label="Favorites"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 30, height: 30, borderRadius: '50%',
            border: `1px solid ${HEADER_BORDER}`,
            color: '#c9a84c', textDecoration: 'none', fontSize: '1rem', fontWeight: 700,
            ...FROST, backgroundColor: 'rgba(255,255,255,0.85)',
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
          border: '1px solid rgba(255,255,255,0.75)',
          textDecoration: 'none', boxSizing: 'border-box',
          position: 'relative', zIndex: 1,
          ...FROST,
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

// Slim immersive bar for full-screen capture surfaces (/capture, /field). Back (history) + optional
// title. No search/favorites — a capture surface is a focused task. Replaces the pages' own in-content
// header bars (this is what removes the /capture "double header").
function CaptureBar({ title }) {
  const navigate = useNavigate()
  return (
    <header style={{
      height: 'calc(52px + env(safe-area-inset-top))',
      paddingTop: 'env(safe-area-inset-top)',
      paddingLeft: 6, paddingRight: 14,
      display: 'flex', alignItems: 'center', gap: 6,
      position: 'sticky', top: 0, zIndex: 80,
      backgroundColor: P.green, boxSizing: 'border-box',
    }}>
      <button type="button" onClick={() => navigate(-1)} aria-label="Back" data-testid="capture-back"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40,
          background: 'transparent', border: 'none', color: P.cream, cursor: 'pointer' }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={P.cream} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
      </button>
      {title && <span style={{ color: P.cream, fontWeight: 700, fontSize: '1rem' }}>{title}</span>}
    </header>
  )
}
