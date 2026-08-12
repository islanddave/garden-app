// src/components/forms/PlantingSelect.jsx
// V4-PLANTPICKER-001 — THE shared planting picker (spec v4-metaphoto-plantingtarget
// IMPLEMENTATION-SPEC §6.5). Six hand-rolled pickers preceded this (EventNew, PhotoLibrary ×2,
// PutUp PlantingField, CaptureFlow ×2); each held a behavior the others lacked, so this composes
// the UNION with explicit props — "migrate to the best one" would silently drop features.
// Searchable combobox modeled on VarietyPicker (the exemplar): unscoped lists are garden-sized,
// so a bare <select> no longer works — and the listbox opens on focus in browse mode showing ALL
// candidates, so PutUp's "see the waves side by side" select behavior is preserved, not replaced.
// Deliberately NOT a 4-mode TargetPicker (SelectChip precedent: "compose, don't overload") —
// multi-target scope stays in ScopeChecklist; this is the single-planting seam only.
//
// Prop defaults follow the MAJORITY site's value so a dropped prop is a visible diff (spec §6.5).
// No includeArchived prop: lambda/plants GET filters archived_at IS NULL in BOTH list branches,
// so no client can ever receive an archived row — a prop that can never act would only mislead.
//
// The empty state means three incompatible things across sites; a `required` boolean cannot
// express the difference (spec §6.5). Modeled as emptyMeaning:
//   'unset'         — nothing chosen yet / invalid            (EventNew, CaptureFlow ×2)
//   'none'          — deliberately not tied to a planting     (PutUp — load-bearing, must survive)
//   'project-level' — deliberately logged at project level    (PhotoLibrary upload + tag modal)
// It controls the placeholder copy + the accessible description; clearing (chip ✕) returns to it.
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useApiFetch } from '../../lib/api.js'
import { P } from '../../lib/constants.js'
import { T, inputChrome } from './formStyles.js'
import { formatQty } from '../../lib/format.js'
import { PROJECTS_HIDDEN } from '../../lib/featureFlags.js'
import { useInOverlaySurface } from '../../context/OverlayContext.jsx'
import {
  useComboboxInput, looseIncludes,
  kbToggleBtnStyle, micToggleBtnStyle, toggleSlotsPaddingRight,
} from '../../lib/comboboxInput.js'

// Max rows rendered in the listbox — VarietyPicker precedent: cap VISIBLY (footer row), never
// truncate silently. Unscoped garden lists run to the hundreds; 200 keeps the DOM sane.
const MAX_RESULTS = 200

// V4-PICKERUX-001 P1 — the listbox used to be a hardcoded 280px box that always opened DOWNWARD,
// with no idea how much room was actually below the input. On Android with the keyboard up, the
// real space below a mid-form field is routinely 60-150px, so the box was simply clipped and the
// user got "about three rows" — the second half of the original report, and a completely separate
// defect from the Save-button collision (P0) that shared its symptom.
const LIST_MAX_H = 280            // unchanged ceiling — 6 rows; the value that was always there
const LIST_MIN_H = 140            // 3 rows (3 x 44) + padding: below this, opening downward is worse
                                  // than flipping, because 2 rows is not a chooser.
const LIST_ABS_MIN = 44           // one row. The floor when NEITHER direction can seat LIST_MIN_H —
                                  // see computePlacement.
const LIST_GAP = 8                // breathing room between the panel edge and the viewport edge

