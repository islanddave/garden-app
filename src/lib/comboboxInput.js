// src/lib/comboboxInput.js
// V4-PICKERKB-002 — the shared input-mode cluster for every search-as-you-type picker
// (Dave, prod smoke 2026-08-03: "It should act the same on every place where I can pick a
// planting unless we've carved out an exception" + "propagate that everywhere ... where there is
// a type ahead or a type search in addition to a chooser. Let's make sure we support both.")
//
// Extracted VERBATIM-in-behavior from VarietyPicker's shipped V4-PICKERKB-001 implementation,
// which is device-validated (Dave, 2026-08-03: keyboard button works, list visible, type-ahead
// fine). Three input modes, one hook:
//   1. TAP    — inputMode="none": the picker opens with the on-screen keyboard SUPPRESSED. Focus
//               is NOT dropped: aria-expanded/aria-controls, the arrow-key handler, and the 150ms
//               blur-close all assume the input holds focus while the listbox is open. inputMode
//               governs only the on-screen keyboard, so a hardware/Bluetooth keyboard still types
//               straight into the field.
//   2. TYPE   — inputMode="text": the field behaves like any other text input, so the tap that
//               focused it raises the keyboard natively, with no JS involved.
//   Which of the two a surface OPENS in is `defaultMode`, per surface (V4-PICKERKBDEF-001).
//   SWAPPING between them mid-interaction is the ⌨ toggle, and Chrome Android will not re-read
//   inputMode on an already-focused element — it needs a blur+refocus. That deliberate blur must
//   NOT be read as "the user tabbed away" (the component's onBlur guards with isDeliberateBlur()).
//   3. SPEAK  — the 🎤 toggle (V4-PICKERVOICE-001). Web Speech via the existing hardened
//               src/lib/transcribe.js wrapper (watchdogs, denial mapping, user-activation
//               contract). Final transcript -> onVoiceText -> the caller sets its query state ->
//               the EXISTING filter runs. Feature-detected; the button never renders where the
//               API is missing (jsdom, Firefox). Inert when unused — zero behavior change for
//               users who never tap it.
import { useState, useEffect, useRef, useCallback } from 'react'
import { P } from './constants.js'
import { isTranscriptionSupported, startLiveTranscription } from './transcribe.js'
import { thumbEdge } from './handedness.js'

export function useComboboxInput({ open, inputRef, onVoiceText, defaultMode = 'none' }) {
  // ── Mode 1/2: the surface's opening mode + the explicit swap ───────────────
  // `defaultMode` defaults to 'none' so every pre-V4-PICKERKBDEF-001 consumer (VarietyPicker) is
  // byte-identical; PlantingSelect passes 'text'.
  const [kbMode, setKbMode] = useState(defaultMode)
  const deliberateBlurRef = useRef(false)

  // Every re-open returns to the surface's default — the swap is per-interaction, never sticky.
  // Without this, one tap on the toggle would make that choice the default for the rest of the
  // session, which is the behavior V4-PICKERKB-001 removed; the argument is symmetric, so it
  // governs the hide direction too.
  useEffect(() => { if (!open) setKbMode(defaultMode) }, [open, defaultMode])

  // The swap Chrome Android actually honours. HARDENING over the shipped setTimeout(0) pattern:
  // Chrome re-reads inputmode at focus time. Write the attribute synchronously rather than
  // trusting React's commit to beat the refocus — if the refocus ever ran against an element
  // still carrying the old value, the keyboard would silently stay down (or stay up). React's own
  // commit then writes the same value (a no-op). The setTimeout(0) refocus itself is KEPT: it
  // preserves Chrome's transient user activation (device-validated on the variety picker
  // 2026-08-03), and a rAF here would gain nothing.
  const swapMode = useCallback((mode) => {
    setKbMode(mode)
    const el = inputRef.current
    if (!el) return
    try { el.setAttribute('inputmode', mode) } catch { /* detached node */ }
    deliberateBlurRef.current = true
    // The blur is what dismisses an open keyboard; the refocus is what keeps this a combobox.
    el.blur()
    setTimeout(() => {
      deliberateBlurRef.current = false
      // kbMode has flushed by now, so the element Chrome re-focuses carries `mode` from React
      // too — the sync attribute write above is the belt to this braces.
      inputRef.current?.focus()
    }, 0)
  }, [inputRef])

  const enableKeyboard = useCallback(() => swapMode('text'), [swapMode])
  const disableKeyboard = useCallback(() => swapMode('none'), [swapMode])

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
      debugLabel: 'Picker',   // BUG-VOICEDUPE-002 — names this surface in /admin/voice-debug
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

  return {
    kbMode, enableKeyboard, disableKeyboard, isDeliberateBlur,
    voiceSupported, voiceState, toggleVoice,
  }
}

