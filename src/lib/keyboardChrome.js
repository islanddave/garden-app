// src/lib/keyboardChrome.js
// V4-KBCHROME-001 — app-wide bottom-chrome suppression while the soft keyboard is up.
//
// WHY. index.html ships interactive-widget=resizes-content (V4-KBVIEWPORT-001), so the keyboard
// now SHRINKS the layout viewport instead of covering it. BottomNav (z100, fixed bottom) and
// TodayBand (z80, fixed above it) therefore ride UP to sit directly on top of the keyboard,
// eating ~112px of an already-halved viewport on every full-page text-entry route. The crucible
// ruling: hide them while the keyboard is up. Scope note — the Sheet overlay is fixed/bottom:0
// with an OPAQUE background at both peek and full, z200 over both chrome components, so
// chrome-above-keyboard does not exist on ANY overlay surface; the real blast radius is
// full-page text-entry routes, and suppression must be INERT when no keyboard is present.
//
// MECHANISM (pre-ruled — do not relitigate):
//   - ONE predicate per chrome component. Each of BottomNav/TodayBand calls
//     useKeyboardChromeSuppressed() and lets the single boolean drive BOTH its
//     `visibility: hidden` AND its own CSS inset var (--bottom-nav-height /
//     --today-band-height -> 0px) in the SAME commit: the style prop mutates in React's DOM
//     commit and the var writes in a useLayoutEffect, both before the same paint — the var and
//     the pixels can never disagree for a frame.
//   - DETECTOR: focused element is text-entry AND visualViewport.height has shrunk >150px vs a
//     continuously recaptured baseline AND vv.scale <= 1.01. The scale guard exists because a
//     2x pinch also shrinks vv.height — without it, zooming reads as keyboard-open and, since
//     the shrink never reverses while zoomed, the chrome would never restore.
//   - Instant suppress; ~300ms debounced restore (absorbs the focus gap when moving between two
//     fields of one form, where focusout->focusin would otherwise flicker the chrome back for a
//     frame or two).
//   - The detector reads visualViewport for CHROME VISIBILITY only. It must never feed content
//     positioning — that JS "fallback" was the root cause V4-KBVIEWPORT-001 removed, and
//     noViewportInsetArithmetic.static.test.js enforces its absence.
//
// BASELINE PROTOCOL (the part that earns "continuously recaptured"):
//   - Seed on first reading, whatever it is (worst case: app loads keyboard-open -> suppression
//     stays off until one clean reading — fail-open, chrome visible, the pre-feature status quo).
//   - GROW instantly: a keyboard can only ever shrink the visual viewport, so a taller reading
//     is always a truer resting height (keyboard closing, URL bar collapsing).
//   - SHRINK only when SETTLED: adopt a smaller resting height only when the restore debounce
//     fires with no text-entry focus. Recapturing the instant focus leaves would poison the
//     baseline with a still-shrunken height during A->B field moves (the keyboard lingers
//     through the gap), which would both flicker the chrome AND kill detection for field B.
//   - Never update while pinch-zoomed (heights are visually scaled).
//   - Orientation change resets the baseline outright (a portrait baseline is meaningless in
//     landscape; stale-large baselines cause FALSE suppression, the harmful direction).
//
// jsdom: no window.visualViewport -> the hook's effect bails -> `false` forever, and the pure
// detector pieces are false/no-op on non-finite inputs. Every existing test renders exactly the
// pre-change chrome. The real gate is the device pass (see the report's device-check list).
import { useState, useEffect } from 'react'

export const KB_SHRINK_MIN_PX = 150
export const KB_SCALE_MAX = 1.01
export const KB_RESTORE_DEBOUNCE_MS = 300

// Input types that never summon a text keyboard. Everything else on INPUT counts as text-entry
// (date/time pickers included — harmless, because the shrink condition must ALSO hold).
const NON_TEXT_INPUT_TYPES = new Set([
  'button', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'submit', 'reset', 'hidden',
])

