import React, { useState, useEffect, useRef, useCallback, useId } from 'react'
import { takePendingCapture } from '../lib/pendingCapture.js'
import { createFinalResultReader } from '../lib/voiceResults.js'
import { createVoiceShapeRecorder } from '../lib/voiceShape.js'
import { recordVoiceEvent, recordVoiceMark } from '../lib/voiceDebug.js'
import { acquireMic, releaseMic } from '../lib/micArbiter.js'
import { saveFileToDevice } from '../lib/saveFileToDevice.js'
import ProjectOptions from '../components/ProjectOptions.jsx'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P, EVENT_TYPES, LOGGABLE_PROJECT_STATUSES, statusLabel } from '../lib/constants.js'
import { EVENT_TYPE_META, requiresPlanting, isPlantReductionEventType } from '../lib/eventTypes.js'
import { PLANTING_REQUIRED_ENABLED, PROJECTS_HIDDEN, HARVEST_QUALITY_HIDDEN, SAVE_TO_DEVICE_HIDDEN, WEIGH_IN_FRAME_ENABLED } from '../lib/featureFlags.js'
import EventTypePicker, { EVENT_TYPES_UI, SECONDARY_GROUPS } from '../components/forms/EventTypePicker.jsx'
// POI-SEEDDOORMENU-001 — the create-a-lot sheet, shared with the planting page's Save seed button so
// both doors run one flow. See its render site near the foot of this component.
import SaveSeedSheet from '../components/planting/SaveSeedSheet.jsx'
import { useUploadPhoto } from '../hooks/useUploadPhoto.js'
import { HARVEST_UNITS, MAX_PLAUSIBLE, WEIGHT_UNITS, MAX_PLAUSIBLE_WEIGHT_G, toGrams } from '../lib/harvest-constants.js'

// Quantity entry — the measurement that governs it, kept here because it is the reason the control
// is shaped the way it is. MEASURED, not guessed: 83.2% of the 519 prod harvest_log rows are
// integers 1-6 and 87.1% are a single character. So the fast path must cost ONE tap and must not
// raise the soft keyboard, which on a 390px viewport takes roughly half the height.
//
// V4-HARVQTYCHIPS-001 served that with a 1-6 chip row (replace semantics). V4-QUICKHITRANGE-001
// (BD-047) superseded it with the digit BUILDER in components/NumberPad.jsx: one tap on '3' still
// yields '3', so the 83.2% path is unchanged, but the 16.8% tail no longer needs the keyboard
// either — '13' is two taps rather than a keyboard round trip. The free-text field is still there
// underneath both, which is why neither change regressed the tail.

// V4-HARVFEEDBACK-001 S5b (spec §8) — how much the bottom spacer grows while the post-save feedback
// zone is rendered, so the last form control still clears the sticky band. CSS-DERIVED ESTIMATE,
// not a measurement: 10px top pad + 44pt Undo row + ~18px row 2 + 12px bottom pad ≈ 84, rounded to
// 86. jsdom returns zero rects for everything, so the real number is an ON-DEVICE measurement at
// 390×500 keyboard-open — that check belongs to the device harness, and this constant is the single
// place to correct it. The 120px base for the action row alone is unchanged and stays inline.
const POST_SAVE_STRIP_SPACER_PX = 86
import { seasonTotalPhrase } from '../lib/harvestSummary.js'
import { useUxFlow, FLOWS, sendUxEvent } from '../lib/uxEvents.js'
import { EVENTNEW_ADD_DETAILS_EXPANDED, PHOTO_MULTI_ATTACH_ENABLED } from '../lib/featureFlags.js'

// V4-PHOTOBULK-001 S2. Matches PhotoUpload's DEFAULT_MAX_FILES — one number for "a handful you just
// took", not the server's MAX_BATCH of 20, which governs Track A's camera-roll drain.
const MAX_EVENT_PHOTOS = 10
let eventPhotoSeq = 0
const nextPhotoId = () => `evphoto-${++eventPhotoSeq}`
import { Field, Input, Select, Textarea, Button, ErrorBanner, PlantingSelect } from '../components/forms'
// BUG-DISCLOSURETAPSIZE-001: the tap floor is a token, not a literal repeated at four call sites.
import { T } from '../components/forms/formStyles.js'
import { snapshotFile, snapshotFiles } from '../lib/fileSnapshot.js'
import { useCachedFetch } from '../hooks/useCachedFetch.js'
import { CROP_CHIPS_AUTO } from '../components/forms/PlantingSelect.jsx'
import TreatmentDetails from '../components/TreatmentDetails.jsx'
import Section from '../components/FormSection.jsx'
// V4-ICON-001: this page's glyphs come from the one registry. Nothing here renders a pictographic
// character except the two reward flourishes in the dead SuccessScreen (see its header).
import Icon from '../components/Icon.jsx'
import PostSaveFeedback, { confirmBtnGhost } from '../components/PostSaveFeedback.jsx'
import { useToast } from '../context/ToastContext.jsx'
import { useInOverlaySurface, useOverlayDismiss, useReportOverlayDirty } from '../context/OverlayContext.jsx'
import { readDraft, writeDraft, clearDraft } from '../lib/draftStash.js'
import { setReloadBlocked } from '../lib/reloadGate.js'
// V4-CROPLISTORDER-001 (BD-010): crop-rank ledger — fed at the same post-save moment as
// logone.lastPlant below; PlantingSelect reads it at picker-open to band-order its crop chips.
import { recordCropLog } from '../lib/cropLogLedger.js'
// V4-HARVSESSION-002: chip-queue ranking — the same order the Today ready band shows, so the tray
// and the band never disagree about what "next" means.
// V4-WATERMATH-001 F0 — watering amount class (Light/Normal/Deep). See src/lib/waterDepth.js
// for the metadata contract with the events Lambda and why it is NOT quantity_numeric.
import WaterDepthChips from '../components/WaterDepthChips.jsx'
// V4-HARVDISPOSITION-001 — the optional "what went wrong with this pick" chip row.
import HarvestDispositionChips from '../components/HarvestDispositionChips.jsx'
import NumberPad from '../components/NumberPad.jsx'
// BUG-WEIGHPADSAVEBAND-001 — the sticky Save band floats over this form and its height is not a
// constant, so the keypad's clearance is resolved against the band as rendered. Rule, stated
// minimum and the measured numbers: src/lib/saveBandLayout.js.
import { SAVE_BAND_BOTTOM_INSET_PX, FRAME_SAVE_HEIGHT_PX, clearWeightPadOfSaveBand, clearControlOfSaveBand, framePadGapPx } from '../lib/saveBandLayout.js'
import { orderByThumb } from '../lib/handedness.js'
import { useHandedness } from '../hooks/useHandedness.js'
import { toLocalISO, todayLocalISO } from '../lib/dateLocal.js'
import {
  WATER_DEPTH_DEFAULT, isWaterDepthType, waterDepthMetadata, waterDepthLabel, WATER_DEPTH_CHIPS,
} from '../lib/waterDepth.js'
import { EVENT_METADATA_FIELDS, HARVEST_QUALITY_LABELS, PLANT_CONTAINER_TYPE_OPTIONS, SEVERITY_LEVELS, ISSUE_OPTIONS } from '../lib/dropdownRegistry.js'
// V4-LOSSUI-001 — the plant-reduction capture panel (a REQUIRED panel, so it sits with harvest /
// treatment / severity and NOT in EVENT_METADATA_FIELDS, whose disclosure is optional-only), plus
// the end-status offer the 201 may carry back. See src/lib/plantReduction.js for the wire contract.
import PlantReductionFields from '../components/PlantReductionFields.jsx'
import EndStatusOffer from '../components/EndStatusOffer.jsx'
import { validateReductionInput, buildReductionMetadata } from '../lib/plantReduction.js'

// V3-EVENT-008: EVENT_TYPE_META lives in the canonical src/lib/eventTypes.js
// (single source of truth). Re-exported here so existing importers from
// EventNew.jsx (EventTypesPhase1.test.jsx) keep working unchanged.
export { EVENT_TYPE_META }

export { EVENT_TYPES_UI, SECONDARY_GROUPS }

const DEFAULT_HARVEST_UNIT = 'count'

// Read the user's last-used harvest unit from localStorage. Guarded for
// tests / SSR where localStorage may be unavailable or throw.
// BUG-LOGTARGETREQ-001 / §5.2 prefill-not-preselect: now keyed PER CROP
// (lastHarvestUnit:<crop_type_slug>) with the legacy global key as fallback. The global
// default was the same silent-wrong-default class as quantity prefill — a "cups"
// blueberry pick defaulted "cups" onto the next count-crop harvest, corrupting the
// exact crop×unit lines the export ships. No crop context (no planting picked yet, or
// an unresolvable slug) → global → DEFAULT, exactly the old chain.
// V4-HARVUNITDEFAULT-001: `cropDefaultUnit` is crop_types.default_unit, carried on
// variety_ref by lambda/plants/index.js. It slots BETWEEN the per-crop memory and the
// legacy GLOBAL key, and that position is the whole point:
//   1. lastHarvestUnit:<slug> — Dave's OWN history for THIS crop. Strongest evidence
//      there is; a curated default must never overrule what he actually does.
//   2. crop_types.default_unit — curated reference. Only consulted on a crop he has
//      never harvested before, i.e. exactly where tier 3 used to guess.
//   3. lastHarvestUnit (global) — the documented corruption vector this displaces:
//      whatever unit the LAST harvest of ANY crop used. This is the "cups blueberry
//      pick defaults cups onto the next count-crop" bug in the comment above.
//   4. 'count'.
// So the new tier can only ever displace a cross-crop guess, never a real signal.
// A crop with default_unit NULL (all 50 non-edible crop types on prod — flowers,
// succulents, houseplants, ornamentals, the one tree) falls straight through to the
// old chain, byte-identical to today's behavior. Validated against HARVEST_UNITS on
// the way in so a bad/retired DB value can never reach the <select> as a dead option.
function readLastHarvestUnit(cropSlug, cropDefaultUnit) {
  try {
    if (cropSlug) {
      const perCrop = localStorage.getItem(`lastHarvestUnit:${cropSlug}`)
      if (perCrop && HARVEST_UNITS.includes(perCrop)) return perCrop
    }
  } catch { /* localStorage unavailable — the crop default below is still usable */ }
  if (cropDefaultUnit && HARVEST_UNITS.includes(cropDefaultUnit)) return cropDefaultUnit
  try {
    const stored = localStorage.getItem('lastHarvestUnit')
    if (stored && HARVEST_UNITS.includes(stored)) return stored
  } catch { /* localStorage unavailable — fall through to default */ }
  return DEFAULT_HARVEST_UNIT
}

// V4-HARVDUAL-001 Slice B: the optional weight half remembers its own unit, independently of the
// quantity unit — the scale reads the same units every time (Dave's reads oz) while the quantity
// unit changes per crop. Sharing one key would make them fight each other.
const DEFAULT_WEIGHT_UNIT = 'g'
function readLastWeightUnit() {
  try {
    const stored = localStorage.getItem('lastHarvestWeightUnit')
    if (stored && WEIGHT_UNITS.includes(stored)) return stored
  } catch { /* localStorage unavailable — fall through to default */ }
  return DEFAULT_WEIGHT_UNIT
}

// Fresh harvest-panel state. Centralised because three places reset it (type change, Save & Next,
// and the initial mount) and they previously drifted field-by-field as the panel grew.
const freshHarvest = () => ({
  quantity:       '',
  unit:           readLastHarvestUnit(),
  quality_rating: null,
  weight:         '',
  weight_unit:    readLastWeightUnit(),
  // V4-HARVDISPOSITION-001: null = a normal pick, and 703 of 707 live harvests are. Deliberately
  // NOT sticky like the two units — a disposition describes ONE pick, and remembering "aborted"
  // onto the next one would silently mislabel the following harvest.
  disposition:    null,
})

// V4-STICKY-001: remember the last chosen project across sessions, mirroring
// LogMany's quicklog.lastScope pattern (module-const key + guarded localStorage,
// validated against live projects on load). Stored as a bare project id string.
const LAST_PROJECT_KEY = 'logone.lastProject'
// V4-LOGTARGET-001 (Lane 2, sticky option b): sticky memory inverted to the PLANTING
// level under a NEW key. The old logone.lastProject key is KEPT and still written on
// every save — it is the project-level fallback for pre-migration devices and for
// saves made deliberately without a planting (a plant-less save REMOVES lastPlant so
// "remembered" is always literally the last save). LogMany's quicklog.* keys untouched.
// BUG-LOGTARGETREQ-001 (BD-006): the cold-mount VALUE seed from this key is REMOVED.
// The sticky auto-seed satisfied the required-planting gate with a planting Dave never
// chose this time — misattribution, not convenience. The key is now consumed ONLY as a
// RANKING signal: EventNew reads it at picker-OPEN (not mount) and passes it as
// PlantingSelect's `recentPlantId`, which pins that row to position 1 with a visible
// "recent" marker. Invariant: a cold mount with NO draft and NO deep-link never
// pre-targets a planting.
// STALE-BUNDLE COMPATIBILITY CONTRACT: the removal is client-only (§5.7 — the server
// validator stays un-flipped), so pre-fix cached PWA bundles keep auto-seeding from
// this key until their SW updates. The KEY NAME and the WRITE-ON-SAVE below must not
// be renamed or removed while any pre-fix bundle can be live — an old bundle reading a
// key that stopped updating would seed a FROZEN stale planting, strictly worse.
const LAST_PLANT_KEY = 'logone.lastPlant'

// V4-OVERLAY-001 Slice 2 draft stash key + the form fields that survive a dismiss/re-open. Only the
// `form` object is stashed: the type-specific panels (metadata/harvest/treatment/severity/container)
// are RESET by the form.event_type-change effect, so restoring them would be immediately clobbered —
// stashing `form` (which those effects never touch) keeps the irreplaceable typed content (event
// type, target plant, notes, quantity, date) without fighting the reset effects. project_id is
// excluded so the load effect's remembered/validated project stands (avoids a mount-order race).
const EVENTNEW_DRAFT_KEY = 'logone'
// is_public was REMOVED from this list on 2026-08-31 (BUG-EVENTPUBFALSE-001). It is the only
// field here with no control anywhere in the form — V4-PUBHIDE-001 removed the toggle — so
// persisting it could never preserve a user's choice, only carry a stale one forward forever.
// A draft holding false from before that toggle was removed made every subsequent harvest
// non-public, invisible on the public site, with nothing in the UI able to show or undo it.
// Rule of thumb this encodes: a draft may persist what the user can SEE. Nothing else.
const DRAFT_FORM_FIELDS = ['event_type', 'notes', 'private_notes', 'quantity', 'event_date', 'plant_id']

// V4-HARVSCROLLANCHOR-001 (BD-016) + V4-HARVPOSTSAVESCROLL-001 (BD-017). Two filed defects, one
// mechanism: nothing on this form ever positions the page, so the two moments that MOVE the user's
// attention (focusing quantity; saving and being told to pick the next plant) leave the thing they
// were sent to somewhere off-screen.
//
// Scroll only — NEVER viewport arithmetic. index.html ships interactive-widget=resizes-content
// (V4-KBVIEWPORT-001), so the keyboard shrinks the layout viewport and the browser preserves
// scrollTop across that resize: anchoring the section header to the top BEFORE the keyboard opens
// leaves it at the top after. Computing a keyboard inset here instead is the exact regression
// noViewportInsetArithmetic.static.test.js exists to catch — this file must stay free of
// `visualViewport` entirely.
const HARVEST_SECTION_ID = 'harvest-section'
const PLANTING_SECTION_ID = 'planting-section'
// BUG-LOGBANDOCCLUDE-001: the chooser's own hit target, not its Section wrapper — the wrapper's
// label sits above the input and clearing THAT would leave the input itself still under the band.
const PLANTING_CHOOSER_SELECTOR = '[aria-label="Plant or group"]'
// V4-PICKERCACHE-001: one spelling of the unscoped chooser projection. PlantingSelect's self-fetch
// builds the identical string, which is the point — dataCache keys on the path, so the two surfaces
// share a single cache entry rather than warming two.
const PICKER_PATH = '/api/plants?view=picker'
// V4-HARVTRAYVIEWPORT-001: aria-controls target for the weigh-in tray's Show more/fewer disclosure.
const HARVEST_TRAY_ID = 'harvest-session-tray'
// BUG-TRAYFETCHSILENT-001: a REJECTION marker, deliberately not `null`. Both tray loaders used to
// `.catch(() => null)`, and `null` is also what a successful-but-empty response reads as downstream
// (`readyD?.candidates`, `harvD?.entries`) — so the merge could not tell "the fetch failed" from
// "there is nothing to offer", and both landed on the same zero-chip render.

// `block:'start'` puts the section HEADER at the viewport top, which is what makes the rest of the
// panel (chips, quantity, weight, error banner, Save) fall into the space the keyboard leaves.
// Guarded for jsdom, which does not implement scrollIntoView — absence must be a silent no-op, not
// a thrown save. Returns whether it actually ran so tests can assert the call rather than pixels.
function anchorSectionToTop(id, behavior = 'smooth') {
  if (typeof document === 'undefined') return false
  const el = document.getElementById(id)
  if (!el || typeof el.scrollIntoView !== 'function') return false
  el.scrollIntoView({ block: 'start', behavior })
  return true
}

// ── V4-WEIGHFRAME-001 — the fixed weigh-in frame (flag WEIGH_IN_FRAME_ENABLED) ────────────────
//
// TopChrome's `detail` bar is `position: sticky; top: 0` and 52px tall, and it is NOT keyboard-
// suppressed (V4-KBCHROME-001 covers bottom chrome only). The page shell below it already sizes
// itself `calc(100dvh - 52px)`, so that — not a bare 100dvh — is the height of "the whole viewport"
// from inside this component. A literal 100dvh here would hang 52px of the frame below the fold and
// push the Save row off the bottom, which is the one thing the frame exists to prevent.
const FRAME_HEIGHT = 'calc(100dvh - 52px)'
// The ledger + Save row. Constant FOREVER — this is the number that replaces the shipped band's
// 48 -> 128 -> 156 -> 184 -> 202px growth across four saves.
const FRAME_LEDGER_PX = 48
// R1. The gap the weight pad owes Save, so a low backspace press lands on track 3's own container — painted
// but handler-less — rather than on the commit. Derived from the ledger height and Save's height
// (lib/saveBandLayout.js) so it cannot drift away from meaning SAVE_BAND_MIN_CLEARANCE_PX; the whole
// accounting for where the px came from is in that file, and the real-engine gate is what holds it.
const FRAME_PAD_GAP_PX = framePadGapPx(FRAME_LEDGER_PX)
// NumberPad's own `marginBottom: 8`, named because the frame now cancels it at BOTH pads. Cancelled
// from the outside rather than changed at source: NumberPad.jsx is another lane's file, and a
// negative margin here is reversible and touches nobody else's render.
const NUMBERPAD_MARGIN_BOTTOM_PX = 8

// Handedness. This lane carried a local shim of `useHandedness`/`orderByThumb` because
// lane-handedness-20260825 was not merged and importing them would not have built. It IS merged now,
// so the shim is gone and both come from their canonical homes — the shim read the same
// `ui.handedness` key and the same `garden:handedness` event, so this is a de-duplication and not a
// behaviour change. Keeping two copies is how the two would eventually disagree.
// MIRROR TASK CONTROLS, NEVER CHROME (the rule the motor seat asked to have written down). Applied
// here to exactly two things: the Save button's edge and the ledger's Undo column. `orderByThumb`
// reorders as an ARRAY rather than with `flex-direction: row-reverse` deliberately — row-reverse
// leaves DOM order and visual order disagreeing, which is a WCAG 1.3.2 / 2.4.3 defect for the sake
// of one property. NOT mirrored: the Harvests-header Weigh-in button (Dave's explicit call),
// BottomNav, digit order.

// BottomNav is App-level chrome and this component cannot re-render it, so the session hides it the
// way the app's own keyboard suppression already does — `visibility: hidden` on the <nav> PLUS
// `--bottom-nav-height: 0px`, together, so the paint and the reserved inset can never disagree for a
// frame (BottomNav.jsx:180-189 states that invariant; this honours it rather than inventing a
// second mechanism). Worth 68px = 13.6% of a 500px viewport, and it is the most thumb-reachable
// strip on the device occupied entirely by targets that ABANDON the session.
// Effect cleanup is what makes "it must return the moment he leaves" structural rather than a
// promise: unmount, flag-off and a route change all restore it. Deliberately NOT mirrored — global
// chrome keeps its shipped side everywhere.
const FRAME_NAV_STYLE_ID = 'weigh-frame-nav-suppress'
function useSuppressBottomNav(active) {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return undefined
    const root = document.documentElement
    const prevInset = root.style.getPropertyValue('--bottom-nav-height')
    const style = document.createElement('style')
    style.id = FRAME_NAV_STYLE_ID
    style.textContent = 'nav[aria-label="Main navigation"]{visibility:hidden !important}'
    document.head.appendChild(style)
    root.style.setProperty('--bottom-nav-height', '0px')
    return () => {
      style.remove()
      // Restore the previous value rather than the constant: BottomNav owns this var and may have
      // been mid-suppression (keyboard up) when the session mounted. Writing 56px back here would
      // fight it. An empty previous value means "never set" — remove, don't invent one.
      if (prevInset) root.style.setProperty('--bottom-nav-height', prevInset)
      else root.style.removeProperty('--bottom-nav-height')
    }
  }, [active])
}

function readLastProjectId() {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY) || ''
  } catch { return '' }
}

function readLastPlantId() {
  try {
    return localStorage.getItem(LAST_PLANT_KEY) || ''
  } catch { return '' }
}

// V1.2a-2 Wave 3: never render a raw server error string to the user. Map known
// server error patterns to canned, friendly copy; fall back to a safe generic.
function friendlyError(err) {
  const raw = (err && err.message) ? String(err.message) : ''
  const status = err && err.status
  // V4-LOSSUI-001 — over-reduction. The events Lambda REFUSES "7 against 5 remaining" with a 409
  // rather than clamping (a clamped row is indistinguishable from a correct one afterwards), and it
  // sends back a sentence already written for a human: "this planting has 5 left, so 7 cannot be
  // removed". Passed through VERBATIM, capitalised only — the generic 4xx line below would drop the
  // two numbers that make the message actionable, and re-wording it here would put the same
  // sentence in two places and let them drift. Keyed on the machine `code`, not on the prose.
  if (err?.body?.code === 'REDUCTION_EXCEEDS_REMAINING' && raw) {
    return raw.charAt(0).toUpperCase() + raw.slice(1) + '.'
  }
  if (/exceeds max for unit/i.test(raw)) {
    return 'Quantity is unusually high — double-check?'
  }
  if (/quantity must be a positive/i.test(raw)) {
    return "Quantity doesn’t look right — check the form and try again."
  }
  if (typeof status === 'number') {
    if (status >= 400 && status < 500) {
      return "Something didn’t look right — check the form and try again."
    }
    if (status >= 500) {
      return "Couldn’t save — try again."
    }
  }
  // Network errors (no status) and anything unmapped.
  return "Couldn’t save — try again."
}

function toDatetimeLocal(date) {
  const d = date || new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// V4-WEIGHDATEREACH-001 — compact label for a `YYYY-MM-DD` string, for the two places the weigh-in
// frame has room to say WHICH DAY: the track-1 date control and the track-3 ledger line.
// "Today"/"Yesterday" rather than a bare date because those are the only two values a weigh-in
// realistically carries, and they are what the user is checking FOR. Parsed with the local-calendar
// constructor, NOT `new Date('YYYY-MM-DD')`, which parses as UTC midnight and renders as the
// PREVIOUS day west of Greenwich — the exact class of bug dateLocal.js exists to prevent.
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function shortDateLabel(ymd, today = todayLocalISO()) {
  if (!ymd) return ''
  const iso = String(ymd).slice(0, 10)
  if (iso === today) return 'Today'
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1)
  if (iso === toLocalISO(yesterday)) return 'Yesterday'
  return `${SHORT_MONTHS[m - 1]} ${d}`
}

function useVoiceInput() {
  const [listening, setListening] = useState(false)
  const [fieldKey,  setFieldKey]  = useState(null)
  const recRef = useRef(null)
  // S1 — the hold belonging to the CURRENTLY live recogniser, so start() and stop() can hand it
  // back. Handlers use their own per-recogniser copy instead; see the note at `myMicToken`.
  const micTokenRef = useRef(null)
  // BUG-VOICEDUPE-003 shape telemetry only. Routed through useApiFetch rather than Clerk directly
  // so the many EventNew tests that mock '../lib/api.js' keep neutralizing it automatically.
  const { getToken } = useApiFetch()

  const supported = typeof window !== 'undefined' &&
    !!(window.SpeechRecognition || window.webkitSpeechRecognition)

  const start = useCallback((key, onResult) => {
    if (!supported) return

    // BUG-VOICEDUPE-002 (b): the outgoing recognizer must be MUTED, not merely stopped. `stop()` is
    // a graceful shutdown — it asks the engine to finalize, which can dispatch one more onresult on
    // the OLD instance. That handler still closes over the OLD onResult, so it appends into the same
    // field the new session is about to append to. Detaching first makes the handover silent.
    const prev = recRef.current
    if (prev) {
      prev.onresult = null
      prev.onend    = null
      prev.onerror  = null
      try { prev.stop() } catch { /* already dead */ }
    }
    // S1 — hand our own hold back before taking a new one. Without this the acquire below evicts
    // US, running the stop() closure against the instance we just detached and stopped by hand.
    // Field-to-field dictation goes through here on every tap, so this is the common path.
    releaseMic(micTokenRef.current)

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    const rec = new SR()
    rec.continuous    = false
    rec.interimResults = false
    rec.lang          = 'en-US'

    // S1 — PER-RECOGNISER, deliberately not read off micTokenRef inside the handlers. onend is a
    // real event and arrives after the next field's start() has already re-pointed the ref, so a
    // handler that released `micTokenRef.current` would hand back the NEW field's hold and leave
    // the mic ownerless while it is still live.
    let myMicToken = null

    // BUG-VOICEDUPE-002 (a) — THE ROOT CAUSE, and the reason BUG-VOICEDUPE-001's fix could not
    // work. This hook does NOT go through src/lib/transcribe.js, so the dedupe shipped there never
    // covered this path — and this is the path Dave dictates notes on.
    //
    // The old handler was `const text = e.results[0][0].transcript; onResult(text)`. It read a FIXED
    // index, ignoring event.resultIndex, while three of the four MicBtn call sites APPEND
    // (`f.notes ? f.notes + ' ' + text : text`). event.results is cumulative for the session, so the
    // moment the engine dispatches a second onresult — which Chrome on Android does even with
    // continuous=false, when it segments an utterance or revises a settled final — index 0 is read
    // and appended a SECOND time. Duplicated words the user never said, "often, not always",
    // because whether a second dispatch happens is cadence-dependent.
    //
    // createFinalResultReader() carries a high-water mark, so each result index is emitted at most
    // once per recognizer no matter how many events visit it.
    const readNewFinals = createFinalResultReader()
    // BUG-VOICEDUPE-003 — the capture the -002 acceptance test asked for and never got, made
    // automatic. voiceDebug.js still writes the full local log behind its flag; this is the
    // shape-only summary that ships without Dave having to enable anything, reproduce on demand and
    // export by hand. Three reports in, that manual capture does not exist and will not appear.
    const shape = createVoiceShapeRecorder()
    let emitted = 0
    rec.onresult = (e) => {
      recordVoiceEvent(`EventNew:${key}`, e)
      shape.observe(e)
      for (const text of readNewFinals(e)) { emitted += 1; onResult(text) }
    }
    rec.onend  = () => {
      recordVoiceMark(`EventNew:${key}`, 'end')
      // Isolated for the same reason the photo beacon is (V4-PHOTOUPLOADINSTR-001): telemetry that
      // can throw into onend would break the listening-state reset below it, so nothing here may
      // escape. Emitted only when something was actually transcribed — a cancelled or silent
      // session is not a sample and would dilute the very rate we are trying to read.
      if (emitted > 0) {
        try {
          Promise.resolve(sendUxEvent(getToken, {
            flowId: FLOWS.VOICE_INPUT,
            stepIndex: 99,
            stepName: key,
            meta: shape.summary(emitted),
          })).catch(() => {})
        } catch { /* telemetry must never affect voice input */ }
      }
      releaseMic(myMicToken)
      setListening(false); setFieldKey(null)
    }
    rec.onerror = (e) => {
      recordVoiceMark(`EventNew:${key}`, 'error', e && e.error)
      releaseMic(myMicToken)
      setListening(false); setFieldKey(null)
    }

    recRef.current = rec
    recordVoiceMark(`EventNew:${key}`, 'start')
    // S1 — acquire in the same frame as rec.start(). Eviction detaches before aborting for the same
    // reason the unmount cleanup does: a graceful stop() asks the engine to finalize, and that late
    // dispatch would append into a field the user has moved away from.
    myMicToken = acquireMic(`EventNew:${key}`, () => {
      const dying = recRef.current
      if (!dying) return
      dying.onresult = null
      dying.onend    = null
      dying.onerror  = null
      try { dying.abort() } catch { /* already gone */ }
      recRef.current = null
      setListening(false)
      setFieldKey(null)
    })
    micTokenRef.current = myMicToken
    rec.start()
    setListening(true)
    setFieldKey(key)
  }, [supported, getToken])

  const stop = useCallback(() => {
    recRef.current?.stop()
    releaseMic(micTokenRef.current)
    setListening(false)
    setFieldKey(null)
  }, [])

  // RELEASE THE MIC ON UNMOUNT. This hook had no useEffect at all, so a recogniser started here
  // outlived the component: navigate away mid-dictation and nothing stopped it. The engine ends the
  // session on its own silence timeout, so the leak was bounded rather than permanent — but for
  // those seconds the mic indicator stays lit on a page the user has already left, the handlers
  // still hold the OLD onResult and set state on a dead component, and a remount can put a SECOND
  // recogniser alongside the first. The probe (ContinuousVoiceProbe) has had this cleanup since it
  // was written; the hook that Dave actually dictates through did not.
  //
  // DETACH BEFORE ABORTING, for the same reason start() detaches the outgoing instance above: a
  // teardown can still dispatch, and a handler that runs after unmount writes into a form that is
  // gone. abort() rather than stop(): stop() is the graceful shutdown that asks the engine to
  // FINALIZE, which is exactly the dispatch we are trying not to receive.
  useEffect(() => () => {
    const rec = recRef.current
    if (!rec) return
    rec.onresult = null
    rec.onend    = null
    rec.onerror  = null
    try { rec.abort() } catch { /* already gone */ }
    recRef.current = null
    // Handlers are detached above, so the onend that would normally release will never run.
    releaseMic(micTokenRef.current)
    micTokenRef.current = null
  }, [])

  return { start, stop, listening, fieldKey, supported }
}

