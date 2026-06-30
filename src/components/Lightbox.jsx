// V4-THEME-001 (V200 Pass B) — full-screen photo Lightbox GALLERY primitive (Slice 1).
//
// Supersedes the single-image lightbox embedded in ZoomableImage.jsx. This is a multi-image
// gallery: swipe/arrow paging, pinch + double-tap zoom (1x-4x), pan-when-zoomed, swipe-down-to-
// close, a filmstrip scrubber, captions, and a fully keyboard/button-operable zoom+pan path
// (WCAG SC 2.5.7 dragging-movements + 2.1.1 keyboard). Pointer Events + CSS transforms only -
// NO external gesture libs, NO iOS gesturechange.
//
// Dialog/portal conventions match ZoomableImage (createPortal to document.body, role=dialog +
// aria-modal + accessible name, focus-to-control, Escape/backdrop close). Focus-trap +
// focus-RESTORE on close match forms/Sheet.jsx. Reduced-motion uses the repo helper pattern
// (CritterAnnouncement) - test-safe (returns false when matchMedia is unavailable in jsdom).
//
// Lives OUTSIDE src/components/forms/, so it is not in the no-hex ESLint scope; the literal
// rgba black backdrop / #fff controls are intentional and mirror ZoomableImage.
//
// Ships DARK: built + unit-tested, NOT exported from any barrel and NOT wired to any consumer
// this slice. A later slice swaps the existing ZoomableImage usages over to it.

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'

// -- Pure, dependency-free math helpers (named exports -> directly unit-testable; jsdom can't
//    exercise real pointer gestures, so the gesture math is covered here instead). ----------

export const MIN_SCALE = 1
export const MAX_SCALE = 4

// Clamp a zoom scale into the supported [MIN_SCALE, MAX_SCALE] range. NaN/garbage -> MIN_SCALE.
export function clampScale(s) {
  if (typeof s !== 'number' || Number.isNaN(s)) return MIN_SCALE
  if (s < MIN_SCALE) return MIN_SCALE
  if (s > MAX_SCALE) return MAX_SCALE
  return s
}

// Clamp a pan offset {x,y} so the scaled image edge never pulls past the viewport interior.
// bounds = { w, h } is the rendered (fit) image box in CSS px at scale 1. At scale s the
// image overflows the box by (s-1)*dim on each axis; max travel is half of that each side.
export function clampPan(pan, scale, bounds) {
  const p = pan || { x: 0, y: 0 }
  const s = clampScale(scale)
  const b = bounds || { w: 0, h: 0 }
  const maxX = Math.max(0, ((s - 1) * (b.w || 0)) / 2)
  const maxY = Math.max(0, ((s - 1) * (b.h || 0)) / 2)
  const cx = Number.isFinite(p.x) ? p.x : 0
  const cy = Number.isFinite(p.y) ? p.y : 0
  return {
    x: Math.min(maxX, Math.max(-maxX, cx)),
    y: Math.min(maxY, Math.max(-maxY, cy)),
  }
}

// Next gallery index after paging by `dir` (+1/-1) over `len` items. CLAMPS at the ends
// (no wrap) - arrows hide/disable at the bounds. Out-of-range inputs are coerced safely.
export function nextIndex(i, dir, len) {
  const n = typeof len === 'number' && len > 0 ? Math.floor(len) : 0
  if (n === 0) return 0
  const cur = Number.isFinite(i) ? Math.floor(i) : 0
  const d = dir > 0 ? 1 : dir < 0 ? -1 : 0
  const next = cur + d
  if (next < 0) return 0
  if (next > n - 1) return n - 1
  return next
}

// Pinch scale = prevScale x (currentDistance / startDistance), clamped. A zero/garbage start
// distance can't produce a ratio, so we fall back to prevScale (clamped).
export function pinchScale(prevScale, startDist, curDist) {
  const prev = clampScale(prevScale)
  if (!Number.isFinite(startDist) || startDist <= 0 || !Number.isFinite(curDist) || curDist <= 0) {
    return prev
  }
  return clampScale(prev * (curDist / startDist))
}