// V4-KBVIEWPORT-001: the app-chrome insets the listbox must stay clear of. Bottom = BottomNav +
// TodayBand, read from the CSS variables those components own (BottomNav.jsx, TodayBand.jsx)
// so this can never desync from their real heights — INCLUDING V4-KBCHROME-001 suppression,
// which zeroes those vars in the same commit it hides the components, so a suppressed nav is
// automatically a 0px inset here with no coupling. Top = TopChrome's actual bottom edge — it is
// `position: sticky; top: 0`, so it occupies the top of the scrollport, and its height varies by
// route class (88 root / 52 detail) plus safe-area, which is why it is measured rather than
// constant. Returns zeros in jsdom (no computed vars, zero rects), so the suite keeps today's path.
//
// CONTAINER-AWARE (analyst finding I2, generalized per Dave's photo-tag smoke 2026-08-03): inside
// an opaque floating container that paints OVER the chrome — the Sheet overlay (z200 > nav z100 >
// band z80) and PhotoLibrary's PhotoModal (fixed, z200) — these insets are pure over-subtraction:
// TodayBand mounts app-wide, so 112px of chromeBottom plus 52-88px of chromeTop were reserved for
// chrome the container covers, and on a keyboard-shrunk viewport that starved the picker to ~2
// rows and forced pointless flips. Two detection paths, belt and braces:
//   - `inOverlay` — the OverlaySurfaceContext signal, exactly as EventNew's sticky Save consumes
//     it (bottom: inOverlay ? 0 : nav+12). Covers the Sheet overlay tree.
//   - hasFixedAncestor(anchorEl) — a DOM walk from the input. Covers PhotoModal and any other
//     fixed-position modal WITHOUT requiring its host file to thread a prop (PhotoLibrary is not
//     ours to edit). Everything fixed in this app that can host the picker paints over the
//     bottom chrome (z190+), so `position: fixed` is a sufficient discriminator today.
// Direction note: the pre-fix bug was CONSERVATIVE (list too small — never a wrong-write onto
// nav). Zeroing insets inside an opaque container keeps it conservative: the container covers
// the chrome, so there is nothing tappable to collide with.
export function hasFixedAncestor(el) {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return false
  let node = el && el.nodeType === 1 ? el : null
  while (node && node !== document.documentElement) {
    try { if (getComputedStyle(node).position === 'fixed') return true } catch { return false }
    node = node.parentElement
  }
  return false
}

export function readChromeInsets(anchorEl = null, inOverlay = false) {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    return { top: 0, bottom: 0 }
  }
  if (inOverlay || hasFixedAncestor(anchorEl)) return { top: 0, bottom: 0 }
  const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }
  const cs = getComputedStyle(document.documentElement)
  const bottom = px(cs.getPropertyValue('--bottom-nav-height'))
    + px(cs.getPropertyValue('--today-band-height'))
  const header = document.querySelector('[data-app-chrome="top"]')
  const rect = header?.getBoundingClientRect?.()
  return { top: Math.max(0, rect?.bottom ?? 0), bottom }
}

// The placement decision, as a pure function of injected numbers. Exported for unit tests: this is
// the ONLY part of the picker's geometry that can be verified without a layout engine, so it is
// where the arithmetic lives. jsdom cannot observe the rendered outcome (zero rects, unresolved
// stacking contexts) — see reference/jsdom-cannot-observe-layout-defects.md.
//
// V4-KBVIEWPORT-001 — chrome-aware in BOTH directions. This used to measure to the raw viewport
// edges, which was harmless only because `resizes-visual` kept the whole bottom chrome stack BEHIND
// the keyboard, leaving the band below the input genuinely empty. Once interactive-widget shrinks
// the layout viewport, BottomNav (z100) and TodayBand (z80) occupy the bottom of that band and both
// beat the listbox (z30) — so a tap aimed at a planting row would land on a nav tab and navigate
// off a half-filled form. That is a wrong-write, strictly worse than the cosmetic overlap
// V4-PICKERUX-001 closed. `chromeTop` is not symmetry for its own sake: subtracting `chromeBottom`
// makes flipping UP the common case, and TopChrome (sticky, z80) paints over the listbox with
// tappable Back/search/avatar controls in it — so a one-sided fix would trade a downward wrong-tap
// hazard for an upward one.
export function computePlacement({
  rectTop, rectBottom, viewTop, viewBottom, chromeTop = 0, chromeBottom = 0,
}) {
  const below = Math.floor(viewBottom - chromeBottom - rectBottom - LIST_GAP)
  const above = Math.floor(rectTop - viewTop - chromeTop - LIST_GAP)
  // Flip only when down genuinely cannot seat a choosable list AND up is roomier. A flip that buys
  // 10px is churn the user reads as jitter.
  const flip = below < LIST_MIN_H && above > below
  const room = flip ? above : below
  // When the roomier direction still cannot seat LIST_MIN_H, render the room we ACTUALLY have.
  // The old unconditional `Math.max(LIST_MIN_H, …)` floored a 40px gap up to 140px — a deliberate
  // 100px overflow into exactly the chrome band we just subtracted for. Subtracting chrome makes
  // both-directions-cramped much more common, so the floor would have made this fix increase the
  // frequency of its own worst residual. One row, scrollable, bounds the overflow at 44px.
  const maxHeight = room >= LIST_MIN_H
    ? Math.min(LIST_MAX_H, room)
    : Math.max(LIST_ABS_MIN, room)
  return { flip, maxHeight }
}

