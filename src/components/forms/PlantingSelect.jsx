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
// V4-PICKERA11Y-001 — this component is the WAI-ARIA 1.2 combobox REFERENCE MODEL for the app.
// It was chosen as the model because no existing picker implemented the pattern: VarietyPicker has
// the roles but no option identity and misuses aria-selected as a highlight flag; AssigneePicker
// has no roles at all; SpaceAttachPicker is a dialog. The four pieces that were missing here —
// aria-activedescendant, option `id`s, focus retention on commit, and Escape-closes-without-blur —
// are exactly the pieces TalkBack (Chrome/Android, the only target) needs to narrate the list.
// Where this deviates from APG the reason is stated inline at the deviation.
import React, { useState, useEffect, useMemo, useRef, useCallback, useId } from 'react'
import { useApiFetch } from '../../lib/api.js'
import { P } from '../../lib/constants.js'
import { T, inputChrome } from './formStyles.js'
import { formatQty } from '../../lib/format.js'
import { PROJECTS_HIDDEN } from '../../lib/featureFlags.js'
import { useInOverlaySurface } from '../../context/OverlayContext.jsx'
import FilterChipRow from './FilterChipRow.jsx'
import { readCropRank } from '../../lib/cropLogLedger.js'
import { useDismissable } from '../../context/DismissRegistry.jsx'
import { LAYER } from '../../lib/dismissLayers.js'
import {
  useComboboxInput, looseIncludes,
  kbToggleBtnStyle, micToggleBtnStyle, closeToggleBtnStyle, toggleSlotsPaddingRight,
} from '../../lib/comboboxInput.js'

// Max rows rendered in the listbox — VarietyPicker precedent: cap VISIBLY (footer row), never
// truncate silently. Unscoped garden lists run to the hundreds; 200 keeps the DOM sane.
const MAX_RESULTS = 200

// V4-CROPFILTER-001 — crop-chip row thresholds + pin policy (design §1b).
// Row suppressed when the list is small enough that scanning beats filtering, or when there is
// nothing to discriminate (fewer than 2 distinct crops). Pins are DATA-DRIVEN, never hard-coded:
// top-2 crop types by live-planting count in the loaded list, with pepper/tomato preference on
// TIES only — encodes the August distribution without freezing it (the trailing-harvest-count
// signal isn't available in picker context, so live-planting count is the proxy).
const CHIPS_MIN_ROWS = 8          // ≤7 rows → scanning beats filtering; no chip row
const CHIPS_MIN_CROPS = 2
const PIN_COUNT = 2
const PIN_TIE_PREF = ['pepper', 'tomato']
// V4-CROPLISTORDER-001 (BD-010) + V4-CROPFILTERLAYOUT-001 (BD-011) — band order + tray budget.
const RECENT_BAND_N = 12          // band-2 cap: pins (2) + recents (12) ≈ the first 14 chips
const RANK_WINDOW_DAYS = 60       // trailing window for distinct-log-days — survives a rainy
                                  // fortnight, turns over per season phase (consult §3)
const TRAY_MAX_H = 184            // expanded-tray scrollport: 3.5 chip rows — the half-clipped
                                  // 4th row IS the scroll affordance (deliberate ADHD-UX detail)
const CHIP_ROW_BASE = 36          // chrome around the tray inside the panel: chipRowWrap padding
                                  // (12) + "N hidden" note line (~22) + separator border (2)
