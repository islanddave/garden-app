import React, { useState, useEffect, useRef, useCallback, useId } from 'react'
import { takePendingCapture } from '../lib/pendingCapture.js'
import { createFinalResultReader } from '../lib/voiceResults.js'
import { recordVoiceEvent, recordVoiceMark } from '../lib/voiceDebug.js'
import { saveFileToDevice } from '../lib/saveFileToDevice.js'
import ProjectOptions from '../components/ProjectOptions.jsx'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P, EVENT_TYPES, LOGGABLE_PROJECT_STATUSES, BOTTOM_NAV_HEIGHT_PX } from '../lib/constants.js'
import { EVENT_TYPE_META, requiresPlanting } from '../lib/eventTypes.js'
import { PLANTING_REQUIRED_ENABLED, PROJECTS_HIDDEN, HARVEST_QUALITY_HIDDEN, SAVE_TO_DEVICE_HIDDEN } from '../lib/featureFlags.js'
import EventTypePicker, { EVENT_TYPES_UI, SECONDARY_GROUPS } from '../components/forms/EventTypePicker.jsx'
import { useUploadPhoto } from '../hooks/useUploadPhoto.js'
import { HARVEST_UNITS, MAX_PLAUSIBLE, WEIGHT_UNITS, MAX_PLAUSIBLE_WEIGHT_G, toGrams } from '../lib/harvest-constants.js'

// V4-HARVQTYCHIPS-001 — the fast-path quantity set. MEASURED, not guessed: 83.2% of the 519 prod
// harvest_log rows are integers 1-6 and 87.1% are a single character, so a chip row collapses the
// two-interaction "tap the field, type a digit" into ONE tap for five of every six harvests AND
// keeps the soft keyboard off the fast path entirely (which is worth more than the tap on a 390px
// viewport, where the keypad takes roughly half the height).
// The chips ADD to the field rather than replacing it, so the 16.8% tail (decimals, integers >6)
// costs exactly what it costs today — no regression to trade against the win.
const QTY_CHIPS = ['1', '2', '3', '4', '5', '6']

// V4-HARVFEEDBACK-001 S5b (spec §8) — how much the bottom spacer grows while the post-save feedback
// zone is rendered, so the last form control still clears the sticky band. CSS-DERIVED ESTIMATE,
// not a measurement: 10px top pad + 44pt Undo row + ~18px row 2 + 12px bottom pad ≈ 84, rounded to
// 86. jsdom returns zero rects for everything, so the real number is an ON-DEVICE measurement at
// 390×500 keyboard-open — that check belongs to the device harness, and this constant is the single
// place to correct it. The 120px base for the action row alone is unchanged and stays inline.
const POST_SAVE_STRIP_SPACER_PX = 86
import { seasonTotalPhrase } from '../lib/harvestSummary.js'
import { useUxFlow, FLOWS } from '../lib/uxEvents.js'
import { EVENTNEW_ADD_DETAILS_EXPANDED } from '../lib/featureFlags.js'
import { Field, Input, Select, Textarea, Button, ErrorBanner, PlantingSelect, SelectChip } from '../components/forms'
import { CROP_CHIPS_AUTO } from '../components/forms/PlantingSelect.jsx'
import TreatmentDetails from '../components/TreatmentDetails.jsx'
import Section from '../components/FormSection.jsx'
import PostSaveFeedback, { confirmBtnGhost } from '../components/PostSaveFeedback.jsx'
import { useToast } from '../context/ToastContext.jsx'
import { OverlaySwapLink, useInOverlaySurface, useOverlaySwap, useOverlayDismiss, useReportOverlayDirty } from '../context/OverlayContext.jsx'
import { readDraft, writeDraft, clearDraft } from '../lib/draftStash.js'
import { setReloadBlocked } from '../lib/reloadGate.js'
// V4-CROPLISTORDER-001 (BD-010): crop-rank ledger — fed at the same post-save moment as
// logone.lastPlant below; PlantingSelect reads it at picker-open to band-order its crop chips.
import { recordCropLog } from '../lib/cropLogLedger.js'
// V4-HARVSESSION-002: chip-queue ranking — the same order the Today ready band shows, so the tray
// and the band never disagree about what "next" means.
import { rankHarvestReady } from '../lib/harvestReadiness.js'
import { selectTrayChips, harvestTrayScrollport } from '../lib/harvestTray.js'
import { sendReadyImpressions } from '../lib/readyImpressions.js'
// V4-WATERMATH-001 F0 — watering amount class (Light/Normal/Deep). See src/lib/waterDepth.js
// for the metadata contract with the events Lambda and why it is NOT quantity_numeric.
import WaterDepthChips from '../components/WaterDepthChips.jsx'
import {
  WATER_DEPTH_DEFAULT, isWaterDepthType, waterDepthMetadata, waterDepthLabel, WATER_DEPTH_CHIPS,
} from '../lib/waterDepth.js'
import { EVENT_METADATA_FIELDS, HARVEST_QUALITY_LABELS, PLANT_CONTAINER_TYPE_OPTIONS, SEVERITY_LEVELS, ISSUE_OPTIONS } from '../lib/dropdownRegistry.js'

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
const DRAFT_FORM_FIELDS = ['event_type', 'notes', 'private_notes', 'quantity', 'event_date', 'is_public', 'plant_id']

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
// V4-HARVTRAYVIEWPORT-001: aria-controls target for the weigh-in tray's Show more/fewer disclosure.
const HARVEST_TRAY_ID = 'harvest-session-tray'

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

