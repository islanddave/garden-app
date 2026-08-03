// src/lib/comboboxInput.js
// V4-PICKERKB-002 — the shared input-mode cluster for every search-as-you-type picker
// (Dave, prod smoke 2026-08-03: "It should act the same on every place where I can pick a
// planting unless we've carved out an exception" + "propagate that everywhere ... where there is
// a type ahead or a type search in addition to a chooser. Let's make sure we support both.")
//
// Extracted VERBATIM-in-behavior from VarietyPicker's shipped V4-PICKERKB-001 implementation,
// which is device-validated (Dave, 2026-08-03: keyboard button works, list visible, type-ahead
// fine). Three input modes, one hook:
//   1. TAP    — default. The picker opens with the on-screen keyboard SUPPRESSED via
//               inputMode="none". Focus is NOT dropped: aria-expanded/aria-controls, the
//               arrow-key handler, and the 150ms blur-close all assume the input holds focus
//               while the listbox is open. inputMode governs only the on-screen keyboard, so a
//               hardware/Bluetooth keyboard still types straight into the field.
//   2. TYPE   — the ⌨ toggle. Chrome Android will not raise the keyboard just because inputMode
//               changed on an already-focused element — it needs a blur+refocus. That deliberate
//               blur must NOT be read as "the user tabbed away" (the component's onBlur guards
//               with isDeliberateBlur()).
//   3. SPEAK  — the 🎤 toggle (V4-PICKERVOICE-001). Web Speech via the existing hardened
//               src/lib/transcribe.js wrapper (watchdogs, denial mapping, user-activation
//               contract). Final transcript -> onVoiceText -> the caller sets its query state ->
//               the EXISTING filter runs. Feature-detected; the button never renders where the
//               API is missing (jsdom, Firefox). Inert when unused — zero behavior change for
//               users who never tap it.
import { useState, useEffect, useRef, useCallback } from 'react'
import { P } from './constants.js'
import { isTranscriptionSupported, startLiveTranscription } from './transcribe.js'

export function useComboboxInput({ open, inputRef, onVoiceText }) {
  // ── Mode 1/2: keyboard-less open + explicit opt-in ─────────────────────────
  const [kbMode, setKbMode] = useState('none')
  const deliberateBlurRef = useRef(false)

  // Every re-open starts keyboard-free. Without this, one tap on ⌨ would make the keyboard the
  // default for the rest of the session, which is the behavior V4-PICKERKB-001 removed.
  useEffect(() => { if (!open) setKbMode('none') }, [open])

  const enableKeyboard = useCallback(() => {
    setKbMode('text')
    const el = inputRef.current
    if (!el) return
    // HARDENING over the shipped setTimeout(0) pattern: Chrome re-reads inputmode at focus time.
    // Write the attribute synchronously rather than trusting React's commit to beat the refocus —
    // if the refocus ever ran against an element still carrying inputmode="none", the keyboard
    // would silently stay down. React's own commit then writes the same value (a no-op). The
    // setTimeout(0) refocus itself is KEPT: it preserves Chrome's transient user activation
    // (device-validated on the variety picker 2026-08-03), and a rAF here would gain nothing.
    try { el.setAttribute('inputmode', 'text') } catch { /* detached node */ }
    deliberateBlurRef.current = true
    el.blur()
    setTimeout(() => {
      deliberateBlurRef.current = false
      // kbMode has flushed by now, so the element Chrome re-focuses has inputMode="text" from
      // React too — the sync attribute write above is the belt to this braces.
      inputRef.current?.focus()
    }, 0)
  }, [inputRef])

  // Synchronous read for the component's onBlur: a blur we caused ourselves to swap inputMode
  // must leave `open` alone, or the 150ms blur-close would shut the list under the user.
  const isDeliberateBlur = useCallback(() => deliberateBlurRef.current, [])

  // ── Mode 3: voice ──────────────────────────────────────────────────────────
  const voiceSupported = isTranscriptionSupported()
  // idle | listening | denied. Denial is sticky (the browser remembers it; a retry would re-fail
  // silently) and renders as a quiet disabled state — no modal, no toast, per the directive.
  // Every other error (no-speech, silent-failure, network) quietly returns to idle: voice is an
  // enhancement, and the recovery path is simply "type instead".
  const [voiceState, setVoiceState] = useState('idle')
  const voiceRef = useRef(null)
  const onVoiceTextRef = useRef(onVoiceText)
  onVoiceTextRef.current = onVoiceText

  // Never leave a recognizer running past unmount (route change mid-listen).
  useEffect(() => () => { try { voiceRef.current?.cancel?.() } catch { /* already dead */ } }, [])

  const toggleVoice = useCallback(() => {
    if (voiceRef.current) {
      // Second tap while listening = graceful stop; onEnd delivers whatever was heard.
      try { voiceRef.current.stop() } catch { /* already stopped */ }
      return
    }
    setVoiceState('listening')
    // startLiveTranscription MUST be called synchronously in the tap handler's frame — the
    // user-activation contract documented in transcribe.js. Do not add async hops here.
    voiceRef.current = startLiveTranscription({
      onError: (code) => {
        voiceRef.current = null
        setVoiceState(code === 'denied' ? 'denied' : 'idle')
      },
      onEnd: ({ finalTranscript }) => {
        voiceRef.current = null
        setVoiceState('idle')
        if (finalTranscript) onVoiceTextRef.current?.(finalTranscript)
      },
    })
  }, [])

  return { kbMode, enableKeyboard, isDeliberateBlur, voiceSupported, voiceState, toggleVoice }
}