// Euclidean distance between two pointer points - used to derive pinch ratios.
export function pointerDistance(a, b) {
  if (!a || !b) return 0
  const dx = (a.x || 0) - (b.x || 0)
  const dy = (a.y || 0) - (b.y || 0)
  return Math.hypot(dx, dy)
}

// Reduced-motion detection - repo helper pattern (CritterAnnouncement). Test-safe: returns
// false when window/matchMedia is absent (jsdom), so transitions render in tests without error.
function prefersReducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

const ZOOM_STEP = 0.5      // +/- button increment
const PAN_STEP = 48        // keyboard / pan-button nudge in CSS px
const DRAG_PAGE_THRESHOLD = 60   // horizontal travel (px) to commit a page at scale 1
const DRAG_CLOSE_THRESHOLD = 110 // vertical drag-down travel (px) to dismiss at scale 1

const CONTROL_BTN = {
  width: 44, height: 44, minWidth: 44, minHeight: 44,
  borderRadius: '50%', border: 'none',
  background: 'rgba(0,0,0,0.5)', color: '#fff',
  fontSize: '1.4rem', lineHeight: 1, cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  padding: 0,
}

export default function Lightbox({
  open,
  images,
  index = 0,
  onIndexChange,
  onClose,
}) {
  const list = Array.isArray(images) ? images : []
  const len = list.length
  const controlled = typeof onIndexChange === 'function'

  // Uncontrolled internal index, seeded from `index` whenever it changes / on open.
  const [internalIndex, setInternalIndex] = useState(index)
  const curIndex = controlled
    ? Math.min(Math.max(0, index || 0), Math.max(0, len - 1))
    : Math.min(Math.max(0, internalIndex), Math.max(0, len - 1))

  // Zoom/pan state for the CURRENT image.
  const [scale, setScale] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  // Live drag offset at scale==1 (page/close gesture) for progressive feedback.
  const [drag, setDrag] = useState({ x: 0, y: 0, closing: false })

  const dialogRef = useRef(null)
  const stageRef = useRef(null)
  const closeBtnRef = useRef(null)
  const restoreFocusRef = useRef(null)
  const boundsRef = useRef({ w: 0, h: 0 })     // rendered fit-box of the current image
  const pointersRef = useRef(new Map())         // active pointerId -> {x,y}
  const pinchRef = useRef(null)                  // { startDist, startScale }
  const panStartRef = useRef(null)               // { x, y, panX, panY, mode }

  const reduceMotion = prefersReducedMotion()
  const transition = reduceMotion ? 'none' : 'transform 0.18s ease, opacity 0.18s ease'

  // Reset zoom/pan/drag whenever the active image changes or the dialog opens.
  useEffect(() => {
    setScale(1)
    setPan({ x: 0, y: 0 })
    setDrag({ x: 0, y: 0, closing: false })
    pointersRef.current.clear()
    pinchRef.current = null
    panStartRef.current = null
  }, [curIndex, open])

  // Keep uncontrolled index in sync with the `index` prop when reopening / prop changes.
  useEffect(() => {
    if (!controlled) setInternalIndex(index || 0)
  }, [index, open, controlled])

  const goTo = useCallback((next) => {
    const clamped = Math.min(Math.max(0, next), Math.max(0, len - 1))
    if (controlled) onIndexChange(clamped)
    else setInternalIndex(clamped)
  }, [controlled, onIndexChange, len])

  const page = useCallback((dir) => {
    goTo(nextIndex(curIndex, dir, len))
  }, [goTo, curIndex, len])

  const close = useCallback(() => { onClose?.() }, [onClose])

  // -- Open lifecycle: focus management (move in + restore) and Esc + focus-trap (Sheet style).
  useEffect(() => {
    if (!open) return
    if (typeof document === 'undefined') return
    restoreFocusRef.current = document.activeElement
    // Move focus to the close control for keyboard + screen-reader users (ZoomableImage style).
    closeBtnRef.current?.focus()

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return }
      if (e.key === 'ArrowRight') { e.preventDefault(); page(1); return }
      if (e.key === 'ArrowLeft') { e.preventDefault(); page(-1); return }
      // Focus trap within the dialog (Sheet pattern).
      if (e.key === 'Tab') {
        const panel = dialogRef.current
        if (!panel) return
        const items = panel.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
        if (!items.length) return
        const first = items[0]
        const last = items[items.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      const el = restoreFocusRef.current
      if (el && typeof el.focus === 'function') el.focus()
    }
  }, [open, close, page])

  // -- Compute the rendered fit-box of the current image (for pan bounds) after decode/load.
  const onImgLoad = useCallback((e) => {
    const img = e?.currentTarget
    if (!img) return
    const stage = stageRef.current
    const natW = img.naturalWidth || 0
    const natH = img.naturalHeight || 0
    if (!natW || !natH || !stage) { boundsRef.current = { w: 0, h: 0 }; return }
    const sw = stage.clientWidth || 0
    const sh = stage.clientHeight || 0
    // contain-fit: scale the natural box down to fit the stage.
    const fit = Math.min(sw / natW, sh / natH) || 0
    boundsRef.current = { w: natW * fit, h: natH * fit }
  }, [])

  const applyScale = useCallback((nextScale, originPan) => {
    const s = clampScale(nextScale)
    setScale(s)
    setPan((prev) => clampPan(originPan || prev, s, boundsRef.current))
  }, [])

  // -- Pointer gesture handling (arbitration keyed on zoom scale). jsdom can't fire real
  //    multi-pointer events, so this path is render-pass-only; the math is unit-tested above.
  const onPointerDown = useCallback((e) => {
    const stage = stageRef.current
    if (!stage) return
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    try { stage.setPointerCapture?.(e.pointerId) } catch { /* noop */ }
    const pts = Array.from(pointersRef.current.values())
    if (pts.length === 2) {
      pinchRef.current = { startDist: pointerDistance(pts[0], pts[1]), startScale: scale }
      panStartRef.current = null
    } else if (pts.length === 1) {
      panStartRef.current = {
        x: e.clientX, y: e.clientY,
        panX: pan.x, panY: pan.y,
        mode: scale > 1 ? 'pan' : 'page', // arbitration: zoomed -> pan; fit -> page/close
      }
    }
  }, [scale, pan])

  const onPointerMove = useCallback((e) => {
    if (!pointersRef.current.has(e.pointerId)) return
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const pts = Array.from(pointersRef.current.values())

    // Two pointers -> pinch zoom.
    if (pts.length === 2 && pinchRef.current) {
      const dist = pointerDistance(pts[0], pts[1])
      applyScale(pinchScale(pinchRef.current.startScale, pinchRef.current.startDist, dist))
      return
    }

    // One pointer -> pan (zoomed) or page/close (fit).
    const start = panStartRef.current
    if (!start) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y

    if (start.mode === 'pan') {
      // Pan the zoomed image; clampPan stops the edge at the viewport interior. Paging is
      // handed off only when a pan hits the image bound (edge reached -> resume page on lift).
      setPan(clampPan({ x: start.panX + dx, y: start.panY + dy }, scale, boundsRef.current))
    } else {
      // At fit scale: horizontal -> page preview, vertical-down -> progressive dismiss fade.
      const horizontal = Math.abs(dx) > Math.abs(dy)
      if (horizontal) setDrag({ x: dx, y: 0, closing: false })
      else if (dy > 0) setDrag({ x: 0, y: dy, closing: true })
      else setDrag({ x: 0, y: 0, closing: false })
    }
  }, [scale, applyScale])

  const endPointer = useCallback((e) => {
    const stage = stageRef.current
    try { stage?.releasePointerCapture?.(e.pointerId) } catch { /* noop */ }
    pointersRef.current.delete(e.pointerId)
    const remaining = pointersRef.current.size

    if (remaining < 2) pinchRef.current = null

    if (remaining === 0) {
      const start = panStartRef.current
      panStartRef.current = null
      if (start && start.mode === 'page') {
        // Commit page or close based on the accumulated drag.
        if (drag.closing && drag.y > DRAG_CLOSE_THRESHOLD) { close(); return }
        if (Math.abs(drag.x) > DRAG_PAGE_THRESHOLD) page(drag.x < 0 ? 1 : -1)
      }
      setDrag({ x: 0, y: 0, closing: false })
    }
  }, [drag, close, page])

  if (!open) return null
  if (len === 0) return null
  if (typeof document === 'undefined') return null

  const current = list[curIndex] || {}
  const accessibleName = current.caption || current.alt || 'Photo viewer'
  const atStart = curIndex <= 0
  const atEnd = curIndex >= len - 1
  const zoomed = scale > 1

  // Progressive backdrop fade as the user drags the photo down to dismiss.
  const dismissProgress = drag.closing ? Math.min(1, drag.y / 260) : 0
  const backdropAlpha = 0.92 - dismissProgress * 0.55

  const stageTransform = zoomed
    ? `translate(${pan.x}px, ${pan.y}px) scale(${scale})`
    : `translate(${drag.x}px, ${drag.y}px)`

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={accessibleName}
      data-testid="lightbox"
      onClick={(e) => { if (e.target === e.currentTarget) close() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: `rgba(0,0,0,${backdropAlpha})`,
        display: 'flex', flexDirection: 'column',
        transition,
      }}
    >
      {/* Top control bar: close + zoom +/- (non-drag a11y path, SC 2.5.7). */}
      <div
        style={{
          position: 'absolute', top: 0, left: 0, right: 0, zIndex: 3,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: 12, gap: 8,
        }}
      >
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => applyScale(scale - ZOOM_STEP)}
            disabled={scale <= MIN_SCALE}
            aria-label="Zoom out"
            data-testid="lightbox-zoom-out"
            style={{ ...CONTROL_BTN, opacity: scale <= MIN_SCALE ? 0.4 : 1 }}
          >
            {'−'}
          </button>
          <button
            type="button"
            onClick={() => applyScale(scale + ZOOM_STEP)}
            disabled={scale >= MAX_SCALE}
            aria-label="Zoom in"
            data-testid="lightbox-zoom-in"
            style={{ ...CONTROL_BTN, opacity: scale >= MAX_SCALE ? 0.4 : 1 }}
          >
            +
          </button>
          {/* Live zoom readout (also a stable test hook for the zoom state). */}
          <span
            data-testid="lightbox-scale"
            aria-live="polite"
            style={{
              color: '#fff', alignSelf: 'center', fontSize: '0.85rem',
              minWidth: 40, textAlign: 'center',
            }}
          >
            {Math.round(scale * 100)}%
          </span>
        </div>
        <button
          ref={closeBtnRef}
          type="button"
          onClick={close}
          aria-label="Close photo viewer"
          data-testid="lightbox-close"
          style={CONTROL_BTN}
        >
          {'×'}
        </button>
      </div>

      {/* When zoomed, expose keyboard/button panning (SC 2.1.1 + 2.5.7). */}
      {zoomed && (
        <div
          style={{
            position: 'absolute', top: 64, right: 12, zIndex: 3,
            display: 'grid', gridTemplateColumns: 'repeat(3, 44px)', gap: 4,
          }}
          data-testid="lightbox-pan-pad"
        >
          <span />
          <button type="button" aria-label="Pan up" style={CONTROL_BTN}
            onClick={() => setPan((p) => clampPan({ x: p.x, y: p.y + PAN_STEP }, scale, boundsRef.current))}>{'↑'}</button>
          <span />
          <button type="button" aria-label="Pan left" style={CONTROL_BTN}
            onClick={() => setPan((p) => clampPan({ x: p.x + PAN_STEP, y: p.y }, scale, boundsRef.current))}>{'←'}</button>
          <span />
          <button type="button" aria-label="Pan right" style={CONTROL_BTN}
            onClick={() => setPan((p) => clampPan({ x: p.x - PAN_STEP, y: p.y }, scale, boundsRef.current))}>{'→'}</button>
          <span />
          <button type="button" aria-label="Pan down" style={CONTROL_BTN}
            onClick={() => setPan((p) => clampPan({ x: p.x, y: p.y - PAN_STEP }, scale, boundsRef.current))}>{'↓'}</button>
          <span />
        </div>
      )}

      {/* Previous arrow (hidden at start). */}
      {!atStart && (
        <button
          type="button"
          onClick={() => page(-1)}
          aria-label="Previous photo"
          data-testid="lightbox-prev"
          style={{
            ...CONTROL_BTN, position: 'absolute', left: 8, top: '50%',
            transform: 'translateY(-50%)', zIndex: 3, width: 48, height: 48,
            minWidth: 48, minHeight: 48,
          }}
        >
          {'‹'}
        </button>
      )}
      {/* Next arrow (hidden at end). */}
      {!atEnd && (
        <button
          type="button"
          onClick={() => page(1)}
          aria-label="Next photo"
          data-testid="lightbox-next"
          style={{
            ...CONTROL_BTN, position: 'absolute', right: 8, top: '50%',
            transform: 'translateY(-50%)', zIndex: 3, width: 48, height: 48,
            minWidth: 48, minHeight: 48,
          }}
        >
          {'›'}
        </button>
      )}

      {/* Image stage - touch-action:none kills native pinch/scroll; transforms drive zoom/pan. */}
      <div
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDoubleClick={(e) => {
          // Double-tap toggles zoom centered on the tap point.
          if (scale > 1) { applyScale(1, { x: 0, y: 0 }); return }
          const stage = stageRef.current
          const rect = stage?.getBoundingClientRect?.()
          if (rect) {
            const target = 2
            const cx = e.clientX - (rect.left + rect.width / 2)
            const cy = e.clientY - (rect.top + rect.height / 2)
            applyScale(target, { x: -cx * (target - 1), y: -cy * (target - 1) })
          } else {
            applyScale(2)
          }
        }}
        style={{
          flex: 1, position: 'relative',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden', touchAction: 'none',
          minHeight: 0,
        }}
      >
        <img
          src={current.src}
          alt={current.alt || ''}
          onLoad={onImgLoad}
          draggable={false}
          data-testid="lightbox-image"
          style={{
            maxWidth: '94vw', maxHeight: '100%', objectFit: 'contain',
            transform: stageTransform,
            transformOrigin: 'center',
            transition: panStartRef.current || pinchRef.current ? 'none' : transition,
            opacity: drag.closing ? Math.max(0.4, 1 - dismissProgress) : 1,
            userSelect: 'none', WebkitUserSelect: 'none',
            cursor: zoomed ? 'grab' : 'default',
            borderRadius: 6,
          }}
        />
      </div>

      {/* Caption for the current image. */}
      {current.caption && (
        <div
          data-testid="lightbox-caption"
          style={{
            position: 'relative', zIndex: 3, color: '#fff', textAlign: 'center',
            padding: '6px 16px', fontSize: '0.95rem',
            textShadow: '0 1px 3px rgba(0,0,0,0.8)',
          }}
        >
          {current.caption}
        </div>
      )}

      {/* Filmstrip scrubber: one focusable thumb per image; current is highlighted. */}
      <div
        role="tablist"
        aria-label="Photo thumbnails"
        data-testid="lightbox-filmstrip"
        style={{
          position: 'relative', zIndex: 3,
          display: 'flex', gap: 6, overflowX: 'auto',
          padding: '8px 12px calc(8px + env(safe-area-inset-bottom))',
          justifyContent: len > 6 ? 'flex-start' : 'center',
        }}
      >
        {list.map((im, i) => (
          <button
            key={`${im.src || 'img'}-${i}`}
            type="button"
            role="tab"
            aria-selected={i === curIndex}
            aria-label={`Go to photo ${i + 1}${im.caption ? `: ${im.caption}` : ''}`}
            data-testid={`lightbox-thumb-${i}`}
            onClick={() => goTo(i)}
            style={{
              flex: '0 0 auto', width: 52, height: 52, padding: 0,
              border: i === curIndex ? '2px solid #fff' : '2px solid transparent',
              borderRadius: 6, overflow: 'hidden', cursor: 'pointer',
              background: '#000', opacity: i === curIndex ? 1 : 0.6,
            }}
          >
            <img
              src={im.src}
              alt=""
              aria-hidden="true"
              draggable={false}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          </button>
        ))}
      </div>
    </div>,
    document.body,
  )
}
