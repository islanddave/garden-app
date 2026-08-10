import React, { useState, useEffect, useRef, useCallback } from 'react'
import { takePendingCapture } from '../lib/pendingCapture.js'
import { saveFileToDevice } from '../lib/saveFileToDevice.js'
import ProjectOptions from '../components/ProjectOptions.jsx'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P, EVENT_TYPES, LOGGABLE_PROJECT_STATUSES, BOTTOM_NAV_HEIGHT_PX } from '../lib/constants.js'
import { EVENT_TYPE_META, requiresPlanting } from '../lib/eventTypes.js'
import { PLANTING_REQUIRED_ENABLED, PROJECTS_HIDDEN, HARVEST_QUALITY_HIDDEN } from '../lib/featureFlags.js'
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
import { seasonTotalPhrase } from '../lib/harvestSummary.js'
import { useUxFlow, FLOWS } from '../lib/uxEvents.js'
import { EVENTNEW_ADD_DETAILS_EXPANDED } from '../lib/featureFlags.js'
import { Field, Input, Select, Textarea, Button, ErrorBanner, PlantingSelect, SelectChip } from '../components/forms'
import TreatmentDetails from '../components/TreatmentDetails.jsx'
import { useToast } from '../context/ToastContext.jsx'
import { OverlaySwapLink, useInOverlaySurface, useOverlaySwap, useOverlayDismiss, useReportOverlayDirty } from '../context/OverlayContext.jsx'
import { readDraft, writeDraft, clearDraft } from '../lib/draftStash.js'
import { EVENT_METADATA_FIELDS, HARVEST_QUALITY_LABELS, PLANT_CONTAINER_TYPE_OPTIONS, SEVERITY_LEVELS, ISSUE_OPTIONS } from '../lib/dropdownRegistry.js'

// V3-EVENT-008: EVENT_TYPE_META lives in the canonical src/lib/eventTypes.js
// (single source of truth). Re-exported here so existing importers from
// EventNew.jsx (EventTypesPhase1.test.jsx) keep working unchanged.
export { EVENT_TYPE_META }

export { EVENT_TYPES_UI, SECONDARY_GROUPS }

const DEFAULT_HARVEST_UNIT = 'count'