// Space available above/below the input, measured against the VISUAL viewport — which tracks the
// Android soft keyboard under BOTH viewport models, so this survives the interactive-widget change
// unchanged. Returns null when it cannot measure: jsdom has no layout engine and no visualViewport,
// so every existing test keeps the previous down-280 behavior rather than silently exercising a new
// path. That guard has its own test (PlantingSelectPlacement.test.jsx) — do not "fix" it by making
// jsdom measure; 340+ test files depend on it.
function measurePlacement(inputEl, inOverlay = false) {
  if (!inputEl || typeof inputEl.getBoundingClientRect !== 'function') return null
  const r = inputEl.getBoundingClientRect()
  if (!r || (!r.top && !r.bottom && !r.height)) return null
  const vv = typeof window !== 'undefined' ? window.visualViewport : null
  const viewTop = vv ? vv.offsetTop : 0
  const viewBottom = vv ? vv.offsetTop + vv.height
    : (typeof window !== 'undefined' ? window.innerHeight : 0)
  if (!viewBottom) return null
  const chrome = readChromeInsets(inputEl, inOverlay)
  return computePlacement({
    rectTop: r.top, rectBottom: r.bottom, viewTop, viewBottom,
    chromeTop: chrome.top, chromeBottom: chrome.bottom,
  })
}

