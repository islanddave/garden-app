// V4-APPBAR-003 — ONE peach search-first header on every content surface. Variant is a function of
// route class (lib/routeClass.js):
//   root    -> 52px: brand wordmark + the three action circles (Snap, Harvest, Search), NO Back.
//   detail  -> the SAME row with a Back (history) button ahead of the brand. root and detail differ
//              by that ONE button and nothing else; both render from a single JSX block below, so a
//              header action can never land on one variant and miss the other. 52px keeps every
//              `100dvh - 52px` shell and PlantingDetail's sticky `top:52` valid.
//   unauth  -> 52px brand moment: brand wordmark + Sign in, banner behind, NO search (targets are
//              Protected pre-auth).
//   capture -> slim immersive CaptureBar (Back + optional title) for /capture, /field.
// Unknown routes default to 'detail', so a new route can never silently lose its header.
//
// Root uses the same magnifier circle every other screen has, giving search parity WITHOUT a Back
// arrow (reclassifying the five tabs to 'detail' would have bought the icon and shipped the arrow;
// routeClass.js records that regression). The 52px box also needs the near-solid DIM_SCRIM: a
// gradient with a 0.42-alpha stop lands right behind the wordmark at 2.03:1 contrast against a 4.5:1
// floor (measured with scripts/banner_contrast.py). One scrim.
// Header is brand + the three actions; Favorites, the Field/Desk chip and the What's-New dot live
// elsewhere (Garden tab, BottomNav More).
// DIM_SCRIM stops mirror scripts/banner_contrast.py STOPS — change BOTH together.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useOverlayLocation, OverlayLink } from '../context/OverlayContext.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { useNavLayout } from '../context/NavPrefsContext.jsx'
import { P, APP_NAME } from '../lib/constants.js'
import { getRouteClass, CAPTURE_TITLES } from '../lib/routeClass.js'
import { pickBanner } from '../lib/pickBanner.js'
import { BANNERS } from '../lib/bannerManifest.js'
import { setPendingCapture } from '../lib/pendingCapture.js'

const HEADER_BG = '#f9e3d6'
const HEADER_BORDER = '#edc7b3'
const BAR_H = 52
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
// INLINE SVG, NOT THE ICON REGISTRY, deliberately: the header is chrome and stays self-contained
// (Magnifier above and the mic draw their own glyphs). The registry has NO harvest anchor
// (`event.harvest` resolves to the emoji STATUS_GLYPHS.harvesting), and minting a real
// `action.harvest` anchor is a governed act (24px + 18px masters on the Pass B keyline grammar, plus
// an approved entry in scripts/icon-ci/icon-golden-baseline.json) that belongs to V4-ICON-001. Both
// glyphs are drawn on Magnifier's exact grammar (24 viewBox, stroke-2, round caps) so the eventual
// registry sweep is mechanical.
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

// One shared shape for every circular header action (search, snap, harvest): separate copies are
// where the three silently drift apart (BD-027).
// 44x44, the platform touch floor. Harvest and photo are the app's #1 and #2 HUMAN ACTIONS measured
// as taps, not as event rows (a watering batch writes ~18 rows, a harvest 1:1), so they must not sit
// on the smallest targets in the product.
//
// NOT fixed here: they are still in the TOP corner, the worst thumb-reach zone one-handed. Moving
// harvest capture into the thumb zone is the real fix and is a layout decision, not a constant.
const ACTION_CIRCLE = {
  position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: 44, height: 44, borderRadius: '50%', border: '1px solid rgba(255,255,255,0.75)',
  textDecoration: 'none', flexShrink: 0, ...FROST,
}

// Snap is a PAGE (route class 'capture' swaps the whole header for CaptureBar); the Snap circle is a
// button that opens the OS picker IN THIS TAP, then parks the file and navigates (BD-032).
//
// A plain Link to /capture would land on a step whose only control is "Choose photo", a dead tap. It
// cannot be fixed from inside CaptureFlow: a file input needs transient activation, the navigation
// gesture is already spent, and Android Chrome blocks auto-opening on mount (CaptureFlow documents
// this). Opening it here works because THIS tap is the trusted gesture. Same pattern as
// planting/QuickActions.jsx; this reuses `pendingCapture` rather than a second hand-off.
//
// It still navigates when the user CANCELS the picker: <input type=file> fires no cancel event, so
// "navigate only on pick" would strand the tap silently. Landing on the photo step with a working
// Choose button is the correct fallback.
//
// Harvest opens the harvest page full-page, not the single-event overlay (V4-WEIGHINCTA-001). Both
// halves are load-bearing: the TARGET, because this circle is on every content surface and is the only
// one-tap doorway from anywhere; and the POSTURE, because session mode is full-page ONLY (EventNew
// gates every session behavior on `harvestSessionParam && !inOverlay`), so an OverlayLink here would
// degrade to the plain ?event_type=harvest form and the session would silently never engage. A Link,
// deliberately. Every CONTEXTUAL harvest entry (HarvestWatchBand, HarvestReadyTile, HarvestReadyBand)
// still deep-links ?plant=&event_type=harvest through an overlay.
// Search lives in HeaderActions rather than being copied into the root variant, so the three circles
// are one definition with one call site per header and root and detail cannot drift apart on what
// actions they carry. Search stays LAST (the right-edge affordance every screen trained on). Not
// rendered by 'unauth' or 'pending' (all three targets are Protected / identity-bearing), which is why
// this stays a component the signed-in row opts into.
function SnapAction() {
  const navigate = useNavigate()
  const inputRef = useRef(null)
  return (
    <>
      <input
        ref={inputRef} type="file" accept="image/*" data-testid="topchrome-snap-input"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''            // re-picking the same file must refire onChange
          if (file) setPendingCapture(file)
          navigate('/capture')
        }}
      />
      {/* No `capture` attribute — V4-HIDECAPTURE-001 made in-app camera the app-wide non-default. */}
      <button
        type="button" aria-label="Snap a photo" data-testid="topchrome-snap"
        onClick={() => inputRef.current?.click()}
        style={{ ...ACTION_CIRCLE, border: 'none', cursor: 'pointer', font: 'inherit' }}
      >
        <Camera />
      </button>
    </>
  )
}