// ── Voice-forgiving matching ──────────────────────────────────────────────────
// Recognition returns "sun ray" for "Sunray" and "chilli red" for "Chili Red". The comparison
// key is normalization-level ONLY (no fuzzy-match engine, per the directive): lowercase, strip
// diacritics ("Jalapeño" -> "jalapeno"), drop whitespace/hyphens/apostrophes/periods, and
// collapse repeated letters ("chilli" and "chili" both -> "chili"). Applied to BOTH sides, so
// matching stays consistent — and it is strictly WIDENING over the old .toLowerCase().includes()
// (every previous match still matches; see PlantingSelectKeyboard.test.jsx for the pins).
//
// BUG-LOOSEKEYREPEAT-001 — TWO defects, both on the two .replace() lines below.
//
// (A) THE SEPARATOR CLASS NOW INCLUDES '_'. It did not, so a snake_case crop-type slug kept its
// underscore while the words a human types or says collapse without one, and the two keys could
// never be equal: 'bunching_onion' -> "bunching_onion" vs 'bunching onion' -> "bunchingonion".
// The slug term therefore contributed NOTHING for any multi-word crop type addressed by its natural
// form. This is the half with users today — 10 underscore crop types carry 12 live plantings
// (bunching_onion, sweet_potato, bee_balm, spider_plant, japanese_maple, christmas_cactus,
// lemon_verbena, red_raspberry, bitter_melon, flower_mix) — and it is strictly WIDENING, so the
// invariant this header claims is preserved. It does mean voiceFuzzyMatch.js's tokens() no longer
// splits on exactly this class; that file documents the agreement as load-bearing and is owned by
// another lane, so the correction is routed rather than made here.
//
// (B) THE REPEAT-COLLAPSE IS NON-DIGIT ONLY. It used to run over every character class, so
// looseKey('1884') === looseKey('184') === '184' and two plantings whose names differ only by a
// repeated digit collided in every typed picker. Letters are the class the collapse exists for — a
// recogniser doubles a LETTER ("chilli" for "chili"), which is the whole motivation — while digits
// carry meaning per character: 1884 is one cultivar name, 184 is a different one, 100 is not 10.
// Scoping the capture to a non-digit keeps every letter case the collapse was built for (both pins
// in comboboxInput.test.js are letter cases and stay green either way, which is exactly why the
// digit cases needed their own test) and makes digit runs identity-preserving. Latent today: no
// live planting pair triggers it. Strictly NARROWING, and only over digit runs. The one downstream
// reader that leaned on the old width is namesAPlantingExactly (VoiceHarvest.jsx:138), and it gets
// SAFER — the digit utterances that key-match Dave's planting named 1884 drop from four
// (184 / 1184 / 1844 / 1884) to one, so three accidental mid-record plant switches stop existing.
// That file's measured-blast-radius comment becomes false; also routed, not edited here.
export function looseKey(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s\-'’._]+/g, '')
    .replace(/([^\d])\1+/g, '$1')
}

export function looseIncludes(haystack, needle) {
  const n = looseKey(needle)
  if (!n) return true
  return looseKey(haystack).includes(n)
}

// ── V4-SEARCHCROPTYPE-001, client leg — crop type as a first-class search term ─
// Dave's ask is that search ALWAYS match on crop type, not just cultivar name: "cucumber" must find
// Suyo Long. The dashboard Lambda has done this server-side since a5d80526, but the server leg is
// only half the surface — the client filters are what run instantly, offline, and when the server
// degrades, and three of them (whole-garden search, the /log planting picker, the variety picker)
// matched crop type either not at all or slug-only. This is the ONE implementation all three share,
// so the surfaces cannot drift apart again.
//
// A multi-word slug is reachable by its spoken/typed form ("bunching onion" -> bunching_onion)
// because looseKey now treats '_' as a separator — defect (A) above. That belongs there, not here:
// it is one normalisation applied to BOTH sides of every comparison, and duplicating it as an extra
// term would leave the two half-fixes free to disagree later.
//
// `cropType` is the crop_types row when the surface has the vocabulary in hand (VarietyPicker holds
// it already via useCropTypes); omit it and the slug term still stands. display_name is what reaches
// "scallion" -> bunching_onion. search_aliases ("cantaloupe" -> melon) is NOT reachable from any
// client today — it is deliberately never SELECTed into a response shape — so that half stays
// server-only; see the lane report.
export function cropTypeTerms(slug, cropType = null) {
  const terms = []
  if (slug) terms.push(String(slug))
  if (cropType?.display_name) terms.push(String(cropType.display_name))
  return terms
}

