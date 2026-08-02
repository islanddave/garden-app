// V4-APPBAR-003 — ONE peach search-first header on every content surface (unifies the old
// root/detail/unauth split; retires TopBar). Variant is a function of route class
// (lib/routeClass.js):
//   root    -> 88px full header: brand wordmark + full "Search your garden" launcher over the
//              daily banner photo (V4-APPBANNER-001) with the breathing peach scrim.
//   detail  -> 52px condensed: Back (history) + centered brand + a compact search icon, over the
//              SAME banner but a near-solid DIM scrim so ink stays legible when the page itself
//              leads with a hero photo (Dave: "auto-dim on clashes"). 52px == the retired TopBar
//              height, so every `100dvh - 52px` shell + PlantingDetail's sticky `top:52` still hold.
//   unauth  -> 52px brand moment: brand wordmark + Sign in, banner behind, NO search (targets are
//              Protected pre-auth).
//   capture -> slim immersive CaptureBar (Back + optional title) for /capture, /field.
// Unknown routes default to 'detail', so a new route can never silently lose its header.
// Rehomed OFF the header (Dave, V4-APPBAR-003): Favorites heart -> Garden tab; Field/Desk chip ->
// BottomNav More (already mirrored there, now the primary home); What's-New dot -> BottomNav More
// "Release Notes" (already present). Header is now brand + search only.
// SCRIM / DIM_SCRIM stops mirror scripts/banner_contrast.py STOPS — change BOTH together.
import React, { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useOverlayLocation, OverlayLink } from '../context/OverlayContext.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { P, APP_NAME } from '../lib/constants.js'
import { getRouteClass, CAPTURE_TITLES } from '../lib/routeClass.js'
import { pickBanner } from '../lib/pickBanner.js'
import { BANNERS } from '../lib/bannerManifest.js'

const HEADER_BG = '#f9e3d6'
const HEADER_BORDER = '#edc7b3'
const SCRIM = 'linear-gradient(180deg, rgba(249,227,214,0.92) 0%, rgba(249,227,214,0.85) 45%, rgba(249,227,214,0.42) 70%, rgba(249,227,214,0.60) 97%, rgba(249,227,214,0.92) 100%)'
const DIM_SCRIM = 'linear-gradient(180deg, rgba(249,227,214,0.95) 0%, rgba(249,227,214,0.90) 100%)'
const FROST = { backgroundColor: 'rgba(255,255,255,0.82)', backdropFilter: 'blur(12px) saturate(1.1)', WebkitBackdropFilter: 'blur(12px) saturate(1.1)' }
const BRAND = { color: P.greenDeep, textDecoration: 'none', fontWeight: 700, fontSize: '0.9rem', letterSpacing: '0.2px', whiteSpace: 'nowrap' }

function Magnifier({ size = 17 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={P.greenDeep} strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

export default function TopChrome() {
  const { user } = useAuth()
  const { pathname } = useOverlayLocation()
  const navigate = useNavigate()
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

  const saveData = typeof navigator !== 'undefined' && navigator.connection?.saveData
  const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  const showBanner = banner && !saveData
  const scrim = cls === 'root' ? SCRIM : DIM_SCRIM
  const barH = cls === 'root' ? 88 : 52

  const bannerLayers = showBanner ? (
    <>
      <img
        aria-hidden="true" alt="" src={banner.src} data-testid="header-banner"
        onLoad={() => setBannerReady(true)} onError={() => setBannerReady(false)}
        style={{
          position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
          objectFit: 'cover', objectPosition: banner.position || 'center',
          zIndex: 0, pointerEvents: 'none',
          opacity: bannerReady ? 1 : 0,
          transition: reduceMotion ? 'none' : 'opacity 250ms ease',
        }}
      />
      <div
        aria-hidden="true" data-testid="header-banner-scrim"
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', background: scrim, zIndex: 0, pointerEvents: 'none' }}
      />
    </>
  ) : null

  const base = {
    height: `calc(${barH}px + env(safe-area-inset-top))`,
    paddingTop: 'env(safe-area-inset-top)',
    paddingLeft: 14, paddingRight: 14,
    position: 'sticky', top: 0, zIndex: 80,
    backgroundColor: HEADER_BG,
    borderBottom: `1px solid ${HEADER_BORDER}`,
    boxSizing: 'border-box', overflow: 'hidden',
  }

  if (cls === 'root') {
    return (
      <header data-app-chrome="top" style={{ ...base, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8 }}>
        {bannerLayers}
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center' }}>
          <Link to="/dashboard" style={BRAND}>{APP_NAME}</Link>
        </div>
        <OverlayLink
          to="/search" aria-label="Search your garden"
          style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', gap: 8, height: 36, padding: '0 12px', borderRadius: 20, border: '1px solid rgba(255,255,255,0.75)', textDecoration: 'none', boxSizing: 'border-box', ...FROST }}
        >
          <Magnifier />
          <span style={{ color: '#6b6259', fontSize: '0.85rem', flex: 1 }}>Search your garden</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={P.greenDeep} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><line x1="12" y1="18" x2="12" y2="21" />
          </svg>
        </OverlayLink>
      </header>
    )
  }

  if (cls === 'unauth') {
    return (
      <header data-app-chrome="top" style={{ ...base, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {bannerLayers}
        <Link to="/" style={{ ...BRAND, position: 'relative', zIndex: 1 }}>{APP_NAME}</Link>
        <Link to="/login" style={{ position: 'relative', zIndex: 1, color: P.greenDeep, textDecoration: 'none', fontWeight: 700, fontSize: '0.85rem' }}>Sign in</Link>
      </header>
    )
  }

  return (
    <header data-app-chrome="top" style={{ ...base, display: 'flex', alignItems: 'center', gap: 6 }}>
      {bannerLayers}
      <button type="button" onClick={() => navigate(-1)} aria-label="Back" data-testid="topbar-back"
        style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, marginLeft: -6, background: 'transparent', border: 'none', color: P.greenDeep, cursor: 'pointer' }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={P.greenDeep} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
      </button>
      <Link to="/dashboard" style={{ ...BRAND, position: 'relative', zIndex: 1, flex: 1, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis' }}>{APP_NAME}</Link>
      <OverlayLink to="/search" aria-label="Search your garden"
        style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: '50%', border: '1px solid rgba(255,255,255,0.75)', textDecoration: 'none', flexShrink: 0, ...FROST }}>
        <Magnifier size={18} />
      </OverlayLink>
    </header>
  )
}

function CaptureBar({ title }) {
  const navigate = useNavigate()
  return (
    <header data-app-chrome="top" style={{
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