function prettyDate(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// 'wave' label — succession disambiguation (from PutUp's plantingOptionLabel, moved here so the
// dependency points page→component; PutUp re-exports it for its provenance display).
// Three "Dark Green Zucchini" rows are indistinguishable by name, so each option carries its
// succession ordinal and sown date.
export function plantingWaveLabel(p) {
  const base = p.name || p.variety_ref?.name || 'Planting'
  const bits = []
  if (p.succession_order != null) bits.push(`wave ${p.succession_order}`)
  if (p.sown_at) { const d = prettyDate(p.sown_at); if (d) bits.push(`sown ${d}`) }
  return bits.length ? `${base} — ${bits.join(', ')}` : base
}

// 'qtyVariety' label — the EventNew/PhotoLibrary majority format.
// V4-PICKERUX-001: the em-dash promises distinguishing information. When a planting is named after
// its cultivar — the common case for herbs and perennials — it delivered "Lemon Thyme — Lemon
// Thyme", forcing a second read to discover the second half is empty, on the highest-frequency
// label shape and at the width that pushes later rows into an ellipsis.
// The rule is deliberately ASYMMETRIC. Equal-after-normalization drops, and name-contains-variety
// drops (the name is the more specific string, so the variety adds nothing) — but NOT
// variety-contains-name: "Jalapeño — Early Jalapeño" must keep its variety, because "Early" is the
// whole point. A symmetric containment test reads as the tidier rule and silently destroys that.
const normLabel = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

export function plantingQtyVarietyLabel(p) {
  const name = p.name ?? ''
  const variety = p.variety_ref?.name ?? ''
  const n = normLabel(name)
  const v = normLabel(variety)
  const redundant = !!v && (v === n || (!!n && n.includes(v)))
  return `${name}${p.quantity > 1 ? ` ×${formatQty(p.quantity)}` : ''}${variety && !redundant ? ` — ${variety}` : ''}`
}

const LABELERS = {
  qtyVariety: plantingQtyVarietyLabel,
  wave: plantingWaveLabel,
  bare: (p) => p.name ?? p.variety_ref?.name ?? 'Planting',
}

const EMPTY_PLACEHOLDER = {
  unset: 'Search plantings…',
  none: '— Not tied to a planting —',
  'project-level': '— All plants (project level) —',
}

export default function PlantingSelect({
  value = '',
  // onChange(id: string, planting: object|null) — id '' on clear. The row rides along so call
  // sites (CaptureFlow submit, PutUp derive) never need their own id→row lookup.
  onChange,
  // Controlled data mode: when `plants` is set the component NEVER fetches — the site owns the
  // list (EventNew's deep-link/sticky validation, PhotoLibrary's per-project effects, CaptureFlow's
  // shared fetch). Absent → self-fetch: unscoped /api/plants, or ?project_id= via scopeProjectId.
  plants,
  scopeProjectId,
  // Progressive scoping (PutUp): a variety pins the list exactly; a crop narrows to that crop's
  // plantings; with neither we offer everything rather than an empty list the user can't explain.
  varietyId,
  cropSlug,
  // PutUp trap (spec §6.5): the selected planting may sit OUTSIDE the current scope (prefilled
  // from a harvest, or the user narrowed the crop afterwards). true = keep it listed + selected;
  // false (majority) = out-of-scope selection renders as unset.
  retainOutOfScopeValue = false,
  sort = 'name',              // 'name' (majority) | 'sown' (PutUp: planting order)
  labelFormat = 'qtyVariety', // 'qtyVariety' (majority) | 'wave' (PutUp) | 'bare' (CaptureFlow)
  emptyMeaning = 'unset',     // see header — 'unset' (majority) | 'none' | 'project-level'
  required = false,
  disabled = false,
  // EventNew: the picker is disabled until a project is chosen, and the disabled control itself
  // must say WHY ("— select a project first —") — a silently disabled required field is the P5
  // failure mode this component exists to prevent.
  disabledHint,
  placeholder,
  id,
  onDerive,     // PutUp back-propagation: ({ crop_type_slug, variety_id, variety }) on selection
  onLoadError,  // PutUp graceful-failure contract: surface load failure, stay non-fatal
  // BUG-PLANTFETCHSILENT-001 — controlled-mode counterpart to the self-fetch `failed` state below.
  // In controlled mode the fetch effect returns early, so `failed` can NEVER fire and a site whose
  // own fetch rejected renders here byte-identically to "No plantings yet." — an unfillable required
  // field that reads as a legitimately empty project, with no error and no way to retry. The site
  // owns the fetch in that mode, so the site must own the failure. `onRetry` is optional: a site
  // that cannot re-run its fetch still gets the honest copy, just without the affordance.
  loadFailed = false,
  onRetry,
  // V4-PICKERUX-001 — onOpenChange(open: boolean). OPTIONAL, no-op default: the other six call
  // sites are untouched. It exists because a host page cannot otherwise know not to render a
  // competing control over the open listbox — EventNew's sticky Save was painting over rows 2-3
  // AND taking their taps, saving events detached from the planting being chosen.
  // Deliberately NOT threaded through the eight setOpen() sites: one effect on `open` below
  // covers every path (focus, type, arrow, escape, blur-timeout, select, chip "Change") and
  // cannot drift when a ninth is added.
  onOpenChange,
  // BUG-POSTSAVEVALIDATION-001 — OPTIONAL, no-op default: the other six call sites are untouched
  // (same contract as onOpenChange above). `touched` is LOCAL state, so when a host clears its own
  // value without unmounting this component — EventNew's resetForNext() after a successful save —
  // `selected` goes null while `touched` stays true and showBlankError renders "Choose a planting."
  // against a field the user has not touched yet. Bumping this nonce marks the field fresh again.
  // Deliberately a nonce and not a `touched` prop: ownership of the flag stays here, and the host
  // only gets to say "this is a new form now", which is the fact it actually knows.
  resetNonce,
  // BUG-LOGTARGETREQ-001 — OPTIONAL, default-off ⇒ all render sites byte-identical. When set and
  // present in the candidate list, that planting is PINNED to position 1 with a visible "recent"
  // text affix (label channel, never color-only), bypassing the internal sort for that row only.
  // Composition rules: FILTERS WIN — an active crop chip or typeahead query that excludes it
  // simply filters it out (never shown-but-dimmed, never overriding a filter); it hoists only
  // within the filtered set; the marker renders only at top position (an out-of-scope retention
  // prepend outranks it). Ranking, never value: this prop must never seed `value`.
  recentPlantId,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
  'data-testid': dataTestId,
}) {
  const { fetch: apiFetch } = useApiFetch()
  const [fetched, setFetched] = useState([])
  const [loading, setLoading] = useState(plants == null)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [touched, setTouched] = useState(false)
  // BUG-POSTSAVEVALIDATION-001. Fires once on mount (a no-op — `touched` already starts false) and
  // again on every host reset. When `resetNonce` is undefined the dep never changes, so the six
  // other call sites see mount-only behaviour identical to before.
  useEffect(() => { setTouched(false) }, [resetNonce])
  const inputRef = useRef(null)
  const listboxId = useMemo(() => `ps-list-${Math.random().toString(36).slice(2, 9)}`, [])

  // Rendering inside the route-overlay Sheet? Context default is false (full page / no provider),
  // exactly the signal EventNew's sticky Save uses. Feeds chrome-inset zeroing in placement.
  const inOverlay = useInOverlaySurface()

  // V4-PICKERKB-002 + V4-PICKERVOICE-001 — the shared input-mode cluster (keyboard-less open,
  // ⌨ opt-in, 🎤 voice). Mechanism + rationale live in lib/comboboxInput.js; VarietyPicker is
  // the device-validated reference consumer.
  const { kbMode, enableKeyboard, isDeliberateBlur, voiceSupported, voiceState, toggleVoice } =
    useComboboxInput({
      open,
      inputRef,
      onVoiceText: (t) => { setQuery(t); setOpen(true) },
    })

  const controlled = plants != null
  const rows = controlled ? plants : fetched
  // One flag for both modes so every downstream branch stays a single condition; the empty-state
  // row must be gated on THIS, not `failed`, or a controlled failure still prints "No plantings yet."
  const loadFailedEffective = failed || loadFailed

  // V4-PICKERUX-001 — the single notification point for `open`. Keyed on `open` ONLY: keying it on
  // the callback identity would re-fire on every parent render (callers pass inline closures), and
  // an effect keyed on a per-render identity is exactly the BUG-SOWFOCUS-001 shape. Read through a
  // ref so a non-memoized handler still cannot retrigger it.
  const onOpenChangeRef = useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange
  useEffect(() => { onOpenChangeRef.current?.(open) }, [open])
  // The listbox unmounts with the component while still open (route change, sheet dismiss, the
  // chip-mode swap). Without this the host is left believing a picker is open forever — for
  // EventNew that means a permanently hidden Save button.
  useEffect(() => () => { onOpenChangeRef.current?.(false) }, [])

  useEffect(() => {
    if (controlled) return
    let live = true
    setLoading(true)
    setFailed(false)
    apiFetch(scopeProjectId ? `/api/plants?project_id=${scopeProjectId}` : '/api/plants')
      .then(data => { if (live) setFetched(Array.isArray(data) ? data : []) })
      .catch(err => { if (live) { setFailed(true); onLoadError?.(err) } })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [apiFetch, controlled, scopeProjectId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Scope → search → sort ─────────────────────────────────────────────────
  const candidates = useMemo(() => {
    let list = rows
    if (varietyId) list = list.filter(p => String(p.variety_id ?? p.variety_ref?.id ?? '') === String(varietyId))
    else if (cropSlug) list = list.filter(p => p.variety_ref?.crop_type_slug === cropSlug)
    const q = query.trim()
    if (q) {
      // V4-PICKERVOICE-001: voice-forgiving normalization ("sun ray" -> "Sunray"). Strictly
      // widens the old .toLowerCase().includes() — typed queries keep every match they had.
      // Fully client-side here (unlike VarietyPicker there is no server ?q= leg to stay strict).
      list = list.filter(p =>
        looseIncludes(p.name, q) ||
        looseIncludes(p.variety_ref?.name, q) ||
        looseIncludes(p.project_name, q)
      )
    }
    const sorted = sort === 'sown'
      ? [...list].sort((a, b) => {
          const at = a.sown_at ? Date.parse(a.sown_at) : Infinity
          const bt = b.sown_at ? Date.parse(b.sown_at) : Infinity
          if (at !== bt) return (isNaN(at) ? Infinity : at) - (isNaN(bt) ? Infinity : bt)
          return (a.name || '').localeCompare(b.name || '')
        })
      : [...list].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    // BUG-LOGTARGETREQ-001 — recentPlantId hoist, AFTER scope+search+sort so filters always win:
    // a row the filter excluded is simply absent (findIndex misses), and the pin acts only within
    // the filtered set. Absent/archived remembered id → no-op, fallback ordering (never a crash).
    if (recentPlantId) {
      const ri = sorted.findIndex(p => String(p.id) === String(recentPlantId))
      if (ri > 0) sorted.unshift(sorted.splice(ri, 1)[0])
    }
    return sorted
  }, [rows, varietyId, cropSlug, query, sort, recentPlantId])

  const selected = useMemo(
    () => rows.find(p => String(p.id) === String(value)) || null,
    [rows, value],
  )

  // Out-of-scope retention (PutUp): silently dropping the current value would blank the field
  // and quietly discard the link. Prepend it so it stays visible AND selectable.
  const listed = useMemo(() => {
    if (retainOutOfScopeValue && selected && !candidates.some(p => String(p.id) === String(selected.id))) {
      return [selected, ...candidates]
    }
    return candidates
  }, [retainOutOfScopeValue, selected, candidates])

  const visible = useMemo(() => listed.slice(0, MAX_RESULTS), [listed])
  const hiddenCount = listed.length - visible.length

  // V4-PICKERUX-001: the project tag discriminates nothing when every visible row carries the same
  // project — which is the norm, because EventNew/PhotoLibrary feed a list already scoped by
  // project. It cost horizontal width on every row, and width is what pushes later rows into an
  // ellipsis. Suppressed on CARDINALITY rather than on the PROJECTS_HIDDEN flag beside it, so it
  // self-corrects whichever way the list is later fed.
  const showProjectTag = useMemo(
    () => new Set(visible.map(p => p.project_name).filter(Boolean)).size > 1,
    [visible],
  )

  // V4-PICKERUX-001 P1 — measured placement. null = "could not measure", which renders exactly the
  // pre-P1 style (down, 280) rather than guessing.
  const [placement, setPlacement] = useState(null)
  useEffect(() => {
    if (!open || disabled) { setPlacement(null); return }
    let raf = 0
    const apply = () => {
      raf = 0
      const next = measurePlacement(inputRef.current, inOverlay)
      // Bail when nothing changed: this runs on visualViewport scroll, which fires per compositor
      // frame during the keyboard animation. Re-rendering a 200-row listbox every frame, on the one
      // interaction where the device is already animating, is exactly the cost not worth paying.
      setPlacement(prev =>
        (prev?.flip === next?.flip && prev?.maxHeight === next?.maxHeight) ? prev : next)
    }
    const schedule = () => {
      if (raf) return
      raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(apply) : (apply(), 0)
    }
    apply()
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    vv?.addEventListener('resize', schedule)
    vv?.addEventListener('scroll', schedule)
    window.addEventListener?.('resize', schedule)
    return () => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
      vv?.removeEventListener('resize', schedule)
      vv?.removeEventListener('scroll', schedule)
      window.removeEventListener?.('resize', schedule)
    }
    // visible.length is a dep because the panel's own height changes the flip decision once the
    // list is short enough to not need the room. inOverlay flips the chrome-inset zeroing.
  }, [open, disabled, visible.length, inOverlay])

  useEffect(() => { setHighlight(0) }, [query, rows])

  const label = LABELERS[labelFormat] ?? LABELERS.qtyVariety

  const select = useCallback((p) => {
    onChange?.(p ? String(p.id) : '', p ?? null)
    if (p && onDerive) {
      onDerive({
        crop_type_slug: p.variety_ref?.crop_type_slug ?? null,
        variety_id: p.variety_id ?? p.variety_ref?.id ?? null,
        variety: p.variety_ref ?? null,
      })
    }
    setOpen(false)
    setQuery('')
    setTouched(true)
  }, [onChange, onDerive])

  const clear = useCallback(() => {
    onChange?.('', null)
    setTouched(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [onChange])

  const onKeyDown = (e) => {
    if (disabled) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) setOpen(true)
      setHighlight(h => Math.min(visible.length - 1, h + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight(h => Math.max(0, h - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (!open) { setOpen(true); return }
      if (visible[highlight]) select(visible[highlight])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      inputRef.current?.blur()
    }
  }

  const onBlur = () => {
    // A blur we caused ourselves to swap inputMode (⌨ opt-in) — leave `open` alone, or the
    // deferred close below would shut the list exactly when the user asked to type into it.
    if (isDeliberateBlur()) return
    // Delay close so a listbox click (which preventDefaults mousedown to keep input focus)
    // lands first — VarietyPicker convention.
    setTimeout(() => setOpen(false), 150)
    setTouched(true)
  }

  // ── Chip mode: a selection is made and the picker is at rest ──────────────
  if (selected && !open) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={chipStyle(disabled)} aria-live="polite" data-testid={dataTestId ? `${dataTestId}-chip` : undefined}>
          <span style={{ fontSize: '0.88rem', fontWeight: 600, color: P.green }}>
            {label(selected)}
          </span>
          {/* V4-PROJHIDE-001: the secondary project_name tag is hidden when projects aren't user-facing
              (extends the existing labelFormat!=='wave' suppression). Flag OFF renders it as before. */}
          {selected.project_name && labelFormat !== 'wave' && !PROJECTS_HIDDEN && (
            <span style={{ fontSize: '0.74rem', color: P.light, marginLeft: 6 }}>
              {selected.project_name}
            </span>
          )}
          {!disabled && (
            <button type="button" onClick={clear} aria-label="Clear planting selection" style={chipClearBtn}>
              ✕
            </button>
          )}
        </div>
        {!disabled && (
          <button
            type="button"
            onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 0) }}
            style={linkBtn}
          >
            Change
          </button>
        )}
      </div>
    )
  }

  const showBlankError = required && touched && !selected && !query
  const effectivePlaceholder = disabled && disabledHint
    ? disabledHint
    : (placeholder ?? EMPTY_PLACEHOLDER[emptyMeaning] ?? EMPTY_PLACEHOLDER.unset)

  // V4-PICKERKB-002: ⌨ while the list is open and the keyboard is still suppressed; 🎤 whenever
  // speech is available and the list is open (independent of kbMode). Mirrors VarietyPicker.
  const showKbBtn = open && !disabled && kbMode === 'none'
  const showMicBtn = open && !disabled && voiceSupported
  const togglePad = toggleSlotsPaddingRight({ showKb: showKbBtn, showMic: showMicBtn })

  return (
    <div style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-required={required || undefined}
        aria-invalid={showBlankError || undefined}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        data-testid={dataTestId}
        value={query}
        inputMode={kbMode}
        onChange={e => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => { if (!disabled) setOpen(true) }}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        placeholder={effectivePlaceholder}
        disabled={disabled}
        style={{
          ...inputChrome(showBlankError), minHeight: 44,
          ...(togglePad ? { paddingRight: togglePad } : null),
          ...(disabled ? { opacity: 0.5, cursor: 'not-allowed' } : null),
        }}
        autoComplete="off"
      />
      {/* V4-PICKERKB-002 — "I do want to type". onMouseDown preventDefault keeps input focus so
          the 150ms blur-close never races the refocus (listbox-row trick). */}
      {showKbBtn && (
        <button
          type="button"
          onMouseDown={e => e.preventDefault()}
          onClick={enableKeyboard}
          aria-label="Type to search plantings"
          title="Type to search"
          style={kbToggleBtnStyle}
        >
          <span aria-hidden="true">⌨</span>
        </button>
      )}
      {/* V4-PICKERVOICE-001 — speak the value. Denied mic = quiet disabled state, no modal/toast. */}
      {showMicBtn && (
        <button
          type="button"
          onMouseDown={e => e.preventDefault()}
          onClick={voiceState === 'denied' ? undefined : toggleVoice}
          aria-label={
            voiceState === 'denied' ? 'Microphone unavailable'
            : voiceState === 'listening' ? 'Stop listening'
            : 'Speak to search plantings'
          }
          aria-pressed={voiceState === 'listening'}
          aria-disabled={voiceState === 'denied' || undefined}
          title="Speak to search"
          style={micToggleBtnStyle(voiceState)}
        >
          <span aria-hidden="true">🎤</span>
        </button>
      )}
      {open && !disabled && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Plantings"
          style={listboxStyle(placement)}
          // Keep input focus while clicking rows; onBlur's deferred close still runs after click.
          onMouseDown={e => e.preventDefault()}
        >
          {loading && <li style={noteRow} role="presentation">Loading plantings…</li>}
          {loadFailedEffective && !loading && (
            <li style={noteRow} role="alert">
              {/* The old copy was unconditional and became false the moment PLANTING_REQUIRED_ENABLED
                  flips: telling someone they can save without a planting, on a form that will refuse
                  exactly that, is worse than saying nothing. Branch on the same prop that drives the
                  requiredness so the two can never disagree. */}
              {required
                ? 'Couldn’t load your plantings — this field is required, so retry before saving.'
                : 'Couldn’t load your plantings — you can still save without one.'}
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  data-testid="ps-retry"
                  style={{
                    marginLeft: 8, padding: 0, border: 'none', background: 'none',
                    color: P.terra, fontSize: '0.8rem', fontWeight: 600,
                    textDecoration: 'underline', cursor: 'pointer',
                  }}
                >
                  Retry
                </button>
              )}
            </li>
          )}
          {!loading && !loadFailedEffective && visible.length === 0 && (
            <li style={noteRow} role="presentation">
              {query.trim() ? `No plantings match “${query.trim()}”.` : 'No plantings yet.'}
            </li>
          )}
          {visible.map((p, i) => (
            <li
              key={p.id}
              role="option"
              aria-selected={String(p.id) === String(value)}
              data-testid={`ps-opt-${p.id}`}
              onClick={() => select(p)}
              style={rowStyle(i === highlight)}
            >
              {/* V4-PICKERUX-001 P1: minWidth 0 is load-bearing — a flex child's default
                  min-width:auto refuses to shrink below its content, so textOverflow never engages
                  without it and the row grows instead of ellipsing. */}
              <span style={{ minWidth: 0, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {label(p)}
              </span>
              {/* BUG-LOGTARGETREQ-001 — "recent" marker: LABEL channel (visible text), never
                  color/position-only, and ONLY at top position — the retention prepend outranks
                  the hoist, so a recent row pushed to index 1 carries no marker. */}
              {i === 0 && recentPlantId && String(p.id) === String(recentPlantId) && (
                <span style={{ fontSize: '0.72rem', fontWeight: 700, color: P.green, marginLeft: 8, flexShrink: 0, textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                  recent
                </span>
              )}
              {/* V4-PROJHIDE-001: option project_name tag hidden when projects aren't user-facing.
                  V4-PICKERUX-001: also hidden when every visible row shares one project. */}
              {p.project_name && labelFormat !== 'wave' && !PROJECTS_HIDDEN && showProjectTag && (
                <span style={{ fontSize: '0.74rem', color: P.light, marginLeft: 8, flexShrink: 0 }}>{p.project_name}</span>
              )}
            </li>
          ))}
          {hiddenCount > 0 && (
            <li style={noteRow} role="presentation">
              +{hiddenCount} more — keep typing to narrow.
            </li>
          )}
        </ul>
      )}
      {showBlankError && (
        <div role="alert" style={{ color: P.terra, fontSize: '0.77rem', marginTop: 4 }}>
          Choose a planting.
        </div>
      )}
    </div>
  )
}

// ── Chrome (composed from P/T per formStyles discipline — no raw hex) ────────
function chipStyle(disabled) {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    backgroundColor: P.greenPale,
    border: `1px solid ${P.green}`,
    borderRadius: T.radiusField,
    padding: '8px 10px',
    minHeight: 44,
    boxSizing: 'border-box',
    opacity: disabled ? 0.6 : 1,
  }
}

const chipClearBtn = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: P.mid,
  fontSize: '0.9rem',
  padding: '4px 6px',
  minWidth: 30,
  minHeight: 30,
  lineHeight: 1,
}

const linkBtn = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: P.green,
  fontSize: '0.82rem',
  fontWeight: 600,
  textDecoration: 'underline',
  padding: '8px 6px',
  minHeight: 44,
}