// V4-KBVIEWPORT-001 — `useVisualViewportInset` WAS HERE AND IS DELETED. Do not reintroduce it.
//
// It computed `innerHeight - vv.height - vv.offsetTop` and lifted bottom-stuck elements by the
// result. Under Chrome Android's default `resizes-visual` that result is the ENTIRE keyboard height
// (~300-430px), because the layout viewport does not shrink while the visual one does — so the
// sticky Save CTA was hoisted ~500px off the bottom, directly into the band where the planting
// picker's listbox opens. That lift was the ROOT CAUSE of V4-PICKERUX-001; v3.87.0 shipped a
// z-index + placement mitigation over the top of it without removing it.
//
// It was also the exact artifact overlay-architecture-design-V102 §8.1 ruled NOT BUILT
// ("`visualViewport` fallback -> NOT built"), shipped by V4-LOGCONF-001 in place of the fix §8.1
// actually ratified. index.html now carries `interactive-widget=resizes-content`, so the layout
// viewport shrinks with the keyboard and bottom-anchored elements need no JS lift at all.
//
// Three reasons it is DELETED rather than left to self-neutralize: (1) the service worker can serve
// a stale precached shell carrying the old viewport meta, which would make the inset ~0 on some
// launches and ~430px on others -- same build, same device, no user-visible cause; (2) it fired
// `setInset` on every compositor-frame visualViewport `scroll` event with no coalescing, re-
// rendering this whole tree per frame during the keyboard animation; (3) a live inset computation
// sitting next to correctly-positioned layout is how the next reader re-derives the wrong model.
// Guarded by src/__tests__/noViewportInsetArithmetic.static.test.js.

function MicBtn({ fieldKey, onResult, voice, top = '50%', transform = 'translateY(-50%)' }) {
  if (!voice.supported) return null
  const active = voice.listening && voice.fieldKey === fieldKey
  return (
    <button
      type="button"
      onClick={() => active ? voice.stop() : voice.start(fieldKey, onResult)}
      aria-label={active ? 'Stop voice input' : 'Speak to fill this field'}
      title={active ? 'Stop' : 'Speak to fill this field'}
      style={{
        position: 'absolute',
        right: 8,
        top,
        transform,
        background:   active ? P.terra : 'transparent',
        border:       `1px solid ${active ? P.terra : P.border}`,
        borderRadius: '50%',
        width:  30,
        height: 30,
        cursor: 'pointer',
        display: 'flex',
        alignItems:     'center',
        justifyContent: 'center',
        fontSize:  '0.85rem',
        color:     active ? P.white : P.mid,
        transition: 'all 0.15s',
        flexShrink: 0,
        zIndex: 1,
      }}
    >
      {/* WCAG 2.5.5 touch target. The visual circle stays 30px — growing it would change the look
          of four fields and shift the two textarea call sites, which pass `top` in px and position
          the box by its EDGE. This transparent child extends the TAPPABLE area 7px past the circle
          on every side (30 + 14 = 44) and inherits the click by bubbling, so geometry and layout
          are byte-identical while the target clears the floor. Every call site already reserves
          paddingRight: 44, so nothing overlaps the field text.
          Raised here per design-weighin-session-20260824.md §8.4, which flagged this second mic
          system as 30x30. It is deliberately NOT the handedness flip — that one is still an open
          question (whether HarvestWatchBand's left/right split, a SAFETY decision, should mirror). */}
      <span aria-hidden="true" style={{ position: 'absolute', top: -7, right: -7, bottom: -7, left: -7 }} />
      {/* V4-ICON-001: registry glyphs, decorative — the button already carries the aria-label that
          names both states, so a second accessible name here would only double-read. */}
      <Icon name={active ? 'media.stop' : 'media.mic'} size={16} decorative />
    </button>
  )
}

