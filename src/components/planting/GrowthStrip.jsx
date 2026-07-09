// src/components/planting/GrowthStrip.jsx — V200 Slice 5b.
// Presentational growth-narrative primitive. Lives OUTSIDE src/components/forms/ (like Lightbox),
// so it is NOT in the no-hex/no-emoji ESLint scope; even so it sources palette colors from P and
// glyphs from Icon — the only literals are the same rgba-black overlay Lightbox uses.
//
// Fed the planting's photos[] sorted OLDEST-first (caller's job). Two modes:
//   <2 photos  -> a "watch this plant grow" prompt (cream card + sprout glyph + camera CTA).
//   >=2 photos -> a before/after compare: a draggable divider over the two endpoint photos with a
//                 44x44 knob (Pointer Events + setPointerCapture), PLUS a real <input type=range>
//                 keyboard/non-drag alternative (SC 2.5.7 dragging-movements + 2.1.1 keyboard),
//                 a Play/Pause/Stop time-lapse (NO autoplay — SC 2.2.2), and milestone thumbnails
//                 that open the Lightbox at their gallery index.
// prefers-reduced-motion: Play is suppressed; a static swipeable milestone strip is shown instead.
import React, { useState, useRef, useEffect, useCallback } from 'react'
import { P } from '../../lib/constants.js'
import Icon from '../Icon.jsx'
import { prefersReducedMotion } from '../../lib/critterArt.js'