function useVoiceInput() {
  const [listening, setListening] = useState(false)
  const [fieldKey,  setFieldKey]  = useState(null)
  const recRef = useRef(null)

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

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    const rec = new SR()
    rec.continuous    = false
    rec.interimResults = false
    rec.lang          = 'en-US'

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
    rec.onresult = (e) => {
      recordVoiceEvent(`EventNew:${key}`, e)
      for (const text of readNewFinals(e)) onResult(text)
    }
    rec.onend  = () => { recordVoiceMark(`EventNew:${key}`, 'end'); setListening(false); setFieldKey(null) }
    rec.onerror = (e) => {
      recordVoiceMark(`EventNew:${key}`, 'error', e && e.error)
      setListening(false); setFieldKey(null)
    }

    recRef.current = rec
    recordVoiceMark(`EventNew:${key}`, 'start')
    rec.start()
    setListening(true)
    setFieldKey(key)
  }, [supported])

  const stop = useCallback(() => {
    recRef.current?.stop()
    setListening(false)
    setFieldKey(null)
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
      {active ? '⏹' : '🎙️'}
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
    is_public:     true,
  })

  // Tier 2 metadata state — { [field.key]: value } — only populated keys submitted
  const { show: showToast, showUndo } = useToast()
  // V4-OVERLAY-001 Slice 2: true only when this form is rendered INSIDE the overlay Sheet. Gates the
  // overlay-only behaviors (in-surface undo, draft stash) so the full-page path is byte-identical.
  const inOverlay = useInOverlaySurface()
  // V4-HARVSESSION-001: session mode is a full-page posture (the overlay keeps its own
  // confirmation strip + draft machinery, untouched).
  const inHarvestSession = harvestSessionParam && !inOverlay
  // Session ledger — every confirmed save this mount. Undone rows stay listed struck-through
  // (excluded from totals): the ledger is an honest record of what happened, not a mutable cart.
  const [sessionRows, setSessionRows] = useState([])
  // V4-HARVSESSION-002: pre-flight queue. Chips come from /api/events/harvest-ready (rank order);
  // tapping one while the form is idle makes it CURRENT (fills planting+project, focuses qty);
  // tapping while a planting is current QUEUES it; Save auto-advances to the next queued planting.
  // `sessionQueue` holds UPCOMING plantings only — current lives in form.plant_id, done derives
  // from sessionRows. This is user-tap seeding, not auto-seeding: the no-auto-seed misattribution
  // guard (BUG-LOGTARGETREQ-001) is untouched because every attribution here is an explicit tap.
  const [readyChips, setReadyChips] = useState([])
  const [sessionQueue, setSessionQueue] = useState([])
  // V4-HARVTRAYVIEWPORT-001: collapsed by cap, not by default — the tray always renders, and the
  // top-ranked chips plus everything the user has queued are always on screen. Sticky once the
  // user expands it: tapping a chip QUEUES it, so a FilterChipRow-style collapse-on-select would
  // shut the tray between every pick of a multi-planting queue. Nothing keyed to keyboard state
  // touches this flag, so it cannot thrash as focus moves between fields.
  const [trayExpanded, setTrayExpanded] = useState(false)
  const [focusQtyNonce, setFocusQtyNonce] = useState(0)
  useEffect(() => {
    if (!inHarvestSession) return
    let off = false
    // BUG-HARVTRAYEMPTY-001: ready candidates ALONE cannot seed the tray — the readiness model is
    // deliberately strict (repeat-habit crops with a set interval, ≥1 prior harvest, DOY window,
    // overdue_ratio ≤ 3 staleness ceiling), so real weigh-ins routinely include plantings it
    // excludes, and a stale dataset (staging) trips the ceiling on EVERYTHING → zero chips. The
    // field-practitioner seat called this in the crucible ("the list will miss volunteer/off-band
    // picks"). Fallback: recent harvest entries (the plantings Dave actually picks), deduped,
    // appended after the ready band's order. Both fetches are best-effort — an empty merge just
    // hides the tray and the picker remains the full path.
    Promise.all([
      apiFetch('/api/events/harvest-ready').catch(() => null),
      apiFetch('/api/harvests?include=entries').catch(() => null),
    ]).then(([readyD, harvD]) => {
      if (off) return
      const ready = (readyD && Array.isArray(readyD.candidates))
        ? rankHarvestReady(readyD.candidates, readyD.et_doy)
        : []
      const seen = new Set(ready.map(c => c.plant_id))
      const recent = []
      for (const e of (harvD?.entries ?? [])) {
        if (!e.plant_id || e.planting_removed || seen.has(e.plant_id)) continue
        seen.add(e.plant_id)
        recent.push({ plant_id: e.plant_id, project_id: e.project_id, name: e.planting_name ?? 'planting', source: 'recent' })
      }
      // V4-READYTRAYIMPRESSION-001 — `source` is the PROVENANCE FLAG (recon §7c called it a blocking
      // prerequisite). Before it, the two producers flattened into one shape and an impression could
      // not tell "the readiness MODEL surfaced this" from "the recency FALLBACK surfaced this" —
      // which is exactly the discrimination any precision claim about the model needs. The ready
      // rows additionally carry their frozen rank coordinate. NOTHING RENDERS ANY OF THESE FIELDS:
      // they exist so the impression log can freeze the model's claim as shown, and every chip
      // consumer below still reads only plant_id / project_id / name.
      const merged = [
        ...ready.map(c => ({
          plant_id: c.plant_id, project_id: c.project_id, name: c.name, source: 'ready',
          overdue_ratio: c.overdue_ratio,
          days_since_last_harvest: c.days_since_last_harvest,
          repeat_interval_days: c.repeat_interval_days,
        })),
        ...recent,
      ].slice(0, 14)
      setReadyChips(merged)
      // Record what was OFFERED, split by what the COLLAPSED tray actually renders. selectTrayChips
      // is called rather than a cap re-derived here, so the region label cannot drift from the
      // pixels. Its user-state arguments are omitted deliberately: nothing has been tapped when the
      // tray first paints, and the only shipped entry point is /log?session=harvest with no &plant=
      // (Harvests.jsx) — so the collapsed set is the top HARVEST_TRAY_COLLAPSED_MAX by rank.
      // NOT awaited and cannot reject (src/lib/readyImpressions.js): a telemetry failure must never
      // reach the weigh-in.
      sendReadyImpressions(apiFetch, merged, selectTrayChips({ chips: merged }).map(c => c.plant_id))
    })
    return () => { off = true }
  }, [inHarvestSession, apiFetch])
  useEffect(() => {
    if (!focusQtyNonce) return
    document.getElementById('harvest-quantity')?.focus()
  }, [focusQtyNonce])
  // V4-HARVESTCENTER-001 (L9): the harvest-log habit-stack trigger. After a harvest saves, offer an
  // ambient "preserve this?" affordance that opens /put-up carrying { prefill } (crop/variety/plant/
  // harvest_log). useOverlaySwap so an in-overlay trigger swaps the SAME overlay's content (preserving
  // the original background); full-page it degrades to a plain navigate. Reward-adjacent, no interrupt.
  const putUpSwap = useOverlaySwap()
  const [preserveCtx, setPreserveCtx] = useState(null)
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

  // V1.2a-2 Wave 3: non-fatal notice (e.g. deep-link project not found).
  const [notice, setNotice] = useState(null)

  const [photoFile,    setPhotoFile]    = useState(null)
  const [photoPreview, setPhotoPreview] = useState(null)
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
    // V4-HARVESTCENTER-001: a fresh type choice clears the lingering "preserve this?" affordance.
    setPreserveCtx(null)
    // V4-WATERMATH-001 F0: a type change is a fresh entry — back to the preselected default.
    setWaterDepth(WATER_DEPTH_DEFAULT); waterDepthTouchedRef.current = false
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
    if (!fromQuick || preselectedEventType !== 'photo') return
    const f = takePendingCapture()
    if (f) { setPhotoFile(f); setPhotoPreview(URL.createObjectURL(f)) }
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
  useEffect(() => {
    const hasSeed = !!(preselectedProjectId || preselectedEventType || preselectedPlantId || resolveEventId || fromQuick)
    if (hasSeed) return
    const draft = readDraft(EVENTNEW_DRAFT_KEY)
    if (!draft || !draft.form) return
    const picked = {}
    for (const k of DRAFT_FORM_FIELDS) if (k in draft.form) picked[k] = draft.form[k]
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
      harvest.quantity || harvest.weight || harvest.quality_rating != null
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
    photoFile || harvest.quantity || harvest.weight ||
    Object.keys(metadataState).length ||
    treatment.pest_target || treatment.product_id || treatment.product_text || treatment.category || treatment.amount ||
    container.type || container.size.trim() ||
    issueOther
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
    apiFetch('/api/plants?project_id=' + form.project_id)
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
  useEffect(() => {
    if (!PROJECTS_HIDDEN) return
    // Cancel guard mirrors the scoped loader above. It had none: this effect re-runs on every
    // apiFetch identity change and on retry, so two responses can land out of order against one
    // setter. Same shape as BUG-PLANTMISMATCH-001, just not yet reached in practice.
    let cancelled = false
    setPlantsLoadFailed(false)
    apiFetch('/api/plants')
      .then(data => { if (!cancelled) setPlantsForProject((data ?? []).filter(p => !p.archived_at)) })
      .catch(() => { if (!cancelled) { setPlantsForProject([]); setPlantsLoadFailed(true) } })
    return () => { cancelled = true }
  }, [apiFetch, plantsReloadKey])

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

  function handlePhotoChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setPhotoFile(file)
    setPhotoPreview(URL.createObjectURL(file))
  }

  // Camera-unification (2026-06-02): one hidden input, capture toggled per choice so the
  // staged-photo flow offers BOTH take-photo and choose-photo, consistent with <PhotoUpload mode="both">.
  const photoInputRef = useRef(null)
  function openPhotoPicker(useCamera) {
    const el = photoInputRef.current
    if (!el) return
    if (useCamera) el.setAttribute('capture', 'environment')
    else el.removeAttribute('capture')
    el.click()
  }

  function clearPhoto() {
    setPhotoFile(null)
    if (photoPreview) URL.revokeObjectURL(photoPreview)
    setPhotoPreview(null)
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

  // V4-HARVSESSION-002: chip → form. Sets BOTH ids from the ready row (plant_id ⇒ project_id
  // invariant — under PROJECTS_HIDDEN the project step never renders, so the chip must carry it).
  function fillFromChip(chip) {
    setForm(f => ({ ...f, plant_id: chip.plant_id, project_id: chip.project_id }))
    setFocusQtyNonce(n => n + 1)
  }
  function tapSessionChip(chip) {
    if (chip.plant_id === form.plant_id) return
    if (sessionQueue.some(q => q.plant_id === chip.plant_id)) {
      setSessionQueue(q => q.filter(x => x.plant_id !== chip.plant_id))
      return
    }
    if (!form.plant_id) fillFromChip(chip)
    else setSessionQueue(q => [...q, chip])
  }

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
  // PRESERVES project_id + plant_id + is_public (scope continuity for rapid sequential
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
      event_date:    toDatetimeLocal(new Date()),
      notes:         '',
      private_notes: '',
      quantity:      '',
      plant_id:      mode === 'type' ? '' : f.plant_id,
      is_public:     f.is_public,
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

  async function handleSubmit(e, { keepMode = 'type' } = {}) {
    e.preventDefault()
    setPreserveCtx(null)
    if (!form.event_type)  { setError('Select an event type above.'); return }
    // V4-LOGTARGET-001 invariant: this gate is also what enforces plant_id ⇒ project_id
    // at submit — a POST can never leave here as {project_id:'', plant_id:X} (the server's
    // exactly_one_parent CHECK would 500 on it). Sticky seeding preserves the same
    // invariant at mount (a remembered plant only seeds alongside its remembered project).
    if (!form.project_id)  { setError('Select a project.'); return }

    // V4-PLANTREQUIRED-001 (Lane 3, flag-gated): per-type required-planting gate (D2 matrix).
    // Inert unless PLANTING_REQUIRED_ENABLED — the planting field is otherwise optional (Lane 2).
    // flag_issue keeps its own plant_id gate below and is not in the vocabulary, so it is unaffected.
    // V4-PROJHIDE-001: when projects are hidden a predicated event has no project step to ride, so the
    // planting is structurally required for those types — implied HERE, independent of the telemetry-
    // gated PLANTING_REQUIRED_ENABLED (the two gates stay decoupled by design).
    if ((PLANTING_REQUIRED_ENABLED || PROJECTS_HIDDEN) && requiresPlanting(form.event_type) && !form.plant_id) {
      setError('Choose a planting for this event.'); return
    }

    // BUG-SNAPATTACH-001: a photo event with no photo is never intentional, and prod has 22 of them
    // out of 582. Two routes produce one outcome: "📷 Photo" is a first-class choice in the type
    // picker so it can simply be saved with nothing attached, and the V4-PHOTOQUICK-001 park/claim
    // seam can drop the file in transit. Both end as a permanent, silent, empty event — the app
    // answers "✓ Logged" and there is nothing to recover, because no upload was ever attempted and
    // so nothing ever failed. Gate it like the harvest quantity gate above: refuse the save, inline,
    // while the photo can still be added. NOT a warn-and-proceed — proceeding is the bug.
    if (form.event_type === 'photo' && !photoFile) {
      setError('Add a photo for a photo event — or pick a different event type.'); return
    }

    // V1.2a-2 Wave 3: harvest panel gate — block the POST on invalid quantity,
    // surface an inline error near the quantity field.
    if (form.event_type === 'harvest') {
      const hErr = validateHarvest()
      if (hErr) { setHarvestError(hErr); return }
      setHarvestError(null)
    }

    // V4-FLAG-001: flag-mode gates — a flag must target a specific planting (so DrG surfaces it)
    // and must carry a severity (required by the events validator + drives DrG urgency).
    if (form.event_type === 'flag_issue') {
      if (!form.plant_id) { setError("Choose the plant you're flagging."); return }
      if (!severity)      { setError('Pick how urgent it is.'); return }
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
    const mergedMeta = { ...metadataState, ...depthMeta, ...(isFlag && issueLabel ? { issue_label: issueLabel } : {}) }
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
          },
        }
      : {}

    // V4-TREATLOG-001: structured treatment fields (only for pest_treatment / doctored).
    const isTreatment = form.event_type === 'pest_treatment' || form.event_type === 'doctored'
    const treatmentPayload = isTreatment
      ? {
          treatment_product_id:   treatment.product_id || null,
          treatment_product_text: treatment.product_text.trim() || null,
          treatment_category:     treatment.category || null,
          treatment_amount:       treatment.amount.trim() || null,
          pest_target:            treatment.pest_target.trim() || null,
        }
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
          is_public:     form.is_public,
          has_photo:     !!photoFile,
          metadata,
          ...harvestPayload,
          ...flagPayload,
          ...treatmentPayload,
        }),
      })
    } catch (err) {
      setSaving(false)
      setError(friendlyError(err))
      return
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
    let photoError = null
    if (photoFile) {
      const photoRes = await photoUploader.upload(photoFile, {
        keyPrefix: 'events',
        parentId:  eventId,
        linkage: {
          project_id: form.project_id,
          event_id:   eventId,
        },
        is_public: form.is_public,
      })
      if (photoRes?.error) photoError = photoRes.error
    }

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

    // V4-HARVESTCENTER-001 (L9): capture the "preserve this?" prefill BEFORE resetForNext clears
    // form.plant_id. Provenance is best-effort — crop/variety resolve off the selected planting's
    // variety_ref; harvest_log_id off the events response's harvest row. At least one of {crop,
    // variety} is what Put-Up needs; if neither resolves, the affordance still opens (user picks a crop).
    // V4-HARVESTVIEW-001 S4a: the crop whose running season total the confirmation card will echo.
    let seasonCropSlug = null
    if (isHarvest && eventId) {
      const selectedPlant = plantsForProject.find(p => p.id === form.plant_id)
      const pf = {}
      if (selectedPlant?.variety_ref?.crop_type_slug) { pf.crop_type_slug = selectedPlant.variety_ref.crop_type_slug; seasonCropSlug = selectedPlant.variety_ref.crop_type_slug }
      if (selectedPlant?.variety_ref?.id) pf.variety_id = selectedPlant.variety_ref.id
      if (form.plant_id) pf.plant_id = form.plant_id
      if (result?.harvest?.id) pf.harvest_log_id = result.harvest.id
      setPreserveCtx({ prefill: pf })
    }

    // V4-HARVSESSION-001: ledger row captured BEFORE resetForNext clears the panel state. grams is
    // display-normalized through the same toGrams the server uses, so the strip's running total
    // agrees with what harvest_log will report.
    const sessionRow = inHarvestSession && isHarvest && eventId
      ? {
          eventId,
          // V4-HARVSESSION-002: plantId feeds the tray's done-✓ derivation.
          plantId: form.plant_id || '',
          plantName: plantName ?? projName,
          qty: harvest.quantity,
          unit: harvest.unit,
          grams: harvest.weight !== '' ? Math.round(toGrams(Number(harvest.weight), harvest.weight_unit) * 10) / 10 : null,
          undone: false,
          undoError: null,
        }
      : null

    resetForNext(keepMode)
    // V4-HARVPOSTSAVESCROLL-001 (BD-017): keepMode 'type' clears plant_id and the confirmation
    // says "pick the next plant" — while the picker itself is left above the fold, so the next
    // planting costs a manual scroll up. Send the user where the copy just told them to go.
    // ONLY on 'type': keepMode 'plant' KEEPS the planting and clears event_type, so the next tap
    // is the event-type row, and scrolling to a picker they are not being asked to touch would be
    // a second defect of the same kind. rAF-deferred so it measures AFTER the reset's commit —
    // the confirmation banner mounts in the same pass and moves everything below it.
    if (keepMode === 'type') {
      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn => setTimeout(fn, 0))
      raf(() => anchorSectionToTop(PLANTING_SECTION_ID))
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
          eventEmoji: EVENT_TYPE_META[form.event_type]?.emoji ?? '✓',
          undone: false,
          error: null,
          photoError,
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
        // V4-HARVSESSION-002 auto-advance: the next queued planting fills in with qty focused, so
        // the steady-state loop is numbers only. Closure-read of sessionQueue is safe here: no chip
        // can be tapped between submit and this line (the same interaction thread is busy saving).
        const [nextChip, ...restQueue] = sessionQueue
        if (nextChip) {
          setSessionQueue(restQueue)
          fillFromChip(nextChip)
        }
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
          message: photoError
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
            {photoPreview ? (
              <div style={{ position: 'relative', display: 'inline-block' }}>
                <img
                  src={photoPreview}
                  alt="Preview"
                  style={{
                    maxWidth: '100%', maxHeight: 220, borderRadius: 8,
                    display: 'block', border: `1px solid ${P.border}`,
                  }}
                />
                <button
                  type="button"
                  onClick={clearPhoto}
                  aria-label="Remove photo"
                  style={{
                    position: 'absolute', top: 8, right: 8,
                    background: 'rgba(0,0,0,0.55)', color: P.white,
                    border: 'none', borderRadius: '50%',
                    width: 28, height: 28, cursor: 'pointer',
                    fontSize: '0.85rem',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >✕</button>
                {!SAVE_TO_DEVICE_HIDDEN && <button
                  type="button"
                  onClick={() => saveFileToDevice(photoFile)}
                  aria-label="Save photo to device"
                  style={{
                    position: 'absolute', bottom: 8, right: 8,
                    background: 'rgba(0,0,0,0.55)', color: P.white,
                    border: 'none', borderRadius: 8, padding: '5px 10px',
                    cursor: 'pointer', fontSize: '0.72rem', fontWeight: 600,
                  }}
                >Save to device</button>}
              </div>
            ) : (
              <div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    type="button"
                    onClick={() => openPhotoPicker(true)}
                    style={{
                      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                      padding: '18px 12px',
                      border: `2px dashed ${P.border}`, borderRadius: 8,
                      cursor: 'pointer', backgroundColor: P.white,
                      color: P.mid, fontSize: '0.88rem', fontWeight: 600,
                    }}
                  >
                    <span style={{ fontSize: '1.3rem' }}>📷</span>
                    <span>Take photo</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => openPhotoPicker(false)}
                    style={{
                      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                      padding: '18px 12px',
                      border: `2px dashed ${P.border}`, borderRadius: 8,
                      cursor: 'pointer', backgroundColor: P.white,
                      color: P.mid, fontSize: '0.88rem', fontWeight: 600,
                    }}
                  >
                    <span style={{ fontSize: '1.3rem' }}>🖼️</span>
                    <span>Choose photo</span>
                  </button>
                </div>
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
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
              <span aria-hidden="true" style={{ fontSize: '1.2rem' }}>🧺</span>
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
                    display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  🚩 Flag an issue
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
  const plantingBlock = (
          <Section id={PLANTING_SECTION_ID} label={(PLANTING_REQUIRED_ENABLED || PROJECTS_HIDDEN) && requiresPlanting(form.event_type) ? 'Planting *' : 'Planting'}>
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
          </Section>
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

          /* ── Tier 2: per-type metadata enrichment (collapsible) ── */
  const metadataBlock = (
          <MetadataSection
            eventType={form.event_type}
            metadataState={metadataState}
            onMetadataChange={handleMetadataChange}
          />
  )

          /* ── V1.2a-2 Wave 3: Harvest panel (harvest events only) ── */
  const harvestBlock = (
          form.event_type === 'harvest' && (
            <Section id={HARVEST_SECTION_ID} label="Harvest *">
              {/* V4-HARVQTYCHIPS-001 — quick-pick chips ABOVE the field, not replacing it.
                  A chip fills the quantity in ONE tap with no keyboard; the field below is
                  untouched, so the 16.8% of harvests outside 1-6 cost exactly what they cost
                  today. Pure addition, no regression on the tail — which is why there is no
                  "More" affordance: the field IS the more affordance.
                  Sits outside <Field> deliberately: Field's frozen contract takes EXACTLY ONE
                  focusable control and clones ARIA onto it (components/forms/Field.jsx), so a
                  chip group inside it would trip contractWarn and steal the input's wiring.
                  Composed from the frozen SelectChip primitive, not a new one (FROZEN.md).

                  BUG-HARVROWOVERFLOW-001 + BUG-HARVUNITVIS-001 — the chip grid is a FULL-WIDTH
                  sibling of the quantity/unit row, NOT nested in that row's flex:2 column.
                  It used to live inside that column, which made both filed defects one defect:
                  six touch chips are minWidth 44 (SelectChip `touch`), so the grid demands
                  6*44 + 5*8 = 304px of min-content, and asking for 304px inside two-thirds of the
                  row forced the whole row to a 399px min-content against a 390px viewport — the
                  overlay Sheet scrolled sideways and the full page scaled down ~2.3%. The same
                  nesting put the unit <Select> beside the CHIPS rather than beside the quantity
                  input, squeezing it to its ~85px minimum where the selected unit is not legible
                  ("it's very easy to miss the unit") — a data-integrity bug on the one form whose
                  purpose is quantity capture, since a wrong-unit harvest logs unnoticed.
                  Full width gives the grid its 304px with room to spare at 390px AND lets the unit
                  take a full third of the row beside the input it actually modifies.
                  The chips are KEPT — Dave's call, they measured 83.2% of quantities — and the
                  <Select> is untouched (replacing it with chips breaks Field's one-control contract). */}
              <div
                role="group"
                aria-label="Harvest quantity quick pick"
                // Grid, not flex-wrap: six equal columns keep the row on ONE line at 375px
                // instead of wrapping to two and doubling the block height from 48px to 104px
                // on the fast path. At full width the 304px min-content clears 375px outright.
                style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, marginBottom: 8 }}
              >
                {QTY_CHIPS.map(q => (
                  <SelectChip
                    key={q}
                    active={harvest.quantity === q}
                    onClick={() => {
                      setHarvest(h => ({ ...h, quantity: q }))
                      if (harvestError) setHarvestError(null)
                    }}
                    touch
                    aria-label={`Harvest quantity ${q}`}
                    data-testid={`qty-chip-${q}`}
                  >
                    {q}
                  </SelectChip>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ flex: 2 }}>
                  <Field label="Quantity *" htmlFor="harvest-quantity">
                    {/* type=text + inputMode=decimal is deliberate and stays: on Chrome Android an
                        invalid intermediate value in a type=number input makes .value return '',
                        which would silently defeat the MAX_PLAUSIBLE[unit] check in validateHarvest(). */}
                    <Input
                      id="harvest-quantity"
                      type="text"
                      inputMode="decimal"
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
                      onFocus={() => anchorSectionToTop(HARVEST_SECTION_ID)}
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
              {/* ── V4-HARVDUAL-001 Slice B: optional weight, alongside the count ──
                  Deliberately SECONDARY to quantity: smaller label, no asterisk, blank by default,
                  and never blocking a save. The count-only path above is the fast path and stays
                  exactly as it was — this row is for when the bowl happens to be near the scale.
                  Its payoff is disproportionate to its size: a count AND a weight together is a
                  per-variety calibration sample, which is what retires the estimated weights. */}
              <div style={{ marginTop: 14 }}>
                <label
                  htmlFor="harvest-weight"
                  style={{ display: 'block', fontSize: '0.74rem', fontWeight: 700, color: P.light, marginBottom: 6, letterSpacing: '0.3px', textTransform: 'uppercase' }}
                >
                  Weight  ·  optional
                </label>
                <div style={{ display: 'flex', gap: 10 }}>
                  <div style={{ flex: 2 }}>
                    <Input
                      id="harvest-weight"
                      type="text"
                      inputMode="decimal"
                      // V4-HARVSESSION-002 (session only): grams → Enter IS the save. Explicit
                      // handler, NOT the form's implicit submission: Save is type="button", and a
                      // multi-input form with no submit button gets no implicit Enter submission,
                      // so without this the Enter key would be dead here.
                      enterKeyHint={inHarvestSession ? 'done' : undefined}
                      onKeyDown={inHarvestSession ? (e => {
                        if (e.key === 'Enter') handleSubmit(e, { keepMode: 'type' })
                      }) : undefined}
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
                <div style={{ marginTop: 5, fontSize: '0.72rem', color: P.light, lineHeight: 1.4 }}>
                  Weigh the whole pick — the count above says how many that was.
                </div>
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
            </Section>
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
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: P.mid, fontSize: '0.82rem', fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', padding: 0, display: 'flex', alignItems: 'center', gap: 6 }}
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

  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 600, margin: '0 auto', padding: '28px 16px 60px' }}>

        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: '0.82rem', color: P.light, marginBottom: 8 }}>
            <Link to="/dashboard" style={{ color: P.green, textDecoration: 'none' }}>Dashboard</Link>
            {' › Log event'}
          </div>
          <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>
            Log an event
          </h1>
          {/* V3-LOGBTN-001: themed ghost button (cream/sage/terra), not a raw text link.
              V4-OVERLAY-001 Slice 2: OverlaySwapLink so this in-overlay cross-link swaps content to
              Log Many while preserving the background (full-page: a plain push, unchanged). */}
          <div style={{ marginTop: 8 }}>
            <OverlaySwapLink
              to="/log/many"
              style={{
                display: 'inline-block', marginTop: 4,
                backgroundColor: P.white, color: P.green,
                border: `1px solid ${P.greenLight}`, borderRadius: 8,
                padding: '8px 14px', fontSize: '0.85rem', fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              Log many →
            </OverlaySwapLink>
          </div>
        </div>

        {error && <ErrorBanner style={{ marginBottom: 16 }}>{error}</ErrorBanner>}
        {notice && <ErrorBanner style={{ marginBottom: 16 }}>{notice}</ErrorBanner>}

        {/* V4-HARVESTCENTER-001 (L9): ambient "preserve this?" affordance after a harvest logs. On
            the overlay path it now renders on the V4-LOGCONF-001 confirmation card (see above); here
            it covers the full-page path and the post-"Log another" form (preserveCtx survives the
            card dismissal so the habit-stack offer isn't lost). */}
        {preserveCtx && (
          <PreserveOffer
            onOpen={() => putUpSwap('/put-up', { state: { prefill: preserveCtx.prefill } })}
            onDismiss={() => setPreserveCtx(null)}
          />
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

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
                  States: current (filled pill), queued (· N position suffix), done (✓ prefix, tap
                  again for a second picking — same-day repeats are separate rows by design). The
                  tray is supplementary: an empty/failed ready fetch renders nothing and the picker
                  below remains the full path for anything not on the list. */}
              {inHarvestSession && readyChips.length > 0 && (() => {
                const donePlantIds = new Set(sessionRows.filter(r => !r.undone && r.plantId).map(r => r.plantId))
                // V4-HARVTRAYVIEWPORT-001. Two bounds, both needed — see src/lib/harvestTray.js for
                // the measured geometry. The label is one line at 390px now (the old copy wrapped to
                // two, ~15px of the very space this row is reclaiming).
                const shownChips = selectTrayChips({
                  chips: readyChips,
                  expanded: trayExpanded,
                  currentPlantId: form.plant_id,
                  queuedPlantIds: sessionQueue.map(q => q.plant_id),
                  donePlantIds,
                })
                const hiddenCount = readyChips.length - shownChips.length
                return (
                  <Section label="Weigh-in queue — tap in weighing order">
                    <div
                      id={HARVEST_TRAY_ID}
                      data-testid="harvest-session-tray"
                      role="group"
                      aria-label="Weigh-in queue"
                      // The scrollport clips the TRAY only. plantingBlock is a later sibling, not a
                      // descendant, so this overflow context cannot clip the picker's listbox the way
                      // BUG-PICKERCLIP-001 did.
                      style={{ display: 'flex', flexWrap: 'wrap', gap: 8, ...harvestTrayScrollport }}
                    >
                      {shownChips.map(chip => {
                        const isCurrent = chip.plant_id === form.plant_id
                        const queuePos = sessionQueue.findIndex(q => q.plant_id === chip.plant_id)
                        const isDone = donePlantIds.has(chip.plant_id)
                        return (
                          // Wrapper carries the done-dimming: SelectChip spreads ...rest AFTER its
                          // own style, so a style prop would REPLACE the chip's styling wholesale.
                          <span key={chip.plant_id} style={isDone && !isCurrent ? { opacity: 0.55 } : undefined}>
                            <SelectChip
                              active={isCurrent}
                              touch
                              onClick={() => tapSessionChip(chip)}
                              aria-label={`${chip.name}${isCurrent ? ' — weighing now' : queuePos >= 0 ? ` — queued ${queuePos + 1}` : isDone ? ' — logged, tap to weigh again' : ''}`}
                              data-testid={`session-chip-${chip.plant_id}`}
                            >
                              {isDone ? '✓ ' : ''}{chip.name}{queuePos >= 0 ? ` · ${queuePos + 1}` : ''}
                            </SelectChip>
                          </span>
                        )
                      })}
                    </div>
                    {(hiddenCount > 0 || trayExpanded) && (
                      // OUTSIDE the scrollport deliberately: a "Show fewer" that scrolls out of
                      // view with the chips is a trap. Same disclosure grammar as the "Photo, notes
                      // & date" toggle below, so the two read as one language — but with a touch
                      // height, because this one is tapped with produce in hand.
                      <button
                        type="button"
                        onClick={() => setTrayExpanded(x => !x)}
                        aria-expanded={trayExpanded}
                        aria-controls={HARVEST_TRAY_ID}
                        data-testid="harvest-tray-toggle"
                        style={{ marginTop: 8, background: 'none', border: 'none', cursor: 'pointer', color: P.mid, fontSize: '0.82rem', fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', padding: '8px 0', minHeight: 44, display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'inherit' }}
                      >
                        <span aria-hidden="true">{trayExpanded ? '▾' : '▸'}</span>
                        <span>{trayExpanded ? 'Show fewer' : `Show ${hiddenCount} more`}</span>
                      </button>
                    )}
                  </Section>
                )
              })()}
              {projectBlock}
              {plantingBlock}
              {harvestBlock}
              {eventTypeBlock}

              <div style={{ backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: '12px 18px' }}>
                <button
                  type="button"
                  onClick={() => setShowHarvestMore(s => !s)}
                  aria-expanded={showHarvestMore}
                  data-testid="harvest-more-toggle"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: P.mid, fontSize: '0.82rem', fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', padding: 0, display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <span aria-hidden="true">{showHarvestMore ? '▾' : '▸'}</span>
                  <span>Photo, notes &amp; date  ·  optional</span>
                </button>
                {showHarvestMore && (
                  <div data-testid="harvest-more-body" style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {photoBlock}
                    {notesBlock}
                    {metadataBlock}
                    {whenBlock}
                  </div>
                )}
              </div>

              {addDetailsBlock}
            </>
          ) : (
            /* ── Every non-harvest type: the shipped V4-LOGPHOTOFIRST-001 sequence, unchanged. ── */
            <>
              {photoBlock}
              {eventTypeBlock}
              {treatmentBlock}
              {waterDepthBlock}
              {projectBlock}
              {plantingBlock}
              {containerBlock}
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
                            there, so clear it. BOTTOM_NAV_HEIGHT_PX + 12, imported rather than the
                            old magic `68` — which was 56+12 hardcoded and free to silently desync.
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
              bottom: inOverlay ? 0 : BOTTOM_NAV_HEIGHT_PX + 12,
              zIndex: 1,
              display: 'flex',
              flexDirection: 'column',
              visibility: pickerOpen ? 'hidden' : 'visible',
              pointerEvents: pickerOpen ? 'none' : 'auto',
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
              return (
                <div data-testid="harvest-session-strip" style={{ backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: '10px 14px', marginBottom: 10, boxShadow: '0 2px 12px rgba(0,0,0,0.10)' }}>
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
              {inOverlay && (
                <button type="button" onClick={dismissOverlay} style={confirmBtnGhost}>
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
                }}
              >
                Save
              </Button>
            </div>
          </div>


        </form>
      </div>
    </div>
  )
}


// V4-FLAG-001: Flag mode body — severity (required, 3 buttons) + a static seeded issue dropdown
// with an "Other" (type OR voice via the shared MicBtn). The chosen issue is stored as free-text
// metadata.issue_label; severity is the DB smallint. Order per spec: severity -> issue.
function FlagModeFields({ severity, onSeverity, issueChoice, onIssueChoice, issueOther, onIssueOther, voice, onBack }) {
  const TONE = { gold: P.gold, terra: P.terra, red: P.severityUrgent }
  const EMOJI = { 1: '🟡', 2: '🟠', 3: '🔴' }
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
              style={{ textAlign: 'left', padding: '11px 14px', borderRadius: 10, cursor: 'pointer',
                border: `2px solid ${active ? tone : P.border}`, backgroundColor: active ? tone : P.white,
                color: active ? P.white : P.mid, fontWeight: 600, fontSize: '0.88rem', fontFamily: 'inherit' }}>
              {EMOJI[sv.value]} {sv.label}
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
            <option value="__other__">➕ Other…</option>
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

// V4-HARVESTCENTER-001 (L9) "preserve this?" offer — ONE definition, TWO hosts: the V4-LOGCONF-001
// confirmation card (injected into PostSaveFeedback via its `preserve` prop) and the form view
// below. Deliberately stays in this file so the card cannot own it. Reward-adjacent, ambient,
// dismissible. Both hosts are pinned by EventNewPostSaveFeedback.characterization.test.jsx.
function PreserveOffer({ onOpen, onDismiss }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, marginBottom: 16, flexWrap: 'wrap',
      backgroundColor: P.greenPale, border: `1px solid ${P.greenLight}`, borderRadius: 10, padding: '12px 14px',
    }}>
      <span style={{ flex: 1, minWidth: 160, fontSize: '0.9rem', fontWeight: 600, color: P.green }}>
        Putting any of this up for later?
      </span>
      <button type="button" onClick={onOpen}
        style={{ background: P.green, color: P.white, border: 'none', borderRadius: 6,
          padding: '7px 14px', fontSize: '0.85rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
        Log a put-up
      </button>
      <button type="button" onClick={onDismiss}
        style={{ background: 'transparent', color: P.green, border: `1px solid ${P.greenLight}`, borderRadius: 6,
          padding: '7px 12px', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
        Not now
      </button>
    </div>
  )
}

// V4-EVENTSEL-005: `Section` was declared identically here and in LogMany.jsx. It is now imported
// from the shared components/FormSection.jsx (see the import at the top of this file). No `style`
// is passed at the call sites — these sections are flex children of the gap:16 <form>, so the card
// deliberately carries no outer margin of its own.

// SuccessScreen retained for reference; V1.2a-1 flow navigates straight to dashboard.
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
        {eventMeta?.emoji ?? '✅'}
      </div>
      <div style={{
        width: 52, height: 52,
        borderRadius: '50%',
        backgroundColor: P.green,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        margin: '0 auto 20px',
        fontSize: '1.4rem', color: P.white,
      }}>
        ✓
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
