// V3-IMGTAP-001 — Default image tap opens a zoomable enlarged view.
//
// ZoomableImage renders an inline <img> that, on tap, opens a full-screen Lightbox
// overlay (dark backdrop, image fit-to-viewport, tap-to-toggle 2× zoom + pan, close via
// backdrop / Escape / × button). It is a drop-in for a plain <img> on surfaces where the
// image is purely displayed and tapping it does nothing else.
//
// NAV / behavior EXCEPTIONS — do NOT replace these <img>s with ZoomableImage, because a tap
// there already means something and the lightbox would hijack it:
//   - Garden.jsx tree-row thumbnails      → the row navigates / expands on tap.
//   - ProjectDetail planting thumbnails   → wrapped in a <Link> to the planting.
//   - Collection.jsx critter images       → reward surface; tap opens the Facts popover.
//   - CritterSprite / CritterArrival / GardenArrival / CritterFactsPopover → reward animations.
//   - PhotoLibrary cards                   → already open a detail modal on tap (own enlarge).
//   - PhotoUpload / mini-logger previews   → transient form previews, not display images.
//
// The onClick stops propagation + prevents default so an accidental wrap in a clickable
// parent still won't double-fire; keep using it only on the inline-display surfaces above.
// Reward UX note: a user-initiated zoom of a content photo is NOT a reward surface — no
// celebration/nudge — so Reward UX V10x does not apply.

import React, { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

function Lightbox({ src, alt, open, onClose }) {
  const [zoomed, setZoomed] = useState(false)
  const closeRef = useRef(null)

  useEffect(() => {
    if (!open) { setZoomed(false); return }
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    // Move focus to the close control for keyboard + screen-reader users.
    closeRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || !src) return null
  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt || 'Enlarged image'}
      data-testid="lightbox"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.88)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'auto', padding: 16,
      }}
    >
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label="Close enlarged image"
        style={{
          position: 'fixed', top: 12, right: 12,
          width: 44, height: 44, borderRadius: '50%', border: 'none',
          background: 'rgba(0,0,0,0.5)', color: '#fff',
          fontSize: '1.5rem', lineHeight: 1, cursor: 'pointer',
        }}
      >
        ×
      </button>
      <img
        src={src}
        alt={alt || ''}
        onClick={(e) => { e.stopPropagation(); setZoomed((z) => !z) }}
        style={{
          maxWidth: zoomed ? 'none' : '92vw',
          maxHeight: zoomed ? 'none' : '92vh',
          transform: zoomed ? 'scale(2)' : 'none',
          transformOrigin: 'center',
          objectFit: 'contain',
          cursor: zoomed ? 'zoom-out' : 'zoom-in',
          transition: 'transform 0.18s ease',
          borderRadius: 8,
        }}
      />
    </div>,
    document.body,
  )
}

export default function ZoomableImage({ src, alt = '', style, ...rest }) {
  const [open, setOpen] = useState(false)
  if (!src) return null
  return (
    <>
      <img
        src={src}
        alt={alt}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen(true) }}
        style={{ cursor: 'zoom-in', ...style }}
        {...rest}
      />
      <Lightbox src={src} alt={alt} open={open} onClose={() => setOpen(false)} />
    </>
  )
}