// V4-PICKERUX-001 P1: placement is now measured (see measurePlacement). `null` reproduces the
// pre-P1 constant exactly — down, 280 — so an environment that cannot measure (jsdom, and any
// browser where the input is not laid out yet) behaves as it always did.
function listboxStyle(placement) {
  const flip = !!placement?.flip
  return {
    position: 'absolute',
    zIndex: 30,
    ...(flip
      ? { bottom: '100%', top: 'auto', margin: '0 0 4px' }
      : { top: '100%', bottom: 'auto', margin: '4px 0 0' }),
    left: 0,
    right: 0,
    padding: 4,
    listStyle: 'none',
    backgroundColor: P.white,
    border: `1px solid ${P.border}`,
    borderRadius: T.radiusField,
    boxShadow: flip ? '0 -6px 18px rgba(0,0,0,0.12)' : '0 6px 18px rgba(0,0,0,0.12)',
    maxHeight: placement?.maxHeight ?? LIST_MAX_H,
    overflowY: 'auto',
    // Without this, flicking past the end of the results chains the scroll to the Sheet panel,
    // which drags the anchored input (and the dropdown with it) away mid-choice. (Pre-dates
    // V4-KBVIEWPORT-001 and still correct under it — scroll chaining is not a viewport-model issue.)
    overscrollBehavior: 'contain',
  }
}

function rowStyle(highlighted) {
  return {
    display: 'flex',
    alignItems: 'baseline',
    padding: '11px 10px',
    // V4-PICKERUX-001 P1: HEIGHT, not just minHeight. A long name had no ellipsis mechanism
    // anywhere, so it wrapped and grew the row past 44 — which shifted every row below it, making
    // the y-position of "the third result" depend on how long the second one was. Under a soft
    // keyboard, tap targets that move between renders are a mis-tap generator. Fixed height + the
    // ellipsis on the label span below makes row positions deterministic.
    height: 44,
    minHeight: 44,
    boxSizing: 'border-box',
    borderRadius: 5,
    cursor: 'pointer',
    fontSize: '0.88rem',
    color: P.dark,
    backgroundColor: highlighted ? P.greenPale : 'transparent',
  }
}

const noteRow = {
  padding: '10px',
  fontSize: '0.8rem',
  color: P.light,
}