export function isTextEntryElement(el) {
  if (!el || typeof el !== 'object') return false
  if (el.isContentEditable) return true
  const tag = String(el.tagName || '').toUpperCase()
  if (tag === 'TEXTAREA') return true
  if (tag === 'INPUT') return !NON_TEXT_INPUT_TYPES.has(String(el.type || 'text').toLowerCase())
  return false
}

// Instant-path baseline update: seed + grow only. Pure.
export function nextBaseline({ baseline, vvHeight, vvScale }) {
  if (!Number.isFinite(vvHeight)) return baseline
  if (!(vvScale <= KB_SCALE_MAX)) return baseline
  if (!Number.isFinite(baseline)) return vvHeight
  return Math.max(baseline, vvHeight)
}

// Settled-path baseline update (restore debounce fired, no text-entry focus): the viewport has
// been keyboard-free for the whole debounce window, so its current height IS the resting height —
// the only moment a DOWNWARD recapture is safe. Pure.
export function settledBaseline({ baseline, vvHeight, vvScale, textEntryFocused }) {
  if (!Number.isFinite(vvHeight)) return baseline
  if (!(vvScale <= KB_SCALE_MAX)) return baseline
  if (textEntryFocused) return baseline
  return vvHeight
}

// The detector, pure over one snapshot. False on any non-finite input — which is exactly the
// jsdom shape (no visualViewport -> no heights).
export function computeKeyboardOpen({ textEntryFocused, vvHeight, baselineHeight, vvScale }) {
  if (!textEntryFocused) return false
  if (!Number.isFinite(vvHeight) || !Number.isFinite(baselineHeight)) return false
  if (!(vvScale <= KB_SCALE_MAX)) return false
  return baselineHeight - vvHeight > KB_SHRINK_MIN_PX
}

// The ONE predicate each chrome component consumes. Returns a boolean; the component maps it to
// visibility + its inset var in the same commit (see BottomNav.jsx / TodayBand.jsx).
export function useKeyboardChromeSuppressed() {
  const [suppressed, setSuppressed] = useState(false)

  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    if (!vv || typeof document === 'undefined') return undefined

    let baseline = null
    let restoreTimer = 0

    const snap = () => ({
      textEntryFocused: isTextEntryElement(document.activeElement),
      vvHeight: vv.height,
      vvScale: vv.scale,
    })

    const evaluate = () => {
      const s = snap()
      baseline = nextBaseline({ baseline, ...s })
      if (computeKeyboardOpen({ ...s, baselineHeight: baseline })) {
        if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = 0 }
        setSuppressed(true) // instant suppress; React bails when already true
      } else if (!restoreTimer) {
        restoreTimer = setTimeout(() => {
          restoreTimer = 0
          const s2 = snap()
          baseline = settledBaseline({ baseline, ...s2 })
          // Re-check rather than blind-restore: if the keyboard reopened without an event
          // landing in between (shouldn't happen, but the check costs nothing), stay hidden.
          if (!computeKeyboardOpen({ ...s2, baselineHeight: baseline })) setSuppressed(false)
        }, KB_RESTORE_DEBOUNCE_MS)
      }
    }

    const resetBaseline = () => { baseline = null; evaluate() }

    evaluate()
    vv.addEventListener('resize', evaluate)
    window.addEventListener('resize', evaluate)
    window.addEventListener('orientationchange', resetBaseline)
    document.addEventListener('focusin', evaluate)
    document.addEventListener('focusout', evaluate)
    return () => {
      if (restoreTimer) clearTimeout(restoreTimer)
      vv.removeEventListener('resize', evaluate)
      window.removeEventListener('resize', evaluate)
      window.removeEventListener('orientationchange', resetBaseline)
      document.removeEventListener('focusin', evaluate)
      document.removeEventListener('focusout', evaluate)
    }
  }, [])

  return suppressed
}
