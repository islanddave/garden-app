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
import { EVENT_TYPE_META, requiresPlanting, isPlantReductionEventType, canonicalEventType } from '../lib/eventTypes.js'
import { PROJECTS_HIDDEN, HARVEST_QUALITY_HIDDEN, SAVE_TO_DEVICE_HIDDEN, WEIGH_IN_FRAME_ENABLED } from '../lib/featureFlags.js'
import EventTypePicker, { EVENT_TYPES_UI, SECONDARY_GROUPS } from '../components/forms/EventTypePicker.jsx'
// Shared with the planting page's Save seed button so both doors run one flow.
import SaveSeedSheet from '../components/planting/SaveSeedSheet.jsx'
import { useUploadPhoto } from '../hooks/useUploadPhoto.js'
import { HARVEST_UNITS, MAX_PLAUSIBLE, WEIGHT_UNITS, MAX_PLAUSIBLE_WEIGHT_G, toGrams } from '../lib/harvest-constants.js'

// Quantity entry: most harvests are a whole number 1-6, so the fast path is one tap that does not
// raise the soft keyboard (NumberPad's digit builder). The free-text field stays underneath for the
// tail.

// How much the bottom spacer grows while the post-save feedback zone renders, so the last control
// still clears the sticky band. A CSS-derived estimate, not a measurement (jsdom has no rects): the
// device harness checks the real number, and this constant is the one place to correct it.
const POST_SAVE_STRIP_SPACER_PX = 86
import { seasonTotalPhrase } from '../lib/harvestSummary.js'
import { useUxFlow, FLOWS, sendUxEvent } from '../lib/uxEvents.js'

// Matches PhotoUpload's DEFAULT_MAX_FILES, not the server's MAX_BATCH of 20.
const MAX_EVENT_PHOTOS = 10
let eventPhotoSeq = 0
const nextPhotoId = () => `evphoto-${++eventPhotoSeq}`
import { Field, Input, Select, Textarea, Button, ErrorBanner, PlantingSelect } from '../components/forms'
import { T } from '../components/forms/formStyles.js'
import { snapshotFile, snapshotFiles } from '../lib/fileSnapshot.js'
import { useCachedFetch } from '../hooks/useCachedFetch.js'
import { CROP_CHIPS_AUTO } from '../components/forms/PlantingSelect.jsx'
import TreatmentDetails from '../components/TreatmentDetails.jsx'
import Section from '../components/FormSection.jsx'
// All glyphs come from the Icon registry; nothing here renders a pictographic character except the
// reward ornament in the unused SuccessScreen (see its header).
import Icon from '../components/Icon.jsx'
import PostSaveFeedback, { confirmBtnGhost } from '../components/PostSaveFeedback.jsx'
import { useToast } from '../context/ToastContext.jsx'
import { useInOverlaySurface, useOverlayDismiss, useReportOverlayDirty } from '../context/OverlayContext.jsx'
import { readDraft, writeDraft, clearDraft } from '../lib/draftStash.js'
import { setReloadBlocked } from '../lib/reloadGate.js'
// Crop-rank ledger, fed at the same post-save moment as logone.lastPlant; PlantingSelect reads it at
// picker open to order its crop chips.
import { recordCropLog } from '../lib/cropLogLedger.js'
import { HARVEST_WRITE_TIMEOUT_MS } from '../lib/harvestWriteTimeout.js'
// Watering amount class. src/lib/waterDepth.js has the metadata contract with the events Lambda and
// why it is not quantity_numeric.
import WaterDepthChips from '../components/WaterDepthChips.jsx'
import HarvestDispositionChips from '../components/HarvestDispositionChips.jsx'
import NumberPad from '../components/NumberPad.jsx'
// The sticky Save band's height is not constant, so the keypad's clearance is resolved against the
// band as rendered. Rule and numbers: src/lib/saveBandLayout.js.
import { SAVE_BAND_BOTTOM_INSET_PX, FRAME_SAVE_HEIGHT_PX, clearWeightPadOfSaveBand, clearControlOfSaveBand, framePadGapPx } from '../lib/saveBandLayout.js'
import { orderByThumb } from '../lib/handedness.js'
import { useHandedness } from '../hooks/useHandedness.js'
import { toLocalISO, todayLocalISO } from '../lib/dateLocal.js'
import {
  WATER_DEPTH_DEFAULT, isWaterDepthType, waterDepthMetadata, waterDepthLabel, WATER_DEPTH_CHIPS,
} from '../lib/waterDepth.js'
import { EVENT_METADATA_FIELDS, HARVEST_QUALITY_LABELS, PLANT_CONTAINER_TYPE_OPTIONS, SEVERITY_LEVELS, ISSUE_OPTIONS } from '../lib/dropdownRegistry.js'
// The plant-reduction panel is required, so it sits with harvest/treatment/severity and not in
// EVENT_METADATA_FIELDS (optional-only). Wire contract: src/lib/plantReduction.js.
import PlantReductionFields from '../components/PlantReductionFields.jsx'
import EndStatusOffer from '../components/EndStatusOffer.jsx'
import { validateReductionInput, buildReductionMetadata } from '../lib/plantReduction.js'

// Re-exported for importers of EventNew.jsx (EventTypesPhase1.test.jsx).
export { EVENT_TYPE_META }

export { EVENT_TYPES_UI, SECONDARY_GROUPS }

const DEFAULT_HARVEST_UNIT = 'count'

// Harvest unit default, strongest signal first:
//   1. lastHarvestUnit:<crop slug>, the user's own history for this crop;
//   2. crop_types.default_unit (cropDefaultUnit), curated, so it only decides a crop never harvested;
//   3. lastHarvestUnit (global), a cross-crop guess that can put "cups" onto a count crop;
//   4. 'count'.
// Every value is checked against HARVEST_UNITS so a retired DB value never reaches the <select>.
// localStorage is guarded because tests may lack it or have it throw.
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

// The weight half remembers its own unit: the scale reads the same unit every time while the
// quantity unit changes per crop. Sharing one key would make them fight.
const DEFAULT_WEIGHT_UNIT = 'g'
function readLastWeightUnit() {
  try {
    const stored = localStorage.getItem('lastHarvestWeightUnit')
    if (stored && WEIGHT_UNITS.includes(stored)) return stored
  } catch { /* localStorage unavailable — fall through to default */ }
  return DEFAULT_WEIGHT_UNIT
}

// Three places reset the harvest panel (type change, Save & Next, mount); one builder keeps them in
// step.
const freshHarvest = () => ({
  quantity:       '',
  unit:           readLastHarvestUnit(),
  quality_rating: null,
  weight:         '',
  weight_unit:    readLastWeightUnit(),
  // null = a normal pick. Not sticky like the units: a disposition describes one pick, and carrying
  // "aborted" forward would mislabel the next harvest.
  disposition:    null,
})

// Last chosen project (a bare id), validated against live projects on load. Still written on every
// save as the project-level fallback for plant-less saves.
const LAST_PROJECT_KEY = 'logone.lastProject'
// Last saved planting. Only a ranking signal (PlantingSelect's recentPlantId, read at picker open),
// never a pre-fill: a cold mount with no draft and no deep link must not pre-target a planting. A
// plant-less save removes it. Old cached PWA bundles still seed from this key, so do not rename it or
// stop writing it on save: a key that stopped updating would seed a stale planting.
const LAST_PLANT_KEY = 'logone.lastPlant'

// Draft stash. Only `form` is stashed: the type-specific panels are reset by the event_type effect,
// so restoring them would be clobbered. project_id is excluded so the load effect's validated project
// stands.
const EVENTNEW_DRAFT_KEY = 'logone'
// A draft may persist only what the user can see. is_public has no control in this form, so
// persisting it would carry a stale false forward and hide every later harvest from the public site.
const DRAFT_FORM_FIELDS = ['event_type', 'notes', 'private_notes', 'quantity', 'event_date', 'plant_id']

// Scroll only, never viewport arithmetic. index.html ships interactive-widget=resizes-content, so the
// browser keeps scrollTop across the keyboard resize: anchoring the section header before the keyboard
// opens leaves it at the top after. This file must stay free of `visualViewport`
// (noViewportInsetArithmetic.static.test.js).
const HARVEST_SECTION_ID = 'harvest-section'
const PLANTING_SECTION_ID = 'planting-section'
// The chooser's own hit target, not its Section wrapper: the wrapper's label sits above the input,
// and clearing that would leave the input itself under the band.
const PLANTING_CHOOSER_SELECTOR = '[aria-label="Plant or group"]'
// One spelling of the unscoped picker path. PlantingSelect's self-fetch builds the same string, so
// both share one dataCache entry.
const PICKER_PATH = '/api/plants?view=picker'
// aria-controls target for the weigh-in tray's Show more/fewer disclosure.
const HARVEST_TRAY_ID = 'harvest-session-tray'
// The session save the server kept once (see the setSessionRows site).
const KEPT_ONCE_NOTICE = 'That matched your last save, so it was kept once.'

// `block:'start'` puts the section header at the viewport top so the rest of the panel falls into
// the space the keyboard leaves. jsdom has no scrollIntoView, so absence is a silent no-op. Returns
// whether it ran so tests can assert the call.
function anchorSectionToTop(id, behavior = 'smooth') {
  if (typeof document === 'undefined') return false
  const el = document.getElementById(id)
  if (!el || typeof el.scrollIntoView !== 'function') return false
  el.scrollIntoView({ block: 'start', behavior })
  return true
}

// Weigh-in frame (flag WEIGH_IN_FRAME_ENABLED).
// TopChrome's detail bar is sticky, 52px tall and not keyboard-suppressed, so the frame's full height
// is `calc(100dvh - 52px)`. A bare 100dvh would push the Save row below the fold.
const FRAME_HEIGHT = 'calc(100dvh - 52px)'
// The ledger + Save row. Constant, so the frame does not grow across saves.
const FRAME_LEDGER_PX = 48
// The gap the weight pad owes Save, so a low backspace press lands on track 3's own container
// (painted but handler-less) rather than on the commit. Derived from the ledger height and Save's
// height (lib/saveBandLayout.js) so it keeps meaning SAVE_BAND_MIN_CLEARANCE_PX; the real-engine gate
// holds it.
const FRAME_PAD_GAP_PX = framePadGapPx(FRAME_LEDGER_PX)
// NumberPad's own `marginBottom: 8`, cancelled from outside at both pads rather than changed in
// NumberPad.jsx.
const NUMBERPAD_MARGIN_BOTTOM_PX = 8

// Mirror task controls, never chrome: only the Save button's edge and the ledger's Undo column follow
// handedness. orderByThumb reorders the array rather than using row-reverse, which would make DOM and
// visual order disagree (WCAG 1.3.2 / 2.4.3). Not mirrored: the Harvests-header Weigh-in button,
// BottomNav, digit order.

// The session hides BottomNav the way keyboard suppression does: `visibility: hidden` on the <nav>
// plus `--bottom-nav-height: 0px` together, so paint and reserved inset never disagree for a frame
// (BottomNav.jsx states that invariant). Effect cleanup restores it on unmount, flag-off and route
// change.
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
      // Restore the previous value, not a constant: BottomNav owns this var and may have been
      // mid-suppression (keyboard up) when the session mounted. Empty means never set, so remove it.
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