const pinTieRank = s => { const i = PIN_TIE_PREF.indexOf(s); return i === -1 ? PIN_TIE_PREF.length : i }
// 'sweet-corn' → 'Sweet Corn' — display fallback until a labels map is ever needed (§ Deferred).
const titleizeSlug = s => String(s).split(/[-_]/).map(w => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ')
// The opt-in value every enabled site passes: no explicit pins, so the row derives its own. A
// SHARED FROZEN CONST, not an inline `{}` — an inline literal is a new identity every host render,
// which would thrash the memos keyed on it on the app's highest-frequency form.
export const CROP_CHIPS_AUTO = Object.freeze({})

// V4-CROPLISTORDER-001 (BD-010) — the chip band order, as a pure function of injected data.
// Exported for direct unit tests: this is the computePlacement discipline — the ONLY part of the
// ordering that matters is the mapping from (options, pins, rank, counts) to a sequence, so that
// is where the arithmetic lives, with no component render in the way. Any future Garden crop
// selector should consume THIS plus FilterChipRow (promote to src/lib/ if that happens).
//
// Three bands:
//   1. pins — in the order given (pinnedSlugs already encodes count-desc + PIN_TIE_PREF). A pin
//      that is also top-ranked appears ONCE, here — never again in band 2.
//   2. recents — up to `bandN` non-pinned crops with ≥1 distinct log day in the rank window,
//      by the total, terminal tie-chain: days DESC → mostRecentLogDay DESC → livePlantingCount
//      DESC → PIN_TIE_PREF rank ASC → displayLabel.localeCompare ASC. Recency-DECAY was rejected
//      in the consult: an invisible tunable that reshuffles between opens is wrong for spatial
//      memory; a day-count over a fixed window moves only when the facts move.
//   3. tail — everything else (unranked, plus rank overflow past bandN), alphabetical by DISPLAY
//      LABEL, not slug: the user scans rendered text, and 'sweet-corn' ≠ 'Sweet Corn' in sort
//      position once labels stop being titleized slugs.
// Cold start (empty rank) ⇒ pins + alphabetical tail — already better than today's count-desc.
export function bandOrder({ options = [], pinned = [], rank, counts, bandN = RECENT_BAND_N }) {
  const rk = rank ?? new Map()
  const ct = counts ?? new Map()
  const pinIndex = new Map(pinned.map((s, i) => [s, i]))
  const pins = []
  const rest = []
  for (const o of options) (pinIndex.has(o.value) ? pins : rest).push(o)
  pins.sort((a, b) => pinIndex.get(a.value) - pinIndex.get(b.value))
  const ranked = rest.filter(o => (rk.get(o.value)?.days ?? 0) > 0)
  const unranked = rest.filter(o => (rk.get(o.value)?.days ?? 0) === 0)
  ranked.sort((a, b) => {
    const ra = rk.get(a.value)
    const rb = rk.get(b.value)
    return (rb.days - ra.days)
      || (ra.last > rb.last ? -1 : ra.last < rb.last ? 1 : 0)
      || ((ct.get(b.value) ?? 0) - (ct.get(a.value) ?? 0))
      || (pinTieRank(a.value) - pinTieRank(b.value))
      || String(a.label ?? '').localeCompare(String(b.label ?? ''))
  })
  const tail = [...ranked.slice(bandN), ...unranked]
    .sort((a, b) => String(a.label ?? '').localeCompare(String(b.label ?? '')))
  return [...pins, ...ranked.slice(0, bandN), ...tail]
}

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
// `position: sticky; top: 0`, so it occupies the top of the scrollport, and its height is 52 plus
// a safe-area inset this cannot resolve statically (it was ALSO route-class-dependent, 88 root / 52
// detail, until V4-HEADERPARITY-001 collapsed the two), which is why it is measured rather than
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
// V4-CROPFILTER-001: `panelExtra` = the chip row's rendered height (0 when no chips). It enters
// BOTH directions' room BEFORE the flip decision and the list clamp — the chip row shares the
// floating panel with the list, so room the chips occupy is room the list cannot have, and a flip
// threshold that ignored it would open a panel taller than the band it measured. panelExtra=0 is
// arithmetically a no-op: every pre-chip caller and test keeps its exact behavior.
export function computePlacement({
  rectTop, rectBottom, viewTop, viewBottom, chromeTop = 0, chromeBottom = 0, panelExtra = 0,
}) {
  const below = Math.floor(viewBottom - chromeBottom - rectBottom - LIST_GAP) - panelExtra
  const above = Math.floor(rectTop - viewTop - chromeTop - LIST_GAP) - panelExtra
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
function measurePlacement(inputEl, inOverlay = false, panelExtra = 0) {
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
    // V4-CROPFILTER-001: chip-row height (zero rect in jsdom → 0 → the measure guard's
    // null/default path is untouched; the suite keeps today's arithmetic).
    panelExtra,
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
  // V4-CROPFILTER-001 — OPT-IN crop-chip row: `cropChips: { pinned?: [slugs] }`. Absent (all
  // legacy sites) ⇒ byte-identical render. When present, a FilterChipRow of crop_type_slug chips
  // renders INSIDE the floating panel, above the listbox (below it when flipped up — chips stay
  // adjacent to the input edge). Multi-select OR across chips, AND with the typeahead. Chips
  // FILTER, never gate: unmatchable plantings (no resolvable slug) stay reachable chips-off and
  // are EXCLUDED under an active chip by design. Row suppressed when the consumer already pins
  // scope (varietyId/cropSlug), under CHIPS_MIN_CROPS distinct crops, or at ≤7 rows. Chip state
  // is per-instance and session-ephemeral — NEVER persisted — but SURVIVES resetNonce (burst
  // logging taps the Tomato chip once, not six times; adjudicated §1b); it clears on unmount.
  // Pass a MODULE-CONST object, not an inline literal, so memo deps stay referentially stable.
  cropChips,
  // V4-HARVFAB-001 — OPTIONAL, default-off ⇒ every other render site byte-identical. True means
  // "open the panel on mount, with no user gesture": the FAB's harvest action lands on a form
  // whose first REQUIRED action is choosing a planting, so that action presents itself instead of
  // waiting to be discovered — which is what makes the 5-tap claim honest. Deliberately LATCHED to
  // the first eligible render rather than tracked live: a prop that re-opened whenever it was
  // truthy would re-open the panel the instant the user dismissed it. Focus is NOT forced — on
  // Android that would summon the keyboard over the list the user came here to read. That last
  // clause SURVIVES V4-PICKERKBDEF-001: this path opens the panel with NO user gesture behind it,
  // so forcing focus here is focus theft on top of an unrequested keyboard. The new default means
  // "the tap that opens the picker raises the keyboard", and this open involves no tap.
  autoOpen = false,
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
  // BUG-POSTSAVEVALIDATION-001. Clears on every host reset. When `resetNonce` is undefined the
  // comparison never trips, so the six other call sites see behaviour identical to before.
  // RENDER-PHASE, not a passive effect — and that is the whole point. The effect version cleared
  // `touched` one commit LATE, so the commit that carried the host's cleared value still rendered
  // showBlankError: "Choose a planting." in red hit the DOM after every successful save and was
  // painted before the effect wiped it. A one-frame red flash on a save that SUCCEEDED is the same
  // defect BUG-POSTSAVEVALIDATION-001 exists to close, just shorter. React's documented
  // adjust-state-on-prop-change pattern re-renders before the commit, so the node is never created.
  // V4-CROPFILTER-001: chipSelection is DELIBERATELY not cleared here — chip filter state must
  // survive the host's resetForNext/save within a mount (§1b adjudication; a 6-tomato burst taps
  // the Tomato chip once). It is filter state, not write-target state (§5.2).
  const [seenResetNonce, setSeenResetNonce] = useState(resetNonce)
  if (resetNonce !== seenResetNonce) {
    setSeenResetNonce(resetNonce)
    setTouched(false)
  }
  // V4-CROPFILTER-001 chip state: per-instance, session-ephemeral (never localStorage).
  const [chipSelection, setChipSelection] = useState(() => new Set())
  // Bumped by FilterChipRow's More-tray toggle so the placement effect re-measures the panel.
  const [chipLayoutNonce, setChipLayoutNonce] = useState(0)
  const chipRowRef = useRef(null)
  const inputRef = useRef(null)
  // The chip-mode "Change" button — the one control that still exists after a commit collapses the
  // picker. select() hands focus here so the TalkBack cursor never falls to <body>. See select().
  const changeBtnRef = useRef(null)
  // V4-PICKERA11Y-001 (A9). Was `Math.random()`. aria-activedescendant points at an option id
  // derived from this, so it must be stable across renders (random-per-mount already was) AND
  // deterministic per instance for tests to assert on. useId gives both. Its ':' delimiters are
  // legal in an id attribute but NOT in a CSS selector, so they are stripped: the active-option
  // scroll below resolves through getElementById, and a future querySelector must not silently
  // fail on a ':' it did not escape.
  const listboxId = `ps-list-${useId().replace(/:/g, '')}`
  // Option identity. Namespaced by listboxId, not bare `ps-opt-${id}`, because CaptureFlow and
  // PhotoLibrary each render TWO PlantingSelects on one page — duplicate DOM ids would make
  // aria-activedescendant resolve to the wrong picker's row. `data-testid` deliberately keeps the
  // un-namespaced `ps-opt-${id}` form: 16 test files select on it.
  const optionId = useCallback((p) => `${listboxId}-opt-${p.id}`, [listboxId])
  const chipLabelId = `${listboxId}-chip-label`

  // Rendering inside the route-overlay Sheet? Context default is false (full page / no provider),
  // exactly the signal EventNew's sticky Save uses. Feeds chrome-inset zeroing in placement.
  const inOverlay = useInOverlaySurface()

  // V4-PICKERKB-002 + V4-PICKERVOICE-001 — the shared input-mode cluster (⌨ swap, 🎤 voice).
  // Mechanism + rationale live in lib/comboboxInput.js; VarietyPicker is the other consumer.
  //
  // V4-PICKERKBDEF-001 (Dave, 2026-08-16): "I want to now default our plantings picker to have the
  // keyboard open. The earlier issue with that has been cleared up with other work, and I find I
  // use it more often than not." defaultMode 'text' is the WHOLE mechanism on Chrome Android —
  // inputMode="none" was the only thing suppressing the keyboard, so removing it hands the field
  // back to the browser and the user's own tap raises the keyboard natively. Deliberately NOT
  // autoFocus: Chrome Android only opens the keyboard for a focus carrying user activation, so
  // autoFocus would be both ignored on the path that matters and a focus thief on the ones that
  // don't (autoOpen below, and any host that mounts this mid-flow).
  //
  // The "earlier issue" is V4-PICKERKB-001 (Dave, device pass 2026-08-02: keyboard-open left "about
  // three rows" of list and the sticky Save painted over them). Both halves shipped since:
  // V4-PICKERUX-001 (onOpenChange suppresses the competing control) and V4-KBVIEWPORT-001
  // (interactive-widget=resizes-content + the chrome-aware computePlacement above + V4-KBCHROME-001
  // hiding nav/band while the keyboard is up). The picker now measures the keyboard-shrunk visual
  // viewport and flips up rather than being clipped by it.
  const {
    kbMode, enableKeyboard, disableKeyboard, isDeliberateBlur,
    voiceSupported, voiceState, toggleVoice,
  } = useComboboxInput({
    open,
    inputRef,
    defaultMode: 'text',
    onVoiceText: (t) => { setQuery(t); setOpen(true) },
  })

  const controlled = plants != null
  const rows = controlled ? plants : fetched
  // One flag for both modes so every downstream branch stays a single condition; the empty-state
  // row must be gated on THIS, not `failed`, or a controlled failure still prints "No plantings yet."
  const loadFailedEffective = failed || loadFailed

  // ── V4-CROPFILTER-001: crop universe + data-driven pins + row eligibility ──
  // Universe derived from the LOADED list (distinct crop_type_slug + live-planting counts),
  // count-desc then alpha — the same list the chips will filter, so a pin can never dead-end.
  const cropUniverse = useMemo(() => {
    if (!cropChips) return []
    const counts = new Map()
    for (const p of rows) {
      const slug = p.variety_ref?.crop_type_slug
      if (slug) counts.set(slug, (counts.get(slug) || 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [cropChips, rows])
  const explicitPinned = cropChips ? cropChips.pinned : undefined
  const pinnedSlugs = useMemo(() => {
    if (!cropChips) return []
    const counts = new Map(cropUniverse)
    // Any pin with ZERO matching plantings is hidden — no dead-end taps (§1b).
    if (explicitPinned) return explicitPinned.filter(s => (counts.get(s) || 0) > 0)
    return [...cropUniverse]
      .sort((a, b) => b[1] - a[1] || pinTieRank(a[0]) - pinTieRank(b[0]) || a[0].localeCompare(b[0]))
      .slice(0, PIN_COUNT)
      .map(([s]) => s)
  }, [cropChips, cropUniverse, explicitPinned])
  // Chips never render when the consumer already pins scope (varietyId/cropSlug — PutUp keeps
  // its shipped behavior), when <2 crops discriminate, or when scanning beats filtering (≤7 rows).
  const chipsEligible = !!cropChips && !varietyId && !cropSlug &&
    cropUniverse.length >= CHIPS_MIN_CROPS && rows.length >= CHIPS_MIN_ROWS
  const chipFilterActive = chipsEligible && chipSelection.size > 0
  const chipOptions = useMemo(
    () => cropUniverse.map(([slug]) => ({ value: slug, label: titleizeSlug(slug) })),
    [cropUniverse],
  )
  // V4-CROPLISTORDER-001 (BD-010) — rank refresh contract: the ledger is read ONCE per
  // picker-OPEN (rankNonce bumps on the open→true transition), mirroring EventNew's
  // logone.lastPlant read-at-open. NOT on mount (a closed picker renders no chips, and an
  // in-burst save must rank fresh on the NEXT open), NOT while open (a reorder under the
  // user's thumb is worse than a stale order), and NOT on resetNonce (the burst-logging
  // contract — order survives resetForNext exactly like chipSelection does). No timers.
  const [rankNonce, setRankNonce] = useState(0)
  useEffect(() => { if (open) setRankNonce(n => n + 1) }, [open])
  const cropRank = useMemo(() => {
    // rankNonce === 0 ⇒ never opened ⇒ no read: "read on open, not mount" is literal.
    if (!cropChips || rankNonce === 0) return null
    return readCropRank({ windowDays: RANK_WINDOW_DAYS })
    // rankNonce is the deliberate (and only) recompute key — see the contract above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cropChips, rankNonce])
  const orderedChipOptions = useMemo(() => {
    if (!cropChips) return []
    return bandOrder({ options: chipOptions, pinned: pinnedSlugs, rank: cropRank, counts: new Map(cropUniverse) })
  }, [cropChips, chipOptions, pinnedSlugs, cropRank, cropUniverse])
  // Toggle/clear own the Set immutably — a mutated Set would not re-run the filter memo.
  const toggleChip = useCallback((slug) => {
    setChipSelection(prev => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }, [])
  const clearChips = useCallback(() => setChipSelection(new Set()), [])

  // V4-HARVFAB-001 — see the `autoOpen` prop doc. Runs at most once per mount, and waits out a
  // `disabled` first render (EventNew's picker is disabled until a project exists when
  // PROJECTS_HIDDEN is off) rather than dropping the auto-open on the floor.
  const autoOpenedRef = useRef(false)
  useEffect(() => {
    if (!autoOpen || disabled || autoOpenedRef.current) return
    autoOpenedRef.current = true
    setOpen(true)
  }, [autoOpen, disabled])

  // BUG-PICKERUNDISMISSABLE-001 — the ONE close path, so every dismissal gesture agrees on what
  // closing means. `touched` is set here rather than left to onBlur: a dismissal that correctly
  // leaves focus where it was (Escape per APG, the Close control, Back) fires no blur, and without
  // this the required-field error would stop appearing on exactly those paths.
  const closePanel = useCallback(() => { setOpen(false); setTouched(true) }, [])

  // BUG-PICKERUNDISMISSABLE-001 — Escape/Back arbitration through the shared registry, the same
  // seam Sheet, Lightbox and the popovers use. Registering is what ARMS a history entry: with
  // nothing armed the popstate listener returns early and Android Back is never routed here at all.
  // On the harvest fast path that meant Back discarded the whole half-filled form, because the
  // route-overlay Sheet hosting it is kind='route' and decideBack hands those to the router.
  //
  // layer SHEET, not something lower: the panel is a DESCENDANT of whatever surface hosts it, so it
  // paints inside that surface's stacking context — at the host's level, above the host's content.
  // The equal-layer tiebreak (later registration wins) is what puts it above the sheet it opened
  // inside; any lower layer would make the sheet topmost and turn Back into a dead press that
  // consumed the marker and did nothing. A true DIALOG over the form still outranks it.
  const { registered: dismissRegistered } = useDismissable({
    open: open && !disabled, onDismiss: closePanel, layer: LAYER.SHEET, armsBack: true,
  })

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

  // ── Scope → search → chip filter → sort ────────────────────────────────────
  // V4-CROPFILTER-001: returns hiddenByChips alongside — the count feeds the loud active-filter
  // signal ("N hidden") whenever the chip filter is non-empty.
  const { candidates, hiddenByChips } = useMemo(() => {
    let list = rows
    if (varietyId) list = list.filter(p => String(p.variety_id ?? p.variety_ref?.id ?? '') === String(varietyId))
    else if (cropSlug) list = list.filter(p => p.variety_ref?.crop_type_slug === cropSlug)
    const q = query.trim()
    if (q) {
      // V4-PICKERVOICE-001: voice-forgiving normalization ("sun ray" -> "Sunray"). Strictly
      // widens the old .toLowerCase().includes() — typed queries keep every match they had.
      // Fully client-side here (unlike VarietyPicker there is no server ?q= leg to stay strict).
      // V4-CROPFILTER-001 rider: crop_type_slug joins the haystack so typing "pepper" narrows
      // even when no name/variety/project carries the word.
      list = list.filter(p =>
        looseIncludes(p.name, q) ||
        looseIncludes(p.variety_ref?.name, q) ||
        looseIncludes(p.project_name, q) ||
        looseIncludes(p.variety_ref?.crop_type_slug, q)
      )
    }
    // V4-CROPFILTER-001: multi-select OR across chips (set membership), AND with the typeahead
    // (both filters apply). Applied AFTER the query so hiddenByChips counts what the CHIPS hide
    // within the current query. Slug-less plantings are excluded under an active chip BY DESIGN
    // (pinned as intended, not accidental — they stay reachable with chips off).
    let chipHidden = 0
    if (chipFilterActive) {
      const before = list.length
      list = list.filter(p => chipSelection.has(p.variety_ref?.crop_type_slug))
      chipHidden = before - list.length
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
    return { candidates: sorted, hiddenByChips: chipHidden }
  }, [rows, varietyId, cropSlug, query, sort, recentPlantId, chipFilterActive, chipSelection])

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
      // V4-CROPFILTER-001: the chip row's LIVE height (0 when absent, and 0 in jsdom's zero-rect
      // world) is the panelExtra term — measured rather than assumed, because the row wraps to a
      // second line on narrow viewports and the More tray expands it further.
      const extra = chipRowRef.current?.getBoundingClientRect?.().height || 0
      const next = measurePlacement(inputRef.current, inOverlay, extra)
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
    // V4-CROPFILTER-001: chipsEligible (row appears/disappears) and chipLayoutNonce (More tray
    // expanded/collapsed) both change panelExtra, so both must re-measure.
  }, [open, disabled, visible.length, inOverlay, chipsEligible, chipLayoutNonce])

  useEffect(() => { setHighlight(0) }, [query, rows])

  // ── V4-PICKERA11Y-001: the roving ACTIVE option ────────────────────────────
  // Claim 1. The highlight was a background colour and nothing else (rowStyle), so ArrowDown moved
  // a visual bar TalkBack could not see and never announced a row. This is the same `highlight`
  // index, promoted to the row object, so there is exactly one source of truth for "which option is
  // active" and the visual highlight and aria-activedescendant cannot drift apart.
  //
  // APG deviation, deliberate: DOM focus does NOT move to the option. That is the pattern's whole
  // point here — on Chrome/Android moving focus out of the <input> dismisses the soft keyboard and
  // breaks the typeahead, so the input keeps focus and only the ACTIVE DESCENDANT roves.
  //
  // `visible[highlight]` can be undefined when a crop chip shrinks the list under a stale highlight
  // (chip toggles deliberately do not reset it — see the chip-state contract above). Undefined then
  // means "no active option", which is exactly right: aria-activedescendant must be ABSENT, never
  // an empty string, or TalkBack looks up an element that does not exist.
  //
  // BUG-PSARIACONTROLS-001 — the same dangling IDREF VarietyPicker carried (BUG-VARPICKERARIA-001).
  // The input declared aria-expanded/aria-controls from `open` alone, but the listbox they name is
  // rendered under `open && !disabled`, so a picker disabled while open told a screen reader
  // "expanded — the popup is #ps-list-x" with #ps-list-x nowhere in the document. Reachable because
  // nothing closes the panel on disable: EventNew's picker disables when its project is cleared, and
  // `disabled` is a prop the host can flip at any time while `open` is our own state. One derived
  // flag now drives the two attributes AND the render, so "expanded", "here is the popup" and what
  // was actually painted cannot disagree. Same shape as VarietyPicker's `listboxOpen`.
  const listboxOpen = open && !disabled
  const activeOption = listboxOpen ? (visible[highlight] ?? null) : null

  // A7. APG requires the active descendant be scrolled into view; with focus staying on the input
  // the browser will never do it for us, and listboxStyle caps the panel height, so an arrowed-to
  // row below the fold was announced but invisible. `block: 'nearest'` scrolls the minimum needed —
  // 'center' would jump the list under a sighted user's thumb on every ArrowDown.
  // jsdom implements neither scrollIntoView nor layout, hence the optional call; this behaviour is
  // asserted by construction (spy), not by observing a scroll position.
  useEffect(() => {
    if (!activeOption) return
    if (typeof document === 'undefined') return
    document.getElementById(optionId(activeOption))?.scrollIntoView?.({ block: 'nearest' })
  }, [activeOption, optionId])

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
    // V4-PICKERA11Y-001 claim 3 — the dropped cursor. Committing a choice swaps this component into
    // chip mode, which does not render the <input> at all; the focused element was therefore
    // UNMOUNTED and focus fell to <body>, so TalkBack lost its place mid-form and the next swipe
    // restarted from the top of the page. The listbox's onMouseDown preventDefault kept focus on
    // the input right up to the swap, which is why this reads as a render-shape bug rather than a
    // focus bug. Move focus to a control that survives: the chip's "Change" button (aria-describedby
    // the chip label, so focusing it announces WHAT was chosen as well as the button).
    // Mirrors clear()'s existing setTimeout-refocus precedent rather than inventing a mechanism.
    //
    // NO FALLBACK TO THE INPUT — and that is load-bearing, not an omission. A host that does not
    // echo `value` back never enters chip mode, so the <input> is still mounted AND still focused
    // (the listbox's onMouseDown preventDefault held focus through the click); there is nothing to
    // restore. Refocusing it anyway fires onFocus, which RE-OPENS the picker — and on EventNew an
    // open picker hides the sticky band, taking the post-save confirmation strip out of the
    // accessibility tree with it. Caught by EventNewOverlaySlice2 / EventNewPostSaveFeedback.
    //
    // The activeElement guard keeps this from stealing focus a host has deliberately moved
    // elsewhere in the same commit; <body> is the expected value here, because that is precisely
    // where focus lands when the input unmounts.
    setTimeout(() => {
      const btn = changeBtnRef.current
      if (!btn || typeof document === 'undefined') return
      const active = document.activeElement
      if (active && active !== document.body && active !== inputRef.current) return
      btn.focus()
    }, 0)
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
      // V4-PICKERA11Y-001 claim 4 + A5. TWO changes, and they are load-bearing TOGETHER — shipping
      // either alone is worse than shipping neither:
      //
      // (a) GATE ON `open`. `e.preventDefault()` used to run unconditionally, and
      //     DismissRegistry.jsx bails on `e.defaultPrevented`. That made Escape DEAD for the
      //     hosting Sheet whenever focus sat in this input with the list closed. It was only
      //     latent because (b) blurred immediately, so "closed + focused" was nearly unreachable.
      //     Fixing (b) makes "closed + focused" the NORMAL post-Escape state, which would promote
      //     that latent trap into "the sheet can never be closed by keyboard". VarietyPicker
      //     already carries this exact gate for this exact reason; this is the port, not a new idea.
      //
      // (b) DO NOT BLUR. APG: Escape closes the popup and keeps focus in the combobox. Blurring
      //     dropped the TalkBack cursor to <body> and made "dismiss the list" indistinguishable
      //     from "leave the field entirely".
      if (open) {
        // BUG-PICKERUNDISMISSABLE-001: when registered, the registry's single listener owns Escape
        // — Sheet.jsx carries this same gate for this same reason. Handling it here as well would
        // preventDefault the key the registry then deliberately bails on, so the panel would close
        // by the legacy path and the arbitration would be dead code that never ran.
        if (dismissRegistered) return
        e.preventDefault()
        e.stopPropagation()
        // The blur we no longer fire was what marked the field touched (see onBlur), which is why
        // closePanel sets it.
        closePanel()
      }
    } else if (e.key === 'Tab') {
      // Tab was unhandled, so focus left while the listbox stayed painted for the 150ms blur timer,
      // leaving a floating panel over the next field. Close immediately. NEVER preventDefault here:
      // Tab must still move focus, and this branch must not commit the highlighted option — a
      // typeahead combobox that writes a value on Tab-out is a wrong-write generator.
      setOpen(false)
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
        {/* V4-PICKERA11Y-001: the `aria-live="polite"` that used to sit here is REMOVED, not
            relocated. It could never announce anything — this whole subtree mounts in the same
            commit as its text, and a live region created together with its content is not spoken
            (TalkBack watches for MUTATIONS to an already-present region). A dead live region reads
            as coverage that does not exist. The selection is announced instead by moving focus here
            (select()) onto a button that is aria-describedby the chip label below — a focus event,
            which is announced deterministically rather than by live-region timing. */}
        <div style={chipStyle(disabled)} data-testid={dataTestId ? `${dataTestId}-chip` : undefined}>
          <span id={chipLabelId} style={{ fontSize: '0.88rem', fontWeight: 600, color: P.green }}>
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
            ref={changeBtnRef}
            type="button"
            // DESCRIBED by, not LABELLED by: the accessible NAME stays exactly "Change" (host tests
            // and any future automation query it by that name), while TalkBack additionally reads
            // the chosen planting when focus lands here after a commit.
            aria-describedby={chipLabelId}
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

  // V4-PICKERKB-002: the ⌨ slot while the list is open; 🎤 whenever speech is available and the
  // list is open (independent of kbMode).
  // V4-PICKERKBDEF-001: now a TWO-WAY toggle rather than a one-shot opt-in. Flipping the default to
  // keyboard-open would otherwise have made the old `kbMode === 'none'` condition permanently
  // false, silently deleting the keyboard-free browse mode V4-PICKERKB-001 was built to give Dave.
  // "Default" means the other mode still exists — so the same slot now offers whichever direction
  // is available. `aria-pressed` carries the state (mirrors the 🎤 button's own pattern below).
  const kbRaised = kbMode === 'text'
  const showKbBtn = open && !disabled
  const showMicBtn = open && !disabled && voiceSupported
  // BUG-PICKERUNDISMISSABLE-001 — present for the whole time the panel is, on every render site.
  // Conditioning it on how the panel was opened would make the app's one shared picker behave two
  // ways, which is the drift this component exists to end.
  const showCloseBtn = open && !disabled
  const togglePad = toggleSlotsPaddingRight({ showKb: showKbBtn, showMic: showMicBtn, showClose: showCloseBtn })

  // V4-CROPFILTER-001 — the chip row sits INSIDE the floating panel but OUTSIDE the listbox role:
  // chips are never options and never keyboard-highlight targets (onKeyDown walks `visible` only).
  // The "N hidden" line is the loud active-filter signal the adjudication requires in exchange for
  // letting chip state survive resetForNext — an invisible filter on a required field is the whole
  // failure mode. Its own mousedown-preventDefault comes from FilterChipRow's root.
  const chipRow = chipsEligible ? (
    <div ref={chipRowRef} style={chipRowWrap(!!placement?.flip)}>
      <FilterChipRow
        // BD-010: band-ordered (pins → recents → alphabetical tail), not count-desc — see
        // bandOrder above. FilterChipRow's pinned-first re-sort is STABLE, so this order
        // passes through it untouched (comment at its `shown` memo).
        options={orderedChipOptions}
        selected={chipSelection}
        onToggle={toggleChip}
        pinned={pinnedSlugs}
        onClear={clearChips}
        onLayoutChange={() => setChipLayoutNonce(n => n + 1)}
        // BD-011: the expanded tray becomes its own bounded scrollport instead of feeding
        // ~26 chip lines into computePlacement as panelExtra (the one-row-listbox mechanism).
        trayMaxHeight={TRAY_MAX_H}
        aria-label="Filter by crop"
        data-testid={dataTestId ? `${dataTestId}-crop-chips` : 'ps-crop-chips'}
      />
      {chipFilterActive && (
        <div data-testid="ps-chip-filter-note" style={chipNote}>
          {hiddenByChips > 0 ? `${hiddenByChips} hidden` : 'Crop filter on'}
        </div>
      )}
    </div>
  ) : null

  // A6 — `role="alert"` is not a valid child of `role="listbox"` (which owns only options and
  // groups), and neither is the Retry <button> it contains. This row is now a SIBLING of the <ul>
  // inside the floating panel rather than a member of it. Moved, not duplicated: an sr-only copy
  // alongside the visible one would have TalkBack read the failure twice.
  const failureNotice = loadFailedEffective && !loading ? (
    <div style={noteRow} role="alert">
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
    </div>
  ) : null

  // The <ul> gives up its own floating-panel chrome to PanelShell whenever ANYTHING shares the
  // panel with it — chips (V4-CROPFILTER-001) or now the failure notice. Without this the notice
  // would sit inside an absolutely-positioned panel while the <ul> ALSO positioned itself at
  // top:100% of that panel, i.e. below its own container.
  const panelNested = chipsEligible || !!failureNotice

  // A8 — result-count announcement. The typeahead and the crop-chip row both change the option set
  // silently: TalkBack reads the listbox only when the user is inside it, so filtering from 40 rows
  // to 0 produced no spoken feedback at all. This node is rendered UNCONDITIONALLY (empty string
  // when there is nothing to say) precisely because a live region must pre-exist its content to be
  // announced — the mistake the removed chip-mode aria-live made.
  // Deliberately NOT role="status": that role is already used by host post-save confirmations
  // (EventNew) which are queried singularly, and a second status node would collide with them.
  // bare aria-live carries the same announcement semantics without claiming the role.
  const liveCount = (!open || disabled || loading || loadFailedEffective) ? ''
    : visible.length === 0 ? 'No plantings available'
    : `${visible.length} planting${visible.length === 1 ? '' : 's'} available`

  return (
    <div style={{ position: 'relative' }}>
      <div aria-live="polite" style={srOnly}>{liveCount}</div>
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        // BUG-PSARIACONTROLS-001 — both derived from listboxOpen, never from `open` alone (see its
        // definition). aria-controls is OMITTED rather than left dangling whenever the listbox is
        // not rendered.
        aria-expanded={listboxOpen}
        aria-controls={listboxOpen ? listboxId : undefined}
        // V4-PICKERA11Y-001 claim 1 — the missing half of the combobox contract. `undefined` (the
        // attribute ABSENT), never '': an empty aria-activedescendant is a dangling reference, and
        // TalkBack treats it as "there is an active option, I just cannot find it".
        aria-activedescendant={activeOption ? optionId(activeOption) : undefined}
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
        // Required BY the Escape fix, not incidental to it. Escape now leaves focus on the input,
        // so tapping the field to re-open it fires NO focus event (it is already focused) and
        // onFocus alone can no longer re-open the list — the field would look dead. Idempotent:
        // clicking an already-open picker is a no-op setState.
        onClick={() => { if (!disabled && !open) setOpen(true) }}
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
      {/* V4-PICKERKB-002 / V4-PICKERKBDEF-001 — "I do want to type" and its inverse, "let me see
          the whole list". onMouseDown preventDefault keeps input focus so the 150ms blur-close
          never races the refocus (listbox-row trick).
          APG deviation, deliberate: APG says a toggle button should keep a STABLE label when it
          carries aria-pressed. This one changes the label AND sets aria-pressed, because the 🎤
          button eight lines below already ships exactly that shape (device-validated) and two
          controls sharing one slot cluster that announce themselves differently is worse for a
          TalkBack user than one mild deviation. The NAME states the action the tap performs; the
          pressed state states the mode it is in. */}
      {showKbBtn && (
        <button
          type="button"
          onMouseDown={e => e.preventDefault()}
          onClick={kbRaised ? disableKeyboard : enableKeyboard}
          aria-label={kbRaised ? 'Hide the keyboard and browse plantings' : 'Type to search plantings'}
          aria-pressed={kbRaised}
          title={kbRaised ? 'Hide the keyboard' : 'Type to search'}
          style={kbToggleBtnStyle}
        >
          <span aria-hidden="true">{kbRaised ? '⌄' : '⌨'}</span>
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
      {/* BUG-PICKERUNDISMISSABLE-001 — the visible exit. This panel has no backdrop, and on the
          autoOpen path no focus either: the input is deliberately NOT focused (forcing it summons
          the Android keyboard over the list the user came to read), so the blur that closes every
          other open never fires, and Android has no Escape key. Choosing a planting was the only
          way out of the app's most frequent form. Sheet §5.3's rule, applied here: an invisible
          dismissal is not a discoverable exit, so this is a real 44px labelled control.
          onMouseDown preventDefault is load-bearing twice over — it keeps focus wherever it already
          is, so a focused input is not blurred into a second close, and an UNfocused one is not
          given focus and made to raise the keyboard on the way out. */}
      {showCloseBtn && (
        <button
          type="button"
          onMouseDown={e => e.preventDefault()}
          onClick={closePanel}
          aria-label="Close the planting list"
          title="Close the list"
          data-testid="ps-close"
          style={closeToggleBtnStyle(showMicBtn)}
        >
          <span aria-hidden="true">✕</span>
        </button>
      )}
      {/* BUG-PSARIACONTROLS-001 — the SAME flag the combobox attributes read, not a second copy of
          the expression. This is the render the IDREF above promises exists. */}
      {listboxOpen && (
        <PanelShell chips={chipRow} notice={failureNotice} placement={placement}>
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Plantings"
          style={listboxStyle(placement, panelNested, chipsEligible)}
          // Keep input focus while clicking rows; onBlur's deferred close still runs after click.
          onMouseDown={e => e.preventDefault()}
        >
          {loading && <li style={noteRow} role="presentation">Loading plantings…</li>}
          {!loading && !loadFailedEffective && visible.length === 0 && (
            <li style={noteRow} role="presentation">
              {/* V4-CROPFILTER-001 filtered-to-empty: naming the CHIPS as the cause (and offering
                  the one-tap exit right here) is the difference between "your garden is empty" and
                  "your filter is". Chips outrank the query in the copy because they are the filter
                  the user cannot see in the input. */}
              {chipFilterActive ? (
                <>
                  No plantings match —{' '}
                  <button
                    type="button"
                    onMouseDown={e => e.preventDefault()}
                    onClick={clearChips}
                    data-testid="ps-chips-clear-empty"
                    style={{
                      padding: 0, border: 'none', background: 'none', color: P.terra,
                      fontSize: '0.8rem', fontWeight: 600, textDecoration: 'underline',
                      cursor: 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    clear chips
                  </button>
                </>
              ) : query.trim() ? `No plantings match “${query.trim()}”.` : 'No plantings yet.'}
            </li>
          )}
          {visible.map((p, i) => (
            <li
              key={p.id}
              id={optionId(p)}
              role="option"
              // aria-selected means SELECTED (the committed value), not highlighted — the active
              // option is carried by aria-activedescendant above. VarietyPicker conflates the two;
              // do not copy it from there.
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
        </PanelShell>
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

// V4-CROPFILTER-001 — panel shell. `chips` null (every legacy call site) ⇒ children pass STRAIGHT
// through: no wrapper node, no style change, byte-identical DOM to before. With chips, this
// wrapper takes over the floating-panel chrome and the <ul> becomes a plain scroll region inside
// it, so the list scrolls under a chip row that stays put. Chip position follows the flip so the
// row is always adjacent to the INPUT edge of the panel — under the input when opening down,
// above it when flipped up (the thumb reaches the same place either way).
// V4-PICKERA11Y-001 (A6): `notice` joins `chips` as a panel co-tenant — the load-failure alert,
// evicted from inside the <ul> because role="alert" (and the Retry button in it) are invalid
// children of role="listbox". It sits on the same side as the chips, i.e. adjacent to the INPUT
// edge, so a failure message is never on the far side of an empty list from the field it describes.
function PanelShell({ chips, notice, placement, children }) {
  if (!chips && !notice) return children
  return (
    <div style={panelStyle(placement)} data-testid="ps-panel">
      {placement?.flip
        ? <>{children}{notice}{chips}</>
        : <>{chips}{notice}{children}</>}
    </div>
  )
}

// V4-PICKERUX-001 P1: placement is now measured (see measurePlacement). `null` reproduces the
// pre-P1 constant exactly — down, 280 — so an environment that cannot measure (jsdom, and any
// browser where the input is not laid out yet) behaves as it always did.
// V4-CROPFILTER-001: `nested` = "the PanelShell above owns the positioning and chrome", so the
// list keeps only its scroll behavior. Default false is the untouched pre-chip path.
// V4-PICKERA11Y-001 (A6): `nested` and `floorRows` split apart. `nested` = "PanelShell owns the
// positioning" (true for chips OR the evicted failure notice); `floorRows` = the BD-011 three-row
// floor, which exists ONLY to stop the chip tray starving the list and must stay OFF when the
// panel's other tenant is the failure notice — otherwise a failed load paints a 140px empty box
// under its own error message.
function listboxStyle(placement, nested = false, floorRows = false) {
  const flip = !!placement?.flip
  if (nested) {
    return {
      margin: 0,
      padding: 4,
      listStyle: 'none',
      maxHeight: placement?.maxHeight ?? LIST_MAX_H,
      // V4-CROPFILTERLAYOUT-001 (BD-011): inside the flex-column panel the list is the elastic
      // member (flex:1) with a HARD floor — LIST_MIN_H (3 rows) — so no chip-row height can ever
      // again starve it to the one-row LIST_ABS_MIN while the tray takes the room. The panel's
      // own maxHeight (panelStyle) bounds the total; the tray cap bounds the chips.
      flex: '1 1 auto',
      ...(floorRows ? { minHeight: LIST_MIN_H } : null),
      overflowY: 'auto',
      overscrollBehavior: 'contain',
    }
  }
  return {
    position: 'absolute',
    // BUG-PICKERUNDISMISSABLE-001 — Z.sheet, was 30. dismissLayers.js's whole premise is that the
    // registered layer equals the painted one, and this panel now registers LAYER.SHEET, so the
    // paint has to say the same thing (layerMatchesPaint.test.js re-derives both halves from
    // source). Inert in every host: inside a Sheet or PhotoModal this value is scoped to that
    // fixed+z-indexed ancestor's stacking context, and on a full page computePlacement already
    // insets the panel clear of the nav — the two hosts that CAN paint into it (EventNew's sticky
    // Save, PhotoLibrary's select bar) both hide themselves while the picker is open. Where it does
    // change anything it is the unmeasured fallback, where the panel is now visible over app chrome
    // instead of clipped under it. Literal rather than `Z.sheet` to match the other inventoried
    // surfaces and the static gate's source scan.
    zIndex: 200,
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

// The chrome the <ul> used to carry, moved out one level when chips share the panel.
// V4-CROPFILTERLAYOUT-001 (BD-011): the panel had NO maxHeight — an expanded ~80-chip tray ran
// to ~1,400px, fed computePlacement as panelExtra, drove room deeply negative, and floored the
// listbox at ONE 44px row while the panel overflowed the viewport (consult §2 — an unbounded
// input to a subtraction, not a tuning problem). Fix: bound the PANEL, budget the tray
// (TRAY_MAX_H, via FilterChipRow's trayMaxHeight), floor the listbox (listboxStyle nested
// branch). computePlacement itself is UNCHANGED. Flex-COLUMN always — PanelShell owns flip
// ordering by swapping children, never column-reverse (DOM order = reading order).
function panelStyle(placement) {
  const flip = !!placement?.flip
  return {
    position: 'absolute',
    // Z.sheet — see the matching note in listboxStyle. The two must not drift: they are the same
    // panel, one nested and one not.
    zIndex: 200,
    ...(flip
      ? { bottom: '100%', top: 'auto', margin: '0 0 4px' }
      : { top: '100%', bottom: 'auto', margin: '4px 0 0' }),
    left: 0,
    right: 0,
    backgroundColor: P.white,
    border: `1px solid ${P.border}`,
    borderRadius: T.radiusField,
    boxShadow: flip ? '0 -6px 18px rgba(0,0,0,0.12)' : '0 6px 18px rgba(0,0,0,0.12)',
    display: 'flex',
    flexDirection: 'column',
    // Finite by construction: list budget + tray budget + tray chrome. When placement measured,
    // the list budget is the measured room; unmeasured (jsdom / pre-layout) it is the LIST_MAX_H
    // constant, keeping the pre-BD-011 fallback discipline.
    maxHeight: (placement?.maxHeight ?? LIST_MAX_H) + TRAY_MAX_H + CHIP_ROW_BASE,
    overflow: 'hidden',
  }
}

// The separator sits on whichever side faces the list, which swaps with the flip.
function chipRowWrap(flip) {
  return {
    padding: '8px 8px 4px',
    ...(flip
      ? { borderTop: `1px solid ${P.border}` }
      : { borderBottom: `1px solid ${P.border}` }),
  }
}

const chipNote = {
  marginTop: 4,
  fontSize: '0.74rem',
  color: P.light,
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

// Screen-reader-only. Same recipe as Field.jsx's "(required)" affix and Spinner.jsx's label —
// copied rather than imported because those own their own local copies and there is no shared
// a11y style module yet; hoisting one is a separate change with its own freeze implications.
const srOnly = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
}