// Tier 2: collapsible per-type metadata fields
function MetadataSection({ eventType, metadataState, onMetadataChange }) {
  const [open, setOpen] = useState(false)
  // V1.2a-2 Wave 3: harvest now has a dedicated structured panel — suppress the
  // legacy weight_g/count/quality "More details" fields for harvest events.
  const fields = eventType === 'harvest' ? null : EVENT_METADATA_FIELDS[eventType]
  if (!fields) return null

  return (
    <div style={{ backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: '12px 18px' }}>
      <button
        type="button"
        onClick={() => setOpen(s => !s)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: P.green, fontSize: '0.82rem', fontWeight: 600, padding: 0, display: 'flex', alignItems: 'center', gap: 6 }}
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>More details (optional)</span>
      </button>
      {open && (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {fields.map(field => (
            <div key={field.key}>
              <label style={{ display: 'block', fontSize: '0.77rem', fontWeight: 700, color: P.mid, marginBottom: 6, letterSpacing: '0.4px', textTransform: 'uppercase' }}>
                {field.label}
              </label>
              {field.type === 'select' ? (
                <Select
                  value={metadataState[field.key] ?? ''}
                  onChange={e => onMetadataChange(field.key, e.target.value || undefined)}
                >
                  <option value="">— optional —</option>
                  {[...field.options].sort((a, b) => String(a).localeCompare(String(b))).map(opt => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </Select>
              ) : (
                <Input
                  type={field.type}
                  value={metadataState[field.key] ?? ''}
                  onChange={e => onMetadataChange(field.key, e.target.value === '' ? undefined : e.target.value)}
                  placeholder="optional"
                  min={field.type === 'number' ? 0 : undefined}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function EventNew() {
  const navigate       = useNavigate()
  const [searchParams] = useSearchParams()
  const preselectedProjectId = searchParams.get('project') || ''
  const preselectedEventType = searchParams.get('event_type') || ''
  const preselectedPlantId = searchParams.get('plant') || ''
  // V4-TREATLOG-001: DrG "Treated…" deep-link — resolve this source finding after the treatment logs.
  const resolveEventId = searchParams.get('resolve') || ''
  const fromQuick = searchParams.get('fromquick')
  // V4-HARVSESSION-001: /log?session=harvest — the weigh-in session. Pins event_type=harvest at
  // mount (same seed mechanism as ?event_type=), locks the type against mis-tap changes, and
  // replaces the post-save toast with a persistent in-band session ledger (rows + running totals
  // + per-row undo). Full-page posture only — `inHarvestSession` (defined below inOverlay) is the
  // gate every session behavior hangs off; an overlay open with this param degrades to the plain
  // ?event_type=harvest deep-link behavior.
  const harvestSessionParam = searchParams.get('session') === 'harvest'
  const { fetch: apiFetch, getToken } = useApiFetch()
  // M1 telemetry (Inc 0) — log_watering flow. Only counts when the event is a watering.
  // Fire-and-forget; never affects the save flow.
  const ux = useUxFlow(FLOWS.LOG_WATERING)

  const voice = useVoiceInput()

  // V2-PHOTO-F1 Session 2: photo upload routed through shared hook in 'swallow'
  // mode — the event has already been saved by the time we call upload(), so a
  // photo failure must NOT take down the success flow. Matches prior behavior
  // (catch {} block that swallowed errors silently).
  const photoUploader = useUploadPhoto({ errorMode: 'swallow' })

  // V4-STICKY-001: cold-mount default for the project — a deep-linked ?project=
  // still wins; otherwise fall back to the last chosen project (validated against
  // live data in the load effect below). Read once (lazy init) so an in-session
  // save that rewrites localStorage never re-seeds this mount.
  const [rememberedProjectId] = useState(readLastProjectId)
  // BUG-LOGTARGETREQ-001: the remembered-PLANTING value seed that lived here is REMOVED
  // (see the LAST_PLANT_KEY note above). plant_id now seeds from ?plant= ONLY — explicit
  // intent (HarvestReadyBand ships a &plant= producer) wins; remembered state is demoted
  // to a ranking signal read at picker-open (recentPlantId below). logone.lastProject
  // seeding SURVIVES by design: under PROJECTS_HIDDEN project_id rides the chosen
  // planting or the default-project fallback, and exempt-type logs rely on it.

  const [form, setForm] = useState({
    // V4-HARVSESSION-001: in session mode harvest wins over any stray ?event_type= — the lock
    // below hides the picker, so a non-harvest seed here would strand the form typeless.
    event_type:    harvestSessionParam ? 'harvest' : preselectedEventType,
    project_id:    preselectedProjectId || rememberedProjectId,
    location_id:   '',
    event_date:    toDatetimeLocal(new Date()),
    notes:         '',
    private_notes: '',
    quantity:      '',
    plant_id:      preselectedPlantId,
  })

  // Tier 2 metadata state — { [field.key]: value } — only populated keys submitted
  const { show: showToast, showUndo } = useToast()
  // V4-OVERLAY-001 Slice 2: true only when this form is rendered INSIDE the overlay Sheet. Gates the
  // overlay-only behaviors (in-surface undo, draft stash) so the full-page path is byte-identical.
  const inOverlay = useInOverlaySurface()
  // V4-HARVSESSION-001: session mode is a full-page posture (the overlay keeps its own
  // confirmation strip + draft machinery, untouched).
  const inHarvestSession = harvestSessionParam && !inOverlay
  // V4-WEIGHFRAME-001. ONE derived predicate for the whole frame, so there is no way to ship half of
  // it: every deletion, every restructure and the nav suppression all read this single name.
  const sessionFrame = inHarvestSession && WEIGH_IN_FRAME_ENABLED
  const hand = useHandedness()
  useSuppressBottomNav(sessionFrame)
  // The frame's history drawer — the last 10 rows, opened by tapping the ledger summary. This is the
  // first build in which "see recent history" exists at all: the shipped `+N earlier` line is a bare
  // <div> with no handler, so it announces withheld rows and offers no way to reach them.
  const [frameLogOpen, setFrameLogOpen] = useState(false)
  // V4-WEIGHDATEREACH-001: the date control is a transparent native <input type="date"> layered over
  // a formatted chip, so a tap opens the system picker directly with no intermediate state. An
  // opacity-0 input takes focus invisibly, so the ring is painted on the wrapper instead — without
  // this the control is keyboard-reachable and keyboard-INVISIBLE, which is worse than unreachable.
  const [frameDateFocused, setFrameDateFocused] = useState(false)
  // Track 2's scroll container. Post-save the frame RESTORES this rather than re-anchoring — the
  // measurement is unambiguous that every entry already ends where it started, so the anchor's only
  // effect was the 126px round trip to get there.
  const frameBodyRef = useRef(null)
  // Session ledger — every confirmed save this mount. Undone rows stay listed struck-through
  // (excluded from totals): the ledger is an honest record of what happened, not a mutable cart.
  const [sessionRows, setSessionRows] = useState([])
  // V4-WEIGHQUEUEKILL-001 (BD-044) — the whole "Weigh-in queue - tap in weighing order" section is
  // GONE, on Dave's instruction: "I never use that... it's a nice idea, but it's just not
  // functionally useful for me and the way I log these." He asked for the WHOLE section, not only
  // the ordering, and confirmed that when asked directly.
  //
  // Scoped, not dissatisfaction: he opened the same braindump saying he LOVES the weigh-in session
  // ("that is really great"). The session, its ledger, undo and the planting picker are untouched.
  // What went is V4-HARVSESSION-002's pre-flight queue and the V4-HARVTRAYVIEWPORT-001 chip tray.
  //
  // Removed with it, deliberately, and each worth knowing:
  //   * TWO fetches off every weigh-in mount (/api/events/harvest-ready and
  //     /api/harvests?include=entries) that are now simply not made;
  //   * SAVE AUTO-ADVANCE. It fired only when a queue existed, so with no queue it was already
  //     unreachable for Dave - no behaviour he actually had is lost;
  //   * the V4-READYTRAYIMPRESSION-001 impression log. That telemetry froze what the readiness
  //     MODEL offered so its precision could be judged later, and it now records nothing. The model
  //     itself (lib/harvestReadiness.js) is untouched and still drives the Today ready band. Called
  //     out rather than dropped quietly: any future precision claim about the ready band has lost
  //     its instrument on this surface, and OPS-HARVFRICTIONREMEASURE-001 owes a re-measure.
  // V4-PRESERVEOFFERKILL-001: the V4-HARVESTCENTER-001 (L9) habit-stack trigger and its `preserveCtx`
  // state are DELETED — see the note at the capture site in handleSubmit. `putUpSwap` goes with them:
  // it existed only to swap an in-overlay Log Event for /put-up, and this was its sole call site.
  // V4-LOGCONF-001 (C1+C2, supersedes the §7 inlineUndo timed banner): after an overlay save the
  // user gets a DURABLE confirmation — no timer, cleared only by the next save or the overlay
  // closing. Same §7 modality rationale (the global toast is AT-invisible behind aria-modal) but as
  // a state change, not a 5s race the user always loses.
  // V4-HARVFEEDBACK-001 S5b: this state no longer REPLACES the sheet body. It now feeds a
  // non-blocking strip folded into the sticky Save band, and the form stays mounted and live
  // underneath (see the save-sticky block below). The card's Close / Log another / View event /
  // View planting actions are gone with it.
  // { eventId, projectId, projName, eventLabel, eventEmoji, undone, error } | null.
  // projectId still comes from the POST RESPONSE (not staged client state).
  const [confirmation, setConfirmation] = useState(null)
  // V4-HARVFEEDBACK-001 S5b (spec §7): burst signal — successful overlay saves since this mount.
  // A plain integer that dies with the overlay. Counts ALL event types (the burst property is the
  // count, not the crop) and is NEVER an identity or role check: Jen on a 12-harvest day gets the
  // count, Dave logging one watering does not. Rendered only at >= 2 (see PostSaveFeedback).
  const [savesThisSession, setSavesThisSession] = useState(0)
  // V4-HARVESTVIEW-001 S4a: ambient "Season: 4.5 cups blueberry (whole garden)" line on the
  // post-save feedback (design §2 loop-closer). STATIC text, best-effort, overlay-only. Null unless
  // the just-logged harvest resolved a crop AND the post-save aggregates GET returned a total.
  const [seasonLine, setSeasonLine] = useState(null)
  const dismissOverlay = useOverlayDismiss()
  const [metadataState, setMetadataState] = useState({})
  // V4-TREATLOG-001: dedicated treatment capture (pest_treatment / doctored).
  const [treatment, setTreatment] = useState({ pest_target: '', product_id: '', product_text: '', category: '', amount: '' })
  const [inventory, setInventory] = useState([])

  // V3-EVENTCONTSIZE-001: optional new-container capture, shown for potting_up/transplant on a specific
  // planting. On submit it also PUTs the planting's container_type/container_size via the live /api/plants
  // endpoint (reuses the PLANT-CONTAINER-001 write path; not stored as event metadata).
  const [container, setContainer] = useState({ type: '', size: '' })

  // V4-WATERMATH-001 F0: watering amount class. Preselected Normal — the default path costs zero
  // added taps, which is the property the whole capture layer is built around. The touched ref is
  // NOT cosmetic: it is what makes `water_depth_source` honest, and `water_depth_source` is what
  // the 30-day <5% instrumentation gate measures. Without it every row would read 'user' and the
  // gate that decides whether the ledger's amount math is feedable could never fire.
  const [waterDepth, setWaterDepth] = useState(WATER_DEPTH_DEFAULT)
  const waterDepthTouchedRef = useRef(false)

  // V1.2a-2 Wave 3: harvest panel state — only submitted for event_type=harvest.
  const [harvest, setHarvest] = useState(freshHarvest)
  // V4-HARVDRAFTGAP-001: names the event_type a draft restore installed, so the type-change reset
  // below can skip that one synthetic transition. Null whenever no restore is in flight.
  const draftRestoredTypeRef = useRef(null)
  const [harvestError, setHarvestError] = useState(null)
  // BUG-LOGTARGETREQ-001 per-crop unit: true once the user explicitly picks a unit for the CURRENT
  // entry — the per-crop re-seed effect below must never override a deliberate in-entry choice.
  // Reset wherever the entry resets (type change, resetForNext) AND on a planting SWAP
  // (BUG-HARVUNITSTICKY-001 / BD-012): a pick made under planting A is evidence about A's crop,
  // not about whatever planting replaces it — see the re-seed effect for the swap semantics.
  const unitTouchedRef = useRef(false)

  // V4-FLAG-001: flag-mode state (event_type='flag_issue'). Severity is REQUIRED; the issue is a
  // static seeded label (Slice 1) or a free-typed/voiced 'Other' -> metadata.issue_label.
  const [severity, setSeverity] = useState(null)
  const [issueChoice, setIssueChoice] = useState('')
  const [issueOther, setIssueOther] = useState('')

  // V4-LOSSUI-001: plant-reduction capture (failed / given_away). BOTH fields are required by the
  // API, so this is panel state and not metadataState — the latter feeds the optional "More details"
  // disclosure, whose entire contract is that a save works with it untouched.
  const [reduction, setReduction] = useState({ qty: '', reason: '' })
  const [reductionError, setReductionError] = useState(null)
  // The 201's `plant_reduction` payload, held ONLY while the offer sheet is up. Captured with the
  // planting it refers to, because resetForNext() clears form.plant_id in the same tick.
  const [endStatusOffer, setEndStatusOffer] = useState(null)

  // V1.2a-2 Wave 3: non-fatal notice (e.g. deep-link project not found).
  const [notice, setNotice] = useState(null)
  // BUG-PHOTOSTAGEDREAD-001: { done, total } while picked files are copied out of the picker's
  // handles, else null. Picking does real I/O now and must not look like a dead tap.
  const [photoPreparing, setPhotoPreparing] = useState(null)

  // V4-PHOTOBULK-001 S2 (design V100 §3 B1) — the harvest/observation form stages N photos, not one.
  // `photoItems` is [{ id, file, url }] in pick order; `photoItems[0]` is the old `photoFile` and the
  // whole array is what handleSubmit uploads. The two scalars this replaces were the ONLY reason
  // "I took four pictures of this one plant" meant four saves.
  //
  // ARRAY EVEN WHEN THE FLAG IS OFF. The flag gates what the PICKER accepts (one file vs many) and
  // what the strip renders — not the shape of the state. A dual-shape state would fork every one of
  // the ten read sites below and give the flag-off branch its own untested code path, which is the
  // opposite of what X1's byte-identical requirement is for: flag-off must be the SAME code carrying
  // exactly one item.
  const [photoItems, setPhotoItems] = useState([])
  const [projects,     setProjects]     = useState([])
  const [locations,    setLocations]    = useState([])
  const [saving,       setSaving]       = useState(false)
  const [error,        setError]        = useState(null)
  const [showPrivate,  setShowPrivate]  = useState(false)
  // BUG-POSTSAVEVALIDATION-001 — bumped by resetForNext() to mark the planting picker fresh again.
  const [pickerResetNonce, setPickerResetNonce] = useState(0)
  // V3-EVENT-008 §8: "Add details" collapsible (Quantity / Visibility / Private notes).
  // Default collapsed unless the feature flag flips it open. Fields stay reachable.
  const [showAddDetails, setShowAddDetails] = useState(EVENTNEW_ADD_DETAILS_EXPANDED)
  // V4-HARVFORMORDER-001 (S4): the harvest-only single disclosure holding Photo / Notes / Project /
  // Metadata / When. Unconditional hook (never rendered for a non-harvest type, but the state must
  // not be conditional). Collapsed by default — that IS the slice: the harvest fast path is
  // Planting → Quantity → Unit and nothing else competes for the first screen.
  const [showHarvestMore, setShowHarvestMore] = useState(false)
  // V4-NOTESCOLLAPSE-001 (BD0806-12): Notes is collapsed and lives at the END of the non-harvest
  // form. Measured on tests/harness at 390x844 before this change: Notes sat at y=789 and pushed the
  // REQUIRED Planting field to y=957 — 113px below the fold — to hold a field Dave rarely fills.
  // The harvest branch is untouched: its Notes already sits inside showHarvestMore's disclosure.
  const [showNotes, setShowNotes] = useState(false)
  const [plantsForProject, setPlantsForProject] = useState([])
  // BUG-PLANTFETCHSILENT-001 — both loaders below used to .catch into an empty list, which the
  // picker renders as "No plantings yet.": a network failure was indistinguishable from a project
  // with nothing planted. Harmless while the field is optional, unfillable the moment
  // PLANTING_REQUIRED_ENABLED flips. Reload key re-runs whichever loader is live without either
  // effect having to know the other exists.
  const [plantsLoadFailed, setPlantsLoadFailed] = useState(false)
  const [plantsReloadKey, setPlantsReloadKey] = useState(0)
  // V4-PICKERUX-001: the planting picker's listbox opens into the band the sticky Save occupies.
  // (The keyboard lift that used to hoist Save ~500px INTO that band is gone as of
  // V4-KBVIEWPORT-001 — the causal mechanism changed, the overlap did not become impossible.)
  // Save was painting over result rows 2-3 AND taking their
  // taps — and because the planting gate at the top of handleSubmit is inert while
  // PLANTING_REQUIRED_ENABLED and PROJECTS_HIDDEN are both false, that mis-tap SAVED the event with
  // plant_id: null and then cleared LAST_PLANT_KEY. A wrong write, not a cosmetic overlap.
  // Save is never the next action while a picker is open, so hiding it costs the user nothing and
  // makes the mis-tap structurally impossible rather than merely unlikely.
  const [pickerOpen, setPickerOpen] = useState(false)
  // BUG-LOGTARGETREQ-001: the remembered planting, demoted from value to RANKING. Read at
  // picker-OPEN, not mount — after an in-burst save rewrites logone.lastPlant, the still-
  // mounted form ranks fresh for harvest #2. Passed to PlantingSelect as recentPlantId
  // (position-1 pin + visible "recent" marker; filters win — see PlantingSelect).
  const [recentPlantId, setRecentPlantId] = useState('')
  // Stable identity: PlantingSelect reads this through a ref and its effect keys on `open` alone,
  // but keeping the handler stable costs nothing and keeps the BUG-SOWFOCUS-001 rule intact for any
  // future consumer that does key on the callback.
  const handlePickerOpenChange = useCallback(open => {
    setPickerOpen(open)
    if (open) setRecentPlantId(readLastPlantId())
  }, [])
  // V4-HARVFAB-001 — auto-open the planting picker on the FAB's harvest arrival, and ONLY there.
  // Guards, per design §1c: event_type=harvest, NO ?plant= (an explicit deep-link already answered
  // the question — HarvestReadyBand seeds &plant=), and NO draft (a restored draft means the user
  // is resuming, not starting). The draft guard is belt-and-braces TODAY: the restore effect below
  // bails on any seed and event_type IS a seed, so no draft can be live on this arrival. It is
  // stated rather than assumed because that coupling belongs to the draft predicate, not here.
  // Lazy state, not a live value: this is a fact about the ARRIVAL, evaluated once.
  // Pre-promote regression pass I-2: the ?project= guard is what makes "and ONLY there" true. Without
  // it this fires on two ALREADY-SHIPPED producers that also carry event_type=harvest —
  // HarvestReadyTile.jsx (`/log?project=…&event_type=harvest`) and the installed-PWA manifest shortcut
  // (`/log?event_type=harvest&fromquick=1`) — neither of which design §1c scoped this to. The FAB row
  // passes NO params but event_type, so it is unaffected.
  // V4-PWAHARVSHORTCUT-001: the manifest shortcut is repointed at `/log?session=harvest`, which
  // carries NO event_type, so it no longer reaches this predicate at all (the session's ranked ready
  // tray is the picker there). The ?project= guard still has to hold for HarvestReadyTile — and for
  // the OLD shortcut url, which keeps launching from Dave's home screen until Chrome re-reads the
  // manifest (launcher-cached, days, unforceable). Keep this listing historical, not current.
  const [harvestFabAutoOpen] = useState(() => (
    preselectedEventType === 'harvest' && !preselectedPlantId && !preselectedProjectId &&
    !readDraft(EVENTNEW_DRAFT_KEY)?.form
  ))
  // the user explicitly started — never a reward/celebration channel).

  // Reset metadata when event type changes
  useEffect(() => {
    // V4-HARVDRAFTGAP-001: a draft restore SETS form.event_type, which lands here as a type CHANGE
    // and would reset the harvest panel the restore just populated — restoring the bytes and
    // destroying them one effect later. (Notes never hit this because they live in `form`, which
    // this effect does not touch; the harvest panel is separate state, which is why it does.)
    // Skipped exactly once, for the one transition INTO the restored type: every panel this effect
    // clears is already empty on a fresh mount, so the skip drops nothing. A later manual type
    // change finds the ref spent and resets normally.
    if (draftRestoredTypeRef.current !== null && form.event_type === draftRestoredTypeRef.current) {
      draftRestoredTypeRef.current = null
      return
    }
    setMetadataState({})
    // V1.2a-2 Wave 3: reset the type-specific panels too. Harvest unit is
    // re-seeded from localStorage so the user's last choice persists across types.
    unitTouchedRef.current = false
    setHarvest(freshHarvest())
    setHarvestError(null)
    // V4-FLAG-001: reset flag-mode fields when the event type changes.
    setSeverity(null); setIssueChoice(''); setIssueOther('')
    // V4-TREATLOG-001: reset treatment capture on type change.
    setTreatment({ pest_target: '', product_id: '', product_text: '', category: '', amount: '' })
    // V4-WATERMATH-001 F0: a type change is a fresh entry — back to the preselected default.
    setWaterDepth(WATER_DEPTH_DEFAULT); waterDepthTouchedRef.current = false
    // V4-LOSSUI-001: same reason the treatment reset above exists. A quantity typed against
    // `failed` must not survive a switch to `given_away` — the two are different questions with
    // different vocabularies, and a carried-over count would be a number the user never chose for
    // the type that ends up being saved.
    setReduction({ qty: '', reason: '' }); setReductionError(null)
  }, [form.event_type])

  // V4-TREATLOG-001: lazy-load treatment-relevant inventory the first time a treatment event is
  // selected (product picker source). Fetched once, filtered client-side by chosen kind.
  useEffect(() => {
    const isTreat = form.event_type === 'pest_treatment' || form.event_type === 'doctored'
    if (!isTreat || inventory.length) return
    apiFetch('/api/inventory-items?category=pest_control,fertilizer,amendment,other')
      .then(rows => setInventory(Array.isArray(rows) ? rows : (rows?.items ?? [])))
      .catch(() => {})
  }, [apiFetch, form.event_type, inventory.length])

  // V3-EVENTCONTSIZE-001: clear the captured container when the event type or target planting changes.
  useEffect(() => { setContainer({ type: '', size: '' }) }, [form.event_type, form.plant_id])

  // BUG-LOGTARGETREQ-001 (§5.2 prefill-not-preselect): re-seed the harvest unit from the CHOSEN
  // planting's per-crop memory (lastHarvestUnit:<crop_type_slug>, global fallback). A prefill is
  // permitted here because a wrong unit is visible beside the quantity and user-confirmable —
  // unlike the removed planting seed, it never silently targets a write. Never fires over an
  // explicit in-entry unit pick (unitTouchedRef); a cleared planting falls back to the global key.
  // BUG-HARVUNITSTICKY-001 (BD-012): the touched guard is scoped to the planting it was set UNDER.
  // Pre-fix it was entry-scoped — reset on type change and post-save but never on a plant_id
  // change — so "cup" picked for blueberries survived a mid-entry swap to cucumber and shipped a
  // wrong-unit row (the same crop×unit corruption class the per-crop key exists to stop). A swap
  // OFF a real planting now clears the guard so the new planting seeds through the exact chain a
  // fresh selection uses. Deliberately NOT cleared on the FIRST selection (prev = no planting):
  // a unit picked before any planting is chosen is planting-agnostic intent, pinned by the
  // 'never overrides an explicit in-entry unit choice' case. The prev-plant ref exists because
  // this effect also re-fires on plantsForProject identity changes (refetch) and type flips —
  // neither of which is a swap, and neither may clobber an explicit pick.
  const unitSeedPlantRef = useRef(form.plant_id)
  useEffect(() => {
    if (form.event_type !== 'harvest') return
    const prevPlant = unitSeedPlantRef.current
    unitSeedPlantRef.current = form.plant_id
    if (prevPlant && prevPlant !== form.plant_id) unitTouchedRef.current = false
    if (unitTouchedRef.current) return
    // V4-HARVUNITDEFAULT-001: both halves come off the SAME variety_ref, so a planting with no
    // variety (3 live on prod) or an unmapped crop type yields undefined for both and the chain
    // degrades to exactly the pre-change behavior rather than to some other crop's unit.
    const vref = plantsForProject.find(p => p.id === form.plant_id)?.variety_ref
    const unit = readLastHarvestUnit(vref?.crop_type_slug, vref?.default_unit)
    setHarvest(h => (h.unit === unit ? h : { ...h, unit }))
  }, [form.event_type, form.plant_id, plantsForProject])

  // M1 telemetry: reset the flow on mount; mark start-capture the first time the
  // event type is set to watering (the "started a watering log" signal).
  useEffect(() => { ux.reset() }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  // V4-PHOTOQUICK-001: claim the File parked by a trusted tap on the planting page (a File can't
  // ride a URL, and an iOS picker opened post-navigation is suppressed). Runs once on mount.
  useEffect(() => {
    // BUG-QUICKPHOTONOTICE-001: claim ONLY for a photo-intent quick capture. `fromquick=1` has two
    // producers and only one of them ever parks a File:
    //   QuickActions.jsx:124  -> /log?...&event_type=photo&fromquick=1   — parks a File, always.
    //   manifest.webmanifest  -> /log?event_type=harvest&fromquick=1     — parks NOTHING, ever.
    // The PWA "Log a harvest" shortcut is a cold launch into a new document, so the module-state
    // park is empty BY CONSTRUCTION — the else branch below then fired on every single launch and
    // opened the app's fastest path with an error about a photo the user never picked. A false
    // error in a channel trains the user to ignore it, which costs exactly when it is true.
    // Narrow the CLAIM, never the notice: the else branch is the visible half of BUG-SNAPATTACH-001
    // and its sibling gate `phantom_photo_events` is a live alert metric (baseline 22, "pre-fix
    // debris"). A photo-intent launch whose park was consumed by a remount MUST still warn.
    // Fixed in the bundle, not the manifest, deliberately: an installed Android PWA's shortcuts are
    // launcher-cached until Chrome re-reads the manifest (days, unforceable, no programmatic
    // invalidation), so a manifest edit would leave the defect live on Dave's device meanwhile and
    // its acceptance criterion unverifiable. `fromquick` in the manifest is now inert for harvest;
    // drop it there only if that file is being edited for some other reason.
    // V4-PWAHARVSHORTCUT-001 took that permission: the shortcut is now `/log?session=harvest` and the
    // manifest is NO LONGER a `fromquick` producer — QuickActions.jsx:124 is the only one left. This
    // guard is NOT dead and must not be narrowed to that one producer: the same launcher-cache that
    // motivated the bundle-side fix means the retired url keeps arriving from Dave's home screen for
    // days after deploy, and the harvest cases in PhotoEventRequiresPhoto.test.jsx pin it for them.
    if (!fromQuick || preselectedEventType !== 'photo') return
    // §3 B7 — the parked File still lands, and still lands as ONE staged item. The trusted-tap path
    // parks a single File by construction (QuickActions.jsx:124), so multi changes nothing here
    // except the container it goes into.
    const f = takePendingCapture()
    if (f) {
      const id = nextPhotoId()
      setPhotoItems([{ id, file: f, url: URL.createObjectURL(f) }])
      // BUG-PHOTOSTAGEDREAD-001, applied WITHOUT changing this effect's timing. The parked File is
      // held until Save, which is the same read-much-later exposure the pickers had — but this claim
      // must stay synchronous (it races a remount for module state that is cleared on read, see
      // BUG-SNAPATTACH-001 below), so the file is staged first and the copy swapped in when it
      // lands. Fire-and-forget on purpose: on failure the original stays, which is exactly today's
      // behaviour, so this can only improve the odds and never cost the photo.
      snapshotFile(f).then(
        snap => setPhotoItems(prev => prev.map(p => (p.id === id ? { ...p, file: snap } : p))),
        () => {},
      )
    }
    // BUG-SNAPATTACH-001: the claim can MISS — the park is module state cleared on read, so a
    // remount between park and claim (overlay host, StrictMode, any route churn) consumes it and
    // the second mount finds nothing. Silence here is what produced photo-typed events carrying no
    // photo: the form arrives pre-set to "Photo", the user saves, and nothing ever says the file
    // was dropped. Say so at the top of the form, while it is still cheap to re-pick.
    else setNotice('That photo didn’t carry over — pick it again below.')
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (form.event_type === 'watering') { ux.tap(); ux.step(1, 'start_capture') }
  }, [form.event_type])  // eslint-disable-line react-hooks/exhaustive-deps

  // §4 draft stash — restore a dismissed/abandoned dirty form. Once, on mount, on BOTH surfaces
  // (V4-DRAFTFULLPAGE-001 (a) extended the stash from overlay-only to the full page: a mis-tap away
  // from full-page /log destroyed in-progress input with no recovery — no blocker exists on this
  // router (useBlocker needs a data router; App uses declarative BrowserRouter), and persistence
  // beats blocking on mobile anyway). Same key both surfaces, so a draft typed on one resumes on the
  // other. ONLY without a seed deep-link (a bare "Log an event" tap): a deep-link's params express an
  // explicit fresh intent and must win over a stale draft. Restores `form` fields only (see key doc).
  // BUG-SESSIONDRAFTRESTORE-001: ?session=harvest is a seed too, and it is the ONE that cannot
  // survive being overridden. It pins event_type at mount (see the useState seed above) but locks
  // the picker away, so a restored draft's event_type wrote over the pin with no way back — while
  // `inHarvestSession` reads the URL, not the form, so the lock strip kept claiming "every save logs
  // a harvest" over a form with no harvest panel, and Save POSTed the draft's type instead. Every
  // shipped handleSubmit call site passes keepMode:'type', which PRESERVES event_type, so one bad
  // restore mis-typed the whole burst; `sessionRow` is gated on isHarvest, so none of it reached the
  // ledger either. All three entry points (Harvests CTA, TopChrome Basket, PWA shortcut) send the
  // bare url, so all three landed here — the retired shortcut url only escaped because its
  // ?event_type=harvest satisfied this predicate. Refuse the restore rather than coercing the draft
  // to harvest: coercion would carry a watering's notes and plant_id onto a harvest row, which is
  // the silent-misattribution class BUG-LOGTARGETREQ-001 exists to stop. Uses the raw PARAM, not
  // `inHarvestSession`: the event_type pin above is param-level and overlay-agnostic, so the seed
  // predicate that protects it has to be too.
  useEffect(() => {
    const hasSeed = !!(preselectedProjectId || preselectedEventType || preselectedPlantId || resolveEventId || fromQuick || harvestSessionParam)
    if (hasSeed) return
    const draft = readDraft(EVENTNEW_DRAFT_KEY)
    if (!draft || !draft.form) return
    const picked = {}
    for (const k of DRAFT_FORM_FIELDS) if (k in draft.form) picked[k] = draft.form[k]
    // POI-SEEDDOORMENU-001 / pre-promote IMP-1 — `seed_saved` is DROPPED from a restore, and this is
    // the same refuse-rather-than-coerce call the harvest predicate above makes, for a sharper
    // reason: this type no longer renders a form, it renders a SHEET.
    //
    // MEASURED, not theorised (three probes, pre-promote pass 2026-09-02). `DRAFT_FORM_FIELDS`
    // carries both `event_type` and `plant_id`; PROJECTS_HIDDEN makes plantsForProject the unscoped
    // list, so a restored plant_id always resolves; and SaveSeedSheet's save path navigates away
    // without clearing the stash. So after ONE trip through the menu door, every later bare tap on
    // "Log an event" re-derived seedSaveTarget and opened the Save-seed sheet with no user action —
    // on the app's most-tapped surface, in an installed PWA where that session outlives the day.
    //
    // Only the TYPE is dropped, not the draft: a half-typed note and the chosen planting still come
    // back, which is what the stash exists for. The user lands on the chooser with their text intact
    // and picks a type — including this one, deliberately, if that is what they meant.
    if (picked.event_type === 'seed_saved') picked.event_type = ''
    setForm(f => ({ ...f, ...picked }))
    if (typeof draft.showPrivate === 'boolean') setShowPrivate(draft.showPrivate)
    if (typeof draft.showAddDetails === 'boolean') setShowAddDetails(draft.showAddDetails)
    // V4-HARVFORMORDER-001: restored text must never come back INVISIBLE. Notes moved under the
    // harvest disclosure, which is collapsed by default, so a draft carrying a half-typed note
    // would otherwise restore the bytes and hide them — indistinguishable from losing them. Honor
    // an explicitly stashed toggle, then force it open whenever restored text exists (a PRE-S4
    // draft has no showHarvestMore key at all, which is exactly the case that needs the fallback).
    // No-op for every non-harvest type: they never render this disclosure.
    if (typeof draft.showHarvestMore === 'boolean') setShowHarvestMore(draft.showHarvestMore)
    if (picked.notes || picked.private_notes) setShowHarvestMore(true)
    // V4-HARVDRAFTGAP-001: restore the harvest panel. It lives in its own state object, not in
    // `form`, so DRAFT_FORM_FIELDS could never have carried it however it was spelled — a typed
    // weight was simply not stashed, and Escape/Back/dismiss destroyed it with nothing to restore.
    // (The SW-reload leg of that same loss is held open by the reload gate above; this is the
    // dismiss/navigate leg, which no gate can defer.)
    // Both fields sit ABOVE the "Photo, notes & date" disclosure, so unlike notes they cannot come
    // back invisible and need no showHarvestMore fallback.
    if (draft.harvest) {
      const h = draft.harvest
      // Claim the upcoming type transition BEFORE it fires (see the type-change effect).
      if (picked.event_type) draftRestoredTypeRef.current = picked.event_type
      setHarvest(cur => ({
        ...cur,
        quantity:       typeof h.quantity === 'string' ? h.quantity : cur.quantity,
        weight:         typeof h.weight === 'string' ? h.weight : cur.weight,
        quality_rating: h.quality_rating ?? cur.quality_rating,
        // V4-HARVDISPOSITION-001: same `??` shape as quality_rating — a draft that never carried
        // one leaves the fresh null alone rather than writing undefined over it.
        disposition:    h.disposition ?? cur.disposition,
        // Units restore only when the draft carried them, so a stale draft can never downgrade the
        // crop-aware default a fresh mount just computed.
        unit:           h.unit || cur.unit,
        weight_unit:    h.weight_unit || cur.weight_unit,
      }))
      // Carry the EXPLICITNESS of the unit pick, not just its value. The crop-default reseed
      // effect below re-fires on plant/type changes and skips only when unitTouchedRef is set, so
      // restoring a deliberately-chosen unit without this flag lets the default clobber it — while
      // setting it unconditionally would pin a never-chosen default as though the user picked it.
      if (h.unitTouched) unitTouchedRef.current = true
    }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // §4 draft stash — persist the in-progress form while dirty (BOTH surfaces, V4-DRAFTFULLPAGE-001).
  // Cleared on a successful save (spent). Dirty NARROWED to typed text (was any-field): the sticky
  // seeds (event_type kept post-save, and the since-removed remembered plant_id — see
  // BUG-LOGTARGETREQ-001 above) satisfied the old predicate on every mount, so the post-save
  // rewrite stored a stale draft. Typed text is the irreplaceable content; picks still ride along
  // in the snapshot whenever text is present. Draft-restored plant_id is KEPT by design
  // (adjudicated: the user explicitly chose that planting in this draft — user context, never a
  // silent default).
  // V4-HARVDRAFTGAP-001 widens the predicate to the TYPED harvest fields. Deliberately excludes
  // unit/weight_unit: freshHarvest() seeds both from stored prefs, so counting them would satisfy
  // the predicate on every pristine harvest mount and re-create exactly the stale-draft rewrite the
  // narrowing above was introduced to kill. quality_rating counts because a tapped star is a
  // deliberate entry, and resetForNext() clears all three, so a post-save mount reads clean.
  useEffect(() => {
    const dirty = !!(
      form.notes || form.private_notes || form.quantity ||
      harvest.quantity || harvest.weight || harvest.quality_rating != null ||
      // V4-HARVDISPOSITION-001: counts for the same reason quality_rating does — a tapped chip is a
      // deliberate entry, and freshHarvest() seeds null so a pristine mount still reads clean.
      harvest.disposition != null
    )
    if (!dirty) return
    const snap = {}
    for (const k of DRAFT_FORM_FIELDS) snap[k] = form[k]
    writeDraft(EVENTNEW_DRAFT_KEY, {
      form: snap,
      showPrivate,
      showAddDetails,
      showHarvestMore,
      harvest: {
        quantity: harvest.quantity,
        weight: harvest.weight,
        quality_rating: harvest.quality_rating,
        disposition: harvest.disposition,
        unit: harvest.unit,
        weight_unit: harvest.weight_unit,
        unitTouched: unitTouchedRef.current,
      },
    })
  }, [form, harvest, showPrivate, showAddDetails, showHarvestMore])

  // V4-DRAFTFULLPAGE-001 (b) — report in-progress content to the hosting Sheet (OverlayHost feeds
  // Sheet §5.2: a stray backdrop tap no-ops while dirty; Escape + the labelled Close stay live, and
  // the draft stash above keeps the bytes recoverable). BROADER than the stash predicate: it also
  // counts the non-stashed panels (photo, harvest qty, metadata, treatment, container, issue text)
  // whose loss a dismiss makes unrecoverable. Deliberately EXCLUDES bare event_type/plant_id picks —
  // sticky/deep-link seeding would otherwise lock the backdrop on every pristine mount. No-op on
  // the full page (no provider).
  // V4-HARVFEEDBACK-001 S5b: the `!confirmation &&` prefix is DELETED. It existed because the card
  // replaced the body — nothing was typeable, so reporting clean kept the card backdrop-dismissable.
  // With the form live for the whole burst, that prefix would pin dirty=false for the rest of the
  // session and a stray backdrop tap would discard genuinely-unsaved harvest #2. The spec (§3)
  // names "keep reporting dirty=false post-save" as the BUG, not the fix. Post-save the predicate
  // reads clean on its own, because resetForNext() clears the fields it counts — which is why
  // EventNewOverlayDirty's post-save pin stays green unchanged.
  // CORRECTED: that was true of every counted field EXCEPT treatment.*, which resetForNext() did
  // not clear (the only handleSubmit call site passes keepMode:'type', which preserves event_type,
  // so the type-change effect that resets treatment never fires). Harmless while the card covered
  // the form; with the form live it left the sheet reporting dirty after a SUCCESSFUL
  // pest_treatment save, so a backdrop tap no-opped. resetForNext() now clears it too.
  // Hoisted to a named value because it now feeds TWO channels with different lifetimes: the Sheet
  // backdrop guard below, and the service-worker reload gate. Same predicate on purpose — both ask
  // the identical question ("is there typed content a dismissal/reload would destroy"), and letting
  // them drift is how one surface ends up defended and the other not.
  const hasUnsavedInput = !!(
    form.notes || form.private_notes || form.quantity ||
    photoItems.length || harvest.quantity || harvest.weight ||
    Object.keys(metadataState).length ||
    treatment.pest_target || treatment.product_id || treatment.product_text || treatment.category || treatment.amount ||
    container.type || container.size.trim() ||
    issueOther ||
    // V4-LOSSUI-001: a typed quantity or a tapped reason is exactly the "typed content a dismissal
    // would destroy" this predicate asks about — and unlike most panels here these two are REQUIRED,
    // so losing them to a stray backdrop tap costs the whole entry, not an optional detail.
    reduction.qty || reduction.reason
  )

  useReportOverlayDirty(hasUnsavedInput)

  // V4-RELOADGATEWIRE-001 — the producer half of OPS-SWRELOADGUARD-001. reloadGate.js and
  // registerSW's deferral shipped fully built and mutation-proved, but NOTHING ever held the gate,
  // so `isReloadBlocked()` was false at every controllerchange and the deferral could not fire: an
  // inert feature that passed every test it had and changed nothing for the user. This is the call
  // that arms it.
  //
  // Runs on BOTH surfaces, unlike useReportOverlayDirty above — that hook is a deliberate no-op with
  // no provider (full page), but a deploy reload hits the full-page /log form exactly as hard as the
  // overlay, and it is the harvest form Dave uses at the plant.
  //
  // The cleanup release is REQUIRED, not defensive: a dismissed or navigated-away dirty form that
  // kept its hold would wedge updates forever and rebuild BUG-STALECLIENT-001, which is the bug that
  // made this a DEFERRAL rather than a cancellation in the first place.
  //
  // Note the release is safe here only because the dep is a BOOLEAN: while the user keeps typing,
  // `hasUnsavedInput` stays true, the deps compare equal and the effect never re-runs, so the
  // cleanup cannot release mid-form. It fires on a genuine true→false flip (correct — the form is
  // clean, let the deferred reload land) or on unmount. Widen this dep to a non-boolean and that
  // stops being true: a release NOTIFIES, and registerSW reloads on that notification.
  //
  // Key is per-instance: reloadGate holds a Set, and if the overlay ever mounts over the full-page
  // form, a shared literal key would let the first unmount release the second instance's hold.
  const reloadGateKey = `event-new:${useId()}`
  useEffect(() => {
    setReloadBlocked(reloadGateKey, hasUnsavedInput)
    return () => setReloadBlocked(reloadGateKey, false)
  }, [reloadGateKey, hasUnsavedInput])

  // Load plants when project selection changes (project-scoped mode — the default).
  useEffect(() => {
    if (PROJECTS_HIDDEN) return // V4-PROJHIDE-001: unscoped mode loads ALL plantings in the effect below
    if (!form.project_id) { setPlantsForProject([]); setPlantsLoadFailed(false); return }
    // BUG-PLANTMISMATCH-001: a switch fires a second fetch while the first may still be in flight.
    // Without this flag a late response for the PREVIOUS project can overwrite the current list and
    // then clear a planting the user legitimately picked from it — i.e. the stale-guard below would
    // itself become a source of wrong writes. Cancel on re-run.
    let cancelled = false
    setPlantsLoadFailed(false)
    // V4-PICKERPAYLOAD-001: the chooser projection. This list is read by exactly two consumers —
    // this file and the PlantingSelect it feeds — and between them they touch nine top-level keys
    // and four of variety_ref's. The wide shape was 814KB + ~426 presigned photo URLs the chooser
    // renders none of; this is ~99KB and none. Field census is in the Lambda branch's comment; if
    // this file starts reading a new field, add it THERE rather than dropping back to the wide shape.
    apiFetch('/api/plants?view=picker&project_id=' + form.project_id)
      .then(data => {
        if (cancelled) return
        const live = (data ?? []).filter(p => !p.archived_at)
        setPlantsForProject(live)
        // BUG-PLANTMISMATCH-001 — GENERALIZED stale-guard. This used to be two checks, each scoped
        // to one specific id (the ?plant= deep-link prefill and the since-removed remembered-
        // planting seed), which is why a HAND-PICKED planting survived a project switch untouched
        // and POSTed as a mismatched (project_id, plant_id) pair with nothing on either side
        // validating it. Prod carries 39 such pairs. The rule is not about where the id came from:
        // any plant_id that is not in this project's live plantings is not a valid target for this
        // project, full stop. BUG-LOGTARGETREQ-001 removed the remembered-planting seed, but the
        // guard stays GENERAL — it still validates the ?plant= deep-link and the hand-picked case.
        setForm(f => (f.plant_id && !live.some(p => p.id === f.plant_id) ? { ...f, plant_id: '' } : f))
      })
      .catch(() => { if (!cancelled) { setPlantsForProject([]); setPlantsLoadFailed(true) } })
    return () => { cancelled = true }
  }, [apiFetch, form.project_id, preselectedPlantId, plantsReloadKey])

  // V4-PROJHIDE-001: unscoped planting source. With the project chooser hidden, the picker lists
  // EVERY live planting and project_id is DERIVED from the chosen planting (see PlantingSelect
  // onChange) — preserving the plant_id ⇒ project_id invariant without a user-visible project step.
  // ── V4-PICKERCACHE-001 — the unscoped picker list, now SWR-cached ────────────────────────────
  // V4-PICKERPAYLOAD-001 made this response ~10x lighter (814,399 B + ~426 presigns -> 123,348 B +
  // zero). It did not make it WARM: PROJECTS_HIDDEN is on, so every log event and every weigh-in
  // still paid a cold round trip through here before the chooser could open, and the chooser is the
  // first thing Dave touches on the surface he uses most.
  //
  // Same SEED shape Garden.jsx adopted in V4-GARDENCACHE-001, and for the same reason: local state
  // stays the render source, so nothing about how this list is consumed, filtered or reset changes.
  // The hook paints from cache on the first render and revalidates on every mount.
  //
  // NOT a behaviour change on failure, but a better one: the hook surfaces `error` only on a COLD
  // failure, so a transient blip during a background revalidate now KEEPS the list Dave is looking
  // at instead of blanking it to `plantsLoadFailed`. The old catch could not tell those apart.
  const pickerCache = useCachedFetch(PROJECTS_HIDDEN ? PICKER_PATH : null)
  const { refetch: refetchPicker } = pickerCache
  useEffect(() => {
    if (!PROJECTS_HIDDEN) return
    if (pickerCache.error) { setPlantsForProject([]); setPlantsLoadFailed(true); return }
    if (pickerCache.data !== undefined) {
      setPlantsForProject((pickerCache.data ?? []).filter(p => !p.archived_at))
      setPlantsLoadFailed(false)
    }
  }, [pickerCache.data, pickerCache.error])

  // `plantsReloadKey` is the inline-add-planting write-through: a planting created without leaving
  // the form must appear in the chooser immediately. Uncached that was a dep bump forcing a refetch;
  // cached it has to be an explicit revalidate, or the next mount would paint the pre-create list —
  // the exact stale-after-mutation hazard Garden's own adoption note calls out. Skipped on mount,
  // where the hook already revalidates: firing both would double the request this row exists to
  // remove.
  const mountedReloadKey = useRef(plantsReloadKey)
  useEffect(() => {
    if (!PROJECTS_HIDDEN) return
    if (plantsReloadKey === mountedReloadKey.current) return
    refetchPicker()
  }, [plantsReloadKey, refetchPicker])

  // BUG-LOGBANDOCCLUDE-001: latches on the first sign the user is driving. `pointerdown` rather
  // than `click` so a press that STARTS a scroll counts, and capture phase so a handler that stops
  // propagation cannot hide the interaction from us.
  const userActedRef = useRef(false)
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const latch = () => { userActedRef.current = true }
    const opts = { capture: true, passive: true }
    document.addEventListener('pointerdown', latch, opts)
    document.addEventListener('keydown', latch, opts)
    document.addEventListener('focusin', latch, opts)
    window.addEventListener('scroll', latch, opts)
    return () => {
      document.removeEventListener('pointerdown', latch, opts)
      document.removeEventListener('keydown', latch, opts)
      document.removeEventListener('focusin', latch, opts)
      window.removeEventListener('scroll', latch, opts)
    }
  }, [])

  // ── BUG-LOGBANDOCCLUDE-001 — the SECOND half of the fix (the first is `pointerEvents` on the
  //    band itself; see the save-sticky style block). Making the band's transparent box stop
  //    hit-testing frees the strip to Save's LEFT, but Save is opaque and painted and genuinely
  //    covers what is under it — measured at a true 390x844, Save occupies x179-359 while the
  //    chooser spans x35-340, so two thirds of a REQUIRED field sat under a control that WRITES.
  //    That is the mis-tap-that-commits hazard SAVE_BAND_MIN_CLEARANCE_PX was minted for, not a
  //    cosmetic overlap, and no amount of pointer-events fixes it.
  //
  //    So: on first paint, scroll the minimum that puts the chooser clear. Deliberately narrow —
  //    `clearControlOfSaveBand` returns 0 when there is no collision, so this is a no-op at every
  //    viewport and scroll position where the bug does not exist, and it is instant rather than
  //    smooth so it cannot race the V4-HARVSCROLLANCHOR-001 anchor mid-animation.
  //
  //    WHY THIS WATCHES LAYOUT AND NOT STATE, which cost two measured wrong answers to learn.
  //    Draft 1 ran once on mount behind a single rAF: at that instant no list had landed, the page
  //    was ~500px shorter, the chooser was nowhere near the band, and the helper correctly returned
  //    0. Draft 2 added `plantsForProject.length` / `projects.length` as deps — and still never
  //    fired, because a list that arrives EMPTY leaves its length at 0 and changes no dep at all,
  //    while the surrounding chrome it unblocks still grows the page. Both drafts reported "no
  //    collision" against a collision that was live in the browser the whole time.
  //    The dependency is not any piece of state. It is the page getting taller. So watch that.
  //
  //    `userActedRef` keeps this from becoming a page that jumps under a thumb: once anything has
  //    been touched, scrolled, or focused, the user owns the scroll and a late arrival must not
  //    reposition them. It latches — this is a first-paint fix and gets exactly one chance — and
  //    the observer disconnects the moment it does.
  //
  //    sessionFrame is exempt: the frame has no sticky band at all (track 3 is a real grid track),
  //    so there is nothing to clear and `!band` would no-op anyway.
  useEffect(() => {
    if (sessionFrame) return undefined
    if (typeof document === 'undefined' || typeof ResizeObserver !== 'function') return undefined
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn => setTimeout(fn, 0))
    let frame = null
    const attempt = () => {
      frame = null
      if (userActedRef.current) { obs.disconnect(); return }
      clearControlOfSaveBand(undefined, { controlSelector: PLANTING_CHOOSER_SELECTOR })
    }
    // Coalesced to one rAF: a settling page fires several resize records in a burst, and each
    // would otherwise measure a half-laid-out frame.
    const schedule = () => {
      if (userActedRef.current) { obs.disconnect(); return }
      if (frame == null) frame = raf(attempt)
    }
    const obs = new ResizeObserver(schedule)
    obs.observe(document.body)
    schedule()
    return () => {
      obs.disconnect()
      if (frame != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
    }
  }, [sessionFrame])

  // Load projects + locations
  useEffect(() => {
    Promise.all([
      apiFetch('/api/projects'),
      apiFetch('/api/locations/with-path'),
    ]).then(([proj, locs]) => {
      const loggable = (proj ?? []).filter(p => LOGGABLE_PROJECT_STATUSES.includes(p.status) && !p.archived_at)
      setProjects(loggable)
      setLocations((locs ?? []).filter(l => l.is_active))
      // V1.2a-2 Wave 3: deep-link safety — if a ?project= param was supplied but
      // doesn't match any loaded (active, owned) project, clear the prefill and
      // surface a non-fatal notice rather than silently POSTing a bad project_id.
      if (preselectedProjectId && !loggable.some(p => p.id === preselectedProjectId)) {
        setForm(f => (f.project_id === preselectedProjectId ? { ...f, project_id: '' } : f))
        setNotice('Project not found — pick one.')
      } else if (!preselectedProjectId && rememberedProjectId && !loggable.some(p => p.id === rememberedProjectId)) {
        // V4-STICKY-001: a remembered project that no longer exists (archived / status
        // changed) must not stick — silently fall back to the current default (no notice).
        // BUG-LOGTARGETREQ-001: the remembered-PLANT seed is gone, so plant_id here can
        // only be a ?plant= param riding the remembered project — it falls with that
        // project (a plant under a dead project would violate plant_id ⇒ project_id).
        setForm(f => (f.project_id === rememberedProjectId ? { ...f, project_id: '', plant_id: '' } : f))
      }
      // V4-PROJHIDE-001: the project chooser is hidden, but exempt (planting-less) events still need
      // a project_id (server exactly_one_parent). Default to the first loggable project as invisible
      // plumbing; a chosen planting overrides it via derivation. Runs last so it fills any clear above.
      if (PROJECTS_HIDDEN) {
        setForm(f => (f.project_id ? f : { ...f, project_id: loggable[0]?.id || '' }))
      }
    }).catch(() => {})
  }, [apiFetch, preselectedProjectId, rememberedProjectId])

  function handleMetadataChange(key, value) {
    setMetadataState(prev => {
      const next = { ...prev }
      if (value === undefined || value === '') {
        delete next[key]
      } else {
        // Coerce number fields to actual numbers
        const fieldDef = EVENT_METADATA_FIELDS[form.event_type]?.find(f => f.key === key)
        next[key] = fieldDef?.type === 'number' ? Number(value) : value
      }
      return next
    })
  }

  // §3 B1 — every file from ONE picker invocation, appended to whatever is already staged (a second
  // trip to the picker adds rather than replaces). Flag-off takes the first file only, which is the
  // shipped behaviour: the input carries no `multiple` attribute in that branch, so the FileList is
  // one entry anyway and the slice is a belt-and-braces guard, not the mechanism.
  // BUG-PHOTOSTAGEDREAD-001 — copy the bytes at pick time. These items are held until Save, which is
  // the longest gap between pick and read anywhere in the app: the user still has to choose a
  // planting, a kind and a date. Android reclaims picker handles well inside that window, and the
  // read failure that follows is Chrome's "could not be read ... after a reference to a file was
  // acquired" — measured on prod v4.80.0 in the Photo Library's copy of this pattern, 9 of 10 lost.
  // Mechanism and why a preview keeps rendering the whole time: lib/fileSnapshot.js.
  async function handlePhotoChange(e) {
    const picked = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (!picked.length) return

    // Bounds the copying only; the updater below re-derives room from `prev` and is the authority,
    // since this function now awaits and `photoItems` can be a render behind when it resumes.
    const roomNow = PHOTO_MULTI_ATTACH_ENABLED ? Math.max(0, MAX_EVENT_PHOTOS - photoItems.length) : 1
    const candidates = picked.slice(0, roomNow)
    if (!candidates.length) return

    setPhotoPreparing({ done: 0, total: candidates.length })
    let ok = [], failed = []
    try {
      ;({ ok, failed } = await snapshotFiles(
        candidates,
        (done, total) => setPhotoPreparing({ done, total }),
      ))
    } finally {
      setPhotoPreparing(null)
    }

    if (failed.length) {
      const names = failed.map(f => f.file?.name).filter(Boolean)
      setNotice(
        `${failed.length} of ${candidates.length} couldn't be read and ${failed.length === 1 ? 'was' : 'were'} not added` +
        `${names.length ? ` (${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''})` : ''}` +
        '. Re-pick from the gallery and try again.'
      )
    }
    if (!ok.length) return

    setPhotoItems(prev => {
      const room = PHOTO_MULTI_ATTACH_ENABLED ? Math.max(0, MAX_EVENT_PHOTOS - prev.length) : 1
      const accepted = ok.slice(0, room)
      if (!accepted.length) return prev
      // Replace, not append, in single mode — re-picking has always swapped the staged file.
      const next = PHOTO_MULTI_ATTACH_ENABLED ? prev : []
      if (!PHOTO_MULTI_ATTACH_ENABLED) for (const it of prev) URL.revokeObjectURL(it.url)
      // Object URL from the SNAPSHOT — one taken from the replaced handle dies on the same schedule.
      return next.concat(accepted.map(({ file }) => ({ id: nextPhotoId(), file, url: URL.createObjectURL(file) })))
    })
  }

  function removePhotoItem(id) {
    setPhotoItems(prev => {
      const hit = prev.find(p => p.id === id)
      if (hit) URL.revokeObjectURL(hit.url)
      return prev.filter(p => p.id !== id)
    })
  }

  // V4-HIDECAPTURE-001: straight to the picker. The 2026-06-02 camera-unification toggle is gone
  // along with the Take arm; <PhotoUpload> lost its `mode`/`capture` props in the same change, so
  // this stays consistent with it by having no camera path rather than by mirroring one.
  const photoInputRef = useRef(null)
  function openPhotoPicker() {
    const el = photoInputRef.current
    if (!el) return
    el.click()
  }

  // §3 B8 — revokes N, not one. Reads from the updater's `prev` rather than the render closure so a
  // call made from resetForNext (which runs in the same tick as other setState) can never revoke a
  // stale list and leak the current one.
  function clearPhoto() {
    setPhotoItems(prev => {
      for (const it of prev) URL.revokeObjectURL(it.url)
      return prev.length ? [] : prev
    })
  }

  // V4-LOGCONF-001 undo — REUSES the sanctioned soft-delete (DELETE /api/events/:id sets deleted_at
  // + recomputes watering memory; same path as EventDetail's delete and the global toast's Undo).
  // Awaited so the card reflects the outcome: success flips to a durable "removed" state; failure
  // surfaces a retryable error instead of silently losing the undo (ADHD forgiveness — a mistake
  // must never have a shame-outcome with no recovery path).
  async function undoEvent() {
    if (!confirmation || confirmation.undone) return
    try {
      await apiFetch('/api/events/' + confirmation.eventId, { method: 'DELETE' })
      setConfirmation(c => (c ? { ...c, undone: true, error: null } : c))
    } catch {
      setConfirmation(c => (c ? { ...c, error: "Couldn't undo — try again." } : c))
    }
  }
  // V4-HARVSESSION-001 per-row undo — the same sanctioned soft-delete as undoEvent above, applied
  // to any row in the session ledger rather than only the latest save.
  async function undoSessionRow(rowEventId) {
    try {
      await apiFetch('/api/events/' + rowEventId, { method: 'DELETE' })
      setSessionRows(rows => rows.map(r => r.eventId === rowEventId ? { ...r, undone: true, undoError: null } : r))
    } catch {
      setSessionRows(rows => rows.map(r => r.eventId === rowEventId ? { ...r, undoError: "Couldn't undo — try again." } : r))
    }
  }

  // BD-044: fillFromChip / tapSessionChip removed with the tray that was their only caller.

  // (V4-HARVFEEDBACK-001 S5a: the confirmPhase-keyed focus effect that used to sit here moved into
  // components/PostSaveFeedback.jsx along with closeBtnRef — the ref's only consumer was the card's
  // Close button. Same derivation, same dep array; EventNew has no other .focus() call, so nothing
  // races it.)

  // V1.2a-2 Wave 3: client-side harvest validation — mirrors the server contract
  // in lambda/events/validators.js. Returns an error string, or null if valid.
  function validateHarvest() {
    const qty = Number(harvest.quantity)
    if (harvest.quantity === '' || !Number.isFinite(qty) || qty <= 0) {
      return 'Enter a quantity greater than zero.'
    }
    if (qty > MAX_PLAUSIBLE[harvest.unit]) {
      return `That's higher than expected for ${harvest.unit} — double-check the amount.`
    }
    // V4-HARVDUAL-001: the weight is OPTIONAL, so an empty field is valid and validated away here
    // before any Number() coercion (Number('') is 0, which would read as "entered zero").
    if (harvest.weight !== '') {
      const w = Number(harvest.weight)
      if (!Number.isFinite(w) || w <= 0) return 'Enter a weight greater than zero, or leave it blank.'
      if (toGrams(w, harvest.weight_unit) > MAX_PLAUSIBLE_WEIGHT_G) {
        return `That's higher than expected for a single weighing — double-check the ${harvest.weight_unit}.`
      }
    }
    return null
  }

  // V3-EVENT-001: reset the form for another entry on the "Save & Next" path.
  // PRESERVES project_id + plant_id (scope continuity for rapid sequential
  // logging) and the localStorage-persisted harvest unit. CLEARS event_type (forces a
  // deliberate re-pick — see DECISION note), event_date→now, notes/quantity/private_notes,
  // and all type-specific panels. Collapses add-details/private back to defaults.
  function resetForNext(mode) {
    // mode 'plant' -> keep the planting (project+plant), clear event_type: log the next
    // event for THIS plant. mode 'type' -> keep event_type, clear plant_id: log the SAME
    // event for the next plant. project_id is preserved both ways so the (project-scoped)
    // plant picker stays populated.
    // V4-LOGTARGET-001 DECISION (spec §6.3.2 "reconsider"): keepMode 'type' KEEPS clearing
    // plant_id. The single Save is V4-EVENTSAVE-001's rapid next-plant flow (same event,
    // next plant) and the next-of-type oracle test pins it; sticky planting covers the
    // next COLD mount, not the in-session reset. Revisit only if Dave flags the clearing.
    setForm(f => ({
      event_type:    mode === 'type' ? f.event_type : '',
      project_id:    f.project_id,
      location_id:   '',
      // V4-WEIGHDATEREACH-001 — STICKY IN A WEIGH-IN SESSION, reset to now everywhere else.
      // Dave: "Maybe even keep the date from the previous log." A sitting is one sitting: if he is
      // standing at the scale on Wednesday working through Tuesday's picking, re-setting the date to
      // today after every save means re-fixing it 17 times, which is the "major PITA" restated as a
      // per-entry tax. Scoped to `inHarvestSession` deliberately — on the general Log Event form a
      // sticky date would silently backdate an unrelated event the user logs an hour later, and
      // there the date IS visible in the form, so nothing is hidden from them.
      event_date:    inHarvestSession ? f.event_date : toDatetimeLocal(new Date()),
      notes:         '',
      private_notes: '',
      quantity:      '',
      plant_id:      mode === 'type' ? '' : f.plant_id,
    }))
    setMetadataState({})
    // Treatment was the one dirty-predicate field this reset missed. Stale values also meant the
    // NEXT save could carry the previous save's treatment data on a keepMode:'type' burst.
    setTreatment({ pest_target: '', product_id: '', product_text: '', category: '', amount: '' })
    unitTouchedRef.current = false
    setHarvest(freshHarvest())
    setHarvestError(null)
    setSeverity(null); setIssueChoice(''); setIssueOther('')
    setContainer({ type: '', size: '' })
    // V4-WATERMATH-001 F0: the amount class does NOT stick across a keepMode:'type' burst. A
    // carried-over Deep would silently record an amount the user never chose for the NEXT
    // planting — the same class of defect the treatment reset above exists to close — and it
    // would also corrupt the annotation-rate signal by inflating one deliberate tap into N.
    setWaterDepth(WATER_DEPTH_DEFAULT); waterDepthTouchedRef.current = false
    // V4-LOSSUI-001: cleared here as well as on type change, because keepMode:'type' PRESERVES
    // event_type — so the type-change effect never fires on a burst and a carried-over "lost 3"
    // would silently ride onto the NEXT planting. Exactly the treatment.* defect recorded above.
    setReduction({ qty: '', reason: '' }); setReductionError(null)
    clearPhoto()
    setShowAddDetails(EVENTNEW_ADD_DETAILS_EXPANDED)
    setShowPrivate(false)
    setError(null)
    setSaving(false)
    // BUG-POSTSAVEVALIDATION-001 — the reset above clears plant_id, but PlantingSelect's `touched`
    // is its own local state and this form does NOT unmount between saves, so it stayed true and
    // the picker rendered "Choose a planting." in red the instant a save SUCCEEDED. Latent before
    // S5b (the confirmation card covered the form until "Log another" was tapped); a live form
    // surfaces it immediately. Bumping the nonce tells the picker this is a fresh form.
    setPickerResetNonce(n => n + 1)
  }

  // RETURNS { ok, reason? , eventId? } — V5-HARVESTVOICEFLOW-001 gate B5 / condition C6.
  //
  // It returned `undefined` on all nine paths: success, POST failure, and every one of the eight
  // validation refusals. Nothing could tell them apart, so a caller that saves and then advances
  // would advance over a FAILED save — the chooser opens on top of the inline error, the next
  // spoken crop overwrites plant_id, and the harvest is silently abandoned. No current caller reads
  // the return (all four are event handlers), so this is purely additive today; it exists so the
  // first caller that needs to know cannot be written against a contract that does not exist.
  //
  // THE RE-ENTRANCY GUARD IS THE LOAD-BEARING LINE. The disabled Save button was the only defence,
  // and it only covers a double-tap ON THAT BUTTON: the Enter-key path (`e.key === 'Enter'` →
  // handleSubmit, below) bypasses it entirely, as would any programmatic caller. `saving` is true
  // only between setSaving(true) and its reset, and BOTH exits from that window reset it — the
  // catch around the POST, and the end of the success path — so this cannot strand the form in a
  // permanently unsubmittable state. Verified: exactly one `return` sits inside that window and it
  // resets first.
  //
  // AN IDEMPOTENCY KEY IS DELIBERATELY NOT HERE. B5 asks for one alongside these two, but it is a
  // server contract (the events Lambda would have to honour and de-duplicate it), and nothing can
  // fire a duplicate save programmatically until the voice flow's S3 slice exists. Adding a key the
  // server ignores would look like protection and be none.
  async function handleSubmit(e, { keepMode = 'type' } = {}) {
    e.preventDefault()
    if (saving) return { ok: false, reason: 'in_flight' }
    if (!form.event_type)  { setError('Select an event type above.'); return { ok: false, reason: 'no_event_type' } }
    // V4-LOGTARGET-001 invariant: this gate is also what enforces plant_id ⇒ project_id
    // at submit — a POST can never leave here as {project_id:'', plant_id:X} (the server's
    // exactly_one_parent CHECK would 500 on it). Sticky seeding preserves the same
    // invariant at mount (a remembered plant only seeds alongside its remembered project).
    if (!form.project_id)  { setError('Select a project.'); return { ok: false, reason: 'no_project' } }

    // V4-PLANTREQUIRED-001 (Lane 3, flag-gated): per-type required-planting gate (D2 matrix).
    // Inert unless PLANTING_REQUIRED_ENABLED — the planting field is otherwise optional (Lane 2).
    // flag_issue keeps its own plant_id gate below and is not in the vocabulary, so it is unaffected.
    // V4-PROJHIDE-001: when projects are hidden a predicated event has no project step to ride, so the
    // planting is structurally required for those types — implied HERE, independent of the telemetry-
    // gated PLANTING_REQUIRED_ENABLED (the two gates stay decoupled by design).
    if ((PLANTING_REQUIRED_ENABLED || PROJECTS_HIDDEN) && requiresPlanting(form.event_type) && !form.plant_id) {
      setError('Choose a planting for this event.'); return { ok: false, reason: 'no_planting' }
    }

    // BUG-SNAPATTACH-001: a photo event with no photo is never intentional, and prod has 22 of them
    // out of 582. Two routes produce one outcome: the "Photo" tile is a first-class choice in the type
    // picker so it can simply be saved with nothing attached, and the V4-PHOTOQUICK-001 park/claim
    // seam can drop the file in transit. Both end as a permanent, silent, empty event — the app
    // answers "Logged" and there is nothing to recover, because no upload was ever attempted and
    // so nothing ever failed. Gate it like the harvest quantity gate above: refuse the save, inline,
    // while the photo can still be added. NOT a warn-and-proceed — proceeding is the bug.
    // §3 B5 — a COUNT check, not a truthiness check. Zero staged files is still refused (the whole
    // BUG-SNAPATTACH-001 protection); one or more proceeds. Widening this to "some photos" would
    // reopen the empty-photo-event class it was written to close.
    if (form.event_type === 'photo' && photoItems.length === 0) {
      setError('Add a photo for a photo event — or pick a different event type.'); return { ok: false, reason: 'no_photo' }
    }

    // V1.2a-2 Wave 3: harvest panel gate — block the POST on invalid quantity,
    // surface an inline error near the quantity field.
    if (form.event_type === 'harvest') {
      const hErr = validateHarvest()
      if (hErr) { setHarvestError(hErr); return { ok: false, reason: 'harvest_invalid' } }
      setHarvestError(null)
    }

    // V4-LOSSUI-001: the plant-reduction gate. BOTH fields are required by the events validator, and
    // its 400s flatten through friendlyError() to "Something didn't look right" — useless beside a
    // form with two empty fields. Refusing here puts the message on the panel instead. Mirrors the
    // harvest gate directly above, deliberately: same shape, same inline surfacing, same position.
    //
    // Over-reduction is NOT gated here. That refusal is the server's 409 (see the reduction branch
    // of friendlyError) because only the server knows the live count — pre-refusing on a plants list
    // fetched at mount would block a legitimate save on stale data, and clamping is what
    // V4-LOSSEVENT-001 expressly refused.
    if (isPlantReductionEventType(form.event_type)) {
      const rErr = validateReductionInput(form.event_type, reduction)
      if (rErr) { setReductionError(rErr); return { ok: false, reason: 'reduction_invalid' } }
      setReductionError(null)
    }

    // V4-FLAG-001: flag-mode gates — a flag must target a specific planting (so DrG surfaces it)
    // and must carry a severity (required by the events validator + drives DrG urgency).
    if (form.event_type === 'flag_issue') {
      if (!form.plant_id) { setError("Choose the plant you're flagging."); return { ok: false, reason: 'no_planting' } }
      if (!severity)      { setError('Pick how urgent it is.'); return { ok: false, reason: 'no_severity' } }
    }

    if (form.event_type === 'watering') ux.tap()  // submit tap (watering flow only)
    setSaving(true)
    setError(null)

    // Send date portion only — Lambda appends T12:00:00 internally
    const eventDateStr = form.event_date.split('T')[0]

    // Build metadata — merge the flag issue_label (V4-FLAG-001) with any Tier-2 metadata.
    const isFlag = form.event_type === 'flag_issue'
    const issueLabel = isFlag ? (issueChoice === '__other__' ? issueOther.trim() : issueChoice) : ''
    // V4-WATERMATH-001 F0: the amount class is ALWAYS written on a watering event, including the
    // untouched default. Writing only user-set classes would leave the ledger unable to tell "the
    // default applied" from "this row predates capture", and would make the annotation-rate
    // denominator unknowable.
    const depthMeta = isWaterDepthType(form.event_type)
      ? waterDepthMetadata(waterDepth, waterDepthTouchedRef.current)
      : {}
    // V4-LOSSUI-001: qty_reduced + the type's reason key. {} for every other type, so this spreads
    // unconditionally — and the events validator FORBIDS these keys on other types, which is what
    // makes "no-op by predicate" the only safe shape here rather than merely the tidy one.
    const reductionMeta = buildReductionMetadata(form.event_type, reduction)
    const mergedMeta = { ...metadataState, ...depthMeta, ...reductionMeta, ...(isFlag && issueLabel ? { issue_label: issueLabel } : {}) }
    const metadata = Object.keys(mergedMeta).length > 0 ? mergedMeta : null
    const flagPayload = isFlag ? { flagged_as_issue: true, severity } : {}

    // V1.2a-2 Wave 3: assemble type-specific payload fields.
    const isHarvest = form.event_type === 'harvest'
    const harvestPayload = isHarvest
      ? {
          harvest: {
            quantity:       Number(harvest.quantity),
            unit:           harvest.unit,
            quality_rating: harvest.quality_rating != null ? Number(harvest.quality_rating) : null,
            // V4-HARVDUAL-001: omit the key entirely when blank rather than sending null. On CREATE
            // the two are equivalent, but the server reads absent-vs-null as distinct intents on the
            // EDIT path, so keeping one shape for both avoids teaching the client a false equivalence.
            ...(harvest.weight !== ''
              ? { weight: Number(harvest.weight), weight_unit: harvest.weight_unit }
              : {}),
            // V4-HARVDISPOSITION-001: the key is OMITTED for a normal pick, matching the weight
            // idiom above — 703 of 707 harvests take this branch, so the create body stays
            // byte-identical to before the feature for the overwhelming majority. On CREATE absent
            // and null are equivalent to the server; keeping one shape for both paths avoids
            // teaching the client a false equivalence it would then carry to the EDIT path, where
            // absent means "untouched" and null means "cleared".
            ...(harvest.disposition != null ? { disposition: harvest.disposition } : {}),
          },
        }
      : {}

    // V4-TREATLOG-001: structured treatment fields (only for pest_treatment / doctored).
    const isTreatment = form.event_type === 'pest_treatment' || form.event_type === 'doctored'
    // BUG-TREATMENTPRODUCT-001: fertilizing had NO product capture at all, so treatment_product_text
    // (a column that already exists) stayed NULL on all 1130 fertilizing rows. It reuses the SAME
    // `treatment.product_text` state slice TreatmentDetails writes — already reset on type change
    // and already counted in hasUnsavedInput below — but sends ONLY the product text, not the other
    // four treatment_* columns: those weren't asked for, and pest_target especially doesn't apply to
    // a fertilizing event. isTreatment above stays pest_treatment/doctored-only on purpose.
    const isFertilizing = form.event_type === 'fertilizing'
    const treatmentPayload = isTreatment
      ? {
          treatment_product_id:   treatment.product_id || null,
          treatment_product_text: treatment.product_text.trim() || null,
          treatment_category:     treatment.category || null,
          treatment_amount:       treatment.amount.trim() || null,
          pest_target:            treatment.pest_target.trim() || null,
        }
      : isFertilizing
        ? { treatment_product_text: treatment.product_text.trim() || null }
        : {}
    // 1 — POST event, get back { eventId, stats }
    let result
    try {
      result = await apiFetch('/api/events', {
        method: 'POST',
        body: JSON.stringify({
          project_id:    form.project_id,
          event_type:    form.event_type,
          event_date:    eventDateStr,
          notes:         form.notes.trim()         || null,
          private_notes: form.private_notes.trim() || null,
          // Harvest events use the structured harvest panel — the generic
          // freetext quantity field is intentionally nulled for them.
          quantity:      isHarvest ? null : (form.quantity.trim() || null),
          plant_id:      form.plant_id               || null,
          // is_public deliberately NOT sent. V4-PUBHIDE-001 is 'default everything to true on
          // all create paths', and the Lambda implements exactly that with `body.is_public ??
          // true` — which only holds while the client stays silent. Sending an explicit false
          // beats a ?? default every time, and that is how 16 harvests went dark on 2026-08-30.
          has_photo:     photoItems.length > 0,
          metadata,
          ...harvestPayload,
          ...flagPayload,
          ...treatmentPayload,
        }),
      })
    } catch (err) {
      setSaving(false)
      setError(friendlyError(err))
      return { ok: false, reason: 'post_failed' }
    }

    // V1.2a-2 Wave 3: remember the chosen harvest unit for next time.
    // BUG-LOGTARGETREQ-001: ALSO written per-crop (lastHarvestUnit:<slug>) so crop A's unit never
    // leaks onto crop B's next harvest. The bare global key keeps being written — it is the
    // fallback for crops with no per-crop memory yet AND the key pre-fix bundles read.
    if (isHarvest) {
      try {
        localStorage.setItem('lastHarvestUnit', harvest.unit)
        const savedSlug = plantsForProject.find(p => p.id === form.plant_id)?.variety_ref?.crop_type_slug
        if (savedSlug) localStorage.setItem(`lastHarvestUnit:${savedSlug}`, harvest.unit)
      } catch { /* noop */ }
      // only remember the weight unit once it has actually been used to weigh something
      if (harvest.weight !== '') {
        try { localStorage.setItem('lastHarvestWeightUnit', harvest.weight_unit) } catch { /* noop */ }
      }
    }

    // V4-STICKY-001: remember the chosen project so the next cold session pre-fills it.
    if (form.project_id) {
      try { localStorage.setItem(LAST_PROJECT_KEY, form.project_id) } catch { /* noop */ }
    }
    // V4-LOGTARGET-001 (sticky option b): remember the exact PLANTING. A deliberate
    // plant-less save clears the key so the next cold mount seeds project-level only —
    // "remembered" is always literally the last save, never an older planting.
    try {
      if (form.plant_id) localStorage.setItem(LAST_PLANT_KEY, form.plant_id)
      else localStorage.removeItem(LAST_PLANT_KEY)
    } catch { /* noop */ }
    // V4-CROPLISTORDER-001 (BD-010): one distinct-day mark for the saved planting's crop —
    // the picker's chip ranking source. Same moment as the lastPlant write above (this is a
    // deliberate single-planting log, exactly the attention signal the ranking wants; LogMany
    // stays excluded — see cropLogLedger.js header). Slug resolution mirrors the per-crop
    // harvest-unit write; a plant-less save or unresolvable slug is a silent no-op, and the
    // ledger try/catches its own storage.
    if (form.plant_id) {
      const rankSlug = plantsForProject.find(p => p.id === form.plant_id)?.variety_ref?.crop_type_slug
      if (rankSlug) recordCropLog(rankSlug, eventDateStr)
    }

    // V4-TREATLOG-001: DrG "Treated…" deep-link — mark the source finding resolved now that the
    // treatment is logged. Non-fatal: the treatment event is already saved.
    if (resolveEventId) {
      try { await apiFetch(`/api/events/${resolveEventId}`, { method: 'PATCH', body: JSON.stringify({ resolved: true }) }) }
      catch { /* resolve can be retried from DrG */ }
    }

    // V3-EVENTCONTSIZE-001: if a potting_up/transplant event captured a new container, persist it to the
    // planting via the live /api/plants PUT (COALESCE leaves untouched fields). Non-fatal: the event is
    // already saved, so a container-write failure surfaces a notice but never blocks the success flow.
    const isPot = form.event_type === 'potting_up' || form.event_type === 'transplant'
    if (isPot && form.plant_id && (container.type || container.size.trim())) {
      try {
        await apiFetch('/api/plants/' + form.plant_id, {
          method: 'PUT',
          body: JSON.stringify({
            container_type: container.type || null,
            container_size: container.size.trim() || null,
          }),
        })
      } catch {
        setNotice("Event saved, but the container update didn't go through — set it on the plant's edit screen.")
      }
    }

    // V1.2a-1 Lambda 2.1.x response shape: event_row fields at top level + updated_streak / xp_gained / newly_earned_achievements / daily_xp_remaining.
    const { id: eventId, updated_streak, xp_gained, newly_earned_achievements } = result
    // V-4 removed (reward-ux-conformance-audit V001 §V-4, ratified jolly-fervent-ritchie):
    // log-save haptic was a banned channel on a reward-signal path. Save still completes.

    // MVP-Critter Stage 1 — server-side hook (Phase B++ refactor 2026-05-30, replaces
    // client-side awardCritter). The events Lambda awards the critter inline in the same
    // POST /api/events transaction; critter_state row exists by the time this response
    // arrives. Dashboard backfill on the next navigate finds it deterministically.
    // No race, no per-surface wiring.

    // 2 — Upload photo via shared hook (non-fatal — errorMode='swallow')
    // The hook runs the same 3-step presign → S3 PUT → POST /api/photos dance.
    // We pass keyPrefix='events' + parentId=eventId so the key resolves to
    // events/{eventId}/{uuid}.{ext} — matching the prior inline behavior.
    // BUG-PHOTOUPLOADHANG-001 follow-up: swallow mode keeps a photo failure non-fatal (the event
    // is already saved), but fully-silent is how a stalled upload masqueraded as a successful save
    // — the user watched "Saving…" for minutes and the photo just never existed. Capture the
    // result so the confirmation surfaces the failure; the event success flow is untouched.
    // §3 B4 — every row written here carries a real parent (`event_id`) and NO `intake_status`. This
    // is in-context attach: the opposite of deferring a tag. Nothing on this path may reach the
    // `inbox/` key prefix or POST /api/photos/batch; keyPrefix stays 'events' for all N.
    //
    // §3 B6 — swallow semantics survive multi. A photo failure never fails the event save (the event
    // is already POSTed by this line), and failures are COUNTED so the confirmation can say how many
    // rather than reporting the last one as if it were the only one.
    //
    // §3 X6 — serial, one decode at a time. Same reasoning as PhotoUpload's queue: a Promise.all
    // here would hold N multi-megabyte decodes at once on an Android phone.
    let photoError = null
    let photoFailCount = 0
    for (const item of photoItems) {
      const photoRes = await photoUploader.upload(item.file, {
        keyPrefix: 'events',
        parentId:  eventId,
        linkage: {
          project_id: form.project_id,
          event_id:   eventId,
        },
        // Same reasoning as the event payload above; useUploadPhoto defaults it to true.
      })
      if (photoRes?.error) {
        photoFailCount += 1
        // Keep the FIRST failure's text: it is the one the user can still act on, and a later
        // failure is usually the same cause restated.
        if (!photoError) photoError = photoRes.error
      }
    }
    const photoTotal = photoItems.length

    setSaving(false)
    if (form.event_type === 'watering') ux.complete({ outcome: 'logged' })  // M1 watering complete

    // V3-EVENT-001 (redesign 2026-06-22, Dave): every save is a rapid-entry save — reset
    // and STAY on the form, never navigate away ("no more Save and go back to Garden").
    // Two entry points: keepMode 'plant' (default / Enter) and keepMode 'type'.
    const projName = projects.find(p => p.id === form.project_id)?.name ?? 'event'
    // V4-VIEWPLANT-001: display name for the card's "View {planting}" action, captured from
    // client state BEFORE resetForNext clears form.plant_id. Label only — the href ids come from
    // the POST response. null → literal-noun "View planting" fallback; never fetched.
    const plantName = form.plant_id ? (plantsForProject.find(p => p.id === form.plant_id)?.name ?? null) : null

    // V4-LOSSUI-001 — the end-status OFFER, captured BEFORE resetForNext() clears form.plant_id for
    // the same reason plantName is.
    //
    // PRESENT ONLY WHEN THIS REDUCTION EMPTIED THE PLANTING. The events Lambda sends
    // plant_reduction: null on every other event, INCLUDING every partial reduction — which is the
    // common case ("10 → 8, pest") and must stay a silent one-tap log. So this is a pass-through of
    // the server's own decision, never a client-side "did it look empty?" inference: the client
    // cannot know the live count, and a second surface guessing at emptiness is the split-brain
    // class this whole feature exists to avoid.
    const reductionOffer = result?.plant_reduction ?? null
    const offerPlantId = result?.plant_id ?? form.plant_id ?? null

    // V4-HARVESTVIEW-001 S4a: the crop whose running season total the confirmation card will echo.
    //
    // V4-PRESERVEOFFERKILL-001 — Dave directive 2026-08-26, verbatim: "hide the do you want to do a
    // put up banner which comes up after doing a harvest event: it is never going to be used at that
    // point, wrong process for that." The V4-HARVESTCENTER-001 (L9) "preserve this?" prefill capture
    // that stood here is DELETED, not flagged off. The habit-stack premise was wrong about the
    // household: putting food up is a separate sitting from picking it, so the offer fired at the one
    // moment it could never be accepted — after EVERY harvest save, i.e. 17 times in a 17-planting
    // weigh-in. That is also the R7 residual OPS-WEIGHINUXFROZEN-001 parked, now answered by its owner.
    // Put-Up's three OTHER prefill doors are untouched (PutUpFromPlanting, PutUpUseSoonBand, and a
    // bare /put-up open — see BottomNav.jsx:362), so no route into Put-Up is stranded; only this
    // trigger dies. Do not reintroduce it as a flag or a "quieter" variant without a fresh Dave ask.
    let seasonCropSlug = null
    if (isHarvest && eventId) {
      const selectedPlant = plantsForProject.find(p => p.id === form.plant_id)
      if (selectedPlant?.variety_ref?.crop_type_slug) seasonCropSlug = selectedPlant.variety_ref.crop_type_slug
    }

    // V4-HARVSESSION-001: ledger row captured BEFORE resetForNext clears the panel state. grams is
    // display-normalized through the same toGrams the server uses, so the strip's running total
    // agrees with what harvest_log will report.
    const sessionRow = inHarvestSession && isHarvest && eventId
      ? {
          eventId,
          // V4-HARVSESSION-002: plantId feeds the tray's done-tick derivation.
          plantId: form.plant_id || '',
          plantName: plantName ?? projName,
          // V4-WEIGHDATEREACH-001: the date this row was FILED UNDER, captured from the same
          // `eventDateStr` the POST body carries — not from `new Date()` at render time. With the
          // date now sticky across a burst, "which day did that one land on" is a question the
          // ledger has to be able to answer for a row logged minutes ago under yesterday's date.
          date: eventDateStr,
          qty: harvest.quantity,
          unit: harvest.unit,
          grams: harvest.weight !== '' ? Math.round(toGrams(Number(harvest.weight), harvest.weight_unit) * 10) / 10 : null,
          undone: false,
          undoError: null,
        }
      : null

    resetForNext(keepMode)
    // V4-LOSSUI-001: raise the offer AFTER the reset, so the sheet is the only thing asking for
    // attention and the form underneath is already clean for the next entry. Requires a plant id —
    // there is nothing to PUT a status onto without one, and an offer with no apply path is worse
    // than no offer.
    if (reductionOffer && offerPlantId) {
      setEndStatusOffer({ ...reductionOffer, plantId: offerPlantId, plantName })
    }
    // V4-HARVPOSTSAVESCROLL-001 (BD-017): keepMode 'type' clears plant_id and the confirmation
    // says "pick the next plant" — while the picker itself is left above the fold, so the next
    // planting costs a manual scroll up. Send the user where the copy just told them to go.
    // ONLY on 'type': keepMode 'plant' KEEPS the planting and clears event_type, so the next tap
    // is the event-type row, and scrolling to a picker they are not being asked to touch would be
    // a second defect of the same kind. rAF-deferred so it measures AFTER the reset's commit —
    // the confirmation banner mounts in the same pass and moves everything below it.
    // V4-WEIGHFRAME-001: DELETED on the frame surface. In a fixed frame the picker is track 1 and is
    // never off the fold, so the anchor has nothing to find — and it was the larger half of the
    // measured round trip (-126px per entry at 390x500, pulling back exactly what the focus anchor
    // had just pushed). What replaces it is a RESTORE, not a second anchor: track 2 is the only
    // scrollable region left, and the measurement says its target is always the offset it was
    // already at.
    if (keepMode === 'type') {
      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn => setTimeout(fn, 0))
      if (sessionFrame) {
        const body = frameBodyRef.current
        const keep = body ? body.scrollTop : 0
        raf(() => { if (frameBodyRef.current) frameBodyRef.current.scrollTop = keep })
      } else {
        raf(() => anchorSectionToTop(PLANTING_SECTION_ID))
      }
    }
    clearDraft(EVENTNEW_DRAFT_KEY)   // saved to DB — the working draft is spent
    // Operational confirmation + undo. Undo = soft-delete the just-logged event. Rewards stay
    // ambient per Reward-UX V101 — never dispatched here.
    if (eventId) {
      if (inOverlay) {
        // V4-LOGCONF-001 (C1+C2) / V4-HARVFEEDBACK-001 S5b: durable confirmation, no timer — now a
        // non-blocking strip in the sticky band rather than a body-replacing card. Global toast is
        // still skipped (AT-invisible behind aria-modal, §7).
        // Spec §7: the burst signal increments HERE, on a confirmed successful save only.
        setSavesThisSession(n => n + 1)
        setConfirmation({
          eventId,
          projectId: result.project_id ?? null,
          // plantId is RESPONSE-sourced (the saved row's truth). V4-HARVFEEDBACK-001 S5b: it no
          // longer builds a "View planting" link (§4.2 dropped it — FLAGGED for Dave as a real
          // regression against shipped V4-VIEWPLANT-001); it now only gates whether the
          // confirmation names a planting or says "no planting attached" (V4-LOGTARGET-001).
          plantId: result.plant_id ?? null,
          plantName,
          projName,
          // V4-WATERMATH-001 F0: the confirmation states the class that was RECORDED — including
          // the default one. A class written without being shown is a class the user cannot
          // correct, and the undo beside it is the correction path. Read from `depthMeta`, which
          // was captured before resetForNext() cleared the chip state.
          eventLabel: ((EVENT_TYPE_META[form.event_type]?.label ?? 'event').replace('\n', ' '))
            + (depthMeta.water_depth ? ` (${waterDepthLabel(depthMeta.water_depth)})` : ''),
          // V4-ICON-001: the checkmark fallback literal is gone. This field is WRITE-ONLY — PostSaveFeedback
          // documents it in its prop shape and never renders it (grep: one hit, the comment) — so a
          // default glyph was decorating nothing. The value itself still comes from EVENT_TYPE_META,
          // which is another lane's file; when that map grows an icon key this becomes `iconName`.
          eventEmoji: EVENT_TYPE_META[form.event_type]?.emoji ?? null,
          undone: false,
          error: null,
          photoError,
          // §3 B6 — the card pluralizes off these; at <= 1 it renders the shipped singular sentence.
          photoFailCount,
          photoTotal,
        })
        // V4-HARVESTVIEW-001 S4a: post-save season-total line (design §2 loop-closer). Cleared first
        // so a prior harvest's total can never flash on this strip; then a harvest-only aggregates
        // GET fills it. Best-effort + STATIC text: renders nothing on failure, adds no link (the
        // strip's zero-link count is a pinned invariant).
        // V4-HARVFEEDBACK-001 S5b (spec §4.3) — NEW: the phrase states its SCOPE. This aggregate is
        // HOUSEHOLD-scoped, so unqualified it silently includes Jen's harvests and reads to each
        // user as "mine". The `Season: ` prefix is preserved so anchored /^Season: / assertions
        // still hold. `(whole garden)` is the shipped DEFAULT — the disclosure is non-negotiable,
        // the exact wording is open for Dave (spec §10.2).
        setSeasonLine(null)
        if (isHarvest && seasonCropSlug) {
          apiFetch(`/api/harvests?include=aggregates&crop=${encodeURIComponent(seasonCropSlug)}`)
            .then(d => { const phrase = seasonTotalPhrase(d?.aggregates?.crops?.[0]); if (phrase) setSeasonLine(`Season: ${phrase} (whole garden)`) })
            .catch(() => { /* ambient — the strip never surfaces a harvests-read failure */ })
        }
      } else if (sessionRow) {
        // V4-HARVSESSION-001: the session ledger IS the confirmation + undo surface — the
        // transient toast would duplicate it and pull attention from the next pile on the scale.
        setSessionRows(rows => [...rows, sessionRow])
        // BD-044: the queue auto-advance stood here; it went with the queue.
      } else {
        // Non-overlay (full page) DELIBERATELY keeps the global operational toast: outside the
        // aria-modal sheet the toast IS AT-reachable, and the full-page rapid-entry flow keeps the
        // form on screen — a body-replacing card here would add a tap to every sequential log.
        // V4-LOGTARGET-001: the toast names the TARGET — the planting when one was attached,
        // otherwise the project with the absence stated plainly.
        const toastTarget = form.plant_id
          ? `Logged event — ${plantName ?? 'planting'}`
          : `Logged event for ${projName} — no planting attached`
        showUndo({
          // The one-photo string is byte-identical to what shipped — pinned by
          // EventNewPostSaveFeedback.characterization.test.jsx's /but the photo didn't upload/.
          message: photoFailCount > 1
            ? `${toastTarget} — but ${photoFailCount} of ${photoTotal} photos didn't upload`
            : photoError
              ? `${toastTarget} — but the photo didn't upload`
              : toastTarget,
          // V4-WATERMATH-001 F0: the recorded amount class, as a SECOND line rather than appended
          // to `message`. Two reasons, both load-bearing: the message string is a pinned oracle
          // (EventNew.test.jsx's exact-match "Logged event — Cayenne #1"), and the class is
          // secondary information that should not compete with the target for the first read.
          // Carries the anchor, so "Deep" is never left to the user's own definition.
          detail: depthMeta.water_depth
            ? `${waterDepthLabel(depthMeta.water_depth)} — ${WATER_DEPTH_CHIPS.find(c => c.value === depthMeta.water_depth)?.anchor ?? ''}`
            : null,
          onUndo: () => { apiFetch('/api/events/' + eventId, { method: 'DELETE' }).catch(() => {}) },
        })
      }
    } else {
      showToast({ message: keepMode === 'type' ? 'Saved — pick the next plant' : 'Saved — log the next event' })
    }
    // The ninth path, and the only one that means the row exists. `eventId` is the id the POST
    // returned, so a caller that saves and advances has the thing it just created rather than only
    // the knowledge that nothing threw.
    return { ok: true, eventId }
  }

  // ── V4-HARVFEEDBACK-001 S5b: the body-replacing early return is DELETED ────────────────────
  // What used to sit here: `if (inOverlay && confirmation) return <PostSaveFeedback …/>` — an early
  // return that UNMOUNTED the whole form and made "Log another" the only way back. Measured
  // on-device (harness at eeb7019): overlay 5N+1 taps vs full-page 4N+1 for N harvests — the whole
  // difference IS that dismissal, exactly 1 tap per harvest, ~20% of the per-harvest interaction,
  // spent undoing the UI's own takeover. The `inOverlay && confirmation` guard survives as the RENDER
  // DECISION — it just gates a strip inside the sticky Save band now (see save-sticky below)
  // instead of gating the whole return, so the form stays mounted and live through a burst.
  // Gone with it: Close, Log another, View event, View planting, and the card's PreserveOffer host
  // (with the form live, both hosts would mount at once — spec §4.5; the form-body host below is
  // now the only one and covers every path).
  const showPostSaveStrip = inOverlay && !!confirmation

  // ── V4-HARVFORMORDER-001 (S4) — ONE definition per block, TWO orders ──
  // The form body used to be a single fixed sequence. Harvest needs a different one (Planting →
  // Quantity → Unit first, so the fast path needs no scroll), and every OTHER event type must keep
  // the shipped V4-LOGPHOTOFIRST-001 photo-first sequence byte-for-byte. Composing the body from
  // named blocks — rather than forking the JSX — makes that structural: there is exactly one Photo
  // block, one Notes block, etc., so the two orders can never silently diverge in CONTENT, only in
  // sequence. Each block below is the same element it was before, moved verbatim.
  const isHarvest = form.event_type === 'harvest'

          /* ── Photo — V4-LOGPHOTOFIRST-001 (BD-003, Dave 2026-08-04): "It should lead. Everything
               else will follow." This block used to sit second-from-last, between "Add details" and
               "When?". Only its POSITION moved — the picker, the staging semantics, the preview
               controls and the submit-time upload are byte-for-byte what they were.

               This is the SAME photo-first model Dave ruled on 2026-07-31 and shipped in v3.88.0 +
               v3.89.0, not a second one. That ruling's own rationale (PhotoLibrary.jsx:50-58) names
               THIS form as the reference implementation — "Log Event already works the other way
               round (pick photo -> then choose planting)" — because EventNew has always staged the
               File in local state (photoFile/photoPreview) and uploaded it inside handleSubmit
               rather than on pick. So the mechanics were already conformant and are deliberately
               untouched; the ordering was the last place the page still read attribute-then-photo.
               Matching PhotoLibrary's shipped block exactly: photo first, and NEVER gated on a
               target being chosen first.

               The label is the one behavioural change, and it serves BUG-SNAPATTACH-001 rather than
               diverging from it: for a `photo` event the submit gate already refuses to save without
               a photo, so "optional" was a lie told at the top of the form and only corrected by an
               error after Save. Same rule, said before the mistake instead of after — the shape
               PhotoLibrary uses for its own one-of-target rule. ── */
  const photoBlock = (
          <Section label={form.event_type === 'photo' ? 'Photo *' : 'Photo  ·  optional'}>
            {/* V4-PHOTOBULK-001 S2. ONE staged photo renders exactly as it always has — the same
                220px-max preview, the same absolutely-positioned remove and save-to-device controls.
                The strip below only differs at N > 1, where each item shrinks to a 96px tile so a
                handful fits without pushing the rest of the form off screen. The single case is the
                overwhelmingly common one and was not worth re-laying-out to serve the new one. */}
            {/* BUG-PHOTOSTAGEDREAD-001: picking copies the bytes now, so a multi-photo pick has a
                visible duration. Sits above the strip so it is the first thing that moves. */}
            {photoPreparing && (
              <p role="status" data-testid="eventnew-photo-preparing"
                 style={{ margin: `0 0 ${T.space.sm}px`, fontSize: T.type.sm, color: P.mid }}>
                Preparing {photoPreparing.done} of {photoPreparing.total}…
              </p>
            )}
            {photoItems.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {photoItems.map((item, idx) => {
                  const solo = photoItems.length === 1
                  return (
                    <div key={item.id} data-testid="eventnew-photo-item"
                         style={{ position: 'relative', display: 'inline-block' }}>
                      <img
                        src={item.url}
                        alt={solo ? 'Preview' : `Preview ${idx + 1} of ${photoItems.length}`}
                        style={solo
                          ? { maxWidth: '100%', maxHeight: 220, borderRadius: 8,
                              display: 'block', border: `1px solid ${P.border}` }
                          : { width: 96, height: 96, objectFit: 'cover', borderRadius: 8,
                              display: 'block', border: `1px solid ${P.border}` }}
                      />
                      <button
                        type="button"
                        onClick={() => (solo ? clearPhoto() : removePhotoItem(item.id))}
                        aria-label={solo ? 'Remove photo' : `Remove photo ${idx + 1}`}
                        style={{
                          position: 'absolute', top: solo ? 8 : 4, right: solo ? 8 : 4,
                          background: 'rgba(0,0,0,0.55)', color: P.white,
                          border: 'none', borderRadius: '50%',
                          width: solo ? 28 : 22, height: solo ? 28 : 22, cursor: 'pointer',
                          fontSize: '0.85rem',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      ><Icon name="action.remove" size={solo ? 14 : 11} decorative /></button>
                      {/* Save-to-device stays SOLO-ONLY: it is a per-file action, and six of them
                          tiled at 96px is six ways to mis-tap next to six removes. Flag-hidden
                          today anyway (SAVE_TO_DEVICE_HIDDEN). */}
                      {solo && !SAVE_TO_DEVICE_HIDDEN && <button
                        type="button"
                        onClick={() => saveFileToDevice(item.file)}
                        aria-label="Save photo to device"
                        style={{
                          position: 'absolute', bottom: 8, right: 8,
                          background: 'rgba(0,0,0,0.55)', color: P.white,
                          border: 'none', borderRadius: 8, padding: '5px 10px',
                          cursor: 'pointer', fontSize: '0.72rem', fontWeight: 600,
                        }}
                      >Save to device</button>}
                    </div>
                  )
                })}
                {/* "Add another" only exists in multi mode, and only while there is room. Its absence
                    is what makes flag-off byte-identical: one photo, one remove, no second door. */}
                {PHOTO_MULTI_ATTACH_ENABLED && photoItems.length < MAX_EVENT_PHOTOS && (
                  <button
                    type="button"
                    onClick={openPhotoPicker}
                    data-testid="eventnew-photo-add-more"
                    style={{
                      width: 96, height: 96, borderRadius: 8,
                      border: `2px dashed ${P.border}`, backgroundColor: P.white,
                      color: P.mid, cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600,
                      display: 'flex', flexDirection: 'column', alignItems: 'center',
                      justifyContent: 'center', gap: 4,
                    }}
                  >
                    <Icon name="media.camera" size={18} decorative />
                    <span>Add more</span>
                  </button>
                )}
                {/* The picker input lives here too — in the shipped layout it was rendered only in
                    the empty branch, so "Add another" would have had nothing to click. */}
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  multiple={PHOTO_MULTI_ATTACH_ENABLED ? true : undefined}
                  onChange={handlePhotoChange}
                  style={{ display: 'none' }}
                />
              </div>
            ) : (
              <div>
                {/* V4-HIDECAPTURE-001: one full-width Choose, no Take arm. The flex row is kept
                    (rather than collapsed to a bare button) so the dashed drop-target proportions
                    and the surrounding spacing are unchanged — this is a control removal, not a
                    re-layout of the photo step. */}
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    type="button"
                    onClick={openPhotoPicker}
                    style={{
                      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                      padding: '18px 12px',
                      border: `2px dashed ${P.border}`, borderRadius: 8,
                      cursor: 'pointer', backgroundColor: P.white,
                      color: P.mid, fontSize: '0.88rem', fontWeight: 600,
                    }}
                  >
                    {/* V4-ICON-001: media.camera is the registry's one "add a photo" affordance —
                        the same glyph ProjectDetail's uploaders adopted when they dropped the
                        camera/frame emoji pair (ProjectDetail.iconLanguage.test.js). */}
                    <Icon name="media.camera" size={20} decorative />
                    {/* Label deliberately UNCHANGED at "Choose photo" even though the picker now
                        accepts several. EventNew.harvestFormOrder.test.jsx:142 pins it with an exact
                        getByText, and copy that tells the user about multi-select is a design call
                        for the gate:design-review pass, not something to slip in under a build. */}
                    <span>Choose photo</span>
                  </button>
                </div>
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  multiple={PHOTO_MULTI_ATTACH_ENABLED ? true : undefined}
                  onChange={handlePhotoChange}
                  style={{ display: 'none' }}
                />
              </div>
            )}
          </Section>
  )

          /* ── Event type ── */
          /* V4-HARVSESSION-001: in session mode the type is LOCKED — the picker is how a mis-tap
             leaves harvest mid-burst, and the session exists to make that impossible. Exiting the
             session (back nav / plain /log) is the way to log another type. */
  const eventTypeBlock = inHarvestSession ? (
          <Section label="What happened? *">
            <div data-testid="harvest-session-lock" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.9rem', color: P.mid, fontWeight: 600 }}>
              {/* event.harvest, NOT nav.harvests: iconAnchors is explicit that the basket means
                  "picking" and the bowl means the browse surface. This lock is about the ACTION
                  every save in the session performs. */}
              <Icon name="event.harvest" size={20} decorative />
              <span>Weigh-in session — every save logs a harvest</span>
            </div>
          </Section>
  ) : (
          <Section label="What happened? *">
            {form.event_type === 'flag_issue' ? (
              <FlagModeFields
                severity={severity} onSeverity={setSeverity}
                issueChoice={issueChoice} onIssueChoice={setIssueChoice}
                issueOther={issueOther} onIssueOther={setIssueOther}
                voice={voice}
                onBack={() => setForm(f => ({ ...f, event_type: '' }))}
              />
            ) : (
              <>
                <EventTypePicker
                  value={form.event_type}
                  onChange={v => setForm(f => ({ ...f, event_type: v }))}
                />
                {/* V4-FLAG-001: dedicated entry into Flag mode (flag_issue is a free-text event
                    type, not a canonical glyphed tile — avoids the icon-completeness harness). */}
                <button type="button" onClick={() => setForm(f => ({ ...f, event_type: 'flag_issue' }))}
                  style={{ marginTop: 12, background: 'none', border: `1px solid ${P.terra}`, borderRadius: 8,
                    color: P.terra, fontWeight: 600, fontSize: '0.85rem', padding: '8px 14px', cursor: 'pointer',
                    /* BUG-DISCLOSURETAPSIZE-001: 36px measured — 8px padding either side of a
                       0.85rem line box. inline-flex honours minHeight, so the chip keeps its
                       hug-the-text width and only grows vertically. */
                    minHeight: T.tapMinHeight,
                    display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Icon name="action.flag" size={16} decorative />
                  <span>Flag an issue</span>
                </button>
              </>
            )}
          </Section>
  )

          /* ── V4-TREATLOG-001: Treatment details — directly below Event Type for pest/treatment events ── */
  const treatmentBlock = (
          (form.event_type === 'pest_treatment' || form.event_type === 'doctored') && (
            <TreatmentDetails value={treatment} onChange={setTreatment} inventory={inventory} eventType={form.event_type} />
          )
  )

          /* ── BUG-TREATMENTPRODUCT-001: fertilizing gets just the product-text slice of the same
               panel — no category chips (their enum is pest-flavored and wasn't asked for), no pest
               target, no inventory picker (ticket: no product database, free text only, same as
               `doctored` already captures). Same slot as treatmentBlock, directly below Event Type. ── */
  const fertilizingProductBlock = (
          form.event_type === 'fertilizing' && (
            <Section label="Product used (optional)">
              <Field label="Product" htmlFor="fert-product" optional help="e.g. Jack's 20-20-20, fish emulsion, compost tea">
                <Input
                  id="fert-product"
                  value={treatment.product_text}
                  onChange={e => setTreatment(t => ({ ...t, product_text: e.target.value }))}
                  placeholder="e.g. Jack's 20-20-20, fish emulsion, compost tea"
                />
              </Field>
            </Section>
          )
  )

          /* ── Notes ── */
  const notesField = (
            <div style={{ position: 'relative' }}>
              <Textarea
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                aria-label="Notes"
                style={{ height: 90, resize: 'vertical', paddingRight: 44 }}
                placeholder="Notes (optional — leave blank to save)"
              />
              <MicBtn
                fieldKey="notes"
                onResult={text => setForm(f => ({ ...f, notes: f.notes ? f.notes + ' ' + text : text }))}
                voice={voice}
                top="14px"
                transform="none"
              />
            </div>
  )
          /* Harvest layout only — already inside showHarvestMore's "Photo, notes & date" disclosure,
             so it keeps the plain Section and renders byte-identically to what shipped. */
  const notesBlock = (
          <Section label="Notes">
            {notesField}
          </Section>
  )

          /* ── V4-NOTESCOLLAPSE-001 — the non-harvest home for Notes: collapsed, at the end of the
               form, expandable on tap. Same disclosure grammar as "Add details" so the form has one
               vocabulary rather than two.

               OPEN is DERIVED (`showNotes || form.notes`), not plain state: collapsing must never
               hide text the user has already written, and a restored draft carrying notes must show
               them without a tap. The tap only ever opens something that was empty. ── */
  const notesOpen = showNotes || !!form.notes
  const notesDisclosureBlock = (
          <div style={{ backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: '12px 18px' }}>
            <button
              type="button"
              data-testid="notes-disclosure"
              onClick={() => setShowNotes(s => !s)}
              aria-expanded={notesOpen}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: P.mid, fontSize: '0.82rem', fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', padding: 0, minHeight: 44, width: '100%', display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <span aria-hidden="true">{notesOpen ? '▾' : '▸'}</span>
              <span>Notes  ·  optional</span>
            </button>
            {notesOpen && <div style={{ marginTop: 14 }}>{notesField}</div>}
          </div>
  )

          /* ── Project ── V4-PROJHIDE-001: hidden when projects are not a user-facing concept; the
               project_id is then derived from the chosen planting (or the default) instead of picked. ── */
  const projectBlock = (
          !PROJECTS_HIDDEN && (
          <Section label="Project *">
            <Select
              value={form.project_id}
              // BUG-PLANTMISMATCH-001: switching project MUST drop the planting, synchronously and
              // in the same state update. The plants list reloads asynchronously, so leaving the old
              // plant_id in place means the form spends the whole fetch window holding a planting
              // from project A under project B — and a fast Save inside that window POSTs the
              // mismatched pair. Clearing here also makes the picker's disabled/empty state honest
              // instead of showing a selection that is not in the list it is about to render.
              // Guarded on an actual change so re-selecting the same project is not a silent reset.
              onChange={e => setForm(f => (
                e.target.value === f.project_id ? f : { ...f, project_id: e.target.value, plant_id: '' }
              ))}
              aria-label="Project"
            >
              <option value="">— Select project —</option>
              <ProjectOptions projects={projects} />
            </Select>
            {projects.length === 0 && (
              <small style={{ color: P.terra, fontSize: '0.75rem', display: 'block', marginTop: 6 }}>
                No active projects — <Link to="/projects/new" style={{ color: P.terra }}>create one first</Link>.
              </small>
            )}
          </Section>
          )
  )

          /* ── Planting — V3-EVENT-005: ever-present, disabled until project chosen.
               V4-LOGTARGET-001: relabeled from "Plant / Group (optional)" and the affirmative
               "— All plants (project level) —" sentinel retired: the no-planting state must read
               as UNSET (a neutral placeholder), never as a deliberate project-level choice.
               No requiredness here — Lane 2 is defaulting + feedback only (Lane 3 owns gating).
               V4-PLANTPICKER-001: the shared searchable PlantingSelect replaces the raw select.
               Scope stays project-bound (plants fed from the load effect above, which owns the
               deep-link/sticky validation); PROJHIDE/Lane 3 flips this to the unscoped source. ── */
  /* Same frame-only flatten as the harvest panel, and the same reason: MEASURED, the Section card
     around the chooser is 110px for a 52px control. The design's budget prices track 1 at 52px, and
     58px of card chrome is the whole difference between the pads fitting and track 2 scrolling —
     which would reinstate, inside the frame, exactly the movement the frame exists to remove. */
  const plantingField = (
          <>
            <PlantingSelect
              plants={plantsForProject}
              value={form.plant_id}
              onChange={id => setForm(f => {
                // V4-PROJHIDE-001: derive the hidden project from the chosen planting (plant_id ⇒
                // project_id). Clearing the planting keeps the current/default project_id.
                if (!PROJECTS_HIDDEN) return { ...f, plant_id: id }
                const derived = id ? (plantsForProject.find(p => p.id === id)?.project_id ?? f.project_id) : f.project_id
                return { ...f, plant_id: id, project_id: derived }
              })}
              required={(PLANTING_REQUIRED_ENABLED || PROJECTS_HIDDEN) && requiresPlanting(form.event_type)}
              // BUG-LOGTARGETREQ-001: remembered planting as RANKING, never value — read at
              // picker-open (see handlePickerOpenChange). Only this site passes it.
              recentPlantId={recentPlantId}
              // V4-CROPFILTER-001: crop chips on the app's highest-frequency picker. Filter state
              // survives resetForNext within the mount, so a tomato burst taps the chip once.
              cropChips={CROP_CHIPS_AUTO}
              // V4-HARVFAB-001: the FAB harvest arrival opens the picker itself (see above).
              autoOpen={harvestFabAutoOpen}
              resetNonce={pickerResetNonce}
              loadFailed={plantsLoadFailed}
              onRetry={() => setPlantsReloadKey(k => k + 1)}
              disabled={PROJECTS_HIDDEN ? false : !form.project_id}
              disabledHint="— select a project first —"
              placeholder="— Choose a planting —"
              aria-label="Plant or group"
              data-testid="evtnew-planting"
              onOpenChange={handlePickerOpenChange}
            />
          </>
  )

  const plantingBlock = (
          sessionFrame
            ? <div id={PLANTING_SECTION_ID}>{plantingField}</div>
            : (
              <Section id={PLANTING_SECTION_ID} label={(PLANTING_REQUIRED_ENABLED || PROJECTS_HIDDEN) && requiresPlanting(form.event_type) ? 'Planting *' : 'Planting'}>
                {plantingField}
              </Section>
            )
  )

          /* ── V3-EVENTCONTSIZE-001: new-container capture for potting_up / transplant on a chosen planting ── */
  const containerBlock = (
          (form.event_type === 'potting_up' || form.event_type === 'transplant') && form.plant_id && (
            <Section label="New container (optional)">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <Field label="Pot / bag type" htmlFor="evt-ctype" optional>
                  <Select id="evt-ctype" value={container.type}
                    onChange={e => setContainer(c => ({ ...c, type: e.target.value }))}
                    options={PLANT_CONTAINER_TYPE_OPTIONS} />
                </Field>
                <Field label="Pot size" htmlFor="evt-csize" optional help="e.g. 3 gal, 5 L, 4 in">
                  <Input id="evt-csize" value={container.size}
                    onChange={e => setContainer(c => ({ ...c, size: e.target.value }))}
                    placeholder="e.g. 3 gal, 5 L, 4 in" />
                </Field>
              </div>
            </Section>
          )
  )

          /* ── V4-WATERMATH-001 F0: watering amount class (watering events only) ──
             Placed directly under the type picker, mirroring where <TreatmentDetails> sits for
             treatment types: a type-specific panel belongs beside the type that summons it, and
             this one must be visible WITHOUT scrolling on the fast path or it will not be used.
             It is never a gate — Normal is already selected, so Save works untouched. ── */
  const waterDepthBlock = (
          isWaterDepthType(form.event_type) && (
            <Section label="How much water">
              <WaterDepthChips
                value={waterDepth}
                onChange={(v) => { setWaterDepth(v); waterDepthTouchedRef.current = true }}
              />
              <p style={{ margin: '8px 0 0', color: P.mid, fontSize: '0.76rem' }}>
                Relative to what this plant needs — Normal is already picked.
              </p>
            </Section>
          )
  )

          /* ── V4-LOSSUI-001: plant-reduction capture (failed / given_away) ──
             REQUIRED, so it is a plain visible Section like Harvest * and What happened? *, NOT an
             EVENT_METADATA_FIELDS entry — that registry feeds the collapsed "More details"
             disclosure whose contract is that everything inside it is optional.

             POSITIONED AFTER the planting picker, which is where this diverges from
             TreatmentDetails and WaterDepthChips (both sit directly under the type picker). The
             question this panel asks is "how many of THESE did you lose", and it can only show the
             live count once a planting is chosen — same reason containerBlock above sits here. The
             panel itself does NOT gate on plant_id, though: hiding a required field until another
             field is filled is how a user reaches Save without knowing what is still missing.

             `remaining` is INFORMATION ONLY (see lib/plantReduction.js): the over-reduction refusal
             is the server's 409, never a client-side clamp. ── */
  const reductionBlock = (
          isPlantReductionEventType(form.event_type) && (
            <PlantReductionFields
              eventType={form.event_type}
              qty={reduction.qty}
              reason={reduction.reason}
              onQty={v => { setReduction(r => ({ ...r, qty: v })); if (reductionError) setReductionError(null) }}
              onReason={v => { setReduction(r => ({ ...r, reason: v })); if (reductionError) setReductionError(null) }}
              error={reductionError}
              remaining={
                form.plant_id
                  ? (plantsForProject.find(p => p.id === form.plant_id)?.quantity ?? null)
                  : null
              }
            />
          )
  )

          /* ── Tier 2: per-type metadata enrichment (collapsible) ── */
  const metadataBlock = (
          <MetadataSection
            eventType={form.event_type}
            metadataState={metadataState}
            onMetadataChange={handleMetadataChange}
          />
  )

          /* ── V1.2a-2 Wave 3: Harvest panel (harvest events only) ── */
  /* V4-WEIGHFRAME-001 — FLATTENED in the frame, and this is a fit requirement, not a taste call.
     MEASURED at a true 390x500 (tests/harness, iframe): the frame is 448px (500 − 52px TopChrome),
     track 3 is 49px, so the fields and their two pads get ~347px once the chooser is flattened too.
     The Section card charges 42px of header + 17px of footer for a title ("Harvest *") that is
     redundant on a surface whose entire purpose is one harvest — 59px, or a quarter of a number pad.
     `Section` is `components/FormSection.jsx`, which this lane does not own, so the frame swaps the
     WRAPPER rather than teaching Section a bare mode. The children are byte-identical either way,
     which is what keeps WeighInFrame.flagOff.test.jsx matching. The id stays on both so anything
     addressing HARVEST_SECTION_ID still resolves. */
  /* Hoisted so the frame can seat it in track 2's secondary region instead of between the weight pad
     and Save. Its own note says it "must never sit between the user and Save on the fast path"
     because it asks about 4 of 707 live picks — in the scrolling document that was satisfied by
     being last; in a fixed frame "last" IS the fast path, directly above Save. Same element either
     way, so the flag-OFF render is unchanged. */
  const dispositionBlock = (
              <HarvestDispositionChips
                value={harvest.disposition}
                onChange={v => setHarvest(h => ({ ...h, disposition: v }))}
              />
  )

  const harvestFields = (
            <>
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ flex: 2 }}>
                  <Field label="Quantity *" htmlFor="harvest-quantity">
                    {/* type=text is deliberate and stays: on Chrome Android an invalid intermediate
                        value in a type=number input makes .value return '', which would silently
                        defeat the MAX_PLAUSIBLE[unit] check in validateHarvest().
                        BUG-HARVNUMPADINPUT-001 (BD-063) RETIRES the session-conditional 'none' that
                        V4-WEIGHKBDNEXT-001 put here in v4.48.0, on Dave's instruction: "tapping the
                        field must raise a numeric keypad."
                        inputMode is a HINT. An Android IME that does not implement 'none' falls back
                        to the DEFAULT keyboard for type="text" — the full alphanumeric one. So on
                        Dave's device 'none' never suppressed a keyboard; it UPGRADED a numeric keypad
                        into an alphanumeric one. That is what he reported, the same day v4.48.0
                        shipped this line, and it also left Enter alive for him — a second reason Next
                        read as redundant, independent of the pad-onChange reason that retired it.
                        'numeric' not 'decimal' here: quantity is whole.
                        THE TRADE, stated not buried: 'none' bought ~301-344px of viewport whenever
                        the keyboard stayed down. That is given back on any tap of the field. It is
                        what Dave asked for — the pad is for when he does NOT tap the field — and
                        BD-055's wizard is where the height gets recovered properly. */}
                    <Input
                      id="harvest-quantity"
                      type="text"
                      inputMode={inHarvestSession ? 'numeric' : 'decimal'}
                      value={harvest.quantity}
                      onChange={e => {
                        setHarvest(h => ({ ...h, quantity: e.target.value }))
                        if (harvestError) setHarvestError(null)
                      }}
                      // V4-HARVSCROLLANCHOR-001 (BD-016): Dave's spec — on quantity focus, anchor
                      // the Harvest header + 1-6 chip row to the viewport top so quantity, weight,
                      // the error banner and Save stay co-visible above the keyboard. Fired on
                      // focus rather than after a resize listener so it lands BEFORE the browser's
                      // own scroll-focused-input-into-view: with the field already visible the
                      // browser has nothing left to correct, so there is no second competing scroll.
                      // V4-WEIGHFRAME-001: DELETED on the frame surface. Its whole job was to drag
                      // quantity, weight and Save into the space the keyboard leaves; the frame puts
                      // them there by construction, so firing it would move content for no reason —
                      // SC 3.2.2 On Input, layout changing as a direct consequence of entering a
                      // field. Measured contribution to the shipped round trip: +118px per entry.
                      onFocus={sessionFrame ? undefined : () => anchorSectionToTop(HARVEST_SECTION_ID)}
                      aria-label="Harvest quantity"
                      error={!!harvestError}
                      placeholder="e.g. 2.5"
                      // V4-HARVSESSION-002 (session only): Enter hops to weight instead of the
                      // form's default submit — the session loop is qty → grams → save, and an
                      // Enter-submit from qty would skip the weigh. Non-session harvest keeps the
                      // shipped Enter-saves-count-only behavior byte-identical.
                      enterKeyHint={inHarvestSession ? 'next' : undefined}
                      onKeyDown={inHarvestSession ? (e => {
                        if (e.key === 'Enter') { e.preventDefault(); document.getElementById('harvest-weight')?.focus() }
                      }) : undefined}
                    />
                  </Field>
                </div>
                <div style={{ flex: 1 }}>
                  <Field label="Unit" htmlFor="harvest-unit">
                    <Select
                      id="harvest-unit"
                      value={harvest.unit}
                      // BUG-LOGTARGETREQ-001: an explicit pick pins the unit — the per-crop
                      // re-seed effect must not override it while the target stays put.
                      // BUG-HARVUNITSTICKY-001: the pin is per-PLANTING, not per-entry — swapping
                      // to a different planting un-pins it and the unit re-seeds for the new crop.
                      onChange={e => { unitTouchedRef.current = true; setHarvest(h => ({ ...h, unit: e.target.value })) }}
                      aria-label="Harvest unit"
                      style={{ minHeight: 44, minWidth: 44 }}
                    >
                      {[...HARVEST_UNITS].sort((a, b) => a.localeCompare(b)).map(u => (
                        <option key={u} value={u}>{u}</option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </div>
              {/* V4-QUICKHITRANGE-001 (BD-047) — the 1-6 quick-pick chips became a digit BUILDER.
                  Supersedes V4-HARVQTYCHIPS-001's replace semantics. The single-digit fast path is
                  byte-identical in cost — one tap on '3' still yields '3', and that is 83.2% of
                  measured quantities. What changed is the tail: '13' was "tap the field, raise the
                  keyboard, type 1, type 3" and is now "tap 1, tap 3". BD-047 originally asked to
                  halve the buttons and extend the range to 20; ten keys cover every value instead,
                  and halving would have taken the keys under the 44px touch floor BD-047 itself
                  warned about. The field above is still untouched for anyone who wants to type.

                  Sits outside <Field> deliberately: Field's frozen contract takes EXACTLY ONE
                  focusable control and clones ARIA onto it (components/forms/Field.jsx), so a
                  key group inside it would trip contractWarn and steal the input's wiring.

                  BUG-HARVROWOVERFLOW-001 + BUG-HARVUNITVIS-001 — the pad is a FULL-WIDTH sibling
                  of the quantity/unit row, NOT nested in that row's flex:2 column. Nesting it made
                  both filed defects one defect: the grid's min-content (now 5*44 + 4*8 = 252px,
                  down from the 6-chip row's 304px) inside two-thirds of the row forced a 399px
                  min-content against a 390px viewport — the overlay Sheet scrolled sideways and the
                  page scaled down ~2.3% — and it put the unit <Select> beside the KEYS rather than
                  beside the quantity input, squeezing it to ~85px where the selected unit is not
                  legible. A wrong-unit harvest logs unnoticed, so that one is data integrity, not
                  polish. Full width keeps both fixed, with more headroom than before.

                  BELOW its field, not above (V4-WEIGHMOBILEVIEWPORT-001). It sat above only because
                  it inherited the slot V4-HARVQTYCHIPS-001's chip row vacated — no comment at
                  either render site ever argued for above-vs-below, and the one position decision on
                  this surface that WAS deliberate (6 columns, not 5) carries a measured
                  justification with coordinates. The weight pad, having no predecessor, was placed
                  fresh and chose below, so the panel shipped with two grammars for one control type.
                  Three reasons for unifying on below. (a) SEQUENCE: reading order runs quantity →
                  weight, so a pad below its own field sits between the field it serves and the one
                  that follows. (This argument was originally written about the `Next →` advance
                  control, removed in BD-063; the ordering it justifies is unaffected — the pad
                  still belongs after its field, which is what the tests below pin.) (b) The keys
                  Dave taps most per harvest drop 72px toward his thumb, for free — this is a
                  reorder, not a growth. (c) The focus anchor (anchorSectionToTop, below) exists to
                  keep quantity, weight, the error banner and Save co-visible; it used to spend its
                  first 104-160px on the pad before quantity appeared.
                  NOTE: MEASURED in tests/harness at a true 390x500 (iframe, not --window-size — macOS
                  Chrome floors a window at ~500px and CROPS rather than reflows, so a narrow window
                  measures a 500px layout), non-session, keyboard-open layout with quantity focused
                  and the section anchored. Before -> after: quantity input y161-200 -> y49-88; pad
                  bottom row y85-133 -> y157-205; weight input y239-278 and Save y440-488 BOTH
                  byte-identical (see the marginTop note below — that is what makes it a pure
                  reorder). Every bottom-row key returns ITSELF from elementFromPoint and true from
                  checkVisibility(), 235px clear of the sticky Save band — the risk this reorder had
                  to clear, since the non-session path keeps inputMode="decimal" and therefore really
                  does meet 390x500. offsetParent was NOT used: it reports both occluded content and
                  content-visibility:hidden content as visible. jsdom returns zero rects and can
                  falsify none of this. */}
              {/* marginTop:8 is NOT cosmetic — it makes this a PURE reorder. NumberPad carries
                  marginBottom:8; above the field that 8px was the pad→row gap, but below the field
                  it lands against the weight group's marginTop:14 and COLLAPSES into it (this
                  Section is block flow, not a flex column), so the naive move silently shortened the
                  panel by 8px and lifted everything under it. MEASURED, and it mattered: the weight
                  pad's bottom row rose y409-457 -> y403-451, and against the sticky Save band at
                  y384-432 (session, synthetic 390x500) that turned a 1px elementFromPoint clearance
                  into a 5px OCCLUSION — the band answered the hit test instead of the key. Restoring
                  the 8px puts every element below this pad back on its shipped coordinate, so the
                  diff moves the pad and nothing else.
                  The "1px elementFromPoint clearance" that note treats as the safe side of the line
                  is what BUG-WEIGHPADSAVEBAND-001 was filed about: 1px is not a margin, it is an
                  accident that happened to hold, and by this build it had become a 15px overlap
                  anyway (BD-063 dropped the quantity pad's Next row and lifted everything under it).
                  Both numbers are now moot — lib/saveBandLayout.js resolves the clearance against the
                  band as rendered, so a future edit here can move this pad without recomputing which
                  pixel it lands on.
                  All of the above is the SHIPPED (block-flow) path. The frame is a grid, not block
                  flow, so nothing collapses there and the 8 buys nothing — hence the conditional.
                  marginBottom (frame only, R1): this pad's own 8px was the LAST unspent padding in
                  the harvest row, and the harvest row is the only place the pad→Save gap can be
                  funded from — freeing height in track 1 or track 3 is absorbed by the 1fr
                  disclosure row instead of moving the pad. Cancelled here, spent below the weight
                  pad. Cost: the quantity pad now abuts the WEIGHT label, which is text and takes no
                  taps, so nothing mis-tappable moved closer to anything else. */}
              {/* Two whole style objects rather than one with conditional values, because a
                  `marginBottom: 0` on the rollback arm is not a no-op — it emits `margin-bottom: 0px`
                  into the inline style and broke both legacy byte fixtures. The frame arm's props
                  must not reach the arm that is the rollback lever. */}
              <div style={sessionFrame ? { marginTop: 0, marginBottom: -NUMBERPAD_MARGIN_BOTTOM_PX } : { marginTop: 8 }}>
                <NumberPad
                  value={harvest.quantity}
                  onChange={v => {
                    setHarvest(h => ({ ...h, quantity: v }))
                    if (harvestError) setHarvestError(null)
                  }}
                  idPrefix="qty-chip"
                  ariaLabel="Harvest quantity quick pick"
                  keyAriaPrefix="Harvest quantity"
                  // BUG-HARVNUMPADINPUT-001 (BD-063), Dave: hide "Next →" entirely, no replacement.
                  //
                  // BD-046 seated this button on the reasoning that inputMode="none" kills the Enter
                  // key, which was "the ONLY shipped mechanism for quantity → weight → save"
                  // (NumberPad.jsx:123-125). That premise is true about the KEYBOARD and false about
                  // this surface: each pad calls its own onChange directly (NumberPad.jsx:86), so the
                  // weight pad writes harvest.weight whether or not the weight field holds focus.
                  // Advancing was never required — the user taps the weight pad, then the sticky Save
                  // band that is already on screen. Verified in tests/harness, not reasoned: with this
                  // button gone, tapping wt-key digits still populates #harvest-weight.
                  //
                  // Removing the props rather than the capability: NumberPad still renders a primary
                  // when given one, for a future surface where the pad owns its own panel. Narrow
                  // fix — it never depended on which BD-055 redesign won.
                  //
                  // Side effect worth keeping: this pad drops its third row, 3 rows -> 2 (104px), so
                  // the in-session pads go 264px -> ~208px and the panel gets ~56px back on a surface
                  // whose whole problem is height.
                />
              </div>
              {/* ── V4-HARVDUAL-001 Slice B: optional weight, alongside the count ──
                  Deliberately SECONDARY to quantity: smaller label, no asterisk, blank by default,
                  and never blocking a save. The count-only path above is the fast path and stays
                  exactly as it was — this row is for when the bowl happens to be near the scale.
                  Its payoff is disproportionate to its size: a count AND a weight together is a
                  per-variety calibration sample, which is what retires the estimated weights. */}
              {/* R1 — paddingBottom, NOT marginBottom, and the difference is load-bearing. This
                  group is the last child of `#harvest-section`, which has no padding or border of
                  its own, so a bottom MARGIN here collapses straight out of the block and lands on
                  the grid item instead of growing it: the pad would not move and the gate would read
                  the same 1px. Padding cannot collapse, and it also stops the pad's own 8px margin
                  collapsing out — so the space below the pad is `8 + this`, which is why this is
                  FRAME_PAD_GAP_PX minus that 8 rather than the gap itself.
                  marginTop 2 -> 0 and the label's marginBottom 2 -> 0 are the other 2px of the
                  10 this row gives up; see the accounting in lib/saveBandLayout.js. */}
              <div style={sessionFrame ? { marginTop: 0, paddingBottom: FRAME_PAD_GAP_PX - NUMBERPAD_MARGIN_BOTTOM_PX } : { marginTop: 14 }}>
                <label
                  htmlFor="harvest-weight"
                  style={{ display: 'block', fontSize: '0.74rem', fontWeight: 700, color: P.light, marginBottom: sessionFrame ? 0 : 6, letterSpacing: '0.3px', textTransform: 'uppercase' }}
                >
                  Weight  ·  optional
                </label>
                <div style={{ display: 'flex', gap: 10 }}>
                  <div style={{ flex: 2 }}>
                    <Input
                      id="harvest-weight"
                      type="text"
                      // BUG-HARVNUMPADINPUT-001 (BD-063): 'decimal' unconditionally. THIS is the
                      // field Dave reported, and the reason the old comment gave for the session
                      // branch — "this is the field that was raising the keyboard at all" — is
                      // exactly why 'none' hurt most here. 'decimal' not 'numeric': grams take a
                      // point. NOT readOnly, which would suppress the keyboard on every IME but kill
                      // the enterKeyHint + Enter-to-save immediately below, since that handler is
                      // only reachable while a keyboard is up.
                      inputMode="decimal"
                      // V4-HARVSESSION-002 (session only): grams → Enter IS the save. Explicit
                      // handler, NOT the form's implicit submission: Save is type="button", and a
                      // multi-input form with no submit button gets no implicit Enter submission,
                      // so without this the Enter key would be dead here.
                      enterKeyHint={inHarvestSession ? 'done' : undefined}
                      onKeyDown={inHarvestSession ? (e => {
                        if (e.key === 'Enter') handleSubmit(e, { keepMode: 'type' })
                      }) : undefined}
                      // BUG-WEIGHPADSAVEBAND-001 — focusing this field is the moment the weigh-in
                      // commits to the keypad below, and on Android that is also the moment the
                      // keyboard shrinks the layout viewport to ~500px and drops the pad's bottom
                      // row into the band. Clear it here rather than on quantity focus: see the
                      // note in lib/saveBandLayout.js for why the anchor is left alone.
                      // !sessionFrame (OPS-SIBLINGLANESEMANTICMERGE-001). lane-weighband added this
                      // call and lane-frame branched from the same base, so neither could see the
                      // other and git merged them clean with no conflict here.
                      // MEASURED, not assumed — and the measurement corrected the expectation.
                      // Removing this predicate changes NOTHING today: the frame renders no
                      // `[data-testid="save-sticky"]` (the band lives in the !sessionFrame arm), so
                      // clearWeightPadOfSaveBand returns 0 at its own `if (!pad || !band)` line
                      // before it touches a scroller. Mutation-tested at 390x500 with the flag on —
                      // guarded and unguarded were identical: padTravel 3/0/0/0 across four entries.
                      // It is kept because that inertness is ACCIDENTAL: it rests on a null-check in
                      // another file, written for the picker-suppression case, that nothing states
                      // or tests as a frame guarantee. The day track 3 takes the `save-sticky`
                      // testid — it is the save band on that surface, and gates key off that name —
                      // the clearance starts firing inside the frame with nothing to catch it.
                      onFocus={inHarvestSession && !sessionFrame ? (() => clearWeightPadOfSaveBand()) : undefined}
                      value={harvest.weight}
                      onChange={e => {
                        setHarvest(h => ({ ...h, weight: e.target.value }))
                        if (harvestError) setHarvestError(null)
                      }}
                      aria-label="Harvest weight"
                      error={!!harvestError}
                      placeholder="e.g. 337"
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <Select
                      value={harvest.weight_unit}
                      onChange={e => setHarvest(h => ({ ...h, weight_unit: e.target.value }))}
                      aria-label="Harvest weight unit"
                      style={{ minHeight: 44, minWidth: 44 }}
                    >
                      {WEIGHT_UNITS.map(u => (
                        <option key={u} value={u}>{u}</option>
                      ))}
                    </Select>
                  </div>
                </div>
                {/* V4-WEIGHKBDNEXT-001 (BD-046) — SESSION ONLY, unlike the quantity pad above.
                    Outside the session weight is the secondary, mostly-skipped field (see the
                    V4-HARVDUAL-001 note above), and a second three-row pad there would cost the
                    common path ~160px to serve the exception. Inside the session it is the field
                    the keyboard was actually being raised for, so it is exactly where the pad pays.
                    NOTE: Viewport arithmetic, MEASURED in tests/harness at 390x844 (not estimated —
                    jsdom returns zeros): each pad is 320x160, so both together add 320px against
                    the ~301-344px of keyboard removed. That is roughly a WASH on height, NOT the
                    ~+50px net win the design doc quotes — that figure assumed one pad per wizard
                    step. The win here is that the keyboard never appears and 13 costs two taps,
                    not that the panel got shorter. Same run: Save sits at bottom 776 against an
                    844 viewport, so it stays above the fold with both pads up, and exactly one
                    control on the surface says "Save". Slice C (the wizard) is what would collapse
                    this to one pad on screen at a time and recover the height. */}
                {/* NumberPad carries its own `marginBottom: 8`. On the shipped path that is the gap
                    to the helper line below it. In the frame this pad is the LAST thing above track
                    3, and as of R1 that 8px is no longer dead space nor cancelled — it is the first
                    8 of FRAME_PAD_GAP_PX, which is why the group's paddingBottom above is the gap
                    MINUS it. Getting that wrong in either direction is a silent 8px, so the gate
                    measures the rendered result rather than trusting this arithmetic. */}
                {inHarvestSession && (
                  <NumberPad
                    value={harvest.weight}
                    onChange={v => {
                      setHarvest(h => ({ ...h, weight: v }))
                      if (harvestError) setHarvestError(null)
                      // BUG-WEIGHPADSAVEBAND-001 — the second trigger, and the one that matters when
                      // the keyboard never comes up: the pad writes the field directly, so a
                      // pad-only weigh-in never focuses #harvest-weight and would never reach the
                      // handler above. The FIRST key press is always from a row that is clear (the
                      // band's top edge cuts the pad's LAST row), so this fires before backspace — the one
                      // key the pad's own header calls mandatory — is needed.
                      // !sessionFrame — same reasoning, and the same measurement, as the onFocus
                      // site above (OPS-SIBLINGLANESEMANTICMERGE-001). This is the worse of the two
                      // to leave coupled: it runs on EVERY key press, so if the frame ever does
                      // render a save-sticky this would re-scroll under the thumb once per digit.
                      if (!sessionFrame) clearWeightPadOfSaveBand()
                    }}
                    idPrefix="wt-key"
                    ariaLabel="Harvest weight keypad"
                    keyAriaPrefix="Harvest weight"
                    // NO primary button here, deliberately — and as of BD-063 neither pad has one.
                    // The sticky Save band (below, position:sticky) is already on screen and already
                    // does this job; a second Save on the pad would be two controls doing one job,
                    // the same defect BD-036b removed from the Today row, reintroduced one screen
                    // over. Exactly one control on this surface says "Save".
                  />
                )}
                {/* 21px of instruction the frame does not spend. It teaches the count/weight
                    relationship, which is worth saying on the general log form; inside a weigh-in
                    session the user has already learned it by the second entry, and 21px is a fifth
                    of a number pad. */}
                {!sessionFrame && (
                <div style={{ marginTop: 5, fontSize: '0.72rem', color: P.light, lineHeight: 1.4 }}>
                  Weigh the whole pick — the count above says how many that was.
                </div>
                )}
              </div>

              {harvestError && (
                <div role="alert" style={{ marginTop: 6, fontSize: '0.78rem', color: P.terra, fontWeight: 600 }}>{harvestError}</div>
              )}

              {/* V4-HIDEQUALITY-001: hidden by flag, not deleted — see featureFlags.js. With the
                  control gone, harvest.quality_rating stays at its null default and the POST body
                  still carries the key, so the server contract is unchanged. */}
              {!HARVEST_QUALITY_HIDDEN && (
              <div style={{ marginTop: 16 }}>
                <label style={{ display: 'block', fontSize: '0.74rem', fontWeight: 700, color: P.light, marginBottom: 6, letterSpacing: '0.3px', textTransform: 'uppercase' }}>
                  Quality  ·  optional
                </label>
                <div role="radiogroup" aria-label="Harvest quality" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {[1, 2, 3, 4, 5].map(n => (
                    <label key={n} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.85rem', color: P.mid }}>
                      <input
                        type="radio"
                        name="harvest-quality"
                        value={n}
                        checked={harvest.quality_rating === n}
                        onChange={() => setHarvest(h => ({ ...h, quality_rating: n }))}
                        style={{ width: 16, height: 16, cursor: 'pointer' }}
                      />
                      <span>{n} = {HARVEST_QUALITY_LABELS[n]}</span>
                    </label>
                  ))}
                </div>
                {harvest.quality_rating != null && (
                  <button
                    type="button"
                    onClick={() => setHarvest(h => ({ ...h, quality_rating: null }))}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: P.light, fontSize: '0.78rem', padding: '6px 0 0', textDecoration: 'underline' }}
                  >
                    Clear quality
                  </button>
                )}
              </div>
              )}

              {/* V4-HARVDISPOSITION-001 — LAST in the panel, and collapsed, on purpose. It asks
                  about the exception (4 of 707 live picks), so it must never sit between the user
                  and Save on the fast path. Not gated by HARVEST_QUALITY_HIDDEN: quality rates a
                  good pick 1-5, this records that a pick went wrong — different questions, and the
                  flag that retired one says nothing about the other. */}
              {!sessionFrame && dispositionBlock}
            </>
  )

  /* The wrapper swap, done as a plain conditional rather than two little components. Declaring a
     component INSIDE render gives it a new identity on every pass, so React unmounts and remounts
     the whole subtree each time — which silently reset the pads' and picker's state. The flag-OFF
     byte fixture is what caught it; a testid census would not have. */
  const harvestBlock = (
          form.event_type === 'harvest' && (
            sessionFrame
              ? <div id={HARVEST_SECTION_ID}>{harvestFields}</div>
              : <Section id={HARVEST_SECTION_ID} label="Harvest *">{harvestFields}</Section>
          )
  )

          /* ── V3-EVENT-008 §8: "Add details" — collapsible home for the three
               low-frequency fields (Quantity / Visibility / Private notes). Default
               collapsed (feature-flagged) to declutter the common path; fully reachable.
               Harvest quantity is a SEPARATE field in the Harvest panel and stays visible. ── */
  const addDetailsBlock = (
          <div style={{ backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: '12px 18px' }}>
            <button
              type="button"
              onClick={() => setShowAddDetails(s => !s)}
              aria-expanded={showAddDetails}
              /* BUG-DISCLOSURETAPSIZE-001: measured 16px tall at 390x844 — the shortest tap target
                 on the surface, and the one gating three fields. `padding: 0` with a 0.82rem line
                 box is the whole cause. minHeight alone (no added padding) grows the collapsed card
                 40 -> 44px and leaves the label's baseline where it was, so nothing else moves. */
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: P.mid, fontSize: '0.82rem', fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', padding: 0, minHeight: T.tapMinHeight, display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <span aria-hidden="true">{showAddDetails ? '▾' : '▸'}</span>
              <span>Add details  ·  optional</span>
            </button>

            {showAddDetails && (
              <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 16 }}>
                {/* Quantity (hidden for harvest — superseded by the harvest panel) */}
                {form.event_type !== 'harvest' && (
                  <div>
                    <label style={{ display: 'block', fontSize: '0.74rem', fontWeight: 700, color: P.light, marginBottom: 6, letterSpacing: '0.3px', textTransform: 'uppercase' }}>
                      Quantity  ·  optional
                    </label>
                    <div style={{ position: 'relative' }}>
                      <Input
                        value={form.quantity}
                        onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))}
                        aria-label="Quantity"
                        style={{ paddingRight: 44 }}
                        placeholder="e.g. 3 plants, 500ml, 1 tray"
                      />
                      <MicBtn
                        fieldKey="quantity"
                        onResult={text => setForm(f => ({ ...f, quantity: text }))}
                        voice={voice}
                      />
                    </div>
                  </div>
                )}

                {/* V4-PUBHIDE-001: is_public toggle removed. */}

                {/* Private notes (collapsible) */}
                <div>
                  <button
                    type="button"
                    onClick={() => setShowPrivate(s => !s)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: P.light, fontSize: '0.82rem', padding: 0, display: 'flex', alignItems: 'center', gap: 6 }}
                  >
                    <span>{showPrivate ? '▾' : '▸'}</span>
                    <span>Private notes  ·  never shown publicly</span>
                  </button>
                  {showPrivate && (
                    <div style={{ position: 'relative', marginTop: 10 }}>
                      <Textarea
                        value={form.private_notes}
                        onChange={e => setForm(f => ({ ...f, private_notes: e.target.value }))}
                        aria-label="Private notes"
                        style={{ height: 72, resize: 'vertical', paddingRight: 44 }}
                        placeholder="Dosage, concerns, anomalies — internal only"
                      />
                      <MicBtn
                        fieldKey="private_notes"
                        onResult={text => setForm(f => ({ ...f, private_notes: f.private_notes ? f.private_notes + ' ' + text : text }))}
                        voice={voice}
                        top="12px"
                        transform="none"
                      />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
  )

          /* ── Date / time ── */
  const whenBlock = (
          <Section label="When?">
            {/* V4-EVENTSEL-005 — ONE When control across Log Event and Log Many, and it is
                `type="date"`, NOT `datetime-local`.

                The row's original note said homogenize ON datetime-local. That direction was
                falsified by the submit path: line ~987 does `form.event_date.split('T')[0]` and
                sends the DATE ONLY. The time this picker collected was never transmitted — the
                server then re-synthesizes one, `normalizeEventDate()` turning a bare YYYY-MM-DD
                into `T12:00:00Z`. That is the origin of the noon-UTC placeholder sitting on 545 of
                577 harvests: a control that asked for a time, dropped it, and had a fake one
                stamped back on. Homogenizing Log Many onto this control would have spread that.

                So the two surfaces converge on the honest control instead. Nothing is lost — no
                user-entered time ever reached the database from here. Restoring real times is a
                server change (the batch/single INSERT plus an offset-aware parse) and is not this
                row's work; when it happens, BOTH surfaces move together from one component.

                `.slice(0, 10)` is not cosmetic: stashed drafts written by earlier builds hold a
                datetime-local string (`2026-08-01T10:00`), and an <input type="date"> renders a
                value in that shape as EMPTY. Slicing keeps a restored draft's date visible. The
                submit-side `.split('T')[0]` already tolerates both shapes. */}
            <Input
              type="date"
              value={form.event_date.slice(0, 10)}
              onChange={e => setForm(f => ({ ...f, event_date: e.target.value }))}
              aria-label="Event date"
            />
          </Section>
  )

  /* ── Photo moved to the TOP of the form — V4-LOGPHOTOFIRST-001 (BD-003). ── */
  /* ── Visibility + Private notes moved into "Add details" above (V3-EVENT-008 §8) ── */

  /* ── The "Photo, notes & date" disclosure. Hoisted out of the harvest branch's inline JSX ONLY so
        the frame can put it in a different track; the element it produces is unchanged, which is
        what lets WeighInFrame.flagOff.test.jsx still match byte-for-byte. `showHarvestMore` is
        deliberately never cleared by resetForNext — that non-reset is what makes entries 2..N
        toll-free for the 1-in-5 photo path, and moving this must not disturb it. ── */
  const frameSecondaryBlock = (
              <div style={{ backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: '12px 18px' }}>
                <button
                  type="button"
                  onClick={() => setShowHarvestMore(s => !s)}
                  aria-expanded={showHarvestMore}
                  data-testid="harvest-more-toggle"
                  /* BUG-DISCLOSURETAPSIZE-001: 24px measured. Safe inside the frame's budget —
                     this control sits in track 2's `1fr` sponge row (see lib/saveBandLayout.js on
                     where the frame's pixels come from), so height added here is absorbed by the
                     sponge and does not move the weight pad relative to Save. */
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: P.mid, fontSize: '0.82rem', fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', padding: 0, minHeight: T.tapMinHeight, display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <span aria-hidden="true">{showHarvestMore ? '▾' : '▸'}</span>
                  {/* V4-WEIGHDATEREACH-001: the label drops "date" IN THE FRAME ONLY, because in the
                      frame the date is no longer in here — it is in track 1. Two date controls on one
                      surface is how a user ends up setting one and being overridden by the other. */}
                  <span>{sessionFrame ? 'Photo & notes  ·  optional' : 'Photo, notes & date  ·  optional'}</span>
                </button>
                {showHarvestMore && (
                  <div data-testid="harvest-more-body" style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {photoBlock}
                    {notesBlock}
                    {metadataBlock}
                    {!sessionFrame && whenBlock}
                  </div>
                )}
              </div>
  )

  /* ── V4-WEIGHFRAME-001 TRACK 3 — the one-line ledger + Save row, permanently 48px ──────────────
     Dave chose one line explicitly, and the trade is worth stating plainly: a fixed frame and a
     three-row always-visible ledger do not both fit (500 − 52 chooser − 48 Save − 144 three-row
     ledger = 256px against 312px of fields and pads). This buys the frame and keeps every job he
     named for the ledger:
       verify what I just entered → the summary NAMES the last row and is always visible;
       undo                       → one dedicated control, always in the same place, never moving,
                                     unlike today's three 22px buttons that shuffle as rows append;
       recent history             → tap the summary, get the last 10 rows. This is the FIRST build
                                     in which that exists at all — the shipped `+N earlier` line is a
                                     bare <div> with no handler, announcing rows it cannot reach.
     Band growth (48 → 128 → 156 → 184 → 202px across four saves) disappears: this row is 48px at
     every N INCLUDING zero, so it never appears, grows or shifts. ── */
  /* V4-WEIGHLEDGERLAST-001 — Dave directive 2026-08-26, verbatim: "The session count/totals are
     confusing because all I want to see there is the last thing logged so I can verify it is
     correct… Remove the session totals." So the running count and running weight are GONE from this
     row. They were not merely noise: they were consuming the horizontal budget that the thing Dave
     actually reads — the entry he just logged — needed in order to be legible at all.

     The second half of the same complaint is a LAYOUT fact, not a content one: "the save button is
     over the right side of that widget, so I never see the rest of whatever specific thing was just
     logged." Save is 150px and Undo 44px on a 358px content box, so this label has ~178px however
     little it says — one `nowrap` line of ~28 characters. "Today · Cherokee Purple · 3 lb · 412 g"
     is ~38, so dropping the totals ALONE would still have ellipsed the numbers off the right edge,
     which is precisely the half of the entry he is checking. Hence TWO lines inside the same 48px
     track (16px + 14px = 30px, centred, and the track does NOT grow — measured at 390x500 after a
     save: track 3 scrollHeight 48 === clientHeight 48): the identity line ellipses if the plant name
     is long, the measurement line does not. Nothing new is added to the row — this is the same
     control, the same tap target, the same drawer.

     `qty` AND `grams` both render, where the shipped label showed grams OR count. Dave asked for
     "planting name, count, and weight" — they are different facts (12 fruit weighing 412 g), and the
     one he is verifying against the scale is the one the old label dropped whenever a count existed. */
  const frameLedger = (() => {
    const live = sessionRows.filter(r => !r.undone)
    const last = live[live.length - 1] || null
    const qtyPart = last && last.qty !== '' && last.qty != null ? `${last.qty}${last.unit ? ` ${last.unit}` : ''}` : ''
    const gramPart = last && last.grams != null ? `${last.grams} g` : ''
    const measureLabel = [qtyPart, gramPart].filter(Boolean).join('  ·  ')
    const dateLabel = last ? shortDateLabel(last.date) : ''
    const identityLabel = last ? [dateLabel, last.plantName].filter(Boolean).join('  ·  ') : ''
    // Retained for the Undo button's accessible name and the drawer toggle's, where a single flat
    // string is required and there is no width constraint.
    const lastLabel = last
      ? [dateLabel, last.plantName, measureLabel].filter(Boolean).join(' ')
      : 'nothing logged yet'
    return { live, last, identityLabel, measureLabel, lastLabel }
  })()

  /* V4-WEIGHDATEREACH-001 — Dave directive 2026-08-26, verbatim: "pull the date out of a collapsed
     section and find a way to get it into the viewport without scrolling. I only use it SOMETIMES
     (rarely) but when I need to log yesterday's session instead of today, it is a major PITA to
     change that date where it is."

     WHERE, and why it is not free-floating: the date lands in TRACK 1, beside the chooser, because
     track 1 is `auto`-height and already 52px tall for the chooser alone — so a 44px control placed
     BESIDE it costs the frame ZERO vertical pixels. Track 2 has zero slack (347/347 measured), and
     anything above the tracks comes straight out of it, so a header row or its own track would have
     re-created the very defect V4-WEIGHFRAME-001 fixed. Horizontal space is what this surface has.

     WHAT it renders: "Today" / "Yesterday" / "Aug 24", not `08/24/2026`. A native date input is ~100px
     of unreadable-at-a-glance chrome; the whole job here is that Dave can SEE at a glance which day
     the next save lands on, and act only in the rare case it is wrong. The real <input type="date">
     is still the interactive element — transparent, filling the control, opening the system picker on
     one tap — so no custom picker is introduced and Android's native affordance is preserved. */
  const frameDateLabel = shortDateLabel(form.event_date)
  const frameDateIsToday = form.event_date.slice(0, 10) === todayLocalISO()
  const frameDateControl = (
    <div
      style={{
        position: 'relative', flexShrink: 0, minHeight: 44, minWidth: 76,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: 8, padding: '0 10px',
        // A date that is NOT today is the state worth seeing from across the kitchen — it means the
        // next save is being filed under another day. Same channel the chip uses for its text.
        border: `1px solid ${frameDateIsToday ? P.border : P.green}`,
        backgroundColor: frameDateIsToday ? P.white : P.greenPale,
        outline: frameDateFocused ? `2px solid ${P.green}` : 'none',
        outlineOffset: 2,
      }}
    >
      <span aria-hidden="true" style={{
        fontSize: '0.82rem', fontWeight: 700, whiteSpace: 'nowrap',
        color: frameDateIsToday ? P.mid : P.green, fontFamily: 'inherit',
      }}>
        {frameDateLabel}
      </span>
      <input
        type="date"
        data-testid="weigh-frame-date"
        value={form.event_date.slice(0, 10)}
        onChange={e => setForm(f => ({ ...f, event_date: e.target.value }))}
        onFocus={() => setFrameDateFocused(true)}
        onBlur={() => setFrameDateFocused(false)}
        aria-label={`Event date — ${frameDateLabel}`}
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%',
          opacity: 0, border: 'none', padding: 0, margin: 0, background: 'transparent',
          fontFamily: 'inherit', cursor: 'pointer',
        }}
      />
    </div>
  )

  /* V4-WEIGHSESSIONCLOSE-001 — Dave directive 2026-08-26, verbatim: "close button". The frame
     suppresses BottomNav for the session's whole duration and drops the breadcrumb + `Log an event`
     heading, so from inside a weigh-in the ONLY exits were the browser's own Back and TopChrome's
     back affordance — neither of which reads as "I am finished with this sitting."
     Destination: back where the session was entered from, which is TopChrome's harvest circle (any
     content page) or the Harvests CTA. `history.state.idx` is React Router's own in-app history
     counter, so `> 0` means there IS an app entry to return to; a cold start (PWA shortcut, a shared
     link) has idx 0 and would otherwise leave the browser, hence the explicit /harvests fallback.
     The unsaved-input guard reuses `hasUnsavedInput` — the SAME predicate the backdrop guard and the
     service-worker reload gate use — rather than a second one, because a close control that silently
     discards a weight already typed onto the scale is the one way this button could do harm. */
  const frameCloseButton = (
    <button
      type="button"
      data-testid="weigh-frame-close"
      aria-label="Close weigh-in session"
      onClick={() => {
        if (hasUnsavedInput && !window.confirm('Close the weigh-in? The entry you have typed will not be saved.')) return
        const idx = window.history.state?.idx
        if (typeof idx === 'number' && idx > 0) navigate(-1)
        else navigate('/harvests')
      }}
      style={{
        flexShrink: 0, minHeight: 44, minWidth: 44, padding: 0,
        background: 'none', border: `1px solid ${P.border}`, borderRadius: 8,
        color: P.mid, fontSize: '1rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
      }}
    >
      <Icon name="action.close" size={16} decorative />
    </button>
  )

  const frameLedgerBlock = (
    <div
      data-testid="weigh-frame-track3"
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        height: FRAME_LEDGER_PX,
        // BUG-SAVEBANDDEADINSET-001 is structurally absent here rather than fixed: this is a real
        // grid track, so it has no `bottom` inset to desync from `--bottom-nav-height` in the first
        // place. The frame also hides BottomNav outright for the session's duration, so there is no
        // nav to clear. The static SAVE_BAND_BOTTOM_INSET_PX class of bug cannot recur on this row.
        paddingBottom: 'env(safe-area-inset-bottom)',
        boxSizing: 'content-box',
        // Opaque: this row sits at the bottom of a non-scrolling frame with the weight pad directly
        // above it, so it must read as a distinct surface rather than floating transparently over
        // content. The transparent shipped band is what produced the measured 178x48 dead zone.
        backgroundColor: P.cream,
        borderTop: `1px solid ${P.border}`,
        // Same V4-PICKERUX-001 suppression as the shipped band, and for the same reason: a listbox
        // opening downward can still reach this row. `visibility` does not reflow, so unlike
        // `display:none` it cannot collapse the track and move the two above it.
        visibility: pickerOpen ? 'hidden' : 'visible',
        pointerEvents: pickerOpen ? 'none' : 'auto',
      }}
    >
      {orderByThumb(hand,
        /* under the thumb — Save. MIRRORS: measured, Save's right half is in the left-thumb
           HARD/DEAD zone, and it is the control pressed once per entry. */
        <Button
          key="save"
          type="button"
          variant="primary"
          loading={saving}
          loadingLabel={
            photoUploader.stage === 'preparing' ? 'Preparing photo…' :
            photoUploader.stage === 'uploading' ? (typeof photoUploader.progress === 'number' ? `Uploading photo… ${photoUploader.progress}%` : 'Uploading photo…') :
            photoUploader.stage === 'saving' ? 'Saving photo…' :
            'Saving…'
          }
          onClick={e => handleSubmit(e, { keepMode: 'type' })}
          // R1 — 44 rather than the primitive's frozen 48, and it is 4 of the 20px of clearance
          // above. Track 3 is `alignItems: center` on a 48px content box, so a 48px Save fills it
          // and its hit area starts 1px under the pad's bottom row; at 44 the top 4px of the track
          // are the container itself, which paints the same and takes no clicks. Bought for a
          // control that is 44x150 — still clear of the 44px WCAG 2.5.5 floor, and MEASURED it moves
          // Save's centre DOWN 2px while the pad rises 15px, so the aim-high error margin improves
          // too (nearest key-bottom to Save-centre: 25px -> 42px). The padding is respelled because
          // buttonChrome's `13px 30px` would otherwise exceed a 44px box.
          // alignSelf is half the point and was MEASURED, not assumed: this row is
          // `alignItems: center`, so a 44px Save centres at y402-446 and splits the 4px into 2px
          // above and 2px below — 18px of clearance, and 2px wasted under a button whose bottom edge
          // is the frame's. flex-end puts all four above, where the hazard is.
          style={{ minWidth: 150, flexShrink: 0, minHeight: FRAME_SAVE_HEIGHT_PX, height: FRAME_SAVE_HEIGHT_PX, padding: '11px 30px', alignSelf: 'flex-end' }}
        >
          Save
        </Button>,
        /* far side — the undo + summary group. The summary takes the flexible middle either way, so
           mirroring moves Undo from row-start to row-end without the ellipsis changing sides. */
        <div key="ledger" style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
          {orderByThumb(hand,
            /* Undo is DELIBERATELY on the offhand side of its own group: it is destructive, it is
               pressed rarely, and the measured shipped defect is Undo sitting within one thumb-arc
               of Save. Splitting them to opposite ends of a 48px row is the largest separation this
               row can offer. Disambiguated accessible name — the shipped strip gives all three of
               its Undo buttons the identical label, which over a 17-planting sitting means two or
               three indistinguishable destructive controls. */
            <button
              key="summary"
              type="button"
              data-testid="weigh-frame-log-toggle"
              onClick={() => setFrameLogOpen(o => !o)}
              aria-expanded={frameLogOpen}
              aria-controls="weigh-frame-log"
              disabled={frameLedger.live.length === 0}
              style={{
                flex: 1, minWidth: 0, textAlign: hand === 'left' ? 'right' : 'left',
                background: 'none', border: 'none', padding: 0, cursor: frameLedger.live.length ? 'pointer' : 'default',
                // P.mid, NOT P.light: `#777` on white measures 4.48:1, under the 4.5:1 AA floor at
                // this size. That failure is live today on the `+N earlier` line this replaces.
                color: P.mid, fontFamily: 'inherit',
                // The two lines are block children, so the button itself must not be a nowrap box.
                // NO `overflow: hidden` here, and that is measured rather than tidy: with it, the
                // button's content box came back scrollHeight 30 / clientHeight 29 at 390x500 and
                // clipped 1px off the bottom of the measurement line's descenders. Each span clips
                // ITSELF horizontally, so the button never needed to.
                display: 'block',
              }}
            >
              {frameLedger.last ? (
                <>
                  {/* identity — ellipses under a long plant name, which is the SAFE thing to lose:
                      the name is also on the chooser one track up, the numbers are nowhere else. */}
                  <span style={{
                    display: 'block', fontSize: '0.85rem', fontWeight: 600, lineHeight: '16px',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {frameLedger.identityLabel}
                  </span>
                  {/* measurement — the line Dave is verifying against the scale. Never truncated. */}
                  {/* 14px line-height, not 13: MEASURED at 390x500, the descenders of "g" overran a
                      13px box by 1px (the button reported scrollHeight 30 / clientHeight 29).
                      16 + 14 = 30px inside a 48px track — still no growth, and the track is
                      `alignItems: center`, so the pair simply re-centres.
                      The ellipsis should never fire — the widest realistic string,
                      "1200 count · 45360 g", measures 146px-wide content against 146px available —
                      and is a BOUND rather than a feature: without it a pathological value overflows
                      horizontally UNDER the Save button, which is invisible, whereas an ellipsis is
                      at least legible as truncation. */}
                  {frameLedger.measureLabel && (
                    <span style={{
                      display: 'block', fontSize: '0.8rem', fontWeight: 700, lineHeight: '14px',
                      color: P.green, whiteSpace: 'nowrap',
                      overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {frameLedger.measureLabel}
                    </span>
                  )}
                </>
              ) : (
                <span style={{
                  display: 'block', fontSize: '0.85rem', fontWeight: 600, lineHeight: '16px',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  Weigh-in — nothing logged yet
                </span>
              )}
            </button>,
            frameLedger.last ? (
              <button
                key="undo"
                type="button"
                data-testid="weigh-frame-undo"
                onClick={() => undoSessionRow(frameLedger.last.eventId)}
                aria-label={`Undo ${frameLedger.lastLabel}, most recent entry`}
                style={{ background: 'none', border: `1px solid ${P.border}`, borderRadius: 8, color: P.terra, fontWeight: 700, fontSize: '0.8rem', minHeight: 44, minWidth: 44, padding: '0 10px', cursor: 'pointer', flexShrink: 0, fontFamily: 'inherit' }}
              >
                <span aria-hidden="true">⟲</span>
              </button>
            ) : <span key="undo" />,
          )}
        </div>,
      )}
    </div>
  )

  /* The page-level banners, hoisted so the frame can OVERLAY them instead of stacking them above the
     form. MEASURED, and it is still the reason this exists: the frame is a fixed-height column, so
     anything rendered above the form comes straight out of the tracks, and track 2 has zero slack.
     top:56 clears track 1 deliberately — an overlay covers SOMETHING, and the chooser is the very
     next control tapped after a save, so it is the one thing that must stay clear. What it does
     cover is the quantity field, which is empty at exactly that moment.
     The "OPEN, for Dave" question that stood here — whether PreserveOffer should raise mid-sitting at
     all — was ANSWERED on 2026-08-26: it should not, and it is gone (V4-PRESERVEOFFERKILL-001). Its
     126px-out-of-track-2 measurement is now history rather than a live constraint; the overlay stays
     for the error/notice banners, which have the same zero-slack problem. */
  const noticeBlocks = (
        <>
        {error && <ErrorBanner style={{ marginBottom: 16 }}>{error}</ErrorBanner>}
        {notice && <ErrorBanner style={{ marginBottom: 16 }}>{notice}</ErrorBanner>}

        {/* V4-PRESERVEOFFERKILL-001: the "preserve this?" host stood here. Deleted with its trigger
            and its component — see the note in handleSubmit. This block is now banners only. */}
        </>
  )

  /* The history drawer. `position: absolute` over track 2 rather than a fourth track: it must cost
     the standing layout ZERO px, and it is opened deliberately by the user, so it is not a jump.
     Capped at the last 10 rows with internal scroll, so it cannot grow without bound either. */
  const frameLogDrawer = (
    sessionFrame && frameLogOpen && (
      <div
        id="weigh-frame-log"
        data-testid="weigh-frame-log"
        style={{
          position: 'absolute', left: 16, right: 16, bottom: FRAME_LEDGER_PX + 8, zIndex: 2,
          maxHeight: 260, overflowY: 'auto',
          backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10,
          boxShadow: '0 2px 12px rgba(0,0,0,0.18)', padding: '10px 14px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: '0.78rem', fontWeight: 700, color: P.green, letterSpacing: '0.3px', textTransform: 'uppercase' }}>
            This session
          </span>
          <button
            type="button"
            onClick={() => setFrameLogOpen(false)}
            aria-label="Close session log"
            style={{ background: 'none', border: 'none', color: P.mid, fontSize: '0.85rem', fontWeight: 700, minHeight: 44, minWidth: 44, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            Close
          </button>
        </div>
        {sessionRows.slice(-10).map((r, i, arr) => (
          <div key={r.eventId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: '0.85rem', color: P.mid }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: r.undone ? 'line-through' : 'none', opacity: r.undone ? 0.5 : 1 }}>
              {r.plantName} — {r.qty} {r.unit}{r.grams != null ? ` · ${r.grams} g` : ''}
            </span>
            {r.undone ? (
              <span style={{ fontSize: '0.74rem', color: P.mid }}>removed</span>
            ) : (
              /* The ordinal is what makes these names distinguishable when the same crop is logged
                 twice in one sitting — routine over 17 plantings. */
              <button
                type="button"
                onClick={() => undoSessionRow(r.eventId)}
                aria-label={`Undo ${r.plantName} ${r.qty} ${r.unit}${r.grams != null ? ` ${r.grams} g` : ''}, entry ${sessionRows.length - (arr.length - 1 - i)}`}
                style={{ background: 'none', border: `1px solid ${P.border}`, borderRadius: 6, color: P.terra, fontWeight: 600, fontSize: '0.78rem', minHeight: 44, padding: '0 10px', cursor: 'pointer', flexShrink: 0, fontFamily: 'inherit' }}
              >
                Undo
              </button>
            )}
            {r.undoError && <span role="alert" style={{ fontSize: '0.72rem', color: P.terra }}>{r.undoError}</span>}
          </div>
        ))}
      </div>
    )
  )

  // POI-SEEDDOORMENU-001 — the planting whose Save-seed sheet should be open, or null.
  // Derived rather than held in state: the two inputs are already form state, and a second copy
  // would need clearing on every path that changes either. Null unless the chosen type is
  // seed_saved AND the planting resolves in the loaded list — see the render site for why an
  // unresolved planting must fall through to the ordinary form rather than open a picker.
  const seedSaveTarget = form.event_type === 'seed_saved' && form.plant_id
    ? (plantsForProject.find(p => p.id === form.plant_id) ?? null)
    : null

  return (
    <>
    {/* POI-SEEDDOORMENU-001 — THE MENU DOOR, and it opens onto the same room as the button.
        Dave's instruction was "Planting pages should have a Save Seed option button to trigger this
        flow, as well as the menu item." The button shipped in v4.94.0 and QuickActions was its only
        renderer, so the create-a-lot flow was reachable from a planting page and nowhere else.
        Picking "Seed saved" out of the More-event-types disclosure — the route he originally went
        looking down — still did the OLD thing: wrote a bare timeline note and created no seed lot at
        all. Two doors, the same name, different outcomes.
        Dave 2026-09-02: "ensure that going from the menu rather than the planting also logs the
        event into the planting's event history. Same behavior in every surface." Both halves come
        free by opening the REAL sheet rather than reimplementing it — SaveSeedSheet's own
        V4-SEEDEVENT-001 POST is what writes the seed_saved row, so the timeline entry the old menu
        route produced still happens, and now the lot exists too.
        GATED ON A RESOLVED PLANTING, not merely on the type. seed_saved is in
        PLANTING_REQUIRED_TYPES so the form asks for one anyway; until it is answered the ordinary
        form renders and this is null. The sheet's whole advantage is that the parent is a PARAMETER
        rather than a picker, so opening it without one would throw that away and ask the question
        twice. Closing without saving clears the type, so the user lands back on the chooser instead
        of behind a dismissed sheet. */}
    {seedSaveTarget && (
      <SaveSeedSheet
        planting={seedSaveTarget}
        onClose={() => setForm(f => ({ ...f, event_type: '' }))}
      />
    )}
    {/* V4-WEIGHFRAME-001: `height` + `overflow: hidden`, not `minHeight`. The frame's entire claim is
       that the document cannot scroll, so there is nothing for a scroll anchor to fight. A minHeight
       would leave the document scrollable the moment content exceeded it and quietly restore every
       behaviour the frame deletes. */}
    <div style={sessionFrame
      ? { height: FRAME_HEIGHT, overflow: 'hidden', backgroundColor: P.cream }
      : { minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={sessionFrame
        // position:relative is the drawer's containing block — it renders OVER track 2 rather than
        // as a fourth track, so the standing layout costs it nothing.
        ? { maxWidth: 600, margin: '0 auto', padding: '0 16px', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }
        : { maxWidth: 600, margin: '0 auto', padding: '28px 16px 60px' }}>

        {/* The breadcrumb + `Log an event` heading are ~84px of browsing chrome on a surface the user
            reached deliberately and will not leave until the bowl is empty. In the frame they are the
            difference between the chooser being pinned to the viewport top and being pushed a third
            of the way down it, so the frame drops them. Nothing is stranded: TopChrome's own back
            affordance is untouched and sits above this. */}
        {!sessionFrame && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: '0.82rem', color: P.light, marginBottom: 8 }}>
            <Link to="/dashboard" style={{ color: P.green, textDecoration: 'none' }}>Dashboard</Link>
            {' › Log event'}
          </div>
          <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>
            Log an event
          </h1>
          {/* V4-LOGMINIBTNKILL-001 (BD-048) — the "Log many →" ghost button is REMOVED.
              ("Log Mini" in the braindump is voice-to-text for "Log many".)
              Dave: "I really don't need the log mini button anymore, the FAB menu is good enough
              for that." Verified before deleting rather than after, because the row says not to
              strand the flow: BottomNav.jsx:86 carries a 'Log many' row in the FAB create sheet
              pointing at the same /log/many, and /log/many is in OVERLAYABLE_CREATE, so it still
              opens as a flyover exactly as this link did.
              The motive is VERTICAL SPACE at the top of the screen — the same small-viewport
              pressure behind BD-045 and BD-047 — so this is a deletion, not a relocation.
              WHAT IT COSTS, accepted by Dave: from an already-open Log Event OVERLAY this was a
              one-tap content swap that preserved the page behind it. The FAB route is dismiss-then-
              tap. Two taps instead of one, on a cross-link, in exchange for the header height on
              every visit. */}
        </div>
        )}

        {/* V4-WEIGHFRAME-001 — the banners OVERLAY the frame instead of sitting above it.
            MEASURED, and it is the reason this branch exists: the frame is a fixed-height column, so
            anything rendered above the form takes its height out of the tracks, and track 2 has zero
            slack. The original 126px measurement was taken against PreserveOffer, which is now
            deleted (V4-PRESERVEOFFERKILL-001) — an error banner has the same effect for the same
            structural reason, so the overlay stays. zIndex 3 clears the history drawer's 2. */}
        {sessionFrame
          ? <div data-testid="weigh-frame-notices" style={{ position: 'absolute', top: 56, left: 16, right: 16, zIndex: 3 }}>{noticeBlocks}</div>
          : noticeBlocks}

        {/* V4-WEIGHFRAME-001 — THE FRAME. Three tracks, and which track a thing is in is the whole
            design:
              track 1  auto  planting chooser            — pinned to the viewport TOP
              track 2  1fr   qty + qty pad + weight + weight pad, bottom-aligned, overflow-y:auto
              track 3  auto  one-line ledger + Save row  — pinned to the viewport BOTTOM
            Because tracks 1 and 3 are `auto` and track 2 is `1fr`, an IME show/hide changes ONLY
            track 2's height. Save's distance from the bottom edge and the chooser's from the top are
            invariant across the transition, and the slack is consumed at the TOP of track 2 — so the
            weight field and weight pad, the things the thumb is actually on, do not move. Quantity
            slides up out of view instead. That is layout, not scroll, so it does not depend on the
            browser preserving scrollTop across the resize.
            gap:0 deliberately: a row gap here would be viewport height spent on nothing, and the
            blocks carry their own margins. */}
        <form
          onSubmit={handleSubmit}
          data-testid={sessionFrame ? 'weigh-frame' : undefined}
          style={sessionFrame
            // gridTemplateColumns: an IMPLICIT grid column is `auto`, which sizes to MAX-CONTENT and
            // does not shrink to its container the way a flex item does. MEASURED at 390x500 on this
            // merged tree and, byte-identically, on lane-frame-20260825 alone — so this is the lane's
            // defect and not the merge's: from the FIRST save the track-3 summary
            // ("1 · 123 g · Bloomsdale Long-Standing") is `whiteSpace: nowrap`, so its max-content
            // contribution took the single column to 563.42px inside a 358px box. `overflow: hidden`
            // then CLIPPED rather than scrolled, so nothing reported an error while Save sat at
            // x424-574 and the weight pad's `.` and backspace keys at x392-479 / x487-574 — all three
            // entirely outside a 390px viewport, unreachable, at entries 2, 3 and 4.
            // minmax(0, 1fr) gives the column a zero MINIMUM, which is what lets the summary's own
            // `overflow: hidden; textOverflow: ellipsis; minWidth: 0` finally engage — that styling
            // was already there and was dead code while the column grew to fit the string instead.
            ? { display: 'grid', gridTemplateRows: 'auto 1fr auto', gridTemplateColumns: 'minmax(0, 1fr)', flex: 1, minHeight: 0, overflow: 'hidden' }
            : { display: 'flex', flexDirection: 'column', gap: 16 }}
        >

          {sessionFrame ? (
            <>
              {/* ── TRACK 1 ──
                  projectBlock keeps its shipped position immediately before Planting. In the
                  shipped config it renders NOTHING (PROJECTS_HIDDEN is on), so it costs the frame
                  zero px; in the flag-OFF rollback config, where Project is a REQUIRED field, it is
                  still the first thing on screen and still ahead of the planting it scopes. Burying
                  it in the secondary region would make a harvest unsaveable without scrolling. */}
              {/* minHeight is the last source of movement on this surface, and it is worth naming.
                  PlantingSelect swaps a 52px search input for a 44px chip on pick and back again on
                  reset — 8px, twice per entry. In the shipped scrolling document both states were
                  52px so it measured 0; flattening the Section card exposed the difference, and it
                  landed as ~16px of residual per-entry travel because track 1 resizing moves track
                  2's top edge. Pinning the track to the taller of the two states makes the swap
                  invisible. */}
              {/* V4-WEIGHDATEREACH-001 + V4-WEIGHSESSIONCLOSE-001: the date control and Close ride
                  ALONGSIDE the chooser rather than above it. Track 1 is `auto` and already pinned to
                  52px by the chooser's own 52/44 swap, so two 44px controls placed beside it add
                  ZERO height — the frame's tracks are unchanged and track 2 keeps every pixel.
                  The chooser gets `flex: 1; minWidth: 0` so a long planting chip ellipses inside its
                  own box instead of pushing Close off the right edge — the same max-content failure
                  that put Save and two weight-pad keys outside the viewport before minmax(0,1fr)
                  was applied to the grid column. */}
              <div data-testid="weigh-frame-chooser" style={{ minHeight: 52, display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>{projectBlock}{plantingBlock}</div>
                {frameDateControl}
                {frameCloseButton}
              </div>

              {/* ── TRACK 2 ──
                  Nested `minmax(0,1fr) auto`, NOT `align-content: end` on the track itself, and the
                  difference is measured rather than stylistic. In real Chrome (151, headless, this
                  lane) a `display:grid; align-content:end; overflow-y:auto` box whose content
                  overflows reports `scrollHeight === clientHeight` and `scrollTop` pinned at 0 —
                  147px of content sat ABOVE the box's top edge and was completely unreachable, with
                  no scrollbar and no error. Bottom-anchoring by giving the SLACK to a flexible row
                  above produces the identical picture when the content fits (empty space at the top,
                  fields and pads sitting on the ledger) and degrades into a real scroller instead of
                  swallowing content when it does not.
                  Row 1 holds the session lock strip and the photo/notes disclosure — low-frequency,
                  and `showHarvestMore` is deliberately never reset between entries, so the 1-in-5
                  photo path stays toll-free exactly as it is today. Row 2 is the four things Dave
                  named. */}
              <div
                ref={frameBodyRef}
                data-testid="weigh-frame-body"
                style={{ overflowY: 'auto', minHeight: 0, display: 'grid', gridTemplateRows: 'minmax(0, 1fr) auto' }}
              >
                <div style={{ overflowY: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {eventTypeBlock}
                  {dispositionBlock}
                  {frameSecondaryBlock}
                  {addDetailsBlock}
                </div>
                {/* No padding: at 390x500 every one of these px comes straight off the pads. */}
                <div>{harvestBlock}</div>
              </div>

              {/* ── TRACK 3 ── */}
              {frameLedgerBlock}
            </>
          ) : (
          <>
          {isHarvest ? (
            /* ── HARVEST order (V4-HARVFORMORDER-001) ──────────────────────────────────────────
               Planting → Quantity → Unit lead, so the two controls a harvest actually needs are on
               screen the moment the form opens. Everything the harvest fast path does not touch
               drops below, under ONE disclosure rather than five separate ones.

               PROJECT IS DELIBERATELY *NOT* IN THAT DISCLOSURE. The plan's "hide the Project select
               for harvest" is ALREADY satisfied: projectBlock is `!PROJECTS_HIDDEN && (…)` and
               PROJECTS_HIDDEN is ON (featureFlags.js) — the select renders for NO event type today.
               Adding a second, harvest-shaped gate on top would be redundant in the shipped config
               and a silent behaviour change in the flag-OFF rollback config, where Project is a
               REQUIRED field and burying it under a collapsed disclosure would make a harvest
               unsaveable without first expanding something. So it keeps its relative position
               (Project immediately before Planting) and simply renders nothing while the flag is on.

               METADATA is in the disclosure for symmetry only — MetadataSection already returns null
               for harvest via its own `eventType === 'harvest'` branch, so it too is inert here.

               The event-type picker stays VISIBLE below the harvest panel rather than going into the
               disclosure: it is how a mis-tapped type is corrected, and the plan's disclosure list
               does not name it. It is off the fast path either way.

               Save is NOT reordered — it is `position: sticky` and therefore already pinned to the
               viewport bottom for every type; the fold problem S4 solves is the SCROLL to quantity,
               not Save's document position. ── */
            <>
              {/* V4-HARVSESSION-002: the pre-flight tray — pay the picker cost ONCE, in tap order.
                  States: current (filled pill), queued (· N position suffix), done (tick prefix, tap
                  again for a second picking — same-day repeats are separate rows by design). The
                  tray is supplementary: an empty ready fetch renders nothing and the picker below
                  remains the full path for anything not on the list.
                  BUG-TRAYFETCHSILENT-001: a FAILED fetch is no longer part of that "renders
                  nothing" case. It renders the section with a notice instead, because silence there
                  is a lie — it tells the user the garden has nothing ready when nobody asked it. */}
              {/* BD-044: the Weigh-in queue chip tray rendered here. Removed entirely. */}
              {projectBlock}
              {plantingBlock}
              {harvestBlock}
              {eventTypeBlock}

              {frameSecondaryBlock}

              {addDetailsBlock}
            </>
          ) : (
            /* ── Every non-harvest type: the shipped V4-LOGPHOTOFIRST-001 sequence, unchanged. ── */
            <>
              {photoBlock}
              {eventTypeBlock}
              {treatmentBlock}
              {fertilizingProductBlock}
              {waterDepthBlock}
              {projectBlock}
              {plantingBlock}
              {containerBlock}
              {reductionBlock}
              {metadataBlock}
              {harvestBlock}
              {addDetailsBlock}
              {whenBlock}
              {/* V4-NOTESCOLLAPSE-001 — LAST. Save is `position: sticky` and pinned to the viewport
                  bottom on every surface, so "below Save" is document order, not viewport order. */}
              {notesDisclosureBlock}
            </>
          )}

          {/* ── Floating Save — V3-EVENT-005 (Dave to eyeball bottom offset) ── */}
          {/* Spacer so content isn't hidden behind the sticky band.
              V4-HARVFEEDBACK-001 S5b (spec §8) — RULE, not a magic number: spacer = rendered
              sticky-band height + ~56px slack. The 120 base is the shipped value for the action row
              alone (44pt control + padding + slack) and is deliberately unchanged, so the pre-save
              and full-page layouts stay byte-identical. It grows by the feedback zone's height only
              while that zone renders. Both numbers are CSS-derived estimates: jsdom returns zero
              rects, so the actual band height is an ON-DEVICE measurement (see the handoff). */}
          <div style={{ height: 120 + (showPostSaveStrip ? POST_SAVE_STRIP_SPACER_PX : 0) }} aria-hidden="true" />
          {/* V4-OVERLAY-001 Slice 2 (§6, BUG-SHEET-001 class): sticky, NOT fixed. `fixed` positions
              against the viewport, so inside a Sheet (which sets no transform/containing block) the
              CTA escaped the panel's scroll region and painted over the sheet at the same z200. sticky
              keeps it inside its scroll container — the Sheet when overlaid, the document when full
              page. right:20 is dropped (a sticky block spans the content column; justify-content:
              flex-end right-aligns the button, and the form's own right padding gives the gap) so
              the inset can't shift it off-panel. */}
          {/* V4-KBVIEWPORT-001 — RESOLVES the deferral that used to sit in this comment block. The
              two scroll containers need two different insets, and conflating them cost real space:
                full page -> the sticky container is the document, the fixed BottomNav is genuinely
                            there, so clear it. SAVE_BAND_BOTTOM_INSET_PX (= BOTTOM_NAV_HEIGHT_PX +
                            12), imported rather than the old magic `68` — which was 56+12
                            hardcoded and free to silently desync. Named in lib/saveBandLayout.js
                            because BUG-WEIGHPADSAVEBAND-001's clearance rule is measured against
                            it, so the two must not be able to drift apart.
                overlay   -> the sticky container is the Sheet's own scrollport, and the Sheet paints
                            OVER the nav (z200 > z100), so nav clearance is dead space. The Sheet
                            already reserves `calc(12px + env(safe-area-inset-bottom))` at its foot,
                            so 0 is both correct and safe-area-complete — no double count.
              The `+ kbInset` visualViewport lift is GONE with the hook (see the note at the top of
              this file); index.html's interactive-widget shrinks the layout viewport instead, so
              there is nothing left for JS to compensate for. */}
          {/* V4-PICKERUX-001: hidden — NOT unmounted — while the planting picker's listbox is open.
              visibility+pointerEvents keeps the node (EventNew.test.jsx pins exactly one "Save", and
              the picker's 150ms blur-close would make an unmounting footer flicker back under a
              finger mid-gesture). zIndex drops 200 -> 1: the 200 was to beat the Sheet panel back
              when this was `position: fixed`, and the sticky conversion dissolved that need. z1
              still puts it in the positive-z layer above every z-auto positioned sibling, so nothing
              moves visually — but the listbox (z30) now wins if onOpenChange ever regresses. Belt
              and braces, because the failure mode here is a wrong write, not a cosmetic overlap.
              This suppression STAYS after V4-KBVIEWPORT-001: removing the lift makes a Save/listbox
              overlap less likely, not impossible — a listbox opening downward from a mid-form input
              can still reach a footer sitting at the bottom of the scrollport. */}
          {/* No aria-hidden: `visibility: hidden` already removes the subtree from the a11y tree AND
              from the tab order, so adding it would only create the aria-hidden-with-focusable-
              descendant anti-pattern axe flags. */}
          {/* V4-HARVFEEDBACK-001 S5b (spec §2): the band is MULTI-ROW now — feedback zone (rows 1-2,
              conditional) stacked above the action zone (row 3, always). Folding the strip in here
              rather than anchoring it to the top of the sheet is chosen for, in order of weight:
              (1) ZERO SACCADE — feedback appears where the thumb just was; a top-anchored strip
              forces a full-viewport reorientation after a bottom Save tap, the exact attention-
              residue mechanism the Reward UX rule exists to prevent; (2) Undo cannot scroll away;
              (3) it is sticky-IN-FLOW inside the Sheet's scrollport, so it never paints over garden
              content and is therefore not a banned snackbar/banner/popover; (4) at ~500px, merging
              into the Save band is the only version that fits.
              The V4-PICKERUX-001 suppression stays on the WHOLE band, not just the action row: the
              band is taller now, so it occludes MORE of a downward-opening listbox, which makes the
              suppression more load-bearing than before, not less. Undo is hidden only for as long as
              the listbox is open. */}
          <div
            data-testid="save-sticky"
            style={{
              position: 'sticky',
              bottom: inOverlay ? 0 : SAVE_BAND_BOTTOM_INSET_PX,
              zIndex: 1,
              display: 'flex',
              flexDirection: 'column',
              visibility: pickerOpen ? 'hidden' : 'visible',
              // BUG-LOGBANDOCCLUDE-001 — the band must not take a tap where it paints nothing.
              //
              // MEASURED, real Chrome, true 390x844, /log at first paint (scrollTop 0): the band
              // is stuck at bottom:68 spanning y728-776 and x16-359, and the "Plant or group"
              // chooser lies at y712-756, x35-340 — 28 of its 44px underneath. FIVE
              // elementFromPoint probes across the chooser's width returned the chooser ZERO
              // times: x50 and x111 hit this container's action row (transparent, left of Save),
              // x188/x264/x325 hit the Save BUTTON itself (x179-359). The field was completely
              // untappable until the user scrolled, with nothing on screen explaining why.
              //
              // The container is a full-content-width box that paints only when the feedback zone
              // renders; the rest of the time it is an invisible 343x48 hit-taker floating over
              // the form. So it hit-tests ONLY when it is opaque, and the two things that ARE
              // painted inside it — the session ledger strip and the action row's buttons — opt
              // back in individually. This is the general half of the fix: it retires the dead
              // strip at every viewport and for every control that ever lands under it, not just
              // this chooser. The painted-Save half cannot be solved here (a floating Save
              // overlaps by design) and is handled by the mount clearance in the effect above.
              pointerEvents: pickerOpen || !showPostSaveStrip ? 'none' : 'auto',
              // Opaque only while the feedback zone renders. Pre-save the band stays transparent —
              // byte-identical to the shipped look, where the shadowed Save floats over the form.
              ...(showPostSaveStrip ? { backgroundColor: P.cream, borderTop: `1px solid ${P.border}` } : null),
            }}
          >
            {showPostSaveStrip && (
              <PostSaveFeedback
                confirmation={confirmation}
                seasonLine={seasonLine}
                savesThisSession={savesThisSession}
                actions={{ onUndo: undoEvent }}
              />
            )}
            {/* V4-HARVSESSION-001: the session ledger — rows + running totals + per-row undo,
                folded into the sticky band for the same zero-saccade reason as the overlay strip
                above (feedback appears where the thumb just was). Capped at the last 3 rows so a
                12-variety session never pushes Save off a 500px viewport; the header always counts
                the WHOLE session. Inherits the band's pickerOpen suppression deliberately. */}
            {inHarvestSession && sessionRows.length > 0 && (() => {
              const live = sessionRows.filter(r => !r.undone)
              const totalG = live.reduce((s, r) => s + (r.grams ?? 0), 0)
              const visible = sessionRows.slice(-3)
              const totalLabel = totalG >= 1000 ? `${Math.round(totalG / 100) / 10} kg` : `${Math.round(totalG)} g`
              // BUG-LOGBANDOCCLUDE-001: this strip opts back in — it is opaque white with its own
              // shadow, so it is a real surface and its per-row Undo buttons must stay tappable
              // even though the band around them no longer hit-tests.
              return (
                <div data-testid="harvest-session-strip" style={{ pointerEvents: 'auto', backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: '10px 14px', marginBottom: 10, boxShadow: '0 2px 12px rgba(0,0,0,0.10)' }}>
                  <div style={{ fontSize: '0.78rem', fontWeight: 700, color: P.green, letterSpacing: '0.3px', textTransform: 'uppercase', marginBottom: 6 }}>
                    This session: {live.length} harvest{live.length === 1 ? '' : 's'}{totalG > 0 ? ` · ${totalLabel}` : ''}
                  </div>
                  {sessionRows.length > visible.length && (
                    <div style={{ fontSize: '0.74rem', color: P.light, marginBottom: 4 }}>+{sessionRows.length - visible.length} earlier</div>
                  )}
                  {visible.map(r => (
                    <div key={r.eventId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: '0.85rem', color: P.mid }}>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: r.undone ? 'line-through' : 'none', opacity: r.undone ? 0.5 : 1 }}>
                        {r.plantName} — {r.qty} {r.unit}{r.grams != null ? ` · ${r.grams} g` : ''}
                      </span>
                      {r.undone ? (
                        <span style={{ fontSize: '0.74rem', color: P.light }}>removed</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => undoSessionRow(r.eventId)}
                          aria-label={`Undo ${r.plantName} harvest`}
                          style={{ background: 'none', border: `1px solid ${P.border}`, borderRadius: 6, color: P.terra, fontWeight: 600, fontSize: '0.74rem', padding: '3px 8px', cursor: 'pointer', flexShrink: 0 }}
                        >
                          Undo
                        </button>
                      )}
                      {r.undoError && <span role="alert" style={{ fontSize: '0.72rem', color: P.terra }}>{r.undoError}</span>}
                    </div>
                  ))}
                </div>
              )
            })()}
            {/* ── ACTION ZONE (row 3) — three functions, three corners (spec §2). Save keeps the
                right (do NOT move it); Done takes the left, diagonally opposite, for maximum thumb
                separation; Undo is row 1 right. Undo above Save is unavoidable once those two are
                placed, and is MITIGATED rather than eliminated, deliberately: all four mis-tap
                outcomes are visible and one-tap-recoverable. The mandated mitigation is the ≥20px
                vertical clearance between Undo's bottom edge and Save's top edge, held even when
                row 2 is absent — the feedback zone's 12px bottom padding plus this row's 12px top
                padding give 24px unconditionally. CSS-derived; jsdom cannot measure it. */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12,
              justifyContent: inOverlay ? 'space-between' : 'flex-end',
              paddingTop: showPostSaveStrip ? 12 : 0,
              paddingBottom: showPostSaveStrip ? 'calc(10px + env(safe-area-inset-bottom))' : 0,
              paddingLeft: showPostSaveStrip ? 12 : 0,
              paddingRight: showPostSaveStrip ? 12 : 0,
            }}>
              {/* V4-HARVFEEDBACK-001 S5b (spec §3) — `Done`, present from MOUNT, not only after a
                  save. Load-bearing: a control that materialises only post-save is one the user
                  never learns exists, and the exit is needed MOST when abandoning before saving.
                  Sheet.jsx does render a labelled 44×44 Close for every consumer, but it is an
                  icon-only X at the top of a scrollport that scrolls — at 390×500 keyboard-open it
                  is off-screen, and the backdrop (the one large easy target) locks the moment the
                  user types. So this is a VISIBILITY fix, not an existence one.
                  Label deliberately differs from the Sheet header's `Close` so the two exits do not
                  read as duplicates, and names the USER's state rather than a UI mechanic (already
                  the app's vocabulary here — LogMany's result screen). Dismisses even while dirty,
                  exactly as the Sheet's own Close does; no confirmation dialog (modals are a banned
                  channel). Overlay-only: on the full page there is no overlay to dismiss and the
                  arm must stay untouched.
                  STATED LOSS (accepted, spec §3): Done with a half-typed harvest quantity discards
                  it — DRAFT_FORM_FIELDS does not cover harvest.quantity/weight. NOT a regression;
                  Escape and Android Back already do exactly this. */}
              {/* BUG-LOGBANDOCCLUDE-001: both buttons opt back in, and keep the pickerOpen belt
                  the container used to carry alone. `visibility: hidden` on the band already
                  removes them from hit testing while the listbox is open — this restates it at the
                  control so the V4-PICKERUX-001 wrong-write guarantee does not depend on a single
                  property on an ancestor. */}
              {inOverlay && (
                <button type="button" onClick={dismissOverlay} style={{ ...confirmBtnGhost, pointerEvents: pickerOpen ? 'none' : 'auto' }}>
                  Done
                </button>
              )}
              {/* V4-EVENTSAVE-001 (Dave): one Save = the former "Next of Type" behavior
                  (keep the event_type, clear the plant, stay on the form for the next plant).
                  The old "Next of Plant" button was rarely used and was removed. */}
              <Button
                type="button"
                variant="primary"
                loading={saving}
                // BUG-PHOTOUPLOADHANG-001: while the photo leg runs, name the step + live % (same
                // labels as PhotoUpload) — a minutes-long "Saving…" with no signal is how a dead
                // upload hid inside the event save. Falls back to "Saving…" for the event POST.
                loadingLabel={
                  photoUploader.stage === 'preparing' ? 'Preparing photo…' :
                  photoUploader.stage === 'uploading' ? (typeof photoUploader.progress === 'number' ? `Uploading photo… ${photoUploader.progress}%` : 'Uploading photo…') :
                  photoUploader.stage === 'saving' ? 'Saving photo…' :
                  'Saving…'
                }
                onClick={e => handleSubmit(e, { keepMode: 'type' })}
                style={{
                  boxShadow: '0 2px 12px rgba(0,0,0,0.18)',
                  minWidth: 180,
                  pointerEvents: pickerOpen ? 'none' : 'auto',
                }}
              >
                Save
              </Button>
            </div>
          </div>
          </>
          )}

        </form>
        {frameLogDrawer}

        {/* ── V4-LOSSUI-001 — the end-status offer ──
            OUTSIDE the form element deliberately: it is a post-save decision about the PLANTING,
            not a field of the event being logged, and the form underneath has already been reset
            for the next entry. Dismissal runs through the shared Sheet primitive and therefore
            through DismissRegistry — Escape, the Android Back gesture, the backdrop and the two
            labelled decline controls all resolve through the one arbiter, and NONE writes a status.
            (Prose here deliberately avoids the literal angle-bracketed Sheet tag: modalSurfaceFreeze
            .static.test.js scans source text for render sites and its own header warns that padding
            the frozen list with files that merely MENTION a modal is how the freeze stops meaning
            anything. EventNew renders no sheet of its own.) */}
        <EndStatusOffer
          offer={endStatusOffer}
          plantName={endStatusOffer?.plantName}
          onDismiss={() => setEndStatusOffer(null)}
          onApply={async (status) => {
            // The ORDINARY plants PUT — the same endpoint the container capture above uses. The
            // events endpoint deliberately never writes status (mutation-proved server-side), so
            // this explicit user tap is the only thing in the system that can.
            await apiFetch('/api/plants/' + endStatusOffer.plantId, {
              method: 'PUT',
              body: JSON.stringify({ status }),
            })
            setEndStatusOffer(null)
            showToast({ message: `Planting set to ${statusLabel(status)}` })
          }}
        />
      </div>
    </div>
    </>
  )
}


// V4-FLAG-001: Flag mode body — severity (required, 3 buttons) + a static seeded issue dropdown
// with an "Other" (type OR voice via the shared MicBtn). The chosen issue is stored as free-text
// metadata.issue_label; severity is the DB smallint. Order per spec: severity -> issue.
function FlagModeFields({ severity, onSeverity, issueChoice, onIssueChoice, issueOther, onIssueOther, voice, onBack }) {
  const TONE = { gold: P.gold, terra: P.terra, red: P.severityUrgent }
  // V4-ICON-001 — WCAG 1.4.1 fix. This was a map of three coloured-circle emoji: three identical circles that
  // differed ONLY in hue, so the whole urgency ladder collapsed for anyone who cannot separate
  // gold/orange/red, and it baked its own colors instead of taking P.gold/P.terra/P.severityUrgent
  // (the §15 baked-color drift the icon spec warns about — the swatch and the button tone could
  // disagree and nothing would catch it). The registry ladder is MONOTONIC BY SHAPE — filled dot ->
  // open triangle -> triangle with an alert inside — so severity survives in greyscale, and each
  // rung already renders beside its own text label. Color now reinforces a third channel instead of
  // being the only one: the glyph takes currentColor, which is the tone on rest and white on select.
  const SEVERITY_ICON = { 1: 'severity.low', 2: 'severity.med', 3: 'severity.high' }
  return (
    <div>
      <button type="button" onClick={onBack}
        style={{ background: 'none', border: 'none', color: P.green, fontSize: '0.82rem', fontWeight: 600,
          cursor: 'pointer', padding: '0 0 12px', display: 'flex', alignItems: 'center', gap: 5 }}>
        ← Choose a different event
      </button>
      <div style={{ fontSize: '0.74rem', fontWeight: 700, color: P.mid, letterSpacing: '0.3px',
        textTransform: 'uppercase', marginBottom: 8 }}>How urgent? *</div>
      <div role="radiogroup" aria-label="Severity" style={{ display: 'grid', gap: 8 }}>
        {SEVERITY_LEVELS.map(sv => {
          const active = severity === sv.value
          const tone = TONE[sv.tone]
          return (
            <button key={sv.value} type="button" role="radio" aria-checked={active}
              onClick={() => onSeverity(sv.value)}
              style={{ display: 'flex', alignItems: 'center', gap: 8,
                textAlign: 'left', padding: '11px 14px', borderRadius: 10, cursor: 'pointer',
                border: `2px solid ${active ? tone : P.border}`, backgroundColor: active ? tone : P.white,
                color: active ? P.white : P.mid, fontWeight: 600, fontSize: '0.88rem', fontFamily: 'inherit' }}>
              {/* Shape is the primary channel; `color` here is the SECOND channel and the label is
                  the third. On rest the glyph takes the rung's own tone against white; on select the
                  button fills with that tone and the glyph goes white for contrast. */}
              <Icon name={SEVERITY_ICON[sv.value]} size={18} decorative
                style={{ flexShrink: 0, color: active ? P.white : tone }} />
              <span>{sv.label}</span>
            </button>
          )
        })}
      </div>
      <div style={{ marginTop: 16 }}>
        <Field label="What's the issue?" htmlFor="flag-issue" optional>
          <Select id="flag-issue" value={issueChoice} onChange={e => onIssueChoice(e.target.value)}>
            <option value="">— Select an issue (optional) —</option>
            {ISSUE_OPTIONS.map(g => (
              <optgroup key={g.group} label={g.group}>
                {g.options.map(o => <option key={o} value={o}>{o}</option>)}
              </optgroup>
            ))}
            {/* No glyph: an <option> renders text only, so the leading plus could never be an
                <Icon> here. Dropping it is the honest fix — the ONE affordance in this file that
                cannot take a registry glyph at all. */}
            <option value="__other__">Other…</option>
          </Select>
        </Field>
        {issueChoice === '__other__' && (
          <div style={{ position: 'relative', marginTop: 10 }}>
            <Input value={issueOther} onChange={e => onIssueOther(e.target.value)}
              aria-label="Describe the issue" placeholder="Describe the issue" style={{ paddingRight: 44 }} />
            <MicBtn fieldKey="issueOther"
              onResult={text => onIssueOther(issueOther ? issueOther + ' ' + text : text)}
              voice={voice} top="14px" transform="none" />
          </div>
        )}
      </div>
    </div>
  )
}

// (V4-LOGCONF-001 confirmBtnPrimary/confirmBtnGhost moved to components/PostSaveFeedback.jsx in
// S5a — the card's action footer was their only consumer.)

// V4-PRESERVEOFFERKILL-001: the V4-HARVESTCENTER-001 (L9) "preserve this?" offer component lived
// here. Deleted 2026-08-26 with its trigger and both its hosts — full rationale at the capture site
// in handleSubmit. The characterization test that pinned "exactly ONE host renders" now pins ZERO,
// so a future session cannot quietly restore it.

// V4-EVENTSEL-005: `Section` was declared identically here and in LogMany.jsx. It is now imported
// from the shared components/FormSection.jsx (see the import at the top of this file). No `style`
// is passed at the call sites — these sections are flex children of the gap:16 <form>, so the card
// deliberately carries no outer margin of its own.

// SuccessScreen retained for reference; V1.2a-1 flow navigates straight to dashboard.
//
// V4-ICON-001 — the ONE place in this file that still renders pictographic characters, and
// deliberately so. The two SIGNIFYING glyphs are routed (the save-confirm fallback and the
// confirm check are registry entries below); what remains is the flame beside the streak count, the bolt beside
// the XP count and the party-popper inside "Level up" — reward ornament, not icon slots. They carry no meaning
// the adjacent text does not already carry, the icon grammar has no celebration family, and
// minting keys for confetti is explicitly out of scope. `eventMeta?.emoji` stays as-is because
// its source is lib/eventTypes.js, which this lane does not own.
// eslint-disable-next-line no-unused-vars
function SuccessScreen({ success, onDashboard }) {
  const eventMeta = EVENT_TYPES_UI.find(t => t.value === success.eventType)
  const streakMsg = success.newStreak > 1 ? `${success.newStreak}-day streak` : 'Day 1 — keep it going!'

  return (
    <div style={{
      textAlign: 'center',
      padding: '40px 32px',
      maxWidth: 340,
    }}>
      <div style={{ fontSize: '3.5rem', lineHeight: 1, marginBottom: 8 }}>
        {eventMeta?.emoji ?? <Icon name="action.check" size={56} decorative />}
      </div>
      <div style={{
        width: 52, height: 52,
        borderRadius: '50%',
        backgroundColor: P.green,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        margin: '0 auto 20px',
        fontSize: '1.4rem', color: P.white,
      }}>
        <Icon name="action.check" size={22} decorative />
      </div>

      <h2 style={{ margin: '0 0 6px', color: P.green, fontSize: '1.5rem', fontWeight: 700 }}>
        Logged!
      </h2>
      <p style={{ margin: '0 0 24px', color: P.mid, fontSize: '0.9rem' }}>
        {eventMeta?.label?.replace('\n', ' ') ?? 'Event'} recorded
      </p>

      <div style={{
        display: 'flex', gap: 12, justifyContent: 'center', marginBottom: 28,
      }}>
        <div style={{
          backgroundColor: P.white, border: `1px solid ${P.border}`,
          borderRadius: 10, padding: '12px 18px', flex: 1,
        }}>
          <div style={{ fontSize: '1.4rem', marginBottom: 4 }}>🔥</div>
          <div style={{ fontSize: '1.05rem', fontWeight: 700, color: P.terra }}>{streakMsg}</div>
        </div>

        <div style={{
          backgroundColor: P.white, border: `1px solid ${P.border}`,
          borderRadius: 10, padding: '12px 18px', flex: 1,
        }}>
          <div style={{ fontSize: '1.4rem', marginBottom: 4 }}>⚡</div>
          <div style={{ fontSize: '1.05rem', fontWeight: 700, color: P.gold }}>+{success.earnedXp} XP</div>
        </div>
      </div>

      {success.isLevelUp && (
        <div role="status" aria-live="polite" style={{
          backgroundColor: '#fef9ec',
          border: '1px solid #e6c96a',
          borderRadius: 10, padding: '12px 20px', marginBottom: 24,
          fontSize: '0.9rem', color: '#7a5c00', fontWeight: 600,
        }}>
          🎉 Level up → Level {success.newLevel}!
        </div>
      )}

      <button
        type="button"
        onClick={onDashboard}
        style={{
          marginTop: 8,
          backgroundColor: P.green, color: P.white,
          border: 'none', borderRadius: 8,
          padding: '13px 30px', fontSize: '0.95rem', fontWeight: 700,
          cursor: 'pointer', minWidth: 180,
        }}
      >
        Back to Dashboard
      </button>
    </div>
  )
}