// Never render a raw server error string: map known patterns to canned copy, else a safe generic.
function friendlyError(err) {
  const raw = (err && err.message) ? String(err.message) : ''
  const status = err && err.status
  // Over-reduction: the events Lambda refuses with a 409 and a sentence already written for a human
  // ("this planting has 5 left, so 7 cannot be removed"). Pass it through, capitalised only: the
  // generic 4xx line would drop the numbers. Keyed on the machine `code`, not the prose.
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

// Compact label for a `YYYY-MM-DD` string in the weigh-in frame: "Today"/"Yesterday" are what the
// user is checking for. Parsed with the local-calendar constructor, not `new Date('YYYY-MM-DD')`,
// which is UTC midnight and renders as the previous day west of Greenwich.
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
  // The hold belonging to the currently live recogniser, so start() and stop() can hand it back.
  // Handlers use their own per-recogniser copy instead; see the note at `myMicToken`.
  const micTokenRef = useRef(null)
  // Shape telemetry only. Routed through useApiFetch rather than Clerk directly so the EventNew tests
  // that mock '../lib/api.js' neutralise it automatically.
  const { getToken } = useApiFetch()

  const supported = typeof window !== 'undefined' &&
    !!(window.SpeechRecognition || window.webkitSpeechRecognition)

  const start = useCallback((key, onResult) => {
    if (!supported) return

    // The outgoing recogniser must be muted, not merely stopped: `stop()` asks the engine to
    // finalise, which can dispatch one more onresult on the old instance, still closed over the old
    // onResult and appending into the field the new session is about to use. Detach first.
    const prev = recRef.current
    if (prev) {
      prev.onresult = null
      prev.onend    = null
      prev.onerror  = null
      try { prev.stop() } catch { /* already dead */ }
    }
    // Hand our own hold back before taking a new one, or the acquire below evicts us and runs the
    // stop() closure against the instance just detached. Field-to-field dictation hits this every tap.
    releaseMic(micTokenRef.current)

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    const rec = new SR()
    rec.continuous    = false
    rec.interimResults = false
    rec.lang          = 'en-US'

    // Per-recogniser, deliberately not read off micTokenRef inside the handlers: onend arrives after
    // the next field's start() has re-pointed the ref, so releasing `micTokenRef.current` would hand
    // back the new field's hold and leave the live mic ownerless.
    let myMicToken = null

    // This hook does not go through src/lib/transcribe.js, so dedupe there never covers it.
    // event.results is cumulative for the session and Chrome on Android can dispatch a second onresult
    // even with continuous=false; reading a fixed index re-appends words the user said once (three of
    // the four MicBtn call sites append). createFinalResultReader() keeps a high-water mark so each
    // result index is emitted at most once per recogniser.
    const readNewFinals = createFinalResultReader()
    // Shape-only voice telemetry that ships without a debug flag; voiceDebug.js still writes the full
    // local log behind its flag.
    const shape = createVoiceShapeRecorder()
    let emitted = 0
    rec.onresult = (e) => {
      recordVoiceEvent(`EventNew:${key}`, e)
      shape.observe(e)
      for (const text of readNewFinals(e)) { emitted += 1; onResult(text) }
    }
    rec.onend  = () => {
      recordVoiceMark(`EventNew:${key}`, 'end')
      // Isolated: telemetry that throws into onend would break the listening-state reset below.
      // Sent only when something was transcribed; a cancelled or silent session would dilute the rate.
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
    // Acquire in the same frame as rec.start(). Eviction detaches before aborting: a graceful stop()
    // asks the engine to finalise, and that late dispatch would append into a field the user has left.
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

  // Release the mic on unmount, or a recogniser started here outlives the page: the mic indicator
  // stays lit, handlers set state on a dead component, and a remount can run a second recogniser.
  // Detach before aborting (a teardown can still dispatch), and abort() rather than stop(): stop()
  // asks the engine to finalise, which is the dispatch we must not receive.
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

// Do not reintroduce a visualViewport inset hook here. index.html carries
// `interactive-widget=resizes-content`, so the layout viewport shrinks with the keyboard and
// bottom-anchored elements need no JS lift. Under Chrome Android's default `resizes-visual` the inset
// is the whole keyboard height and hoisted the sticky Save into the planting picker's listbox; a stale
// precached shell can also flip the inset between ~0 and ~430px on the same build.
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
      {/* Touch target (WCAG 2.5.5): the visual circle stays 30px because the textarea call sites
          position it by its edge. This transparent child extends the tappable area 7px past the
          circle on every side (44px) and gets the click by bubbling. Every call site reserves
          paddingRight: 44, so nothing overlaps the field text. */}
      <span aria-hidden="true" style={{ position: 'absolute', top: -7, right: -7, bottom: -7, left: -7 }} />
      {/* Decorative: the button's aria-label already names both states. */}
      <Icon name={active ? 'media.stop' : 'media.mic'} size={16} decorative />
    </button>
  )
}

// Collapsible per-type metadata fields.
function MetadataSection({ eventType, metadataState, onMetadataChange }) {
  const [open, setOpen] = useState(false)
  // Harvest has its own structured panel, so it gets no "More details" fields.
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

// `harvestSession` is the prop form of `?session=harvest`, set by HarvestLog when its selector is on
// Manual. A prop rather than writing the param into HarvestLog's URL, which would put two spellings
// of the same state in the address bar and make the App.jsx redirect ambiguous.
export default function EventNew({ harvestSession = false } = {}) {
  const navigate       = useNavigate()
  // Set once the sheet has put seed into an existing lot and this page is leaving for the planting's;
  // see the SaveSeedSheet render site.
  const seedAddedRef = useRef(false)
  const [searchParams] = useSearchParams()
  const preselectedProjectId = searchParams.get('project') || ''
  // A saved or stale link can still say ?event_type=failed / given_away.
  const preselectedEventType = canonicalEventType(searchParams.get('event_type') || '')
  const preselectedPlantId = searchParams.get('plant') || ''
  // Treated… deep link: resolve this source finding after the treatment logs.
  const resolveEventId = searchParams.get('resolve') || ''
  const fromQuick = searchParams.get('fromquick')
  // The weigh-in session (prop or ?session=harvest; same state by two routes, so downstream reads
  // only this name). Pins event_type=harvest at mount, locks the type, and replaces the post-save
  // toast with the in-band session ledger. Full-page only: `inHarvestSession` (below inOverlay) is the
  // gate; an overlay with this param behaves like ?event_type=harvest.
  const harvestSessionParam = harvestSession || searchParams.get('session') === 'harvest'
  const { fetch: apiFetch, getToken } = useApiFetch()
  // log_watering flow telemetry; counts only waterings. Fire-and-forget, never affects the save.
  const ux = useUxFlow(FLOWS.LOG_WATERING)

  const voice = useVoiceInput()

  // 'swallow' mode: the event is already saved when upload() runs, so a photo failure must not take
  // down the success flow.
  const photoUploader = useUploadPhoto({ errorMode: 'swallow' })

  // Cold-mount project: a deep-linked ?project= wins, else the last chosen project (validated in the
  // load effect). Read once so an in-session save that rewrites localStorage never re-seeds this
  // mount. plant_id seeds from ?plant= only (see LAST_PLANT_KEY). Project seeding stays on purpose:
  // under PROJECTS_HIDDEN, exempt-type logs rely on it.
  const [rememberedProjectId] = useState(readLastProjectId)

  const [form, setForm] = useState({
    // In session mode harvest wins over any stray ?event_type=: the picker is hidden, so a
    // non-harvest seed would strand the form typeless.
    event_type:    harvestSessionParam ? 'harvest' : preselectedEventType,
    project_id:    preselectedProjectId || rememberedProjectId,
    location_id:   '',
    event_date:    toDatetimeLocal(new Date()),
    notes:         '',
    private_notes: '',
    quantity:      '',
    plant_id:      preselectedPlantId,
  })

  const { show: showToast, showUndo } = useToast()
  // True only inside the overlay Sheet. Gates overlay-only behaviour (in-surface undo, draft stash).
  const inOverlay = useInOverlaySurface()
  // Session mode is full-page only; the overlay keeps its own confirmation strip and draft machinery.
  const inHarvestSession = harvestSessionParam && !inOverlay
  // One predicate for the whole weigh-in frame, so it cannot ship half-on: every frame branch and the
  // nav suppression read this name.
  const sessionFrame = inHarvestSession && WEIGH_IN_FRAME_ENABLED
  const hand = useHandedness()
  useSuppressBottomNav(sessionFrame)
  // The frame's history drawer (last 10 rows), opened by tapping the ledger summary.
  const [frameLogOpen, setFrameLogOpen] = useState(false)
  // The date control is a transparent native <input type="date"> over a formatted chip, so a tap
  // opens the system picker directly. An opacity-0 input takes focus invisibly, so the focus ring is
  // painted on the wrapper; without it the control is keyboard-reachable but invisible.
  const [frameDateFocused, setFrameDateFocused] = useState(false)
  // Track 2's scroll container. Post-save the frame restores this rather than re-anchoring: every
  // entry already ends where it started.
  const frameBodyRef = useRef(null)
  // Session ledger: every confirmed save this mount. Undone rows stay listed struck-through and are
  // excluded from totals.
  const [sessionRows, setSessionRows] = useState([])
  // After an overlay save the user gets a durable confirmation: no timer, cleared only by the next
  // save or the overlay closing (the global toast is invisible to AT behind aria-modal). It feeds a
  // non-blocking strip in the sticky Save band; the form stays mounted underneath.
  // { eventId, projectId, projName, eventLabel, eventEmoji, undone, error } | null. projectId comes
  // from the POST response, not staged client state.
  const [confirmation, setConfirmation] = useState(null)
  // Successful overlay saves since this mount; dies with the overlay. Counts all event types and is
  // never an identity or role check. Rendered only at >= 2 (see PostSaveFeedback).
  const [savesThisSession, setSavesThisSession] = useState(0)
  // Ambient "Season: 4.5 cups blueberry" line on the post-save feedback. Best-effort, overlay-only;
  // null unless the harvest resolved a crop and the aggregates GET returned a total.
  const [seasonLine, setSeasonLine] = useState(null)
  const dismissOverlay = useOverlayDismiss()
  const [metadataState, setMetadataState] = useState({})
  // Treatment capture (pest_treatment / doctored).
  const [treatment, setTreatment] = useState({ pest_target: '', product_id: '', product_text: '', category: '', amount: '' })
  const [inventory, setInventory] = useState([])

  // Optional new-container capture for potting_up/transplant on a specific planting. On submit it
  // PUTs the planting's container_type/container_size via /api/plants; not stored as event metadata.
  const [container, setContainer] = useState({ type: '', size: '' })

  // Watering amount class, preselected Normal so the default path costs no taps. The touched ref
  // keeps `water_depth_source` honest; that field is what the instrumentation gate measures, and
  // without the ref every row would read 'user'.
  const [waterDepth, setWaterDepth] = useState(WATER_DEPTH_DEFAULT)
  const waterDepthTouchedRef = useRef(false)

  // Harvest panel state, submitted only for event_type=harvest.
  const [harvest, setHarvest] = useState(freshHarvest)
  // The event_type a draft restore installed, so the type-change reset can skip that one synthetic
  // transition. Null whenever no restore is in flight.
  const draftRestoredTypeRef = useRef(null)
  const [harvestError, setHarvestError] = useState(null)
  // True once the user picks a unit for the current entry, so the per-crop re-seed effect never
  // overrides it. Reset with the entry (type change, resetForNext) and on a planting swap: a pick
  // made under planting A says nothing about the replacement's crop.
  const unitTouchedRef = useRef(false)

  // flag_issue mode. Severity is required; the issue is a seeded label or a free-typed/voiced 'Other'
  // (metadata.issue_label).
  const [severity, setSeverity] = useState(null)
  const [issueChoice, setIssueChoice] = useState('')
  const [issueOther, setIssueOther] = useState('')

  // Plant-reduction capture (failed / given_away). Both fields are required by the API, so this is
  // panel state, not metadataState (the optional "More details" disclosure).
  const [reduction, setReduction] = useState({ qty: '', reason: '' })
  const [reductionError, setReductionError] = useState(null)
  // The 201's `plant_reduction` payload, held only while the offer sheet is up. Captured with its
  // planting because resetForNext() clears form.plant_id in the same tick.
  const [endStatusOffer, setEndStatusOffer] = useState(null)

  // Non-fatal notice (e.g. deep-link project not found).
  const [notice, setNotice] = useState(null)
  // { done, total } while picked files are copied out of the picker's handles, else null. Picking does
  // real I/O and must not look like a dead tap.
  const [photoPreparing, setPhotoPreparing] = useState(null)

  // Staged photos, [{ id, file, url }] in pick order; handleSubmit uploads them all.
  const [photoItems, setPhotoItems] = useState([])
  // Removal is deferred, not destructive: nothing in the app can re-create a revoked blob, so one
  // mis-tap on a small remove control would cost a trip back to the gallery. The removed item parks
  // here (one slot, with its index) and its URL is released only when the removal is committed: a
  // newer removal, a fresh pick, the post-save reset, or unmount. `removedPhotoRef` mirrors it because
  // the unmount cleanup closes over the mount-time value; without the ref the deferral would leak.
  const [removedPhoto, setRemovedPhoto] = useState(null)
  const removedPhotoRef = useRef(null)
  const [projects,     setProjects]     = useState([])
  const [locations,    setLocations]    = useState([])
  const [saving,       setSaving]       = useState(false)
  // `saving` is React state, so a second submit in the same frame (two Enters, two clicks) reads the
  // old closure and posts again. This ref is the synchronous half of the guard; see handleSubmit.
  const submitInFlight = useRef(false)
  const [error,        setError]        = useState(null)
  const [showPrivate,  setShowPrivate]  = useState(false)
  // Bumped by resetForNext() to mark the planting picker fresh again.
  const [pickerResetNonce, setPickerResetNonce] = useState(0)
  // "Add details" disclosure (Quantity / Visibility / Private notes), collapsed at start.
  const [showAddDetails, setShowAddDetails] = useState(false)
  // The harvest-only disclosure holding Photo / Notes / Project / Metadata / When, collapsed by
  // default so the harvest fast path is Planting → Quantity → Unit. The hook is unconditional even
  // though only harvest renders it.
  const [showHarvestMore, setShowHarvestMore] = useState(false)
  // Notes is collapsed and sits at the end of the non-harvest form so the required Planting field
  // stays above the fold. Harvest's Notes lives inside showHarvestMore's disclosure.
  const [showNotes, setShowNotes] = useState(false)
  const [plantsForProject, setPlantsForProject] = useState([])
  // A failed load must not render as "No plantings yet.", which reads as an empty project on a field
  // that is required for plant-predicated types. The reload key re-runs whichever loader is live.
  const [plantsLoadFailed, setPlantsLoadFailed] = useState(false)
  const [plantsReloadKey, setPlantsReloadKey] = useState(0)
  // The planting picker's listbox opens into the band the sticky Save occupies. Save painted over
  // result rows and took their taps; for an exempt type that saved the event with plant_id: null and
  // cleared LAST_PLANT_KEY. Save is never the next action while a picker is open, so it is hidden.
  const [pickerOpen, setPickerOpen] = useState(false)
  // The remembered planting as a ranking signal, read at picker open (not mount) so a save that
  // rewrites logone.lastPlant ranks fresh for the next harvest. Passed as PlantingSelect's
  // recentPlantId (position-1 pin + "recent" marker; filters win).
  const [recentPlantId, setRecentPlantId] = useState('')
  // Stable identity: PlantingSelect reads this through a ref and keys its effect on `open` alone, but
  // a stable handler keeps any future consumer that keys on the callback safe.
  const handlePickerOpenChange = useCallback(open => {
    setPickerOpen(open)
    if (open) setRecentPlantId(readLastPlantId())
  }, [])
  // Auto-open the planting picker on the FAB's harvest arrival, and only there: event_type=harvest
  // with no ?plant= (a deep link already answered), no ?project= (HarvestReadyTile and the old PWA
  // shortcut url also carry event_type=harvest; the old url keeps launching from launcher caches), and
  // no draft (resuming, not starting). The restore effect already bails on any seed, so the draft guard
  // is belt-and-braces; it is stated here because that coupling belongs to the draft predicate. Lazy
  // state: a fact about the arrival, evaluated once.
  const [harvestFabAutoOpen] = useState(() => (
    preselectedEventType === 'harvest' && !preselectedPlantId && !preselectedProjectId &&
    !readDraft(EVENTNEW_DRAFT_KEY)?.form
  ))

  // Reset metadata when event type changes
  useEffect(() => {
    // A draft restore sets form.event_type, which lands here as a type change and would reset the
    // harvest panel the restore just populated. Skipped once, for the transition into the restored
    // type; a later manual change finds the ref spent and resets normally.
    if (draftRestoredTypeRef.current !== null && form.event_type === draftRestoredTypeRef.current) {
      draftRestoredTypeRef.current = null
      return
    }
    setMetadataState({})
    // Reset the type-specific panels. The harvest unit is re-seeded from localStorage.
    unitTouchedRef.current = false
    setHarvest(freshHarvest())
    setHarvestError(null)
    setSeverity(null); setIssueChoice(''); setIssueOther('')
    setTreatment({ pest_target: '', product_id: '', product_text: '', category: '', amount: '' })
    // A type change is a fresh entry: back to the preselected watering default.
    setWaterDepth(WATER_DEPTH_DEFAULT); waterDepthTouchedRef.current = false
    // A quantity typed against one reduction type must not carry over to another: the user never
    // chose that number for the type that ends up saved.
    setReduction({ qty: '', reason: '' }); setReductionError(null)
  }, [form.event_type])

  // Lazy-load treatment inventory (product picker source) the first time a treatment type is chosen.
  // Fetched once, filtered client-side by kind.
  useEffect(() => {
    const isTreat = form.event_type === 'pest_treatment' || form.event_type === 'doctored'
    if (!isTreat || inventory.length) return
    apiFetch('/api/inventory-items?category=pest_control,fertilizer,amendment,other')
      .then(rows => setInventory(Array.isArray(rows) ? rows : (rows?.items ?? [])))
      .catch(() => {})
  }, [apiFetch, form.event_type, inventory.length])

  // Clear the captured container when the event type or target planting changes.
  useEffect(() => { setContainer({ type: '', size: '' }) }, [form.event_type, form.plant_id])

  // Re-seed the harvest unit from the chosen planting's per-crop memory. A prefill is allowed here
  // because a wrong unit is visible beside the quantity, unlike a planting seed that silently targets
  // a write. Never overrides an explicit in-entry pick (unitTouchedRef). The touched guard is scoped
  // to the planting it was set under: a swap off a real planting clears it, so "cup" picked for
  // blueberries cannot ship on a cucumber row. Not cleared on the first selection: a unit picked
  // before any planting is planting-agnostic intent. The prev-plant ref exists because this effect
  // also re-fires on refetch and type flips, which are not swaps.
  const unitSeedPlantRef = useRef(form.plant_id)
  useEffect(() => {
    if (form.event_type !== 'harvest') return
    const prevPlant = unitSeedPlantRef.current
    unitSeedPlantRef.current = form.plant_id
    if (prevPlant && prevPlant !== form.plant_id) unitTouchedRef.current = false
    if (unitTouchedRef.current) return
    // Both halves come off the same variety_ref, so a planting with no variety or an unmapped crop
    // yields undefined for both and the chain falls back to the global tiers.
    const vref = plantsForProject.find(p => p.id === form.plant_id)?.variety_ref
    const unit = readLastHarvestUnit(vref?.crop_type_slug, vref?.default_unit)
    setHarvest(h => (h.unit === unit ? h : { ...h, unit }))
  }, [form.event_type, form.plant_id, plantsForProject])

  // Telemetry: reset the flow on mount; mark start-capture the first time the type becomes watering.
  useEffect(() => { ux.reset() }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  // Claim the File parked by a trusted tap on the planting page (a File can't ride a URL, and an iOS
  // picker opened after navigation is suppressed). Runs once on mount.
  useEffect(() => {
    // Claim only for a photo-intent quick capture. `fromquick=1` also arrives from the retired PWA
    // harvest shortcut url (launcher-cached for days), which parks nothing; claiming there would open
    // the fastest path with an error about a photo the user never picked. Narrow the claim, never the
    // notice: a photo-intent launch whose park was consumed must still warn. Harvest cases in
    // PhotoEventRequiresPhoto.test.jsx pin this.
    if (!fromQuick || preselectedEventType !== 'photo') return
    // The trusted-tap path parks a single File, so it lands as one staged item.
    const f = takePendingCapture()
    if (f) {
      const id = nextPhotoId()
      setPhotoItems([{ id, file: f, url: URL.createObjectURL(f) }])
      // The parked File is held until Save, so swap in a snapshot copy when it lands. The claim
      // itself must stay synchronous (it races a remount for module state cleared on read). On
      // failure the original stays, so this can only improve the odds.
      snapshotFile(f).then(
        snap => setPhotoItems(prev => prev.map(p => (p.id === id ? { ...p, file: snap } : p))),
        () => {},
      )
    }
    // The claim can miss: the park is module state cleared on read, so a remount between park and
    // claim (overlay host, StrictMode, route churn) consumes it. Silence here produced photo-typed
    // events with no photo; say so while it is still cheap to re-pick.
    else setNotice('That photo didn’t carry over — pick it again below.')
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (form.event_type === 'watering') { ux.tap(); ux.step(1, 'start_capture') }
  }, [form.event_type])  // eslint-disable-line react-hooks/exhaustive-deps

  // Restore a dismissed or abandoned dirty form, once on mount, on both surfaces (same key, so a draft
  // typed on one resumes on the other). There is no navigation blocker on this router (useBlocker
  // needs a data router), so persistence is the protection. Only without a seed deep link: a
  // deep link's params are fresh intent and win over a stale draft. Restores `form` fields only.
  // ?session=harvest counts as a seed: it pins event_type and hides the picker, so a restored draft's
  // type would mis-type the whole weigh-in burst with no way back. Refuse rather than coerce the draft
  // to harvest, which would carry another type's notes and plant_id onto a harvest row. Uses the raw
  // param, not `inHarvestSession`, because the event_type pin is param-level and overlay-agnostic.
  useEffect(() => {
    const hasSeed = !!(preselectedProjectId || preselectedEventType || preselectedPlantId || resolveEventId || fromQuick || harvestSessionParam)
    if (hasSeed) return
    const draft = readDraft(EVENTNEW_DRAFT_KEY)
    if (!draft || !draft.form) return
    const picked = {}
    for (const k of DRAFT_FORM_FIELDS) if (k in draft.form) picked[k] = draft.form[k]
    // `seed_saved` is dropped from a restore: that type opens the Save-seed sheet, and SaveSeedSheet
    // navigates away without clearing the stash, so a restored draft would reopen the sheet on every
    // later bare "Log an event" tap. Only the type is dropped; notes and planting still come back.
    if (picked.event_type === 'seed_saved') picked.event_type = ''
    // A draft from an older bundle can carry legacy `failed` / `given_away`; raw, the reduction panel
    // would not render and the save would 400.
    if ('event_type' in picked) picked.event_type = canonicalEventType(picked.event_type)
    setForm(f => ({ ...f, ...picked }))
    if (typeof draft.showPrivate === 'boolean') setShowPrivate(draft.showPrivate)
    if (typeof draft.showAddDetails === 'boolean') setShowAddDetails(draft.showAddDetails)
    // Restored text must never come back invisible. Notes sit under the harvest disclosure, which is
    // collapsed by default: honour a stashed toggle, then force it open whenever restored text exists
    // (older drafts carry no showHarvestMore key). No-op for non-harvest types.
    if (typeof draft.showHarvestMore === 'boolean') setShowHarvestMore(draft.showHarvestMore)
    if (picked.notes || picked.private_notes) setShowHarvestMore(true)
    // Restore the harvest panel. It is separate state, not `form`, so DRAFT_FORM_FIELDS never carries
    // it. Its fields sit above the "Photo, notes & date" disclosure, so they need no showHarvestMore
    // fallback.
    if (draft.harvest) {
      const h = draft.harvest
      // Claim the upcoming type transition BEFORE it fires (see the type-change effect).
      if (picked.event_type) draftRestoredTypeRef.current = picked.event_type
      setHarvest(cur => ({
        ...cur,
        quantity:       typeof h.quantity === 'string' ? h.quantity : cur.quantity,
        weight:         typeof h.weight === 'string' ? h.weight : cur.weight,
        quality_rating: h.quality_rating ?? cur.quality_rating,
        // Same `??` shape as quality_rating: a draft without one leaves the fresh null alone.
        disposition:    h.disposition ?? cur.disposition,
        // Units restore only when the draft carried them, so a stale draft can never downgrade the
        // crop-aware default a fresh mount just computed.
        unit:           h.unit || cur.unit,
        weight_unit:    h.weight_unit || cur.weight_unit,
      }))
      // Carry whether the unit was picked, not just its value. The crop-default reseed skips only when
      // unitTouchedRef is set, so restoring a chosen unit without it lets the default clobber it;
      // setting it unconditionally would pin a never-chosen default as a pick.
      if (h.unitTouched) unitTouchedRef.current = true
    }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // Persist the in-progress form while dirty (both surfaces); cleared on a successful save. Dirty means
  // typed text or typed harvest fields, not picks: sticky seeds (event_type kept post-save) would
  // otherwise store a stale draft after every save. Picks ride along whenever text is present.
  // unit/weight_unit are excluded because freshHarvest() seeds them from stored prefs; quality_rating
  // counts because a tapped star is deliberate, and resetForNext() clears all of them.
  useEffect(() => {
    const dirty = !!(
      form.notes || form.private_notes || form.quantity ||
      harvest.quantity || harvest.weight || harvest.quality_rating != null ||
      // A tapped chip is deliberate; freshHarvest() seeds null so a pristine mount reads clean.
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

  // Typed content a dismissal or reload would destroy. Feeds two channels on purpose so they cannot
  // drift: the Sheet backdrop guard (a stray backdrop tap no-ops while dirty; no-op on the full page)
  // and the service-worker reload gate. Broader than the stash predicate (it counts photo, metadata,
  // treatment, container, issue text) but excludes bare event_type/plant_id picks, which seeding would
  // otherwise lock on every pristine mount. Post-save it reads clean because resetForNext() clears
  // every counted field, treatment included (EventNewOverlayDirty pins this).
  const hasUnsavedInput = !!(
    form.notes || form.private_notes || form.quantity ||
    photoItems.length || harvest.quantity || harvest.weight ||
    Object.keys(metadataState).length ||
    treatment.pest_target || treatment.product_id || treatment.product_text || treatment.category || treatment.amount ||
    container.type || container.size.trim() ||
    issueOther ||
    // Required fields: losing them to a stray backdrop tap costs the whole entry.
    reduction.qty || reduction.reason
  )

  useReportOverlayDirty(hasUnsavedInput)

  // Hold the service-worker reload gate while there is unsaved input, on both surfaces (a deploy
  // reload hits the full-page form as hard as the overlay). The cleanup release is required: a dirty
  // form that kept its hold after leaving would block updates forever.
  // The release is safe only because the dep is a boolean: while the user types it stays true and the
  // effect does not re-run, so cleanup cannot release mid-form. A non-boolean dep would break this: a
  // release notifies, and registerSW reloads on that notification.
  // The key is per-instance: reloadGate holds a Set, and a shared key would let one instance's unmount
  // release another's hold.
  const reloadGateKey = `event-new:${useId()}`
  useEffect(() => {
    setReloadBlocked(reloadGateKey, hasUnsavedInput)
    return () => setReloadBlocked(reloadGateKey, false)
  }, [reloadGateKey, hasUnsavedInput])

  // Load plants when the project changes (project-scoped mode, the default).
  useEffect(() => {
    if (PROJECTS_HIDDEN) return // unscoped mode loads all plantings in the effect below
    if (!form.project_id) { setPlantsForProject([]); setPlantsLoadFailed(false); return }
    // A switch fires a second fetch while the first may be in flight; a late response for the previous
    // project would overwrite the list and clear a planting picked from the new one. Cancel on re-run.
    let cancelled = false
    setPlantsLoadFailed(false)
    // The picker projection: ~99KB and no presigned photo URLs, versus 814KB for the wide shape. Field
    // census is in the Lambda branch's comment; if this file starts reading a new field, add it there
    // rather than dropping back to the wide shape.
    apiFetch('/api/plants?view=picker&project_id=' + form.project_id)
      .then(data => {
        if (cancelled) return
        const live = (data ?? []).filter(p => !p.archived_at)
        setPlantsForProject(live)
        // Any plant_id not among this project's live plantings is not a valid target, whatever its
        // source (?plant= deep link or hand pick): clear it so a mismatched (project_id, plant_id)
        // pair can never POST.
        setForm(f => (f.plant_id && !live.some(p => p.id === f.plant_id) ? { ...f, plant_id: '' } : f))
      })
      .catch(() => { if (!cancelled) { setPlantsForProject([]); setPlantsLoadFailed(true) } })
    return () => { cancelled = true }
  }, [apiFetch, form.project_id, preselectedPlantId, plantsReloadKey])

  // Unscoped planting source. With the project chooser hidden the picker lists every live planting
  // and project_id is derived from the chosen planting (PlantingSelect onChange), keeping the
  // plant_id ⇒ project_id invariant without a visible project step.
  // SWR-cached: local state stays the render source, so consumption, filtering and reset are
  // unchanged; the hook paints from cache and revalidates on every mount. It surfaces `error` only on
  // a cold failure, so a blip during a background revalidate keeps the list instead of blanking it.
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
  // the form must appear in the chooser at once. Cached, that needs an explicit revalidate, or the
  // next mount paints the pre-create list. Skipped on mount, where the hook already revalidates.
  const mountedReloadKey = useRef(plantsReloadKey)
  useEffect(() => {
    if (!PROJECTS_HIDDEN) return
    if (plantsReloadKey === mountedReloadKey.current) return
    refetchPicker()
  }, [plantsReloadKey, refetchPicker])

  // Latches on the first sign the user is driving. `pointerdown` rather than `click` so a press that
  // starts a scroll counts, and capture phase so a handler that stops propagation cannot hide it.
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

  // On first paint, scroll the minimum that puts the required planting chooser clear of Save (the
  // band's `pointerEvents` handles the transparent strip; Save itself is opaque and would take a tap
  // meant for the chooser and write). `clearControlOfSaveBand` returns 0 when there is no collision,
  // so this is a no-op wherever the problem does not exist, and it is instant so it cannot race the
  // section anchor's smooth scroll.
  // It watches layout, not state: lists can arrive empty (no dep changes) while the page still grows,
  // and the collision only exists once the page is tall. So observe the body's size.
  // `userActedRef` stops it moving the page under a thumb: once anything is touched, scrolled or
  // focused the user owns the scroll, and the observer disconnects.
  // sessionFrame is exempt: the frame has no sticky band.
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
    // Coalesced to one rAF: a settling page fires several resize records in a burst, and each would
    // otherwise measure a half-laid-out frame.
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

  // Load projects + locations.
  useEffect(() => {
    Promise.all([
      apiFetch('/api/projects'),
      apiFetch('/api/locations/with-path'),
    ]).then(([proj, locs]) => {
      const loggable = (proj ?? []).filter(p => LOGGABLE_PROJECT_STATUSES.includes(p.status) && !p.archived_at)
      setProjects(loggable)
      setLocations((locs ?? []).filter(l => l.is_active))
      // A ?project= that matches no loaded (active, owned) project is cleared with a non-fatal notice
      // rather than POSTing a bad project_id.
      if (preselectedProjectId && !loggable.some(p => p.id === preselectedProjectId)) {
        setForm(f => (f.project_id === preselectedProjectId ? { ...f, project_id: '' } : f))
        setNotice('Project not found — pick one.')
      } else if (!preselectedProjectId && rememberedProjectId && !loggable.some(p => p.id === rememberedProjectId)) {
        // A remembered project that no longer exists falls back silently to the default. plant_id here
        // can only be a ?plant= riding that project, so it falls with it (plant_id ⇒ project_id).
        setForm(f => (f.project_id === rememberedProjectId ? { ...f, project_id: '', plant_id: '' } : f))
      }
      // With the project chooser hidden, planting-less events still need a project_id (server
      // exactly_one_parent): default to the first loggable project; a chosen planting overrides it.
      // Runs last so it fills any clear above.
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
        const fieldDef = EVENT_METADATA_FIELDS[form.event_type]?.find(f => f.key === key)
        next[key] = fieldDef?.type === 'number' ? Number(value) : value
      }
      return next
    })
  }

  // Every file from one picker invocation, appended to what is already staged, up to
  // MAX_EVENT_PHOTOS. Bytes are copied at pick time: these items are held until Save, and Android
  // reclaims picker handles inside that window, so a late read fails ("could not be read ... after a
  // reference to a file was acquired"). Mechanism, and why a preview keeps rendering: lib/fileSnapshot.js.
  async function handlePhotoChange(e) {
    const picked = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (!picked.length) return

    // Bounds the copying only; the updater below re-derives room from `prev` and is the authority,
    // since this function awaits and `photoItems` can be a render behind when it resumes.
    const roomNow = Math.max(0, MAX_EVENT_PHOTOS - photoItems.length)
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

    // A fresh pick commits any parked removal: the user has moved on, and with the slot emptied here an
    // undoable removal can only exist against a list one short of the cap, so undo never exceeds
    // MAX_EVENT_PHOTOS.
    commitRemovedPhoto()
    setPhotoItems(prev => {
      const room = Math.max(0, MAX_EVENT_PHOTOS - prev.length)
      const accepted = ok.slice(0, room)
      if (!accepted.length) return prev
      // Object URL from the snapshot: one taken from the picker's handle dies with the handle.
      return prev.concat(accepted.map(({ file }) => ({ id: nextPhotoId(), file, url: URL.createObjectURL(file) })))
    })
  }

  // Releases whatever is parked in the undo slot. Called at every commit point and the only place the
  // deferred URL dies, so "is the undo window over?" and "is the blob gone?" cannot disagree. Safe on
  // an empty slot.
  function commitRemovedPhoto() {
    const parked = removedPhotoRef.current
    if (parked) URL.revokeObjectURL(parked.item.url)
    removedPhotoRef.current = null
    setRemovedPhoto(null)
  }

  // Unmount is a commit point. Cleanup-only effect with empty deps; the ref is read at teardown, so it
  // sees the last parked value, not the mount-time null.
  useEffect(() => () => {
    const parked = removedPhotoRef.current
    if (parked) URL.revokeObjectURL(parked.item.url)
    removedPhotoRef.current = null
  }, [])

  // The index comes from the render closure so nothing with a side effect runs inside setPhotoItems:
  // StrictMode double-invokes updaters, and a park-then-revoke done there would revoke the item it had
  // just parked on the second pass.
  function removePhotoItem(id) {
    const index = photoItems.findIndex(p => p.id === id)
    if (index < 0) return
    // One slot: parking a new removal commits the older one. No revoke for the item being parked.
    const prevParked = removedPhotoRef.current
    if (prevParked) URL.revokeObjectURL(prevParked.item.url)
    const entry = { item: photoItems[index], index }
    removedPhotoRef.current = entry
    setRemovedPhoto(entry)
    setPhotoItems(prev => prev.filter(p => p.id !== id))
  }

  // Re-inserts at the original index, so undo restores the strip's order and not just its contents.
  // Never revokes: the URL it is handing back is the one removal deliberately did not release.
  function undoRemovePhoto() {
    const parked = removedPhotoRef.current
    if (!parked) return
    removedPhotoRef.current = null
    setRemovedPhoto(null)
    setPhotoItems(prev => {
      if (prev.some(p => p.id === parked.item.id)) return prev
      const next = prev.slice()
      next.splice(Math.min(parked.index, next.length), 0, parked.item)
      return next
    })
  }

  // Straight to the picker; there is no camera path.
  const photoInputRef = useRef(null)
  function openPhotoPicker() {
    const el = photoInputRef.current
    if (!el) return
    el.click()
  }

  // Revokes every staged URL. Reads the updater's `prev`, not the render closure, so a call from
  // resetForNext (same tick as other setState) cannot revoke a stale list and leak the current one.
  function clearPhoto() {
    commitRemovedPhoto()
    setPhotoItems(prev => {
      for (const it of prev) URL.revokeObjectURL(it.url)
      return prev.length ? [] : prev
    })
  }

  // Undo reuses the soft-delete (DELETE /api/events/:id sets deleted_at and recomputes watering
  // memory). Awaited so the strip shows the outcome: success flips to a durable "removed" state,
  // failure shows a retryable error instead of silently losing the undo.
  async function undoEvent() {
    if (!confirmation || confirmation.undone) return
    try {
      await apiFetch('/api/events/' + confirmation.eventId, { method: 'DELETE' })
      setConfirmation(c => (c ? { ...c, undone: true, error: null } : c))
    } catch {
      setConfirmation(c => (c ? { ...c, error: "Couldn't undo — try again." } : c))
    }
  }
  // Per-row undo: the same soft-delete as undoEvent, for any row in the session ledger.
  async function undoSessionRow(rowEventId) {
    try {
      await apiFetch('/api/events/' + rowEventId, { method: 'DELETE' })
      setSessionRows(rows => rows.map(r => r.eventId === rowEventId ? { ...r, undone: true, undoError: null } : r))
    } catch {
      setSessionRows(rows => rows.map(r => r.eventId === rowEventId ? { ...r, undoError: "Couldn't undo — try again." } : r))
    }
  }

  // Client-side harvest validation mirroring lambda/events/validators.js. Returns an error string, or
  // null if valid.
  function validateHarvest() {
    const qty = Number(harvest.quantity)
    if (harvest.quantity === '' || !Number.isFinite(qty) || qty <= 0) {
      return 'Enter a quantity greater than zero.'
    }
    if (qty > MAX_PLAUSIBLE[harvest.unit]) {
      return `That's higher than expected for ${harvest.unit} — double-check the amount.`
    }
    // The weight is optional: empty is valid and handled before Number(), since Number('') is 0.
    if (harvest.weight !== '') {
      const w = Number(harvest.weight)
      if (!Number.isFinite(w) || w <= 0) return 'Enter a weight greater than zero, or leave it blank.'
      if (toGrams(w, harvest.weight_unit) > MAX_PLAUSIBLE_WEIGHT_G) {
        return `That's higher than expected for a single weighing — double-check the ${harvest.weight_unit}.`
      }
    }
    return null
  }

  // Reset for the next entry.
  // mode 'plant': keep the planting, clear event_type (next event for this plant).
  // mode 'type': keep event_type, clear plant_id (same event for the next plant); the next-of-type
  // oracle test pins this. project_id is kept both ways so the plant picker stays populated.
  // Clears date (except in a weigh-in session), notes, quantity, private notes and all type-specific
  // panels; collapses add-details/private.
  function resetForNext(mode) {
    setForm(f => ({
      event_type:    mode === 'type' ? f.event_type : '',
      project_id:    f.project_id,
      location_id:   '',
      // Sticky in a weigh-in session, now everywhere else: one sitting at the scale often works through
      // an earlier day's picking. On the general form a sticky date would silently backdate an
      // unrelated event logged later.
      event_date:    inHarvestSession ? f.event_date : toDatetimeLocal(new Date()),
      notes:         '',
      private_notes: '',
      quantity:      '',
      plant_id:      mode === 'type' ? '' : f.plant_id,
    }))
    setMetadataState({})
    // Treatment is part of the dirty predicate, and a keepMode:'type' burst would otherwise carry it
    // onto the next save.
    setTreatment({ pest_target: '', product_id: '', product_text: '', category: '', amount: '' })
    unitTouchedRef.current = false
    setHarvest(freshHarvest())
    setHarvestError(null)
    setSeverity(null); setIssueChoice(''); setIssueOther('')
    setContainer({ type: '', size: '' })
    // Amount class does not stick across a keepMode:'type' burst: a carried-over Deep would record an
    // amount the user never chose for the next planting and inflate the annotation-rate signal.
    setWaterDepth(WATER_DEPTH_DEFAULT); waterDepthTouchedRef.current = false
    // Cleared here as well as on type change: keepMode:'type' preserves event_type, so the type-change
    // effect never fires on a burst and a carried-over count would ride onto the next planting.
    setReduction({ qty: '', reason: '' }); setReductionError(null)
    clearPhoto()
    setShowAddDetails(false)
    setShowPrivate(false)
    setError(null)
    setSaving(false)
    // PlantingSelect's `touched` is its own state and this form does not unmount between saves, so
    // without this the picker shows "Choose a planting." in red the moment a save succeeds.
    setPickerResetNonce(n => n + 1)
  }

  // Returns { ok, reason?, eventId? } so a caller that saves and then advances never advances over a
  // failed save.
  // Re-entrancy: the disabled Save button covers only taps on that button; the Enter-key path and any
  // programmatic caller bypass it. `saving` is reset at both exits of the save window (the POST catch
  // and the end of the success path), so it cannot strand the form. `saving` is state, so a second
  // call in the same frame still sees false: `submitInFlight` is set with setSaving(true), after every
  // refusal and before the first await, and released at the same two exits. Not a finally: a throw
  // inside the window leaves `saving` true anyway. The server also answers a re-sent event with the
  // row that stands (lambda/events repeatGuard.js).
  // No idempotency key: it would need the events Lambda to honour it, and a key the server ignores
  // would look like protection and be none.
  async function handleSubmit(e, { keepMode = 'type' } = {}) {
    e.preventDefault()
    if (saving || submitInFlight.current) return { ok: false, reason: 'in_flight' }
    if (!form.event_type)  { setError('Select an event type above.'); return { ok: false, reason: 'no_event_type' } }
    // Also enforces plant_id ⇒ project_id at submit: a POST never leaves as {project_id:'',
    // plant_id:X} (the server's exactly_one_parent CHECK would 500).
    if (!form.project_id)  { setError('Select a project.'); return { ok: false, reason: 'no_project' } }

    // Per-type required-planting gate. Client-side only: the server validator stays optional so a
    // stale cached bundle cannot 400. flag_issue keeps its own plant_id gate below.
    if (requiresPlanting(form.event_type) && !form.plant_id) {
      setError('Choose a planting for this event.'); return { ok: false, reason: 'no_planting' }
    }

    // A photo event with no photo is never intentional and, once saved, nothing can recover it (no
    // upload was attempted, so nothing failed). Refuse inline while a photo can still be added; do not
    // warn-and-proceed. A count check: zero staged files is refused, one or more proceeds.
    if (form.event_type === 'photo' && photoItems.length === 0) {
      setError('Add a photo for a photo event — or pick a different event type.'); return { ok: false, reason: 'no_photo' }
    }

    // Harvest panel gate: block the POST on an invalid quantity, with an inline error by the field.
    if (form.event_type === 'harvest') {
      const hErr = validateHarvest()
      if (hErr) { setHarvestError(hErr); return { ok: false, reason: 'harvest_invalid' } }
      setHarvestError(null)
    }

    // Plant-reduction gate. Both fields are required by the events validator, whose 400 would
    // flatten through friendlyError() to a generic line; refusing here puts the message on the panel.
    // Over-reduction is not gated here: only the server knows the live count (its 409 is handled in
    // friendlyError), and pre-refusing on a list fetched at mount would block valid saves.
    if (isPlantReductionEventType(form.event_type)) {
      const rErr = validateReductionInput(form.event_type, reduction)
      if (rErr) { setReductionError(rErr); return { ok: false, reason: 'reduction_invalid' } }
      setReductionError(null)
    }

    // A flag must target a planting (so DrG surfaces it) and carry a severity (required by the events
    // validator; drives DrG urgency).
    if (form.event_type === 'flag_issue') {
      if (!form.plant_id) { setError("Choose the plant you're flagging."); return { ok: false, reason: 'no_planting' } }
      if (!severity)      { setError('Pick how urgent it is.'); return { ok: false, reason: 'no_severity' } }
    }

    if (form.event_type === 'watering') ux.tap()  // submit tap (watering flow only)
    submitInFlight.current = true
    setSaving(true)
    setError(null)

    // Send the date portion only; the Lambda appends T12:00:00.
    const eventDateStr = form.event_date.split('T')[0]

    // Metadata: flag issue_label merged with any Tier-2 metadata.
    const isFlag = form.event_type === 'flag_issue'
    const issueLabel = isFlag ? (issueChoice === '__other__' ? issueOther.trim() : issueChoice) : ''
    // The amount class is always written on a watering, including the untouched default; otherwise
    // the ledger cannot tell "default applied" from "row predates capture".
    const depthMeta = isWaterDepthType(form.event_type)
      ? waterDepthMetadata(waterDepth, waterDepthTouchedRef.current)
      : {}
    // {} for every other type, so it spreads unconditionally; the events validator forbids these keys
    // on other types.
    const reductionMeta = buildReductionMetadata(form.event_type, reduction)
    const mergedMeta = { ...metadataState, ...depthMeta, ...reductionMeta, ...(isFlag && issueLabel ? { issue_label: issueLabel } : {}) }
    const metadata = Object.keys(mergedMeta).length > 0 ? mergedMeta : null
    const flagPayload = isFlag ? { flagged_as_issue: true, severity } : {}

    const isHarvest = form.event_type === 'harvest'
    const harvestPayload = isHarvest
      ? {
          harvest: {
            quantity:       Number(harvest.quantity),
            unit:           harvest.unit,
            quality_rating: harvest.quality_rating != null ? Number(harvest.quality_rating) : null,
            // Omitted when blank rather than null: the server reads absent and null as different
            // intents on the EDIT path, so the client keeps one shape for both.
            ...(harvest.weight !== ''
              ? { weight: Number(harvest.weight), weight_unit: harvest.weight_unit }
              : {}),
            // Omitted for a normal pick, like weight: on EDIT absent means "untouched" and null means
            // "cleared".
            ...(harvest.disposition != null ? { disposition: harvest.disposition } : {}),
          },
        }
      : {}

    // Structured treatment fields (pest_treatment / doctored only).
    const isTreatment = form.event_type === 'pest_treatment' || form.event_type === 'doctored'
    // Fertilizing sends only the product text, from the same `treatment.product_text` slice
    // TreatmentDetails writes; the other treatment_* columns do not apply to it.
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
    // POST the event.
    let result
    try {
      result = await apiFetch('/api/events', {
        method: 'POST',
        // A harvest outwaits the Lambda rather than aborting at 15s.
        ...(isHarvest ? { timeoutMs: HARVEST_WRITE_TIMEOUT_MS } : {}),
        body: JSON.stringify({
          project_id:    form.project_id,
          event_type:    form.event_type,
          event_date:    eventDateStr,
          notes:         form.notes.trim()         || null,
          private_notes: form.private_notes.trim() || null,
          // Harvests use the structured panel, so the free-text quantity is nulled for them.
          quantity:      isHarvest ? null : (form.quantity.trim() || null),
          plant_id:      form.plant_id               || null,
          // is_public is deliberately not sent: the Lambda defaults it with `body.is_public ?? true`,
          // which holds only while the client stays silent. An explicit false hides the event from
          // the public site.
          has_photo:     photoItems.length > 0,
          metadata,
          ...harvestPayload,
          ...flagPayload,
          ...treatmentPayload,
        }),
      })
    } catch (err) {
      submitInFlight.current = false
      setSaving(false)
      setError(friendlyError(err))
      return { ok: false, reason: 'post_failed' }
    }

    // Remember the harvest unit per crop and globally. The global key is the fallback for crops with
    // no per-crop memory and the key old bundles read.
    if (isHarvest) {
      try {
        localStorage.setItem('lastHarvestUnit', harvest.unit)
        const savedSlug = plantsForProject.find(p => p.id === form.plant_id)?.variety_ref?.crop_type_slug
        if (savedSlug) localStorage.setItem(`lastHarvestUnit:${savedSlug}`, harvest.unit)
      } catch { /* noop */ }
      // Remember the weight unit only once it has weighed something.
      if (harvest.weight !== '') {
        try { localStorage.setItem('lastHarvestWeightUnit', harvest.weight_unit) } catch { /* noop */ }
      }
    }

    // Remember the project for the next cold session.
    if (form.project_id) {
      try { localStorage.setItem(LAST_PROJECT_KEY, form.project_id) } catch { /* noop */ }
    }
    // Remember the planting; a plant-less save clears the key so it is always the last save.
    try {
      if (form.plant_id) localStorage.setItem(LAST_PLANT_KEY, form.plant_id)
      else localStorage.removeItem(LAST_PLANT_KEY)
    } catch { /* noop */ }
    // One distinct-day mark for the saved planting's crop, the picker's chip ranking source. LogMany
    // stays excluded (see cropLogLedger.js). A plant-less save or unresolvable slug is a no-op; the
    // ledger guards its own storage.
    if (form.plant_id) {
      const rankSlug = plantsForProject.find(p => p.id === form.plant_id)?.variety_ref?.crop_type_slug
      if (rankSlug) recordCropLog(rankSlug, eventDateStr)
    }

    // Treated… deep link: mark the source finding resolved. Non-fatal; the treatment is saved.
    if (resolveEventId) {
      try { await apiFetch(`/api/events/${resolveEventId}`, { method: 'PATCH', body: JSON.stringify({ resolved: true }) }) }
      catch { /* resolve can be retried from DrG */ }
    }

    // A potting_up/transplant with a new container PUTs it to the planting (COALESCE leaves untouched
    // fields). Non-fatal: a failure surfaces a notice and never blocks the success flow.
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

    // The response carries the event row at top level plus updated_streak / xp_gained /
    // newly_earned_achievements / daily_xp_remaining.
    const { id: eventId, updated_streak, xp_gained, newly_earned_achievements } = result
    // No haptic on save: a banned channel on a reward-signal path. The critter is awarded by the
    // events Lambda inside the same POST transaction.

    // Upload photos (non-fatal, errorMode='swallow'). keyPrefix='events' + parentId=eventId gives
    // events/{eventId}/{uuid}.{ext}. Every row carries a real parent (`event_id`) and no
    // `intake_status`: nothing here may reach the `inbox/` prefix or POST /api/photos/batch.
    // Failures are counted so the confirmation can say how many, instead of the save looking clean
    // while a photo never existed. Serial, one decode at a time: a Promise.all would hold N
    // multi-megabyte decodes on a phone.
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
        // is_public not sent, as for the event payload; useUploadPhoto defaults it to true.
      })
      if (photoRes?.error) {
        photoFailCount += 1
        // Keep the first failure's text: the user can act on it, and later ones usually restate it.
        if (!photoError) photoError = photoRes.error
      }
    }
    const photoTotal = photoItems.length

    submitInFlight.current = false
    setSaving(false)
    if (form.event_type === 'watering') ux.complete({ outcome: 'logged' })  // M1 watering complete

    // Every save is a rapid-entry save: reset and stay on the form, never navigate away.
    const projName = projects.find(p => p.id === form.project_id)?.name ?? 'event'
    // Display name for "View {planting}", captured before resetForNext clears form.plant_id. Label
    // only; href ids come from the POST response. null → "View planting".
    const plantName = form.plant_id ? (plantsForProject.find(p => p.id === form.plant_id)?.name ?? null) : null

    // The end-status offer, captured before resetForNext() clears form.plant_id. Present only when
    // this reduction emptied the planting: the events Lambda sends plant_reduction: null otherwise,
    // including every partial reduction, which must stay a silent one-tap log. A pass-through of the
    // server's decision, never a client-side guess at emptiness (the client cannot know the live count).
    const reductionOffer = result?.plant_reduction ?? null
    const offerPlantId = result?.plant_id ?? form.plant_id ?? null

    // The crop whose season total the confirmation will echo.
    // No "preserve this?" put-up offer after a harvest: putting food up is a separate sitting from
    // picking, so it fired where it could never be accepted. Do not reintroduce it, flagged or quieter,
    // without a fresh ask from Dave. Put-Up's other prefill doors are unaffected.
    let seasonCropSlug = null
    if (isHarvest && eventId) {
      const selectedPlant = plantsForProject.find(p => p.id === form.plant_id)
      if (selectedPlant?.variety_ref?.crop_type_slug) seasonCropSlug = selectedPlant.variety_ref.crop_type_slug
    }

    // Ledger row, captured before resetForNext clears the panel. grams goes through the same toGrams
    // the server uses, so the running total agrees with harvest_log.
    const sessionRow = inHarvestSession && isHarvest && eventId
      ? {
          eventId,
          // Feeds the tray's done-tick derivation.
          plantId: form.plant_id || '',
          plantName: plantName ?? projName,
          // The date this row was filed under, from the same `eventDateStr` the POST carries. The
          // date is sticky across a burst, so the ledger must show which day each row landed on.
          date: eventDateStr,
          qty: harvest.quantity,
          unit: harvest.unit,
          grams: harvest.weight !== '' ? Math.round(toGrams(Number(harvest.weight), harvest.weight_unit) * 10) / 10 : null,
          undone: false,
          undoError: null,
        }
      : null

    resetForNext(keepMode)
    // Raise the offer after the reset, so the sheet is the only thing asking for attention and the
    // form underneath is clean. Requires a plant id: there is nothing to PUT a status onto otherwise.
    if (reductionOffer && offerPlantId) {
      setEndStatusOffer({ ...reductionOffer, plantId: offerPlantId, plantName })
    }
    // keepMode 'type' clears plant_id and the confirmation says "pick the next plant", so scroll to
    // the picker. Only on 'type': 'plant' keeps the planting and the next tap is the event-type row.
    // rAF-deferred so it measures after the reset's commit (the confirmation mounts in the same pass).
    // The frame never anchors (its picker is track 1, always visible); it restores track 2's scroll
    // offset instead.
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
    // Operational confirmation + undo (soft-delete the just-logged event). Rewards stay ambient and
    // are never dispatched here.
    if (eventId) {
      if (inOverlay) {
        // Durable confirmation, no timer: a non-blocking strip in the sticky band. The global toast is
        // skipped (invisible to AT behind aria-modal). The burst count increments only here, on a
        // confirmed successful save.
        setSavesThisSession(n => n + 1)
        setConfirmation({
          eventId,
          projectId: result.project_id ?? null,
          // Response-sourced (the saved row's truth). Gates whether the confirmation names a planting
          // or says "no planting attached".
          plantId: result.plant_id ?? null,
          plantName,
          projName,
          // States the class that was recorded, including the default: a class written without being
          // shown cannot be corrected, and the undo beside it is the correction path. Read from
          // `depthMeta`, captured before resetForNext() cleared the chip state.
          eventLabel: ((EVENT_TYPE_META[form.event_type]?.label ?? 'event').replace('\n', ' '))
            + (depthMeta.water_depth ? ` (${waterDepthLabel(depthMeta.water_depth)})` : ''),
          // Write-only: PostSaveFeedback documents it in its prop shape and never renders it.
          eventEmoji: EVENT_TYPE_META[form.event_type]?.emoji ?? null,
          undone: false,
          error: null,
          photoError,
          // The strip pluralises off these; at <= 1 it renders the singular sentence.
          photoFailCount,
          photoTotal,
        })
        // Season-total line: cleared first so a prior harvest's total never flashes, then filled by a
        // harvest-only aggregates GET. Best-effort static text with no link (the strip's zero-link
        // count is pinned). The aggregate is household-scoped, so it says "(whole garden)"; the
        // `Season: ` prefix is kept for anchored /^Season: / assertions.
        setSeasonLine(null)
        if (isHarvest && seasonCropSlug) {
          apiFetch(`/api/harvests?include=aggregates&crop=${encodeURIComponent(seasonCropSlug)}`)
            .then(d => { const phrase = seasonTotalPhrase(d?.aggregates?.crops?.[0]); if (phrase) setSeasonLine(`Season: ${phrase} (whole garden)`) })
            .catch(() => { /* ambient — the strip never surfaces a harvests-read failure */ })
        }
      } else if (sessionRow) {
        // The session ledger is the confirmation and undo surface; a toast would duplicate it.
        // A pick identical to one saved in the last 45 s answers 200 `repeated` with that row's id.
        // If the ledger already holds it live, a second row would over-count, duplicate the key and
        // 404 on undo: add no row and show the notice. An id the ledger does not hold (the first
        // attempt failed here after the server wrote it) is appended; the next ordinary save clears
        // the notice.
        const liveRowOf = rows => rows.some(r => !r.undone && r.eventId === eventId)
        const keptOnce = result?.repeated === true && liveRowOf(sessionRows)
        if (keptOnce) setNotice(KEPT_ONCE_NOTICE)
        else setNotice(n => (n === KEPT_ONCE_NOTICE ? null : n))
        setSessionRows(rows => (result?.repeated === true && liveRowOf(rows) ? rows : [...rows, sessionRow]))
      } else {
        // The full page keeps the global toast: outside the aria-modal sheet it is AT-reachable, and
        // the form stays on screen. The toast names the target: the planting, or the project with the
        // absence stated.
        const toastTarget = form.plant_id
          ? `Logged event — ${plantName ?? 'planting'}`
          : `Logged event for ${projName} — no planting attached`
        showUndo({
          // The one-photo string is pinned by EventNewPostSaveFeedback.characterization.test.jsx's
          // /but the photo didn't upload/.
          message: photoFailCount > 1
            ? `${toastTarget} — but ${photoFailCount} of ${photoTotal} photos didn't upload`
            : photoError
              ? `${toastTarget} — but the photo didn't upload`
              : toastTarget,
          // The recorded amount class as a second line, not appended to `message`: the message is a
          // pinned oracle (EventNew.test.jsx's exact "Logged event — Cayenne #1"), and the class is
          // secondary. Carries the anchor so "Deep" is never left to the user's own definition.
          detail: depthMeta.water_depth
            ? `${waterDepthLabel(depthMeta.water_depth)} — ${WATER_DEPTH_CHIPS.find(c => c.value === depthMeta.water_depth)?.anchor ?? ''}`
            : null,
          onUndo: () => { apiFetch('/api/events/' + eventId, { method: 'DELETE' }).catch(() => {}) },
        })
      }
    } else {
      showToast({ message: keepMode === 'type' ? 'Saved — pick the next plant' : 'Saved — log the next event' })
    }
    // The only path that means the row exists; `eventId` is the id the POST returned.
    return { ok: true, eventId }
  }

  // The confirmation is a strip inside the sticky Save band, not a body-replacing early return: the
  // form stays mounted and live through a burst, saving a dismissal tap per harvest.
  const showPostSaveStrip = inOverlay && !!confirmation

  // One definition per block, two orders. Harvest leads Planting → Quantity → Unit so the fast path
  // needs no scroll; every other type keeps the photo-first sequence. Composing the body from named
  // blocks rather than forking the JSX means the two orders can differ only in sequence, never in
  // content.
  const isHarvest = form.event_type === 'harvest'

          /* Photo leads for non-harvest types and is never gated on a target being chosen first;
             the file is staged in local state and uploaded inside handleSubmit. For a `photo` event
             the label says required, because the submit gate refuses to save without one. */
  const photoBlock = (
          <Section label={form.event_type === 'photo' ? 'Photo *' : 'Photo  ·  optional'}>
            {/* One staged photo renders as a 220px-max preview with absolutely positioned controls;
                at N > 1 each item is a 96px tile so a handful fits without pushing the form off
                screen. */}
            {/* Picking copies the bytes, so a multi-photo pick has a visible duration. Above the
                strip so it is the first thing that moves. */}
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
                      {/* The solo case also goes through removePhotoItem, so one photo is as
                          recoverable as one of six. clearPhoto is the commit, not the remove. */}
                      <button
                        type="button"
                        onClick={() => removePhotoItem(item.id)}
                        aria-label={solo ? 'Remove photo' : `Remove photo ${idx + 1}`}
                        style={{
                          position: 'absolute', top: solo ? 8 : 4, right: solo ? 8 : 4,
                          background: 'rgba(0,0,0,0.55)', color: P.white,
                          border: 'none', borderRadius: '50%',
                          width: solo ? 28 : 22, height: solo ? 28 : 22, cursor: 'pointer',
                          fontSize: '0.85rem',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        <Icon name="action.remove" size={solo ? 14 : 11} decorative />
                        {/* Touch target (WCAG 2.5.5) on a destructive control: a transparent child
                            grows the hit area while the visible circle stays pinned to its corner.
                            It grows down and left, into the photo, because outward expansion would
                            hang a remove target over the neighbouring tile. Arithmetic, not a
                            measurement: solo 28+8+8 = 44; strip 22+4+18 = 44. */}
                        <span aria-hidden="true" style={{
                          position: 'absolute',
                          top: solo ? -8 : -4, right: solo ? -8 : -4,
                          bottom: solo ? -8 : -18, left: solo ? -8 : -18,
                        }} />
                      </button>
                      {/* Save-to-device is solo-only: a per-file action, and six tiled next to six
                          removes is six mis-taps waiting. Hidden by SAVE_TO_DEVICE_HIDDEN. */}
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
                {/* "Add another" only while there is room. */}
                {photoItems.length < MAX_EVENT_PHOTOS && (
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
                {/* The picker input is rendered in both branches so "Add more" has something to
                    click. */}
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handlePhotoChange}
                  style={{ display: 'none' }}
                />
              </div>
            ) : (
              <div>
                {/* One full-width Choose button; the flex row keeps the dashed drop-target
                    proportions. */}
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
                    {/* media.camera is the registry's one "add a photo" glyph
                        (ProjectDetail.iconLanguage.test.js). */}
                    <Icon name="media.camera" size={20} decorative />
                    {/* Label stays "Choose photo" although the picker takes several: an exact
                        getByText in EventNew.harvestFormOrder.test.jsx pins it, and multi-select copy
                        is a design-review call. */}
                    <span>Choose photo</span>
                  </button>
                </div>
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handlePhotoChange}
                  style={{ display: 'none' }}
                />
              </div>
            )}
            {/* The undo for a removal: inline and ambient under the strip, not a toast or confirm (a
                confirm taxes every correct removal). Renders in both branches (removing the only
                photo lands in the empty one) and withdraws once the removal is committed. Undo
                geometry matches PostSaveFeedback: 44x44 visual, not hit-slop. */}
            {removedPhoto && (
              <div data-testid="eventnew-photo-undo"
                   style={{ display: 'flex', alignItems: 'center', gap: 8,
                            marginTop: 8, fontSize: '0.85rem', color: P.mid }}>
                {/* The live region is the sentence only: a button announced from inside
                    role="status" leaves the user hunting for a control they heard about. */}
                <span role="status">Photo removed.</span>
                <button
                  type="button"
                  onClick={undoRemovePhoto}
                  data-testid="eventnew-photo-undo-btn"
                  style={{
                    background: 'transparent', border: 'none', color: P.green, fontWeight: 600,
                    fontSize: '0.88rem', cursor: 'pointer', minHeight: 44, minWidth: 44,
                    padding: '10px 12px', fontFamily: 'inherit',
                  }}
                >Undo</button>
              </div>
            )}
          </Section>
  )

          /* Event type. In session mode the type is locked: the picker is how a mis-tap leaves
             harvest mid-burst. Leaving the session (back nav / plain /log) is how to log another
             type. */
  const eventTypeBlock = inHarvestSession ? (
          <Section label="What happened? *">
            <div data-testid="harvest-session-lock" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.9rem', color: P.mid, fontWeight: 600 }}>
              {/* event.harvest, not nav.harvests: per iconAnchors the basket means picking and the
                  bowl the browse surface; this lock is about the action every save performs. */}
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
                {/* Dedicated entry into Flag mode: flag_issue is a free-text event type, not a
                    canonical glyphed tile. */}
                <button type="button" onClick={() => setForm(f => ({ ...f, event_type: 'flag_issue' }))}
                  style={{ marginTop: 12, background: 'none', border: `1px solid ${P.terra}`, borderRadius: 8,
                    color: P.terra, fontWeight: 600, fontSize: '0.85rem', padding: '8px 14px', cursor: 'pointer',
                    /* inline-flex honours minHeight, so the chip keeps its hug-the-text width and
                       only grows to the tap floor. */
                    minHeight: T.tapMinHeight,
                    display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Icon name="action.flag" size={16} decorative />
                  <span>Flag an issue</span>
                </button>
              </>
            )}
          </Section>
  )

          /* Treatment details, directly below Event Type for pest/treatment events. */
  const treatmentBlock = (
          (form.event_type === 'pest_treatment' || form.event_type === 'doctored') && (
            <TreatmentDetails value={treatment} onChange={setTreatment} inventory={inventory} eventType={form.event_type} />
          )
  )

          /* Fertilizing gets only the product-text slice of the treatment panel: no category chips
             (a pest-flavoured enum), no pest target, no inventory picker. Same slot as
             treatmentBlock. */
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

          /* Notes */
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
          /* Harvest layout only: already inside showHarvestMore's disclosure, so a plain Section. */
  const notesBlock = (
          <Section label="Notes">
            {notesField}
          </Section>
  )

          /* The non-harvest home for Notes: collapsed at the end of the form, same disclosure
             grammar as "Add details". Open is derived (`showNotes || form.notes`) so collapsing
             never hides written text and a restored draft shows its notes without a tap. */
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

          /* Project: hidden when projects are not user-facing (PROJECTS_HIDDEN); project_id is then
             derived from the chosen planting or the default. */
  const projectBlock = (
          !PROJECTS_HIDDEN && (
          <Section label="Project *">
            <Select
              value={form.project_id}
              // Switching project drops the planting in the same state update: the plants list
              // reloads asynchronously, and a fast Save inside that window would POST a mismatched
              // pair. Guarded on an actual change so re-selecting the same project is not a reset.
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

          /* Planting: the shared searchable PlantingSelect. The unset state reads as a neutral
             placeholder, never as a deliberate project-level choice. */
  /* In the frame the Section card is dropped: it is 110px around a 52px control, and that chrome is
     the difference between the pads fitting and track 2 scrolling. */
  const plantingField = (
          <>
            <PlantingSelect
              plants={plantsForProject}
              value={form.plant_id}
              onChange={id => setForm(f => {
                // Derive the hidden project from the chosen planting (plant_id ⇒ project_id).
                // Clearing the planting keeps the current/default project_id.
                if (!PROJECTS_HIDDEN) return { ...f, plant_id: id }
                const derived = id ? (plantsForProject.find(p => p.id === id)?.project_id ?? f.project_id) : f.project_id
                return { ...f, plant_id: id, project_id: derived }
              })}
              required={requiresPlanting(form.event_type)}
              // Remembered planting as ranking, never value, read at picker open (see
              // handlePickerOpenChange). Only this site passes it.
              recentPlantId={recentPlantId}
              // Crop chips. Filter state survives resetForNext within the mount, so a tomato burst
              // taps the chip once.
              cropChips={CROP_CHIPS_AUTO}
              // The FAB harvest arrival opens the picker itself (see harvestFabAutoOpen).
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
              <Section id={PLANTING_SECTION_ID} label={requiresPlanting(form.event_type) ? 'Planting *' : 'Planting'}>
                {plantingField}
              </Section>
            )
  )

          /* New-container capture for potting_up / transplant on a chosen planting. */
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

          /* Watering amount class (watering events only), directly under the type picker like
             <TreatmentDetails>: it must be visible without scrolling on the fast path. Never a gate;
             Normal is preselected. */
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

          /* Plant-reduction capture (failed / given_away). Required, so a plain visible Section, not
             an EVENT_METADATA_FIELDS entry (that feeds the optional "More details" disclosure).
             Placed after the planting picker because it shows the chosen planting's live count. It
             does not gate on plant_id: hiding a required field until another is filled lets a user
             reach Save without knowing what is missing. `remaining` is information only; the
             over-reduction refusal is the server's 409 (lib/plantReduction.js). */
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

          /* Tier 2: per-type metadata enrichment (collapsible). */
  const metadataBlock = (
          <MetadataSection
            eventType={form.event_type}
            metadataState={metadataState}
            onMetadataChange={handleMetadataChange}
          />
  )

          /* Harvest panel (harvest events only). */
  /* In the frame the Section wrapper is swapped for a bare one: its header and footer cost 59px on a
     surface that is only ever one harvest, and the frame cannot spare them. Children are identical
     either way, which keeps WeighInFrame.flagOff.test.jsx matching; the id stays on both so
     HARVEST_SECTION_ID still resolves. */
  /* Hoisted so the frame can seat it in track 2's secondary region: it asks about a rare case and
     must never sit between the user and Save on the fast path, and in a fixed frame "last" is
     directly above Save. Same element either way, so the flag-off render is unchanged. */
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
                    {/* type=text is deliberate: on Chrome Android an invalid intermediate value in a
                        type=number input makes .value return '', silently defeating the
                        MAX_PLAUSIBLE[unit] check in validateHarvest(). Never inputMode 'none': an
                        Android IME that does not implement it falls back to the full alphanumeric
                        keyboard. 'numeric' in session (quantity is whole). */}
                    <Input
                      id="harvest-quantity"
                      type="text"
                      inputMode={inHarvestSession ? 'numeric' : 'decimal'}
                      value={harvest.quantity}
                      onChange={e => {
                        setHarvest(h => ({ ...h, quantity: e.target.value }))
                        if (harvestError) setHarvestError(null)
                      }}
                      // Anchor the Harvest header to the viewport top on focus so quantity, weight,
                      // the error banner and Save stay visible above the keyboard. On focus, so it
                      // lands before the browser's own scroll-into-view and leaves nothing to correct.
                      // Not in the frame, which already puts them there; moving content on focus
                      // there would breach SC 3.2.2.
                      onFocus={sessionFrame ? undefined : () => anchorSectionToTop(HARVEST_SECTION_ID)}
                      aria-label="Harvest quantity"
                      error={!!harvestError}
                      placeholder="e.g. 2.5"
                      // Session only: Enter hops to weight instead of submitting (the loop is qty →
                      // grams → save). Non-session harvest keeps Enter-saves-count-only.
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
                      // An explicit pick pins the unit for the current planting; swapping planting
                      // un-pins it and the unit re-seeds for the new crop.
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
              {/* The digit builder: one tap on '3' yields '3' (most quantities), and '13' is two
                  taps with no keyboard. The field above stays for typing.
                  Outside <Field> on purpose: Field takes exactly one focusable control and clones
                  ARIA onto it (components/forms/Field.jsx), so a key group inside would steal the
                  input's wiring.
                  A full-width sibling of the quantity/unit row, not nested in its flex:2 column:
                  nested, the grid's min-content overflowed a 390px viewport and squeezed the unit
                  <Select> until the selected unit was illegible (a wrong-unit harvest logs
                  unnoticed).
                  Below its field, like the weight pad: reading order runs quantity → weight, and the
                  most-tapped keys sit nearer the thumb. jsdom has no layout; coordinates are checked
                  in tests/harness. */}
              {/* Shipped (block-flow) path: marginTop 8 restores the pad→row gap that NumberPad's
                  own marginBottom:8 would otherwise collapse into the weight group's marginTop:14,
                  which would lift everything below by 8px. Clearance against the sticky Save band
                  is resolved at runtime by lib/saveBandLayout.js, not by these pixels.
                  The frame is a grid, so nothing collapses there. Its marginBottom cancels the pad's
                  own 8px, the last spare height in the harvest row (track 1 or 3 height is absorbed
                  by the 1fr disclosure row instead); it is spent below the weight pad. */}
              {/* Two whole style objects rather than one with conditional values: `marginBottom: 0`
                  on the rollback arm emits `margin-bottom: 0px` and breaks the legacy byte
                  fixtures. The frame arm's props must not reach the rollback arm. */}
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
                  // No primary ("Next →") key: each pad calls its own onChange directly
                  // (NumberPad.jsx), so the weight pad writes harvest.weight whether or not its field
                  // has focus and advancing is never required. NumberPad still supports a primary for
                  // a surface where the pad owns its panel.
                />
              </div>
              {/* Optional weight, secondary to quantity: smaller label, no asterisk, blank by
                  default, never blocking a save. A count and a weight together is a per-variety
                  calibration sample. */}
              {/* Frame: paddingBottom, not marginBottom. This group is the last child of
                  `#harvest-section`, which has no padding or border, so a bottom margin would
                  collapse out of the block and not move the pad. Padding cannot collapse and also
                  keeps the pad's own 8px margin in, so the space below the pad is `8 + this`: hence
                  FRAME_PAD_GAP_PX minus that 8. Accounting: lib/saveBandLayout.js. */}
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
                      // 'decimal' unconditionally (grams take a point). Not readOnly, which would kill
                      // the Enter-to-save below: that handler is only reachable while a keyboard is up.
                      inputMode="decimal"
                      // Session only: grams → Enter is the save. Explicit, because Save is
                      // type="button" and a multi-input form with no submit button gets no implicit
                      // Enter submission.
                      enterKeyHint={inHarvestSession ? 'done' : undefined}
                      onKeyDown={inHarvestSession ? (e => {
                        if (e.key === 'Enter') handleSubmit(e, { keepMode: 'type' })
                      }) : undefined}
                      // Focusing this field commits the weigh-in to the keypad below, and on Android
                      // the keyboard then shrinks the viewport and drops the pad's bottom row into the
                      // band, so clear it here (lib/saveBandLayout.js explains why the anchor is left
                      // alone). `!sessionFrame` is inert today only because the frame renders no
                      // `[data-testid="save-sticky"]` and clearWeightPadOfSaveBand returns early on a
                      // missing band. Keep it: if track 3 ever takes that testid, the clearance would
                      // start firing inside the frame with nothing to catch it.
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
                {/* Weight keypad, session only: outside the session weight is the mostly-skipped
                    secondary field and a pad would cost the common path height. In session it is the
                    field the keyboard was raised for, and exactly one control on the surface says
                    "Save". */}
                {/* NumberPad's own `marginBottom: 8` is the gap to the helper line on the shipped
                    path. In the frame it is the first 8px of FRAME_PAD_GAP_PX, which is why the
                    group's paddingBottom is the gap minus it. The gate measures the rendered result
                    rather than trusting this arithmetic. */}
                {inHarvestSession && (
                  <NumberPad
                    value={harvest.weight}
                    onChange={v => {
                      setHarvest(h => ({ ...h, weight: v }))
                      if (harvestError) setHarvestError(null)
                      // The second trigger: a pad-only weigh-in never focuses #harvest-weight, so
                      // the onFocus handler above never runs. The first key press always comes from a
                      // row clear of the band, so this fires before backspace (bottom row) is needed.
                      // `!sessionFrame` as above, and it matters more here: this runs on every key
                      // press and would re-scroll under the thumb once per digit.
                      if (!sessionFrame) clearWeightPadOfSaveBand()
                    }}
                    idPrefix="wt-key"
                    ariaLabel="Harvest weight keypad"
                    keyAriaPrefix="Harvest weight"
                    // No primary button: the sticky Save band is already on screen, and a second Save
                    // would be two controls doing one job.
                  />
                )}
                {/* Helper line skipped in the frame: by the second entry the user knows it, and the
                    frame cannot spare the height. */}
                {!sessionFrame && (
                <div style={{ marginTop: 5, fontSize: '0.72rem', color: P.light, lineHeight: 1.4 }}>
                  Weigh the whole pick — the count above says how many that was.
                </div>
                )}
              </div>

              {harvestError && (
                <div role="alert" style={{ marginTop: 6, fontSize: '0.78rem', color: P.terra, fontWeight: 600 }}>{harvestError}</div>
              )}

              {/* Hidden by flag, not deleted (featureFlags.js). quality_rating stays null and the
                  POST still carries the key, so the server contract is unchanged. */}
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

              {/* Disposition sits last in the panel: it asks about the exception and must never sit
                  between the user and Save. Not gated by HARVEST_QUALITY_HIDDEN: quality rates a
                  good pick, this records that a pick went wrong. */}
              {!sessionFrame && dispositionBlock}
            </>
  )

  /* The wrapper swap is a plain conditional, not two little components: a component declared inside
     render gets a new identity every pass, so React remounts the subtree and resets the pads' and
     picker's state. The flag-off byte fixture catches it. */
  const harvestBlock = (
          form.event_type === 'harvest' && (
            sessionFrame
              ? <div id={HARVEST_SECTION_ID}>{harvestFields}</div>
              : <Section id={HARVEST_SECTION_ID} label="Harvest *">{harvestFields}</Section>
          )
  )

          /* "Add details": collapsible home for Quantity / Visibility / Private notes, collapsed by
             default. Harvest quantity is a separate, always-visible field in the Harvest panel. */
  const addDetailsBlock = (
          <div style={{ backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: '12px 18px' }}>
            <button
              type="button"
              onClick={() => setShowAddDetails(s => !s)}
              aria-expanded={showAddDetails}
              /* minHeight alone (no added padding) brings the tap target to the floor and leaves the
                 label's baseline where it was. */
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: P.mid, fontSize: '0.82rem', fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', padding: 0, minHeight: T.tapMinHeight, display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <span aria-hidden="true">{showAddDetails ? '▾' : '▸'}</span>
              <span>Add details  ·  optional</span>
            </button>

            {showAddDetails && (
              <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 16 }}>
                {/* Quantity (hidden for harvest, which has its own panel) */}
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

          /* Date */
  const whenBlock = (
          <Section label="When?">
            {/* One When control across Log Event and Log Many, and it is `type="date"`: handleSubmit
                sends `form.event_date.split('T')[0]` and the server sets the time, so a time picker
                here would collect a value that is never stored. Real times would be a server change
                to both surfaces together.
                `.slice(0, 10)` matters: drafts from earlier builds hold a datetime-local string, and
                <input type="date"> renders that shape as empty. */}
            <Input
              type="date"
              value={form.event_date.slice(0, 10)}
              onChange={e => setForm(f => ({ ...f, event_date: e.target.value }))}
              aria-label="Event date"
            />
          </Section>
  )

  /* The "Photo, notes & date" disclosure, hoisted so the frame can put it in a different track; the
     element is unchanged (WeighInFrame.flagOff.test.jsx matches byte-for-byte). `showHarvestMore` is
     deliberately never cleared by resetForNext, so entries 2..N on the photo path cost no extra tap. */
  const frameSecondaryBlock = (
              <div style={{ backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: '12px 18px' }}>
                <button
                  type="button"
                  onClick={() => setShowHarvestMore(s => !s)}
                  aria-expanded={showHarvestMore}
                  data-testid="harvest-more-toggle"
                  /* Height added here is absorbed by track 2's `1fr` row and does not move the weight
                     pad relative to Save (lib/saveBandLayout.js). */
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: P.mid, fontSize: '0.82rem', fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', padding: 0, minHeight: T.tapMinHeight, display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <span aria-hidden="true">{showHarvestMore ? '▾' : '▸'}</span>
                  {/* In the frame the date lives in track 1, so the label drops "date": two date
                      controls on one surface let one override the other. */}
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

  /* Track 3: the ledger + Save row, a constant 48px at every N including zero, so it never appears,
     grows or shifts. It names the last saved row (identity line, which may ellipse, and a measurement
     line, which does not; together 30px inside the 48). Save and Undo leave the label ~178px, which
     is why it is two lines. No running totals: the user reads the last entry to verify it against
     the scale. `qty` and `grams` both render because they are different facts. Undo is one control in
     a fixed place; tapping the summary opens the last 10 rows. */
  const frameLedger = (() => {
    const live = sessionRows.filter(r => !r.undone)
    const last = live[live.length - 1] || null
    const qtyPart = last && last.qty !== '' && last.qty != null ? `${last.qty}${last.unit ? ` ${last.unit}` : ''}` : ''
    const gramPart = last && last.grams != null ? `${last.grams} g` : ''
    const measureLabel = [qtyPart, gramPart].filter(Boolean).join('  ·  ')
    const dateLabel = last ? shortDateLabel(last.date) : ''
    const identityLabel = last ? [dateLabel, last.plantName].filter(Boolean).join('  ·  ') : ''
    // For the Undo button's and drawer toggle's accessible names, which need one flat string.
    const lastLabel = last
      ? [dateLabel, last.plantName, measureLabel].filter(Boolean).join(' ')
      : 'nothing logged yet'
    return { live, last, identityLabel, measureLabel, lastLabel }
  })()

  /* The date control sits in track 1 beside the chooser: track 1 is already 52px tall, so a 44px
     control beside it costs no height, while track 2 has no slack. It shows "Today" / "Yesterday" /
     "Aug 24" so the filing day is readable at a glance. The real <input type="date"> is still the
     interactive element (transparent, filling the control), so the native picker opens on one tap. */
  const frameDateLabel = shortDateLabel(form.event_date)
  const frameDateIsToday = form.event_date.slice(0, 10) === todayLocalISO()
  const frameDateControl = (
    <div
      style={{
        position: 'relative', flexShrink: 0, minHeight: 44, minWidth: 76,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: 8, padding: '0 10px',
        // A date that is not today is the state worth seeing: the next save files under another day.
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

  /* The frame hides BottomNav and the heading, so it needs its own exit. It returns where the session
     was entered from: `history.state.idx` is React Router's in-app history counter, so `> 0` means
     there is an app entry to go back to; a cold start (PWA shortcut, shared link) has idx 0 and would
     leave the app, hence the /harvests fallback. Confirms over `hasUnsavedInput`, the same predicate as
     the backdrop guard and reload gate, so it never silently discards a typed weight. */
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
        // A real grid track, so there is no `bottom` inset to desync from `--bottom-nav-height`, and
        // BottomNav is hidden for the session anyway.
        paddingBottom: 'env(safe-area-inset-bottom)',
        boxSizing: 'content-box',
        // Opaque: it sits under the weight pad in a non-scrolling frame and must read as its own
        // surface; a transparent band leaves a dead zone that looks tappable.
        backgroundColor: P.cream,
        borderTop: `1px solid ${P.border}`,
        // Hidden while the planting picker is open, like the shipped band: a listbox opening downward
        // can reach this row. `visibility` does not reflow, so the tracks above do not move.
        visibility: pickerOpen ? 'hidden' : 'visible',
        pointerEvents: pickerOpen ? 'none' : 'auto',
      }}
    >
      {orderByThumb(hand,
        /* Under the thumb: Save, pressed once per entry. */
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
          // 44px, not the primitive's 48: in the 48px track a 48px Save's hit area would start 1px
          // under the pad's bottom row, and at 44 the top of the track is the container (paints the
          // same, takes no clicks). Still above the 44px WCAG 2.5.5 floor. The padding is respelled
          // because buttonChrome's `13px 30px` would overflow 44px. alignSelf flex-end puts all 4px
          // of freed space above Save, where the hazard is, instead of splitting it 2/2.
          style={{ minWidth: 150, flexShrink: 0, minHeight: FRAME_SAVE_HEIGHT_PX, height: FRAME_SAVE_HEIGHT_PX, padding: '11px 30px', alignSelf: 'flex-end' }}
        >
          Save
        </Button>,
        /* Far side: the undo + summary group. The summary takes the flexible middle either way, so
           mirroring moves Undo between ends without the ellipsis changing sides. */
        <div key="ledger" style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
          {orderByThumb(hand,
            /* Undo goes on the offhand side of its own group: destructive and rarely pressed, so it is
               kept as far from Save as this row allows. Its accessible name names the entry, so
               several Undo controls are never indistinguishable. */
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
                // P.mid: this is the line the control exists to surface.
                color: P.mid, fontFamily: 'inherit',
                // The two lines are block children, so the button is not a nowrap box. No
                // `overflow: hidden` here: it clipped 1px off the measurement line's descenders. Each
                // span clips itself horizontally.
                display: 'block',
              }}
            >
              {frameLedger.last ? (
                <>
                  {/* Identity ellipses under a long plant name, the safe thing to lose: the name is
                      also on the chooser, the numbers are nowhere else. */}
                  <span style={{
                    display: 'block', fontSize: '0.85rem', fontWeight: 600, lineHeight: '16px',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {frameLedger.identityLabel}
                  </span>
                  {/* Measurement: the line checked against the scale. 14px line-height, not 13, so
                      the descenders of "g" fit (16 + 14 = 30px inside the 48px track). The ellipsis
                      should never fire on realistic values; it bounds a pathological one, which would
                      otherwise overflow invisibly under Save. */}
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

  /* The page-level banners, hoisted so the frame can overlay them instead of stacking them above the
     form: the frame is a fixed-height column and anything above the form comes out of track 2, which
     has no slack. top:56 clears track 1, because the chooser is the next control tapped after a save;
     the overlay covers the quantity field, which is empty at that moment. */
  const noticeBlocks = (
        <>
        {error && <ErrorBanner style={{ marginBottom: 16 }}>{error}</ErrorBanner>}
        {notice && <ErrorBanner style={{ marginBottom: 16 }}>{notice}</ErrorBanner>}

        </>
  )

  /* The history drawer: `position: absolute` over track 2 rather than a fourth track, so the standing
     layout pays nothing; the user opens it deliberately. Capped at 10 rows with internal scroll. */
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
              /* The ordinal distinguishes rows when the same crop is logged twice in one sitting. */
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

  // The planting whose Save-seed sheet should be open, or null. Derived, not state: the inputs are
  // already form state. Null unless the type is seed_saved and the planting resolves in the loaded
  // list (see the render site).
  const seedSaveTarget = form.event_type === 'seed_saved' && form.plant_id
    ? (plantsForProject.find(p => p.id === form.plant_id) ?? null)
    : null

  return (
    <>
    {/* Choosing "Seed saved" opens the same SaveSeedSheet as the planting page's button, so both doors
        create the lot and write the seed_saved timeline row (the sheet's own POST). Gated on a
        resolved planting, not merely the type: the sheet takes the parent as a parameter, so until
        the required planting is answered the ordinary form renders. Closing without saving clears the
        type, landing the user back on the chooser.
        Seed added to an existing lot ends on that planting's page; the close that follows must not
        clear the type, or the chooser would draw for a frame under a page that is already leaving. */}
    {seedSaveTarget && (
      <SaveSeedSheet
        planting={seedSaveTarget}
        onClose={() => { if (!seedAddedRef.current) setForm(f => ({ ...f, event_type: '' })) }}
        onSeedAdded={(_reply, { replace, closed } = {}) => {
          // An add that lands after the sheet was closed only says "Added": the close already cleared
          // the type, so nothing here marks the page as leaving.
          if (closed) return
          seedAddedRef.current = true
          const to = `/plantings/${seedSaveTarget.id}`
          if (replace) navigate(to, { replace: true })
          else navigate(to)
        }}
      />
    )}
    {/* Frame: `height` + `overflow: hidden`, not `minHeight`. The frame relies on the document never
       scrolling; a minHeight would let it scroll once content exceeded it. */}
    <div style={sessionFrame
      ? { height: FRAME_HEIGHT, overflow: 'hidden', backgroundColor: P.cream }
      : { minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={sessionFrame
        // position:relative is the drawer's containing block (it overlays track 2).
        ? { maxWidth: 600, margin: '0 auto', padding: '0 16px', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }
        : { maxWidth: 600, margin: '0 auto', padding: '28px 16px 60px' }}>

        {/* The frame drops the breadcrumb and heading: ~84px that would push the chooser a third of the
            way down. TopChrome's back affordance is untouched above. */}
        {!sessionFrame && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: '0.82rem', color: P.light, marginBottom: 8 }}>
            <Link to="/dashboard" style={{ color: P.green, textDecoration: 'none' }}>Dashboard</Link>
            {' › Log event'}
          </div>
          <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>
            Log an event
          </h1>
        </div>
        )}

        {/* The frame overlays the banners instead of stacking them above (see noticeBlocks). zIndex 3
            clears the history drawer's 2. */}
        {sessionFrame
          ? <div data-testid="weigh-frame-notices" style={{ position: 'absolute', top: 56, left: 16, right: 16, zIndex: 3 }}>{noticeBlocks}</div>
          : noticeBlocks}

        {/* The frame. Three tracks:
              track 1  auto  planting chooser (pinned top)
              track 2  1fr   qty + qty pad + weight + weight pad, bottom-aligned, overflow-y:auto
              track 3  auto  ledger + Save row (pinned bottom)
            Tracks 1 and 3 are `auto` and track 2 is `1fr`, so an IME show/hide changes only track 2:
            Save and the chooser do not move, the slack is taken at the top of track 2, and the weight
            field and pad under the thumb stay put. Layout, not scroll, so it does not depend on the
            browser preserving scrollTop. gap:0: a row gap would spend viewport height on nothing. */}
        <form
          onSubmit={handleSubmit}
          data-testid={sessionFrame ? 'weigh-frame' : undefined}
          style={sessionFrame
            // gridTemplateColumns minmax(0, 1fr): an implicit column is `auto` (max-content), so the
            // nowrap ledger summary widened it past the viewport and `overflow: hidden` clipped Save
            // and two weight-pad keys off-screen with no error. A zero minimum lets the summary's own
            // ellipsis styling engage.
            ? { display: 'grid', gridTemplateRows: 'auto 1fr auto', gridTemplateColumns: 'minmax(0, 1fr)', flex: 1, minHeight: 0, overflow: 'hidden' }
            : { display: 'flex', flexDirection: 'column', gap: 16 }}
        >

          {sessionFrame ? (
            <>
              {/* Track 1. projectBlock stays immediately before Planting: it renders nothing while
                  PROJECTS_HIDDEN is on, and in the flag-off config Project is required, so burying it
                  would make a harvest unsaveable without scrolling.
                  minHeight 52 pins the track to the taller of PlantingSelect's two states (52px input,
                  44px chip); otherwise the swap on pick and reset moves track 2's top edge.
                  The date control and Close sit beside the chooser, adding no height. The chooser gets
                  `flex: 1; minWidth: 0` so a long chip ellipses instead of pushing Close off-screen. */}
              <div data-testid="weigh-frame-chooser" style={{ minHeight: 52, display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>{projectBlock}{plantingBlock}</div>
                {frameDateControl}
                {frameCloseButton}
              </div>

              {/* Track 2. A nested `minmax(0,1fr) auto` grid, not `align-content: end` on the track:
                  in Chrome an `align-content:end; overflow-y:auto` grid whose content overflows puts
                  the overflow above the top edge, unreachable, with scrollTop pinned at 0. Giving the
                  slack to a flexible first row bottom-anchors the same way and degrades into a real
                  scroller. Row 1: the session lock strip and the photo/notes disclosure. Row 2: the
                  harvest fields and pads. */}
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
                {/* No padding: every px here comes off the pads. */}
                <div>{harvestBlock}</div>
              </div>

              {/* Track 3 */}
              {frameLedgerBlock}
            </>
          ) : (
          <>
          {isHarvest ? (
            /* Harvest order: Planting → Quantity → Unit lead, so the controls a harvest needs are on
               screen when the form opens; everything else drops below under one disclosure.
               Project is not in that disclosure: it renders nothing while PROJECTS_HIDDEN is on, and in
               the flag-off config it is required, so burying it would make a harvest unsaveable
               without expanding something. It stays immediately before Planting.
               The event-type picker stays visible below the harvest panel: it is how a mis-tapped
               type is corrected. Save needs no reordering; it is sticky for every type. */
            <>
              {projectBlock}
              {plantingBlock}
              {harvestBlock}
              {eventTypeBlock}

              {frameSecondaryBlock}

              {addDetailsBlock}
            </>
          ) : (
            /* Every non-harvest type: the photo-first sequence. */
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
              {/* Notes last. Save is sticky, so "below Save" is document order, not viewport order. */}
              {notesDisclosureBlock}
            </>
          )}

          {/* Floating Save. */}
          {/* Spacer so content is not hidden behind the sticky band: 120 for the action row alone,
              plus the feedback zone's height while it renders. CSS-derived estimates (jsdom has no
              rects); the real band height is checked on device. */}
          <div style={{ height: 120 + (showPostSaveStrip ? POST_SAVE_STRIP_SPACER_PX : 0) }} aria-hidden="true" />
          {/* Sticky, not fixed: `fixed` positions against the viewport, so inside a Sheet the CTA
              escaped the panel's scroll region and painted over it. Sticky keeps it inside its scroll
              container (the Sheet when overlaid, the document on the full page). No right inset: a
              sticky block spans the content column and justify-content right-aligns the button.
              Bottom inset differs by container: full page clears the fixed BottomNav with
              SAVE_BAND_BOTTOM_INSET_PX (named in lib/saveBandLayout.js, which measures the weigh-in
              clearance against it); in the overlay the Sheet paints over the nav and already reserves
              the safe area at its foot, so 0. No visualViewport lift (see the note near MicBtn). */}
          {/* Hidden, not unmounted, while the planting picker's listbox is open: EventNew.test.jsx
              pins exactly one "Save", and the picker's 150ms blur-close would make an unmounting
              footer flicker back under a finger. zIndex 1 (sticky needs no more) keeps it above z-auto
              siblings while the listbox (z30) wins if onOpenChange ever regresses. The failure here is
              a wrong write, so both guards stay. */}
          {/* No aria-hidden: `visibility: hidden` already removes the subtree from the a11y tree and
              tab order, and aria-hidden would create the hidden-with-focusable-descendant pattern axe
              flags. */}
          {/* The band is multi-row: the feedback zone (rows 1-2, conditional) above the action zone
              (row 3). Feedback lives here rather than at the top of the sheet so it appears where the
              thumb just was, Undo cannot scroll away, it never paints over content (sticky in flow),
              and it fits at ~500px. The picker suppression covers the whole band, not just the action
              row, because the taller band occludes more of a downward-opening listbox. */}
          <div
            data-testid="save-sticky"
            style={{
              position: 'sticky',
              bottom: inOverlay ? 0 : SAVE_BAND_BOTTOM_INSET_PX,
              zIndex: 1,
              display: 'flex',
              flexDirection: 'column',
              visibility: pickerOpen ? 'hidden' : 'visible',
              // The band must not take a tap where it paints nothing. It spans the content width but
              // paints only while the feedback zone renders; otherwise it is an invisible hit-taker
              // over the form (it made the planting chooser untappable at first paint). So it
              // hit-tests only when opaque, and the painted things inside it (the session strip and
              // the action row's buttons) opt back in. The opaque Save itself overlapping the chooser
              // is handled by the mount clearance effect.
              pointerEvents: pickerOpen || !showPostSaveStrip ? 'none' : 'auto',
              // Opaque only while the feedback zone renders; pre-save the shadowed Save floats over the
              // form.
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
            {/* The session ledger: rows, running totals and per-row undo, in the sticky band where
                the thumb just was. Capped at the last 3 rows so Save stays on a 500px viewport; the
                header counts the whole session. Inherits the band's pickerOpen suppression. */}
            {inHarvestSession && sessionRows.length > 0 && (() => {
              const live = sessionRows.filter(r => !r.undone)
              const totalG = live.reduce((s, r) => s + (r.grams ?? 0), 0)
              const visible = sessionRows.slice(-3)
              const totalLabel = totalG >= 1000 ? `${Math.round(totalG / 100) / 10} kg` : `${Math.round(totalG)} g`
              // Opts back in: an opaque surface whose per-row Undo buttons must stay tappable while
              // the band around them does not hit-test.
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
            {/* Action zone (row 3): Save keeps the right, Done takes the left, Undo is row 1 right.
                Undo above Save is mitigated rather than avoided: every mis-tap outcome is visible and
                one-tap recoverable, and Undo's bottom edge stays at least 20px above Save's top
                (feedback zone's 12px bottom padding + this row's 12px top padding). CSS-derived;
                jsdom cannot measure it. */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12,
              justifyContent: inOverlay ? 'space-between' : 'flex-end',
              paddingTop: showPostSaveStrip ? 12 : 0,
              paddingBottom: showPostSaveStrip ? 'calc(10px + env(safe-area-inset-bottom))' : 0,
              paddingLeft: showPostSaveStrip ? 12 : 0,
              paddingRight: showPostSaveStrip ? 12 : 0,
            }}>
              {/* `Done`, present from mount (overlay only): the exit is needed most when abandoning
                  before a save. Sheet's own Close is an icon at the top of a scrollport that is
                  off-screen at 390×500 with the keyboard open, and the backdrop locks once the user
                  types. Named differently from the header's Close so the two exits do not read as
                  duplicates. Dismisses even while dirty, like Close; no confirmation dialog (modals are
                  a banned channel). A half-typed harvest quantity is discarded, as Escape and Back
                  already do.
                  Both buttons opt back in to pointer events and restate the pickerOpen guard at the
                  control, so the wrong-write protection does not rest on one ancestor property. */}
              {inOverlay && (
                <button type="button" onClick={dismissOverlay} style={{ ...confirmBtnGhost, pointerEvents: pickerOpen ? 'none' : 'auto' }}>
                  Done
                </button>
              )}
              {/* One Save: keep the event_type, clear the plant, stay on the form for the next plant. */}
              <Button
                type="button"
                variant="primary"
                loading={saving}
                // While the photo leg runs, name the step and live % (same labels as PhotoUpload), so
                // a stalled upload never hides behind a long "Saving…".
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

        {/* The end-status offer sits outside the form: it is a post-save decision about the
            planting, and the form has already been reset. It dismisses through the shared Sheet
            primitive and DismissRegistry (Escape, Android Back, backdrop and the two decline
            controls), and none of those writes a status. This prose avoids the literal
            angle-bracketed Sheet tag on purpose: modalSurfaceFreeze.static.test.js scans source
            text for render sites, and EventNew renders no sheet of its own. */}
        <EndStatusOffer
          offer={endStatusOffer}
          plantName={endStatusOffer?.plantName}
          onDismiss={() => setEndStatusOffer(null)}
          onApply={async (status) => {
            // The ordinary plants PUT. The events endpoint never writes status, so this explicit tap
            // is the only path that can.
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


// Flag mode body: severity (required, 3 buttons), then a seeded issue dropdown with an "Other" (typed
// or voiced via MicBtn). The issue is stored as free-text metadata.issue_label; severity is the DB
// smallint.
function FlagModeFields({ severity, onSeverity, issueChoice, onIssueChoice, issueOther, onIssueOther, voice, onBack }) {
  const TONE = { gold: P.gold, terra: P.terra, red: P.severityUrgent }
  // WCAG 1.4.1: the ladder is monotonic by shape (filled dot -> open triangle -> triangle with an
  // alert), so severity survives in greyscale. Colour is a second channel and the label a third; the
  // glyph takes currentColor (the tone on rest, white on select) from P, never baked colours.
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
              {/* On rest the glyph takes the rung's tone against white; on select the button fills
                  with that tone and the glyph goes white. */}
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
            {/* No glyph: an <option> renders text only, so it cannot take an <Icon>. */}
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

// `Section` is imported from components/FormSection.jsx. No `style` is passed at the call sites: these
// sections are flex children of the gap:16 <form>, so the card carries no outer margin.

// SuccessScreen is unused (the save flow stays on the form). It is the one place in this file that
// renders pictographic characters: the streak flame, XP bolt and level-up popper are reward ornament,
// not icon slots, and add nothing the adjacent text does not say. `eventMeta?.emoji` comes from
// lib/eventTypes.js.
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