function HeaderActions() {
  return (
    <>
      <SnapAction />
      {/* V5-HARVESTONEDOOR-001: opens the combined harvest page. Still a plain Link and still
          full-page for the V4-WEIGHINCTA-001 reason above: the Manual half IS the weigh-in session
          and it engages only outside an overlay. It lands on voice by default, with the session one
          tap away. */}
      <Link to="/log/harvest" aria-label="Log a harvest" data-testid="topchrome-harvest" style={ACTION_CIRCLE}>
        <Basket />
      </Link>
      <OverlayLink to="/search" aria-label="Search your garden" data-testid="topchrome-search" style={ACTION_CIRCLE}>
        <Magnifier size={18} />
      </OverlayLink>
    </>
  )
}

export default function TopChrome() {
  const { user, loading } = useAuth()
  const { pathname } = useOverlayLocation()
  const { bar } = useNavLayout()
  const navigate = useNavigate()
  const [dayKey, setDayKey] = useState(() => new Date().toDateString())
  const [bannerReady, setBannerReady] = useState(false)
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') setDayKey(new Date().toDateString()) }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  const banner = useMemo(() => pickBanner(new Date(dayKey), BANNERS), [dayKey])

  // V5-NAVANYSLOT-001 — `bar` is the SAME value BottomNav maps over, from the same context read, so a
  // More page loses its Back arrow in the very commit its tab is drawn and never otherwise. Do not
  // derive it here by another road (routeClass.js).
  const cls = getRouteClass(pathname, { user, loading, bar })
  if (cls === 'capture') return <CaptureBar title={CAPTURE_TITLES[pathname] ?? null} />

  const saveData = typeof navigator !== 'undefined' && navigator.connection?.saveData
  const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  const showBanner = banner && !saveData

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
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', background: DIM_SCRIM, zIndex: 0, pointerEvents: 'none' }}
      />
    </>
  ) : null

  // One box for every non-capture variant, so 'pending' reserves the resolved geometry on EVERY route
  // and the handover cannot reflow whichever way auth resolves.
  const base = {
    height: `calc(${BAR_H}px + env(safe-area-inset-top))`,
    paddingTop: 'env(safe-area-inset-top)',
    paddingLeft: 14, paddingRight: 14,
    position: 'sticky', top: 0, zIndex: 80,
    backgroundColor: HEADER_BG,
    borderBottom: `1px solid ${HEADER_BORDER}`,
    boxSizing: 'border-box', overflow: 'hidden',
  }

  // V4-PERFCLERK-001 C — identity UNRESOLVED. Brand + banner only: no Sign in (a signed-out
  // affordance), no search/Snap/Harvest (signed-in affordances whose targets are Protected), and no
  // Link at all, so there is no navigation target to mis-fire during the window. The wordmark is a
  // span, not a Link to /dashboard, for that reason. It reserves the resolved row exactly (same 52px
  // box, same brand slot), so only the trailing controls fade in.
  if (cls === 'pending') {
    return (
      <header data-app-chrome="top" data-chrome-state="pending" aria-busy="true"
        style={{ ...base, display: 'flex', alignItems: 'center', gap: 6 }}>
        {bannerLayers}
        <span style={{ ...BRAND, position: 'relative', zIndex: 1, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{APP_NAME}</span>
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

  // root AND detail, from ONE block. The Back button is the entire difference: a root tab is where a
  // journey starts, so there is no history behind it, while every pushed route gets the arrow.
  // Anything added below lands on both variants by construction.
  return (
    <header data-app-chrome="top" style={{ ...base, display: 'flex', alignItems: 'center', gap: 6 }}>
      {bannerLayers}
      {cls === 'detail' && (
        <button type="button" onClick={() => navigate(-1)} aria-label="Back" data-testid="topbar-back"
          style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, marginLeft: -6, background: 'transparent', border: 'none', color: P.greenDeep, cursor: 'pointer' }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={P.greenDeep} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
      )}
      {/* 390px viewport budget, detail being the tighter of the two: 14+14 padding, 40 back, 3x44
          circles, 4x6 gaps => ~166px left for the brand, which ellipsizes rather than pushing an
          action off; root gets the button's 46px back. textAlign:center is dropped: with three
          trailing actions the optical centre is no longer the box centre. */}
      <Link to="/dashboard" style={{ ...BRAND, position: 'relative', zIndex: 1, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{APP_NAME}</Link>
      <HeaderActions />
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