function fmtShort(value) {
  if (!value) return ''
  const d = new Date(typeof value === 'string' && value.length === 10 ? value + 'T00:00:00' : value)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function photoDate(p) {
  return p?.taken_at || p?.created_at || p?.event_date || null
}

const PLAYBACK_MS = 900

export default function GrowthStrip({ photos = [], onOpen, indexBase = 0 }) {
  const list = Array.isArray(photos) ? photos : []
  const reduceMotion = prefersReducedMotion()

  // ── <2 photos: invitation prompt ──────────────────────────────────────────────────────────
  if (list.length < 2) {
    return (
      <div style={{ backgroundColor: P.cream, border: `1px solid ${P.border}`, borderRadius: 10,
        padding: 20, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center' }}>
        <Icon name="lifecycle.sprout" size={40} decorative style={{ color: P.greenLight }} />
        <div style={{ fontSize: '0.9rem', color: P.mid, lineHeight: 1.4 }}>
          Add photos to watch this plant grow
        </div>
        {typeof onOpen === 'function' && list.length === 1 && (
          <button type="button" onClick={() => onOpen(indexBase)}
            aria-label="View this planting's photo"
            style={ctaBtn}>
            <Icon name="media.camera" size={18} decorative style={{ color: P.white }} />
            View photo
          </button>
        )}
      </div>
    )
  }

  // ── >=2 photos: before/after compare + time-lapse ─────────────────────────────────────────
  return <GrowthCompare list={list} onOpen={onOpen} indexBase={indexBase} reduceMotion={reduceMotion} />
}

function GrowthCompare({ list, onOpen, indexBase, reduceMotion }) {
  const before = list[0]
  const after = list[list.length - 1]
  const [pos, setPos] = useState(50)            // divider position 0..100 (% from left)
  const [playing, setPlaying] = useState(false)
  const [frame, setFrame] = useState(0)         // which photo is showing during playback
  const boxRef = useRef(null)
  const timerRef = useRef(null)

  const beforeDate = fmtShort(photoDate(before))
  const afterDate = fmtShort(photoDate(after))

  // Pointer drag on the divider knob — setPointerCapture so the drag tracks outside the knob.
  const onKnobDown = useCallback((e) => {
    const box = boxRef.current
    if (!box) return
    try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch { /* noop */ }
    const move = (clientX) => {
      const r = box.getBoundingClientRect()
      if (!r.width) return
      const pct = ((clientX - r.left) / r.width) * 100
      setPos(Math.min(100, Math.max(0, pct)))
    }
    move(e.clientX)
  }, [])

  const onKnobMove = useCallback((e) => {
    if (e.buttons === 0) return  // only while pressed
    const box = boxRef.current
    if (!box) return
    const r = box.getBoundingClientRect()
    if (!r.width) return
    const pct = ((e.clientX - r.left) / r.width) * 100
    setPos(Math.min(100, Math.max(0, pct)))
  }, [])

  // Time-lapse playback. NO autoplay — only starts on an explicit Play press.
  const stopPlay = useCallback(() => {
    setPlaying(false)
    setFrame(0)
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
  }, [])

  const startPlay = useCallback(() => {
    if (reduceMotion) return
    setPlaying(true)
    setFrame(0)
  }, [reduceMotion])

  useEffect(() => {
    if (!playing) return
    timerRef.current = setInterval(() => {
      setFrame(f => {
        if (f >= list.length - 1) {  // reached the end -> stop on the final frame
          if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
          setPlaying(false)
          return list.length - 1
        }
        return f + 1
      })
    }, PLAYBACK_MS)
    return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null } }
  }, [playing, list.length])

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current) }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Compare / playback stage */}
      <div ref={boxRef} style={{ position: 'relative', width: '100%', aspectRatio: '4 / 3',
        maxHeight: 360, borderRadius: 12, overflow: 'hidden', backgroundColor: P.cream,
        border: `1px solid ${P.border}` }}>
        {playing ? (
          // Playback: show the current frame full-bleed.
          <img src={list[frame]?.view_url} alt={list[frame]?.caption || 'Growth photo'}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <>
            {/* AFTER fills the box; BEFORE is clipped to the divider position on top. */}
            <img src={after?.view_url} alt={after?.caption || 'Latest photo'}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
            <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', width: `${pos}%` }}>
              <img src={before?.view_url} alt={before?.caption || 'First photo'}
                style={{ position: 'absolute', top: 0, left: 0, height: '100%', width: 'auto',
                  minWidth: '100%', objectFit: 'cover' }} />
            </div>
            {/* Divider line + draggable knob (44x44 hit target). */}
            <div aria-hidden="true" style={{ position: 'absolute', top: 0, bottom: 0, left: `${pos}%`,
              width: 2, marginLeft: -1, backgroundColor: P.white, boxShadow: '0 0 4px rgba(0,0,0,0.5)' }} />
            <button type="button"
              onPointerDown={onKnobDown}
              onPointerMove={onKnobMove}
              aria-hidden="true"
              tabIndex={-1}
              style={{ position: 'absolute', top: '50%', left: `${pos}%`,
                transform: 'translate(-50%, -50%)', width: 44, height: 44, borderRadius: '50%',
                border: `2px solid ${P.white}`, backgroundColor: 'rgba(0,0,0,0.5)', cursor: 'ew-resize',
                touchAction: 'none', padding: 0, display: 'inline-flex', alignItems: 'center',
                justifyContent: 'center' }}>
              <Icon name="facet.location" size={18} decorative surface="inverse"
                style={{ color: P.white, transform: 'rotate(90deg)' }} />
            </button>
          </>
        )}
      </div>

      {/* Keyboard / non-drag alternative to the divider drag (SC 2.5.7 + 2.1.1). */}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: '0.72rem', fontWeight: 600, color: P.light,
          textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          {beforeDate || 'First'} &nbsp;↔&nbsp; {afterDate || 'Latest'}
        </span>
        <input
          type="range" min={0} max={100} value={Math.round(pos)}
          onChange={(e) => setPos(Number(e.target.value))}
          aria-label="Before/after comparison position"
          aria-valuetext={`Showing ${beforeDate || 'first photo'} on the left, ${afterDate || 'latest photo'} on the right`}
          disabled={playing}
          style={{ width: '100%' }}
        />
      </label>

      {/* Playback controls — NO autoplay; reduced-motion hides Play entirely. */}
      {!reduceMotion && (
        <div style={{ display: 'flex', gap: 8 }}>
          {!playing ? (
            <button type="button" onClick={startPlay} aria-label="Play time-lapse" style={ctaBtnSlim}>
              <Icon name="media.play" size={18} decorative style={{ color: P.white }} />
              Play time-lapse
            </button>
          ) : (
            <>
              <button type="button" onClick={() => stopPlay()} aria-label="Pause time-lapse" style={ctaBtnSlim}>
                <Icon name="media.pause" size={18} decorative style={{ color: P.white }} />
                Pause
              </button>
              <button type="button" onClick={stopPlay} aria-label="Stop time-lapse" style={ctaBtnSlimAlt}>
                <Icon name="media.stop" size={18} decorative style={{ color: P.green }} />
                Stop
              </button>
            </>
          )}
        </div>
      )}

      {/* Milestone thumbnails — open the Lightbox at the photo's gallery index. data-hscroll marks
          this as a horizontal scroller so the PlantingDetail swipe-pager cedes horizontal drags
          here (it checks e.target.closest('[data-hscroll]')); overscroll-behavior-x contains the
          rubber-band so a boundary drag doesn't trigger browser history nav. */}
      <div data-hscroll style={{ display: 'flex', gap: 8, overflowX: 'auto', overscrollBehaviorX: 'contain', paddingBottom: 4 }}>
        {list.map((p, i) => (
          <button key={p.id || i} type="button"
            onClick={() => typeof onOpen === 'function' && onOpen(indexBase + i)}
            aria-label={`Open growth photo ${i + 1}${photoDate(p) ? ` from ${fmtShort(photoDate(p))}` : ''}`}
            style={{ flex: '0 0 auto', width: 64, padding: 0, border: 'none', background: 'transparent',
              cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'center' }}>
            <img src={p.view_url} alt="" aria-hidden="true"
              style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8,
                border: `1px solid ${P.border}`, display: 'block' }} />
            <span style={{ fontSize: '0.62rem', color: P.light, lineHeight: 1.1, textAlign: 'center' }}>
              {fmtShort(photoDate(p))}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

const ctaBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 44,
  backgroundColor: P.green, color: P.white, border: 'none', borderRadius: 10,
  padding: '0 16px', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer', textDecoration: 'none',
}
const ctaBtnSlim = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 44,
  backgroundColor: P.green, color: P.white, border: 'none', borderRadius: 10,
  padding: '0 16px', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer', flex: 1,
}
const ctaBtnSlimAlt = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 44,
  backgroundColor: P.white, color: P.green, border: `1px solid ${P.greenLight}`, borderRadius: 10,
  padding: '0 16px', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer', flex: 1,
}