// Haystack-first, needle-second — the looseIncludes argument order, deliberately. A slug-less row
// yields no terms and so matches nothing, including an empty needle (looseIncludes returns true for
// an empty needle; every call site already guards on a non-empty query, and this asymmetry is the
// safe direction — an untyped crop type must not silently match).
export function looseIncludesCropType(slug, needle, cropType = null) {
  return cropTypeTerms(slug, cropType).some(t => looseIncludes(t, needle))
}

// ── Shared toggle-button chrome ───────────────────────────────────────────────
// Slot geometry is FIXED per surface state so tap targets never move mid-interaction:
// ⌨ lives at right:0 (the shipped V4-PICKERKB-001 position), 🎤 at right:44 when speech is
// supported. Where the ⌨ slot can empty mid-interaction (VarietyPicker: the control hides once
// the keyboard is raised) the mic deliberately does NOT slide into it. A surface that renders the
// slot as a two-way toggle instead (PlantingSelect, V4-PICKERKBDEF-001) never empties it at all.
// Buttons are full field height (input minHeight 44) so the target tracks the field.
//
// V4-HANDEDNESSCONTROLS-001 (BD-054) — THE SLOTS FOLLOW THE HANDEDNESS SETTING, AND THIS IS THE
// DEFECT THE TICKET WAS FILED ABOUT. Dave, verbatim: on "choose a planting" the MICROPHONE sits on
// the RIGHT of the field, which is the far side for his logging thumb during a weigh-in (right hand
// on the scale, left hand on the phone). These are PHYSICAL `right:` offsets, not logical
// properties and not flex order, so neither a `dir` flip nor any reorder would ever have reached
// them — the edge has to be computed. `thumbEdge` returns 'right' for the default hand, so the
// shipped positions are unchanged for anyone who never opens the setting.
//
// The slot ORDER off the edge is preserved in both modes (⌨ outermost, then 🎤, then ✕): those are
// positions a thumb already knows, and BUG-PICKERUNDISMISSABLE-001's rule that the dismiss slot is
// APPENDED beyond the shipped two rather than inserted between them is unchanged by mirroring.
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

export function kbToggleBtnStyle(hand) {
  return { ...toggleBtnBase, [thumbEdge(hand)]: 0 }
}

export function micToggleBtnStyle(voiceState, hand) {
  return {
    ...toggleBtnBase,
    [thumbEdge(hand)]: 44,
    ...(voiceState === 'listening' ? { backgroundColor: P.greenPale, color: P.green } : null),
    ...(voiceState === 'denied' ? { opacity: 0.35, cursor: 'default' } : null),
  }
}

// BUG-PICKERUNDISMISSABLE-001 — the dismiss slot, APPENDED beyond ⌨/🎤 rather than inserted: the
// two shipped slots must keep the positions a thumb already knows. It takes the OUTERMOST occupied
// slot, so it sits at 88 alongside a mic and at 44 where speech is unsupported — a capability that
// is fixed for the life of the mount, so the target still never moves mid-interaction.
export function closeToggleBtnStyle(showMic, hand) {
  return { ...toggleBtnBase, [thumbEdge(hand)]: showMic ? 88 : 44 }
}

// Input padding-right for the slots currently occupied: mic shown -> clear both slots (it sits
// at 44..88 even when ⌨ is hidden); else ⌨ shown -> clear one; else the caller's default.
// `showClose` defaults false, so every surface that does not render the dismiss slot (VarietyPicker)
// keeps its exact padding.
export function toggleSlotsPaddingRight({ showKb, showMic, showClose = false }) {
  if (showClose) return showMic ? 136 : 92
  if (showMic) return 92
  if (showKb) return 48
  return null
}

// The same width, expressed as the style object the caller spreads. Returns `null` (not an empty
// object) when no slot is occupied, so `togglePad ? {...} : base` at both call sites keeps working
// unchanged. V4-HANDEDNESSCONTROLS-001: the padding has to move to whichever side the slots did,
// or the query text runs underneath them — the same physical-offset problem one level up.
export function toggleSlotsPaddingStyle({ showKb, showMic, showClose = false, hand }) {
  const px = toggleSlotsPaddingRight({ showKb, showMic, showClose })
  if (px == null) return null
  return thumbEdge(hand) === 'left' ? { paddingLeft: px } : { paddingRight: px }
}
