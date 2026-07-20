// src/components/planting/HeroPhoto.jsx — V200 Slice 5b photo hero.
// Full-bleed featured photo (4:3, maxHeight 420, radius 12) with two scrims, floating controls
// (Back / Share / Favorite), and a bottom overlay carrying the planting NAME (rendered AS the
// page <h1> so the heading role still resolves to the name), the lifecycle status badge, a gold
// key-fact pill, and a Details pill that opens the tabbed Details fly-up (owned by the parent).
// No-photo fallback: a per-crop-family illustrated placeholder + "add first photo" deep-link.
//
// Lives OUTSIDE src/components/forms/, so it is not in the no-hex ESLint scope; the rgba-black
// scrim gradients / control backgrounds are intentional literals (mirrors Lightbox). Palette
// colors come from P; glyphs come from Icon.
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { OverlayLink } from '../../context/OverlayContext.jsx'
import { P } from '../../lib/constants.js'
import Icon from '../Icon.jsx'
import FavoriteToggle from '../FavoriteToggle.jsx'
import StatusPicker from './StatusPicker.jsx'
import { selectKeyFact, selectCropType, cropFamilyGlyph } from '../../lib/keyFact.js'

const TOP_PAD = 'calc(8px + env(safe-area-inset-top, 0px))'

// Circular floating control over the scrim (Back / Share). 44x44 hit target.
const floatBtn = {
  width: 44, height: 44, minWidth: 44, minHeight: 44, borderRadius: '50%', border: 'none',
  backgroundColor: 'rgba(0,0,0,0.5)', cursor: 'pointer', padding: 0,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
}

function FloatingControls({ name, shareUrl, plantId }) {
  const navigate = useNavigate()
  function handleShare() {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        navigator.share({ title: name || 'Planting', url: shareUrl }).catch(() => {})
      }
      // No-op fallback when Web Share is unsupported — the button is still operable, just inert.
    } catch { /* noop */ }
  }
  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 3,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: `${TOP_PAD} 10px 0`, gap: 8 }}>
      <button type="button" onClick={() => navigate(-1)} aria-label="Back" style={floatBtn}>
        <Icon name="nav.back" size={22} decorative surface="inverse" style={{ color: P.white }} />
      </button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" onClick={handleShare} aria-label="Share this planting" style={floatBtn}>
          <Icon name="action.share" size={22} decorative surface="inverse" style={{ color: P.white }} />
        </button>
        <span style={{ ...floatBtn, color: P.white }}>
          <FavoriteToggle entityType="plant" entityId={plantId} size="1.5rem" />
        </span>
      </div>
    </div>
  )
}

function BottomOverlay({ name, planting, keyFact, cropType, onOpenDetails, onStatusChanged }) {
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 3,
      padding: '0 14px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h1 style={{ margin: 0, color: P.white, fontSize: '1.4rem', fontWeight: 700,
        lineHeight: 1.2, wordBreak: 'break-word', textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
        {name}
      </h1>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* V4-STATUSTAP-001 — the status face is now the single tappable status control. */}
        <StatusPicker planting={planting} onStatusChanged={onStatusChanged} />
        {/* V4-ABOVEFOLD-001 — crop TYPE above the fold (complements the key-fact pill). */}
        {cropType && (
          <span style={{ backgroundColor: 'rgba(255,255,255,0.92)', color: P.green, fontSize: '0.78rem',
            fontWeight: 700, padding: '4px 10px', borderRadius: 12, whiteSpace: 'nowrap' }}>
            {cropType}
          </span>
        )}
        {keyFact && (
          <span style={{ backgroundColor: P.warn, color: P.statusInkGold, fontSize: '0.78rem',
            fontWeight: 700, padding: '4px 10px', borderRadius: 12, whiteSpace: 'nowrap' }}>
            {keyFact}
          </span>
        )}
        <button type="button" onClick={onOpenDetails} aria-haspopup="dialog"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, backgroundColor: P.white,
            color: P.dark, border: 'none', borderRadius: 12, padding: '5px 12px', minHeight: 32,
            fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer' }}>
          <Icon name="action.info" size={16} decorative style={{ color: P.dark }} />
          Details
        </button>
      </div>
    </div>
  )
}

export default function HeroPhoto({ planting, src, alt, onOpenLightbox, onOpenDetails, onStatusChanged }) {
  const pl = planting || {}
  const name = pl.name || 'Planting'
  const keyFact = selectKeyFact(pl)
  const cropType = selectCropType(pl)
  const shareUrl = typeof window !== 'undefined' ? window.location.href : ''

  const container = {
    position: 'relative', width: '100%', aspectRatio: '4 / 3', maxHeight: 420,
    borderRadius: 12, overflow: 'hidden', backgroundColor: P.greenPale,
  }
  const topScrim = {
    position: 'absolute', top: 0, left: 0, right: 0, height: 88, zIndex: 2, pointerEvents: 'none',
    background: 'linear-gradient(rgba(0,0,0,0.45), transparent)',
  }
  const bottomScrim = {
    // V4-A11Y-001 (SC 1.4.3): deepened + taller so the white <h1> name band sits over >=0.70 alpha,
    // clearing 3:1 large-text over a worst-case bright photo (was h=120 / 0.55 -> 1.8-3.3:1).
    position: 'absolute', bottom: 0, left: 0, right: 0, height: 180, zIndex: 2, pointerEvents: 'none',
    background: 'linear-gradient(transparent, rgba(0,0,0,0.30) 32%, rgba(0,0,0,0.72) 74%, rgba(0,0,0,0.82))',
  }

  if (src) {
    return (
      <div style={container}>
        <button type="button" onClick={() => onOpenLightbox?.(0)}
          aria-label={`View ${name} photo`}
          style={{ position: 'absolute', inset: 0, padding: 0, border: 'none', background: 'transparent',
            cursor: 'pointer', display: 'block' }}>
          <img src={src} alt={alt || `${name} photo`} loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        </button>
        <div style={topScrim} />
        <div style={bottomScrim} />
        <FloatingControls name={name} shareUrl={shareUrl} plantId={pl.id} />
        <BottomOverlay name={name} planting={pl} keyFact={keyFact} cropType={cropType} onOpenDetails={onOpenDetails} onStatusChanged={onStatusChanged} />
      </div>
    )
  }

  // ── No-photo fallback: per-crop-family illustrated placeholder ─────────────────────────────
  const glyph = cropFamilyGlyph(pl)
  const logHref = `/log?project=${pl.project_id}&plant=${pl.id}`
  return (
    <div style={container}>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 14, backgroundColor: P.greenPale }}>
        <Icon name={glyph} size={56} decorative style={{ color: P.greenLight }} />
        <OverlayLink to={logHref} aria-label="Add the first photo for this planting"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 44,
            backgroundColor: P.green, color: P.white, border: 'none', borderRadius: 10,
            padding: '0 16px', fontSize: '0.85rem', fontWeight: 600, textDecoration: 'none' }}>
          <Icon name="media.camera" size={18} decorative surface="inverse" style={{ color: P.white }} />
          Tap to add first photo
        </OverlayLink>
      </div>
      <div style={topScrim} />
      <div style={bottomScrim} />
      <FloatingControls name={name} shareUrl={shareUrl} plantId={pl.id} />
      <BottomOverlay name={name} planting={pl} keyFact={keyFact} cropType={cropType} onOpenDetails={onOpenDetails} onStatusChanged={onStatusChanged} />
    </div>
  )
}
