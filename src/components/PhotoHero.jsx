// src/components/PhotoHero.jsx — TIER-AGNOSTIC photo-hero shell (front-of-roadmap Wave 2C /
// V4-SPACEPHOTO-001). Owns the hero BOX and nothing else: the 4:3 container (maxHeight 420,
// radius 12), the two scrims, the floating Back / Share controls, and the centered no-photo CTA
// slot. Composes PhotoImg for the image layer (PhotoImg's contract is frozen — it gains NO
// hero/variant/tier prop; this is composition, not configuration).
//
// It knows nothing about plantings, plants, spaces or locations. Every tier-specific affordance
// arrives as a SLOT: `actions` (extra floating controls, right of Share), `overlay` (the bottom
// chrome band), `emptyState` (the no-photo CTA body). HeroPhoto specializes it for a planting; the
// space hero will specialize it too. There is exactly ONE hero shell — do not fork a second.
//
// Lives OUTSIDE src/components/forms/, so it is not in the no-hex ESLint scope; the rgba-black scrim
// gradients / control backgrounds are intentional literals (mirrors Lightbox), lifted verbatim from
// HeroPhoto. Palette colors come from P; glyphs come from Icon.
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { P } from '../lib/constants.js'
import Icon from './Icon.jsx'
import PhotoImg from './PhotoImg.jsx'

const TOP_PAD = 'calc(8px + env(safe-area-inset-top, 0px))'

// Circular floating control over the scrim (Back / Share, and anything a tier passes as `actions`).
// 44x44 hit target. Exported so a specializer's own floating control matches without re-declaring it.
export const HERO_FLOAT_BTN = {
  width: 44, height: 44, minWidth: 44, minHeight: 44, borderRadius: '50%', border: 'none',
  backgroundColor: 'rgba(0,0,0,0.5)', cursor: 'pointer', padding: 0,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
}

const containerStyle = {
  position: 'relative', width: '100%', aspectRatio: '4 / 3', maxHeight: 420,
  borderRadius: 12, overflow: 'hidden', backgroundColor: P.greenPale,
}
const topScrimStyle = {
  position: 'absolute', top: 0, left: 0, right: 0, height: 88, zIndex: 2, pointerEvents: 'none',
  background: 'linear-gradient(rgba(0,0,0,0.45), transparent)',
}
const bottomScrimStyle = {
  // V4-A11Y-001 (SC 1.4.3): deepened + taller so the white <h1> name band sits over >=0.70 alpha,
  // clearing 3:1 large-text over a worst-case bright photo (was h=120 / 0.55 -> 1.8-3.3:1).
  position: 'absolute', bottom: 0, left: 0, right: 0, height: 180, zIndex: 2, pointerEvents: 'none',
  background: 'linear-gradient(transparent, rgba(0,0,0,0.30) 32%, rgba(0,0,0,0.72) 74%, rgba(0,0,0,0.82))',
}
const emptyStyle = {
  position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
  alignItems: 'center', justifyContent: 'center', gap: 14, backgroundColor: P.greenPale,
}
const openBtnStyle = {
  position: 'absolute', inset: 0, padding: 0, border: 'none', background: 'transparent',
  cursor: 'pointer', display: 'block',
}
const imgStyle = { width: '100%', height: '100%', objectFit: 'cover', display: 'block' }
// No open handler → the image carries its own fill positioning instead of inheriting the button's.
const staticImgStyle = { ...imgStyle, position: 'absolute', inset: 0 }

function FloatingControls({ shareTitle, shareUrl, shareLabel, actions }) {
  const navigate = useNavigate()
  function handleShare() {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        navigator.share({ title: shareTitle, url: shareUrl }).catch(() => {})
      }
      // No-op fallback when Web Share is unsupported — the button is still operable, just inert.
    } catch { /* noop */ }
  }
  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 3,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: `${TOP_PAD} 10px 0`, gap: 8 }}>
      <button type="button" onClick={() => navigate(-1)} aria-label="Back" style={HERO_FLOAT_BTN}>
        <Icon name="nav.back" size={22} decorative surface="inverse" style={{ color: P.white }} />
      </button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" onClick={handleShare} aria-label={shareLabel} style={HERO_FLOAT_BTN}>
          <Icon name="action.share" size={22} decorative surface="inverse" style={{ color: P.white }} />
        </button>
        {actions}
      </div>
    </div>
  )
}

export default function PhotoHero({
  src, photoId, alt = '', onOpenImage, openLabel = 'View photo',
  shareTitle = 'My garden', shareUrl, shareLabel = 'Share',
  actions, overlay, emptyState,
}) {
  const url = shareUrl ?? (typeof window !== 'undefined' ? window.location.href : '')
  // Presence of a rendered URL — NOT of a photoId — selects the image layer. An id-only hero would
  // need PhotoImg's mount-mint path (A2b P1) and a pending box; no tier needs that today, and
  // keying off `src` keeps the planting hero's branch byte-identical to its pre-extraction form.
  const image = src
    ? <PhotoImg photoId={photoId} initialUrl={src} alt={alt} style={onOpenImage ? imgStyle : staticImgStyle} />
    : null

  return (
    <div style={containerStyle}>
      {image
        ? (onOpenImage
            ? <button type="button" onClick={onOpenImage} aria-label={openLabel} style={openBtnStyle}>{image}</button>
            : image)
        : <div style={emptyStyle}>{emptyState}</div>}
      <div style={topScrimStyle} />
      <div style={bottomScrimStyle} />
      <FloatingControls shareTitle={shareTitle} shareUrl={url} shareLabel={shareLabel} actions={actions} />
      {overlay}
    </div>
  )
}
