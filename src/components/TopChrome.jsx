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

// V4-TOPCHROMEACTIONS-001 (BD-027) — Snap + Harvest as header actions.
//
// INLINE SVG, NOT THE ICON REGISTRY, deliberately. This file already draws its own glyphs
// (Magnifier above, the mic in the root pill) and pulls in no icon module; the header is chrome
// and stays self-contained. More decisively: the registry has NO harvest anchor — `event.harvest`
// resolves to STATUS_GLYPHS.harvesting, which is the EMOJI 🧺 (iconRegistry.js:21), and minting a
// real `action.harvest` anchor is a governed act (24px + 18px masters on the Pass B keyline
// grammar, plus an approved entry in scripts/icon-ci/icon-golden-baseline.json). That belongs to
// V4-ICON-001, not to this lane. Both glyphs below are drawn on Magnifier's exact grammar —
// 24 viewBox, stroke-2, round caps — so the eventual registry sweep is mechanical.
function Camera({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={P.greenDeep} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8.5a2 2 0 0 1 2-2h2.3l1.2-2h7l1.2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <circle cx="12" cy="12.5" r="3.4" />
    </svg>
  )
}

// Harvest = a gathering basket: trapezoid body + handle arc. Reads at 18px because the silhouette
// carries it (the handle is the whole tell), so no separate small master is needed here.
function Basket({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={P.greenDeep} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.2 10.5h17.6l-1.9 8.2a1.6 1.6 0 0 1-1.6 1.3H6.7a1.6 1.6 0 0 1-1.6-1.3z" />
      <path d="M8 10.5a4 4 0 0 1 8 0" />
    </svg>
  )
}

// One shared shape for every circular header action (search, snap, harvest) — the search circle's
// style was already a literal in the detail header; a second and third copy is where the three
// silently drift apart, which is the exact divergence BD-027 exists to kill.
const ACTION_CIRCLE = {
  position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: 36, height: 36, borderRadius: '50%', border: '1px solid rgba(255,255,255,0.75)',
  textDecoration: 'none', flexShrink: 0, ...FROST,
}

// Snap is a PAGE (route class 'capture' swaps the whole header for CaptureBar), so a plain Link.
// Harvest is an OverlayLink to the SAME target the FAB row used — /log?event_type=harvest, exact
// string — so the fast path transfers byte-for-byte when V4-HARVFABREMOVE-001 pulls that row.
function HeaderActions() {
  return (
    <>
      <Link to="/capture" aria-label="Snap a photo" data-testid="topchrome-snap" style={ACTION_CIRCLE}>
        <Camera />
      </Link>
      <OverlayLink to="/log?event_type=harvest" aria-label="Log a harvest" data-testid="topchrome-harvest" style={ACTION_CIRCLE}>
        <Basket />
      </OverlayLink>
    </>
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
        {/* Brand row carries the two actions: it was brand-left + dead space, and the search
            launcher below stays full-width, so search-first (V4-APPBAR-003) is untouched. */}
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Link to="/dashboard" style={{ ...BRAND, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{APP_NAME}</Link>
          <HeaderActions />
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
      {/* 390px viewport budget: 14+14 padding, 40 back, 3x36 circles, 4x6 gaps => ~190px left for
          the brand, which ellipsizes rather than pushing an action off. textAlign:center is dropped
          — with three trailing actions the optical centre is no longer the box centre, and a
          centered label inside a squeezed flex box reads as mis-aligned rather than centered. */}
      <Link to="/dashboard" style={{ ...BRAND, position: 'relative', zIndex: 1, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{APP_NAME}</Link>
      <HeaderActions />
      <OverlayLink to="/search" aria-label="Search your garden" data-testid="topchrome-search" style={ACTION_CIRCLE}>
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
