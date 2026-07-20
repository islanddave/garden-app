import React, { useState, useEffect, useRef, useCallback } from 'react'
import { takePendingCapture } from '../lib/pendingCapture.js'
import { saveFileToDevice } from '../lib/saveFileToDevice.js'
import ProjectOptions from '../components/ProjectOptions.jsx'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P, EVENT_TYPES, LOGGABLE_PROJECT_STATUSES } from '../lib/constants.js'
import { EVENT_TYPE_META } from '../lib/eventTypes.js'
import EventTypePicker, { EVENT_TYPES_UI, SECONDARY_GROUPS } from '../components/forms/EventTypePicker.jsx'
import { formatQty } from '../lib/format.js'
import { useUploadPhoto } from '../hooks/useUploadPhoto.js'
import { HARVEST_UNITS, MAX_PLAUSIBLE } from '../lib/harvest-constants.js'
import { useUxFlow, FLOWS } from '../lib/uxEvents.js'
import { EVENTNEW_ADD_DETAILS_EXPANDED } from '../lib/featureFlags.js'
import { Field, Input, Select, Textarea, Button, ErrorBanner } from '../components/forms'
import TreatmentDetails from '../components/TreatmentDetails.jsx'
import { useToast } from '../context/ToastContext.jsx'
import { OverlaySwapLink, useInOverlaySurface, useOverlaySwap } from '../context/OverlayContext.jsx'
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