// ── Voice-forgiving matching ──────────────────────────────────────────────────
// Recognition returns "sun ray" for "Sunray" and "chilli red" for "Chili Red". The comparison
// key is normalization-level ONLY (no fuzzy-match engine, per the directive): lowercase, strip
// diacritics ("Jalapeño" -> "jalapeno"), drop whitespace/hyphens/apostrophes/periods, and
// collapse repeated letters ("chilli" and "chili" both -> "chili"). Applied to BOTH sides, so
// matching stays consistent — and it is strictly WIDENING over the old .toLowerCase().includes()
// (every previous match still matches; see PlantingSelectKeyboard.test.jsx for the pins).
export function looseKey(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s\-'’.]+/g, '')
    .replace(/(.)\1+/g, '$1')
}

export function looseIncludes(haystack, needle) {
  const n = looseKey(needle)
  if (!n) return true
  return looseKey(haystack).includes(n)
}

// ── Shared toggle-button chrome ───────────────────────────────────────────────
// Slot geometry is FIXED per surface state so tap targets never move mid-interaction:
// ⌨ lives at right:0 (the shipped V4-PICKERKB-001 position), 🎤 at right:44 when speech is
// supported. When ⌨ hides (keyboard raised) the mic deliberately does NOT slide into its slot.
// Buttons are full field height (input minHeight 44) so the target tracks the field.
const toggleBtnBase = {
  position: 'absolute',
  top: 0, bottom: 0,
  width: 44,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'none',
  border: 'none',
  borderRadius: 7,
  color: P.mid,
  fontSize: '1.05rem',
  lineHeight: 1,
  cursor: 'pointer',
  padding: 0,
}

export const kbToggleBtnStyle = { ...toggleBtnBase, right: 0 }

export function micToggleBtnStyle(voiceState) {
  return {
    ...toggleBtnBase,
    right: 44,
    ...(voiceState === 'listening' ? { backgroundColor: P.greenPale, color: P.green } : null),
    ...(voiceState === 'denied' ? { opacity: 0.35, cursor: 'default' } : null),
  }
}

// Input padding-right for the slots currently occupied: mic shown -> clear both slots (it sits
// at 44..88 even when ⌨ is hidden); else ⌨ shown -> clear one; else the caller's default.
export function toggleSlotsPaddingRight({ showKb, showMic }) {
  if (showMic) return 92
  if (showKb) return 48
  return null
}