// Read the user's last-used harvest unit from localStorage. Guarded for
// tests / SSR where localStorage may be unavailable or throw.
function readLastHarvestUnit() {
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
// INVARIANT (server exactly_one_parent CHECK): a remembered plant is only ever seeded
// alongside its remembered parent project — plant_id present ⇒ project_id present.
const LAST_PLANT_KEY = 'logone.lastPlant'

// V4-OVERLAY-001 Slice 2 draft stash key + the form fields that survive a dismiss/re-open. Only the
// `form` object is stashed: the type-specific panels (metadata/harvest/treatment/severity/container)
// are RESET by the form.event_type-change effect, so restoring them would be immediately clobbered —
// stashing `form` (which those effects never touch) keeps the irreplaceable typed content (event
// type, target plant, notes, quantity, date) without fighting the reset effects. project_id is
// excluded so the load effect's remembered/validated project stands (avoids a mount-order race).
const EVENTNEW_DRAFT_KEY = 'logone'
const DRAFT_FORM_FIELDS = ['event_type', 'notes', 'private_notes', 'quantity', 'event_date', 'is_public', 'plant_id']

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
    recRef.current?.stop()

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    const rec = new SR()
    rec.continuous    = false
    rec.interimResults = false
    rec.lang          = 'en-US'

    rec.onresult = (e) => {
      const text = e.results[0][0].transcript
      onResult(text)
    }
    rec.onend  = () => { setListening(false); setFieldKey(null) }
    rec.onerror = () => { setListening(false); setFieldKey(null) }

    recRef.current = rec
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
  // V4-LOGTARGET-001 (sticky option b): remembered PLANTING, seeded ONLY when its
  // remembered parent project is also seeding — never with a deep-linked ?project=
  // or ?plant= (explicit intent wins), and never without a remembered project (a
  // plant with no parent project would violate the server's exactly_one_parent
  // CHECK at submit). Validated against the project's live plants in the load
  // effect below (archived/missing → cleared, same fallback as the project path).
  const [rememberedPlantId] = useState(() =>
    (!preselectedProjectId && !preselectedPlantId && rememberedProjectId) ? readLastPlantId() : ''
  )

  const [form, setForm] = useState({
    event_type:    preselectedEventType,
    project_id:    preselectedProjectId || rememberedProjectId,
    location_id:   '',
    event_date:    toDatetimeLocal(new Date()),
    notes:         '',
    private_notes: '',
    quantity:      '',
    plant_id:      preselectedPlantId || rememberedPlantId,
    is_public:     true,
  })

  // Tier 2 metadata state — { [field.key]: value } — only populated keys submitted
  const { show: showToast, showUndo } = useToast()
  // V4-OVERLAY-001 Slice 2: true only when this form is rendered INSIDE the overlay Sheet. Gates the
  // overlay-only behaviors (in-surface undo, draft stash) so the full-page path is byte-identical.
  const inOverlay = useInOverlaySurface()
  // V4-HARVESTCENTER-001 (L9): the harvest-log habit-stack trigger. After a harvest saves, offer an
  // ambient "preserve this?" affordance that opens /put-up carrying { prefill } (crop/variety/plant/
  // harvest_log). useOverlaySwap so an in-overlay trigger swaps the SAME overlay's content (preserving
  // the original background); full-page it degrades to a plain navigate. Reward-adjacent, no interrupt.
  const putUpSwap = useOverlaySwap()
  const [preserveCtx, setPreserveCtx] = useState(null)
  // V4-LOGCONF-001 (C1+C2, supersedes the §7 inlineUndo timed banner): after an overlay save the
  // sheet BODY is replaced by a DURABLE confirmation card — no timer, dismissed only by explicit
  // action (Close / View event / Log another / Undo). Same §7 modality rationale (the global toast
  // is AT-invisible behind aria-modal) but as a state change, not a 5s race the user always loses.
  // { eventId, projectId, projName, eventLabel, eventEmoji, undone, error } | null.
  // projectId comes from the POST RESPONSE (not staged client state) — it builds the View link.
  const [confirmation, setConfirmation] = useState(null)
  // V4-HARVESTVIEW-001 S4a: ambient "Season: 4.5 cups blueberry" line on the harvest confirmation
  // card (design §2 loop-closer). STATIC text, best-effort, overlay-only. Null unless the just-logged
  // harvest resolved a crop AND the post-save aggregates GET returned a total.
  const [seasonLine, setSeasonLine] = useState(null)
  const closeBtnRef = useRef(null)
  const dismissOverlay = useOverlayDismiss()
  const [metadataState, setMetadataState] = useState({})
  // V4-TREATLOG-001: dedicated treatment capture (pest_treatment / doctored).
  const [treatment, setTreatment] = useState({ pest_target: '', product_id: '', product_text: '', category: '', amount: '' })
  const [inventory, setInventory] = useState([])

  // V3-EVENTCONTSIZE-001: optional new-container capture, shown for potting_up/transplant on a specific
  // planting. On submit it also PUTs the planting's container_type/container_size via the live /api/plants
  // endpoint (reuses the PLANT-CONTAINER-001 write path; not stored as event metadata).
  const [container, setContainer] = useState({ type: '', size: '' })

  // V1.2a-2 Wave 3: harvest panel state — only submitted for event_type=harvest.
  const [harvest, setHarvest] = useState(freshHarvest)
  const [harvestError, setHarvestError] = useState(null)

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
  // V3-EVENT-008 §8: "Add details" collapsible (Quantity / Visibility / Private notes).
  // Default collapsed unless the feature flag flips it open. Fields stay reachable.
  const [showAddDetails, setShowAddDetails] = useState(EVENTNEW_ADD_DETAILS_EXPANDED)
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
  // Stable identity: PlantingSelect reads this through a ref and its effect keys on `open` alone,
  // but keeping the handler stable costs nothing and keeps the BUG-SOWFOCUS-001 rule intact for any
  // future consumer that does key on the callback.
  const handlePickerOpenChange = useCallback(open => setPickerOpen(open), [])
  // the user explicitly started — never a reward/celebration channel).

  // Reset metadata when event type changes
  useEffect(() => {
    setMetadataState({})
    // V1.2a-2 Wave 3: reset the type-specific panels too. Harvest unit is
    // re-seeded from localStorage so the user's last choice persists across types.
    setHarvest(freshHarvest())
    setHarvestError(null)
    // V4-FLAG-001: reset flag-mode fields when the event type changes.
    setSeverity(null); setIssueChoice(''); setIssueOther('')
    // V4-TREATLOG-001: reset treatment capture on type change.
    setTreatment({ pest_target: '', product_id: '', product_text: '', category: '', amount: '' })
    // V4-HARVESTCENTER-001: a fresh type choice clears the lingering "preserve this?" affordance.
    setPreserveCtx(null)
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
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // §4 draft stash — persist the in-progress form while dirty (BOTH surfaces, V4-DRAFTFULLPAGE-001).
  // Cleared on a successful save (spent). Dirty NARROWED to typed text (was any-field): the sticky
  // seeds (event_type kept post-save, remembered plant_id) satisfied the old predicate on every
  // mount, so the post-save rewrite stored a draft whose EMPTY plant_id then clobbered the
  // V4-LOGTARGET-001 remembered-planting seed on the next bare mount. Typed text is the
  // irreplaceable content; picks still ride along in the snapshot whenever text is present.
  useEffect(() => {
    const dirty = !!(form.notes || form.private_notes || form.quantity)
    if (!dirty) return
    const snap = {}
    for (const k of DRAFT_FORM_FIELDS) snap[k] = form[k]
    writeDraft(EVENTNEW_DRAFT_KEY, { form: snap, showPrivate, showAddDetails })
  }, [form, showPrivate, showAddDetails])

  // V4-DRAFTFULLPAGE-001 (b) — report in-progress content to the hosting Sheet (OverlayHost feeds
  // Sheet §5.2: a stray backdrop tap no-ops while dirty; Escape + the labelled Close stay live, and
  // the draft stash above keeps the bytes recoverable). BROADER than the stash predicate: it also
  // counts the non-stashed panels (photo, harvest qty, metadata, treatment, container, issue text)
  // whose loss a dismiss makes unrecoverable. Deliberately EXCLUDES bare event_type/plant_id picks —
  // sticky/deep-link seeding would otherwise lock the backdrop on every pristine mount. False while
  // the confirmation card shows (already saved — the card must stay backdrop-dismissable). No-op on
  // the full page (no provider).
  useReportOverlayDirty(!confirmation && !!(
    form.notes || form.private_notes || form.quantity ||
    photoFile || harvest.quantity || harvest.weight ||
    Object.keys(metadataState).length ||
    treatment.pest_target || treatment.product_id || treatment.product_text || treatment.category || treatment.amount ||
    container.type || container.size.trim() ||
    issueOther
  ))

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
        // to one specific id (the ?plant= deep-link prefill and the remembered planting), which is
        // why a HAND-PICKED planting survived a project switch untouched and POSTed as a mismatched
        // (project_id, plant_id) pair with nothing on either side validating it. Prod carries 39
        // such pairs. The rule is not about where the id came from: any plant_id that is not in this
        // project's live plantings is not a valid target for this project, full stop. Subsumes both
        // prior checks (V3-LOG-001 deep-link safety, V4-LOGTARGET-001 remembered-planting fallback)
        // — same silent fall-back to no planting, no notice, since neither is a user error.
        setForm(f => (f.plant_id && !live.some(p => p.id === f.plant_id) ? { ...f, plant_id: '' } : f))
      })
      .catch(() => { if (!cancelled) { setPlantsForProject([]); setPlantsLoadFailed(true) } })
    return () => { cancelled = true }
  }, [apiFetch, form.project_id, preselectedPlantId, rememberedPlantId, plantsReloadKey])

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
        // V4-LOGTARGET-001: the remembered PLANT falls with its parent project — a plant
        // seeded without a live project would violate plant_id ⇒ project_id at submit.
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
  // Deliberate focus management (C1): when the card appears (and again when Undo lands), move focus
  // to the primary Close action. Keyed on the PHASE string, not the confirmation object, so an undo
  // FAILURE (error added, phase unchanged) never yanks focus away from the retryable Undo button.
  // (BUG-SOWFOCUS-001 class: never key a focus effect on an identity that changes per render.)
  const confirmPhase = confirmation ? (confirmation.undone ? 'undone' : 'logged') : null
  useEffect(() => {
    if (confirmPhase) closeBtnRef.current?.focus()
  }, [confirmPhase])

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
    setHarvest(freshHarvest())
    setHarvestError(null)
    setSeverity(null); setIssueChoice(''); setIssueOther('')
    setContainer({ type: '', size: '' })
    clearPhoto()
    setShowAddDetails(EVENTNEW_ADD_DETAILS_EXPANDED)
    setShowPrivate(false)
    setError(null)
    setSaving(false)
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
    const mergedMeta = { ...metadataState, ...(isFlag && issueLabel ? { issue_label: issueLabel } : {}) }
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
    if (isHarvest) {
      try { localStorage.setItem('lastHarvestUnit', harvest.unit) } catch { /* noop */ }
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

    resetForNext(keepMode)
    clearDraft(EVENTNEW_DRAFT_KEY)   // saved to DB — the working draft is spent
    // Operational confirmation + undo. Undo = soft-delete the just-logged event. Rewards stay
    // ambient per Reward-UX V101 — never dispatched here.
    if (eventId) {
      if (inOverlay) {
        // V4-LOGCONF-001 (C1+C2): durable confirmation card replaces the sheet body — no timer.
        // Global toast is skipped (AT-invisible behind aria-modal, §7). projectId is taken from the
        // POST RESPONSE so the View link can never point at a stale/mismatched client-side project.
        setConfirmation({
          eventId,
          projectId: result.project_id ?? null,
          // V4-VIEWPLANT-001: plantId gates + builds the "View planting" action. RESPONSE-sourced
          // (same event row as project_id, so the pair corresponds by construction — the project-
          // scoped planting route's ownership guard, PlantingDetail.jsx:126, is satisfied).
          plantId: result.plant_id ?? null,
          plantName,
          projName,
          eventLabel: (EVENT_TYPE_META[form.event_type]?.label ?? 'event').replace('\n', ' '),
          eventEmoji: EVENT_TYPE_META[form.event_type]?.emoji ?? '✓',
          undone: false,
          error: null,
          photoError,
        })
        // V4-HARVESTVIEW-001 S4a: post-save season-total line (design §2 loop-closer). Cleared first
        // so a prior harvest's total can never flash on this card; then a harvest-only aggregates GET
        // fills it. Best-effort + STATIC text: renders nothing on failure, adds no link (the card's
        // link count is a pinned B5 invariant), and does not touch confirmPhase, so focus stays put.
        setSeasonLine(null)
        if (isHarvest && seasonCropSlug) {
          apiFetch(`/api/harvests?include=aggregates&crop=${encodeURIComponent(seasonCropSlug)}`)
            .then(d => { const phrase = seasonTotalPhrase(d?.aggregates?.crops?.[0]); if (phrase) setSeasonLine(`Season: ${phrase}`) })
            .catch(() => { /* ambient — the card never surfaces a harvests-read failure */ })
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
          onUndo: () => { apiFetch('/api/events/' + eventId, { method: 'DELETE' }).catch(() => {}) },
        })
      }
    } else {
      showToast({ message: keepMode === 'type' ? 'Saved — pick the next plant' : 'Saved — log the next event' })
    }
  }

  // ── V4-LOGCONF-001 (C1+C2): durable overlay confirmation — replaces the sheet body ──
  // Pattern copied from LogMany's proven result screen (:248-269). Overlay-only: the full-page
  // branch keeps the global toast + always-visible form (see handleSubmit). Dismissed ONLY by
  // explicit action: Close (primary → dismiss overlay), View event + View planting (sibling
  // secondaries, literal nouns — EventDetail / PlantingDetail from the POST response; the planting
  // one renders only when the event has a plant_id — V4-VIEWPLANT-001), Log another (rapid entry,
  // V3-EVENT-001 — the form is already reset underneath), Undo (tertiary: separated placement + icon + lighter weight, not
  // color alone; ≥44pt). The action footer is sticky with env(safe-area-inset-bottom) ON the footer
  // ON the footer. (The visualViewport lift that used to be here went with V4-KBVIEWPORT-001:
  // interactive-widget=resizes-content puts the layout viewport above the keyboard, so a sticky
  // bottom:0 footer is already clear of it.)
  if (inOverlay && confirmation) {
    const viewHref = (!confirmation.undone && confirmation.eventId)
      ? `/events/${confirmation.eventId}` : null
    // V4-VIEWPLANT-001: sibling secondary to View event, shown ONLY when the created event has a
    // planting (response plant_id). V4-UNSCOPEDROUTES-001: both links use the canonical un-scoped
    // routes, so they no longer require a projectId — the knock-on that made "View planting"
    // silently disappear for project-less plantings is closed.
    const viewPlantingHref = (!confirmation.undone && confirmation.plantId)
      ? `/plantings/${confirmation.plantId}` : null
    return (
      <div style={{ backgroundColor: P.cream, display: 'flex', flexDirection: 'column', minHeight: '45dvh' }}>
        <div style={{ maxWidth: 600, width: '100%', margin: '0 auto', padding: '24px 16px 8px', flex: 1, boxSizing: 'border-box' }}>
          <div style={{ backgroundColor: P.greenPale, border: `1px solid ${P.greenLight}`, borderRadius: 10, padding: 20, textAlign: 'center' }}>
            <div role="status" aria-live="polite">
              {confirmation.undone ? (
                <p style={{ margin: 0, fontWeight: 700, color: P.green, fontSize: '1.05rem' }}>
                  <span aria-hidden="true">↩ </span>Event removed
                </p>
              ) : (
                <>
                  <div style={{ fontSize: '2rem', lineHeight: 1, marginBottom: 8 }} aria-hidden="true">{confirmation.eventEmoji}</div>
                  {/* V4-LOGTARGET-001: the confirmation names the TARGET, not just the project.
                      plantId is RESPONSE-sourced (the saved row's truth): planting attached → name
                      it; none → say so plainly. Static text on the existing card (Reward-UX ambient;
                      no new surface). plantName is the client-state label; if it didn't resolve the
                      dash phrase is simply omitted rather than mislabeling the row. */}
                  <p style={{ margin: '0 0 4px', fontWeight: 700, color: P.green, fontSize: '1.05rem' }}>
                    ✓ Logged {confirmation.eventLabel}
                    {confirmation.plantId
                      ? (confirmation.plantName ? ` — ${confirmation.plantName}` : '')
                      : ' — no planting attached'}
                  </p>
                  <p style={{ margin: 0, color: P.mid, fontSize: '0.85rem' }}>for {confirmation.projName}</p>
                </>
              )}
            </div>
            {/* V4-HARVESTVIEW-001 S4a: ambient season-total line (design §2). STATIC text, NOT a link
                — the card's link count is a pinned B5 invariant (EventNewOverlaySlice2). Outside the
                role=status region so it isn't re-announced when it arrives async. Hidden once undone
                (the just-logged harvest was removed, so the total would be stale). */}
            {seasonLine && !confirmation.undone && (
              <p style={{ margin: '10px 0 0', color: P.green, fontSize: '0.9rem', fontWeight: 600 }}>{seasonLine}</p>
            )}
            {confirmation.error && (
              <p role="alert" style={{ margin: '10px 0 0', color: P.terra, fontSize: '0.82rem', fontWeight: 600 }}>
                {confirmation.error}
              </p>
            )}
            {/* BUG-PHOTOUPLOADHANG-001: a swallowed photo failure must still be VISIBLE. Static
                text, NO link — the card's link count is a pinned B5 invariant. */}
            {confirmation.photoError && !confirmation.undone && (
              <p role="alert" style={{ margin: '10px 0 0', color: P.terra, fontSize: '0.82rem', fontWeight: 600 }}>
                ⚠️ The photo didn't upload: {confirmation.photoError}
              </p>
            )}
            {!confirmation.undone && (
              <div style={{ marginTop: 14, paddingTop: 10, borderTop: `1px solid ${P.greenLight}` }}>
                <button type="button" onClick={undoEvent} style={{
                  background: 'transparent', border: 'none', color: P.mid, fontWeight: 500,
                  fontSize: '0.88rem', cursor: 'pointer', minHeight: 44, minWidth: 44,
                  padding: '10px 14px', fontFamily: 'inherit',
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}>
                  <span aria-hidden="true">↩</span> Undo this log
                </button>
              </div>
            )}
          </div>
          {preserveCtx && !confirmation.undone && (
            <PreserveOffer
              onOpen={() => putUpSwap('/put-up', { state: { prefill: preserveCtx.prefill } })}
              onDismiss={() => setPreserveCtx(null)}
            />
          )}
        </div>
        <div style={{
          // V4-KBVIEWPORT-001: bottom:0, not a keyboard inset. This footer is sticky inside the
          // Sheet's own scrollport, and the Sheet already reserves
          // `calc(12px + env(safe-area-inset-bottom))` (Sheet.jsx) at its foot.
          position: 'sticky', bottom: 0, zIndex: 200, backgroundColor: P.cream,
          borderTop: `1px solid ${P.border}`, padding: '10px 16px',
          paddingBottom: 'calc(10px + env(safe-area-inset-bottom))',
          display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap',
        }}>
          <button type="button" onClick={() => { setConfirmation(null); setSeasonLine(null) }} style={confirmBtnGhost}>
            Log another
          </button>
          {viewHref && (
            <Link to={viewHref} style={{ ...confirmBtnGhost, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>
              View event
            </Link>
          )}
          {viewPlantingHref && (
            <Link to={viewPlantingHref} style={{ ...confirmBtnGhost, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', maxWidth: 180 }}>
              {/* long plant names: clamp the label text (ellipsis needs the inner span — an
                  inline-flex box won't ellipsize itself), keep the 44pt target; the footer's
                  flexWrap stacks/wraps at ~390px rather than shrinking targets */}
              <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {confirmation.plantName ? `View ${confirmation.plantName}` : 'View planting'}
              </span>
            </Link>
          )}
          <button type="button" ref={closeBtnRef} onClick={dismissOverlay} style={confirmBtnPrimary}>
            Close
          </button>
        </div>
      </div>
    )
  }

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

          {/* ── Photo — V4-LOGPHOTOFIRST-001 (BD-003, Dave 2026-08-04): "It should lead. Everything
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
               PhotoLibrary uses for its own one-of-target rule. ── */}
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
                <button
                  type="button"
                  onClick={() => saveFileToDevice(photoFile)}
                  aria-label="Save photo to device"
                  style={{
                    position: 'absolute', bottom: 8, right: 8,
                    background: 'rgba(0,0,0,0.55)', color: P.white,
                    border: 'none', borderRadius: 8, padding: '5px 10px',
                    cursor: 'pointer', fontSize: '0.72rem', fontWeight: 600,
                  }}
                >Save to device</button>
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

          {/* ── Event type ── */}
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

          {/* ── V4-TREATLOG-001: Treatment details — directly below Event Type for pest/treatment events ── */}
          {(form.event_type === 'pest_treatment' || form.event_type === 'doctored') && (
            <TreatmentDetails value={treatment} onChange={setTreatment} inventory={inventory} eventType={form.event_type} />
          )}

          {/* ── Notes ── */}
          <Section label="Notes">
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
          </Section>

          {/* ── Project ── V4-PROJHIDE-001: hidden when projects are not a user-facing concept; the
               project_id is then derived from the chosen planting (or the default) instead of picked. ── */}
          {!PROJECTS_HIDDEN && (
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
          )}

          {/* ── Planting — V3-EVENT-005: ever-present, disabled until project chosen.
               V4-LOGTARGET-001: relabeled from "Plant / Group (optional)" and the affirmative
               "— All plants (project level) —" sentinel retired: the no-planting state must read
               as UNSET (a neutral placeholder), never as a deliberate project-level choice.
               No requiredness here — Lane 2 is defaulting + feedback only (Lane 3 owns gating).
               V4-PLANTPICKER-001: the shared searchable PlantingSelect replaces the raw select.
               Scope stays project-bound (plants fed from the load effect above, which owns the
               deep-link/sticky validation); PROJHIDE/Lane 3 flips this to the unscoped source. ── */}
          <Section label={(PLANTING_REQUIRED_ENABLED || PROJECTS_HIDDEN) && requiresPlanting(form.event_type) ? 'Planting *' : 'Planting'}>
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

          {/* ── V3-EVENTCONTSIZE-001: new-container capture for potting_up / transplant on a chosen planting ── */}
          {(form.event_type === 'potting_up' || form.event_type === 'transplant') && form.plant_id && (
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
          )}

          {/* ── Tier 2: per-type metadata enrichment (collapsible) ── */}
          <MetadataSection
            eventType={form.event_type}
            metadataState={metadataState}
            onMetadataChange={handleMetadataChange}
          />

          {/* ── V1.2a-2 Wave 3: Harvest panel (harvest events only) ── */}
          {form.event_type === 'harvest' && (
            <Section label="Harvest *">
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ flex: 2 }}>
                  {/* V4-HARVQTYCHIPS-001 — quick-pick chips ABOVE the field, not replacing it.
                      A chip fills the quantity in ONE tap with no keyboard; the field below is
                      untouched, so the 16.8% of harvests outside 1-6 cost exactly what they cost
                      today. Pure addition, no regression on the tail — which is why there is no
                      "More" affordance: the field IS the more affordance.
                      Sits outside <Field> deliberately: Field's frozen contract takes EXACTLY ONE
                      focusable control and clones ARIA onto it (components/forms/Field.jsx), so a
                      chip group inside it would trip contractWarn and steal the input's wiring.
                      Composed from the frozen SelectChip primitive, not a new one (FROZEN.md). */}
                  <div
                    role="group"
                    aria-label="Harvest quantity quick pick"
                    // Grid, not flex-wrap: six equal columns keep the row on ONE line at 375px
                    // (measured 45.2px per chip) instead of wrapping to two and doubling the block
                    // height from 48px to 104px on the fast path.
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
                      aria-label="Harvest quantity"
                      error={!!harvestError}
                      placeholder="e.g. 2.5"
                    />
                  </Field>
                </div>
                <div style={{ flex: 1 }}>
                  <Field label="Unit" htmlFor="harvest-unit">
                    <Select
                      id="harvest-unit"
                      value={harvest.unit}
                      onChange={e => setHarvest(h => ({ ...h, unit: e.target.value }))}
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
          )}

          {/* ── V3-EVENT-008 §8: "Add details" — collapsible home for the three
               low-frequency fields (Quantity / Visibility / Private notes). Default
               collapsed (feature-flagged) to declutter the common path; fully reachable.
               Harvest quantity is a SEPARATE field in the Harvest panel and stays visible. ── */}
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

          {/* ── Photo moved to the TOP of the form — V4-LOGPHOTOFIRST-001 (BD-003). ── */}

          {/* ── Visibility + Private notes moved into "Add details" above (V3-EVENT-008 §8) ── */}

          {/* ── Date / time ── */}
          <Section label="When?">
            <Input
              type="datetime-local"
              value={form.event_date}
              onChange={e => setForm(f => ({ ...f, event_date: e.target.value }))}
              aria-label="Event date and time"
            />
          </Section>

          {/* ── Floating Save — V3-EVENT-005 (Dave to eyeball bottom offset) ── */}
          {/* Spacer so content isn't hidden behind the sticky button */}
          <div style={{ height: 120 }} aria-hidden="true" />
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
          <div
            data-testid="save-sticky"
            style={{
              position: 'sticky',
              bottom: inOverlay ? 0 : BOTTOM_NAV_HEIGHT_PX + 12,
              zIndex: 1,
              display: 'flex',
              justifyContent: 'flex-end',
              visibility: pickerOpen ? 'hidden' : 'visible',
              pointerEvents: pickerOpen ? 'none' : 'auto',
            }}
          >
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

// V4-LOGCONF-001 action styles — mirror LogMany's result-screen buttons; min 44pt touch targets.
const confirmBtnPrimary = { backgroundColor: P.green, color: P.white, border: 'none', borderRadius: 8, padding: '11px 18px', minHeight: 44, fontSize: '0.9rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }
const confirmBtnGhost = { backgroundColor: P.white, color: P.green, border: `1px solid ${P.greenLight}`, borderRadius: 8, padding: '10px 16px', minHeight: 44, fontSize: '0.88rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }

// V4-HARVESTCENTER-001 (L9) "preserve this?" offer — extracted so the V4-LOGCONF-001 confirmation
// card and the form view render the identical affordance. Reward-adjacent, ambient, dismissible.
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

function Section({ label, children }) {
  return (
    <div style={{
      backgroundColor: P.white, border: `1px solid ${P.border}`,
      borderRadius: 10, padding: '16px 18px',
    }}>
      <label style={{
        display: 'block', fontSize: '0.77rem', fontWeight: 700,
        color: P.mid, marginBottom: 10,
        letterSpacing: '0.4px', textTransform: 'uppercase',
      }}>
        {label}
      </label>
      {children}
    </div>
  )
}

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