// V4-STICKY-001: remember the last chosen project across sessions, mirroring
// LogMany's quicklog.lastScope pattern (module-const key + guarded localStorage,
// validated against live projects on load). Stored as a bare project id string.
const LAST_PROJECT_KEY = 'logone.lastProject'

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

  const [form, setForm] = useState({
    event_type:    preselectedEventType,
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
  // V4-HARVESTCENTER-001 (L9): the harvest-log habit-stack trigger. After a harvest saves, offer an
  // ambient "preserve this?" affordance that opens /put-up carrying { prefill } (crop/variety/plant/
  // harvest_log). useOverlaySwap so an in-overlay trigger swaps the SAME overlay's content (preserving
  // the original background); full-page it degrades to a plain navigate. Reward-adjacent, no interrupt.
  const putUpSwap = useOverlaySwap()
  const [preserveCtx, setPreserveCtx] = useState(null)
  // §7 toast modality: the global Undo toast renders OUTSIDE the aria-modal dialog, so a screen
  // reader (and the focus trap) can't reach it. Inside the overlay we surface an in-panel, announced,
  // focusable undo instead. { message, eventId } | null.
  const [inlineUndo, setInlineUndo] = useState(null)
  const [metadataState, setMetadataState] = useState({})
  // V4-TREATLOG-001: dedicated treatment capture (pest_treatment / doctored).
  const [treatment, setTreatment] = useState({ pest_target: '', product_id: '', product_text: '', category: '', amount: '' })
  const [inventory, setInventory] = useState([])

  // V3-EVENTCONTSIZE-001: optional new-container capture, shown for potting_up/transplant on a specific
  // planting. On submit it also PUTs the planting's container_type/container_size via the live /api/plants
  // endpoint (reuses the PLANT-CONTAINER-001 write path; not stored as event metadata).
  const [container, setContainer] = useState({ type: '', size: '' })

  // V1.2a-2 Wave 3: harvest panel state — only submitted for event_type=harvest.
  const [harvest, setHarvest] = useState(() => ({
    quantity:       '',
    unit:           readLastHarvestUnit(),
    quality_rating: null,
  }))
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
  // the user explicitly started — never a reward/celebration channel).

  // Reset metadata when event type changes
  useEffect(() => {
    setMetadataState({})
    // V1.2a-2 Wave 3: reset the type-specific panels too. Harvest unit is
    // re-seeded from localStorage so the user's last choice persists across types.
    setHarvest({ quantity: '', unit: readLastHarvestUnit(), quality_rating: null })
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
    if (!fromQuick) return
    const f = takePendingCapture()
    if (f) { setPhotoFile(f); setPhotoPreview(URL.createObjectURL(f)) }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (form.event_type === 'watering') { ux.tap(); ux.step(1, 'start_capture') }
  }, [form.event_type])  // eslint-disable-line react-hooks/exhaustive-deps

  // §4 draft stash — restore a dismissed-while-dirty overlay form. Once, on mount, ONLY when opened
  // as an overlay with no seed deep-link (a bare "Log an event" tap): a deep-link's params express an
  // explicit fresh intent and must win over a stale draft. Restores `form` fields only (see key doc).
  useEffect(() => {
    if (!inOverlay) return
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

  // §4 draft stash — persist the in-progress form while dirty (overlay only). Cleared on a successful
  // save (spent) above. Dirty = any user-entered content; the pristine default is never stashed.
  useEffect(() => {
    if (!inOverlay) return
    const dirty = !!(form.notes || form.private_notes || form.quantity || form.plant_id || form.event_type)
    if (!dirty) return
    const snap = {}
    for (const k of DRAFT_FORM_FIELDS) snap[k] = form[k]
    writeDraft(EVENTNEW_DRAFT_KEY, { form: snap, showPrivate, showAddDetails })
  }, [inOverlay, form, showPrivate, showAddDetails])

  // Load plants when project selection changes
  useEffect(() => {
    if (!form.project_id) { setPlantsForProject([]); return }
    apiFetch('/api/plants?project_id=' + form.project_id)
      .then(data => {
        const live = (data ?? []).filter(p => !p.archived_at)
        setPlantsForProject(live)
        // V3-LOG-001 deep-link safety: clear a ?plant= prefill not in this project.
        if (preselectedPlantId && !live.some(p => p.id === preselectedPlantId)) {
          setForm(f => (f.plant_id === preselectedPlantId ? { ...f, plant_id: '' } : f))
        }
      })
      .catch(() => setPlantsForProject([]))
  }, [apiFetch, form.project_id, preselectedPlantId])

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
        setForm(f => (f.project_id === rememberedProjectId ? { ...f, project_id: '' } : f))
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

  // §7 in-surface undo — soft-delete the just-logged event (same action as the global toast's Undo).
  function undoInline() {
    if (!inlineUndo) return
    apiFetch('/api/events/' + inlineUndo.eventId, { method: 'DELETE' }).catch(() => {})
    setInlineUndo(null)
  }
  // Auto-dismiss the in-surface undo after 5s, mirroring the global undo toast's lifetime.
  useEffect(() => {
    if (!inlineUndo) return
    const t = setTimeout(() => setInlineUndo(null), 5000)
    return () => clearTimeout(t)
  }, [inlineUndo])

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
    setHarvest({ quantity: '', unit: readLastHarvestUnit(), quality_rating: null })
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
    if (!form.project_id)  { setError('Select a project.'); return }

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
    }

    // V4-STICKY-001: remember the chosen project so the next cold session pre-fills it.
    if (form.project_id) {
      try { localStorage.setItem(LAST_PROJECT_KEY, form.project_id) } catch { /* noop */ }
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
    if (photoFile) {
      await photoUploader.upload(photoFile, {
        keyPrefix: 'events',
        parentId:  eventId,
        linkage: {
          project_id: form.project_id,
          event_id:   eventId,
        },
        is_public: form.is_public,
      })
      // Errors are already swallowed by the hook in 'swallow' mode — no try/catch needed.
    }

    setSaving(false)
    if (form.event_type === 'watering') ux.complete({ outcome: 'logged' })  // M1 watering complete

    // V3-EVENT-001 (redesign 2026-06-22, Dave): every save is a rapid-entry save — reset
    // and STAY on the form, never navigate away ("no more Save and go back to Garden").
    // Two entry points: keepMode 'plant' (default / Enter) and keepMode 'type'.
    const projName = projects.find(p => p.id === form.project_id)?.name ?? 'event'

    // V4-HARVESTCENTER-001 (L9): capture the "preserve this?" prefill BEFORE resetForNext clears
    // form.plant_id. Provenance is best-effort — crop/variety resolve off the selected planting's
    // variety_ref; harvest_log_id off the events response's harvest row. At least one of {crop,
    // variety} is what Put-Up needs; if neither resolves, the affordance still opens (user picks a crop).
    if (isHarvest && eventId) {
      const selectedPlant = plantsForProject.find(p => p.id === form.plant_id)
      const pf = {}
      if (selectedPlant?.variety_ref?.crop_type_slug) pf.crop_type_slug = selectedPlant.variety_ref.crop_type_slug
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
        // §7 modality fix: the global toast is AT-invisible behind aria-modal, so surface the undo
        // INSIDE the panel (announced + focusable). Global toast is skipped to avoid a duplicate.
        setInlineUndo({ message: `Logged event for ${projName}`, eventId })
      } else {
        showUndo({
          message: `Logged event for ${projName}`,
          onUndo: () => { apiFetch('/api/events/' + eventId, { method: 'DELETE' }).catch(() => {}) },
        })
      }
    } else {
      showToast({ message: keepMode === 'type' ? 'Saved — pick the next plant' : 'Saved — log the next event' })
    }
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

        {/* §7 in-surface undo — announced (role=status + aria-live) and focusable INSIDE the dialog,
            so the just-logged event is reversible for AT + keyboard users the global toast can't reach
            (it renders outside aria-modal). Overlay-only; the full-page path uses the global toast. */}
        {inOverlay && inlineUndo && (
          <div role="status" aria-live="polite" style={{
            display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
            backgroundColor: P.greenPale, border: `1px solid ${P.greenLight}`, borderRadius: 10,
            padding: '10px 14px',
          }}>
            <span style={{ flex: 1, fontSize: '0.88rem', fontWeight: 600, color: P.green }}>
              ✓ {inlineUndo.message}
            </span>
            <button type="button" onClick={undoInline} style={{
              background: 'transparent', color: P.green, border: `1px solid ${P.greenLight}`,
              borderRadius: 6, padding: '5px 12px', fontSize: '0.85rem', fontWeight: 700, cursor: 'pointer',
              fontFamily: 'inherit',
            }}>Undo</button>
          </div>
        )}

        {/* V4-HARVESTCENTER-001 (L9): ambient "preserve this?" affordance after a harvest logs. No
            interrupt, no modal — an inline, dismissible offer that opens Put-Up prefilled. Honors
            Reward-UX (reward-adjacent, not a reward surface). Renders on both the overlay + full-page
            paths (putUpSwap degrades to a plain navigate full-page). */}
        {preserveCtx && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap',
            backgroundColor: P.greenPale, border: `1px solid ${P.greenLight}`, borderRadius: 10, padding: '12px 14px',
          }}>
            <span style={{ flex: 1, minWidth: 160, fontSize: '0.9rem', fontWeight: 600, color: P.green }}>
              Putting any of this up for later?
            </span>
            <button type="button"
              onClick={() => putUpSwap('/put-up', { state: { prefill: preserveCtx.prefill } })}
              style={{ background: P.green, color: P.white, border: 'none', borderRadius: 6,
                padding: '7px 14px', fontSize: '0.85rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
              Log a put-up
            </button>
            <button type="button" onClick={() => setPreserveCtx(null)}
              style={{ background: 'transparent', color: P.green, border: `1px solid ${P.greenLight}`, borderRadius: 6,
                padding: '7px 12px', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
              Not now
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

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

          {/* ── Project ── */}
          <Section label="Project *">
            <Select
              value={form.project_id}
              onChange={e => setForm(f => ({ ...f, project_id: e.target.value }))}
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

          {/* ── Plant / Group — V3-EVENT-005: ever-present, disabled until project chosen ── */}
          <Section label="Plant / Group (optional)">
            <Select
              value={form.plant_id}
              onChange={e => setForm(f => ({ ...f, plant_id: e.target.value }))}
              aria-label="Plant or group"
              disabled={!form.project_id}
              style={{ opacity: form.project_id ? 1 : 0.5 }}
            >
              {form.project_id ? (
                <>
                  <option value="">— All plants (project level) —</option>
                  {[...plantsForProject].sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(pl => (
                    <option key={pl.id} value={pl.id}>
                      {pl.name}{pl.quantity > 1 ? ` ×${formatQty(pl.quantity)}` : ''}{pl.variety_ref?.name ? ` — ${pl.variety_ref.name}` : ''}
                    </option>
                  ))}
                </>
              ) : (
                <option value="">— select a project first —</option>
              )}
            </Select>
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
                  <Field label="Quantity *" htmlFor="harvest-quantity">
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
              {harvestError && (
                <div role="alert" style={{ marginTop: 6, fontSize: '0.78rem', color: P.terra, fontWeight: 600 }}>{harvestError}</div>
              )}

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

          {/* ── Photo ── */}
          <Section label="Photo  ·  optional">
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
              page. bottom:68 still clears the fixed BottomNav on the full-page path. right:20 is dropped
              (a sticky block spans the content column; justify-content:flex-end right-aligns the button,
              and the form's own right padding gives the gap) so the inset can't shift it off-panel. */}
          <div
            style={{
              position: 'sticky',
              bottom: 68,
              zIndex: 200,
              display: 'flex',
              justifyContent: 'flex-end',
            }}
          >
            {/* V4-EVENTSAVE-001 (Dave): one Save = the former "Next of Type" behavior
                (keep the event_type, clear the plant, stay on the form for the next plant).
                The old "Next of Plant" button was rarely used and was removed. */}
            <Button
              type="button"
              variant="primary"
              loading={saving}
              loadingLabel="Saving…"
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
