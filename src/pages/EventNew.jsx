import React, { useState, useEffect, useRef, useCallback } from 'react'
import ProjectOptions from '../components/ProjectOptions.jsx'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P, EVENT_TYPES, PROJECT_STATUSES } from '../lib/constants.js'
import { EVENT_TYPE_META } from '../lib/eventTypes.js'
import EventTypePicker, { EVENT_TYPES_UI, SECONDARY_GROUPS } from '../components/forms/EventTypePicker.jsx'
import { formatQty } from '../lib/format.js'
import { useUploadPhoto } from '../hooks/useUploadPhoto.js'
import { HARVEST_UNITS, MAX_PLAUSIBLE } from '../lib/harvest-constants.js'
import { useUxFlow, FLOWS } from '../lib/uxEvents.js'
import { EVENTNEW_ADD_DETAILS_EXPANDED } from '../lib/featureFlags.js'

// V3-EVENT-008: EVENT_TYPE_META lives in the canonical src/lib/eventTypes.js
// (single source of truth). Re-exported here so existing importers from
// EventNew.jsx (EventTypesPhase1.test.jsx) keep working unchanged.
export { EVENT_TYPE_META }

export { EVENT_TYPES_UI, SECONDARY_GROUPS }

// Per-type metadata field definitions for Tier 2 enrichment
const EVENT_METADATA_FIELDS = {
  sowing:        [
    { key: 'depth_cm',                  label: 'Sowing depth (cm)',        type: 'number' },
    { key: 'spacing_cm',                label: 'Spacing (cm)',              type: 'number' },
    { key: 'germination_expected_days', label: 'Expected germination (days)', type: 'number' },
  ],
  germination:   [
    { key: 'days_to_germinate',      label: 'Days to germinate',    type: 'number' },
    { key: 'germination_rate_pct',   label: 'Germination rate (%)', type: 'number' },
  ],
  observation:   [
    { key: 'height_cm',   label: 'Height (cm)',  type: 'number' },
    { key: 'leaf_count',  label: 'Leaf count',   type: 'number' },
    { key: 'health',      label: 'Health',        type: 'select', options: ['excellent', 'good', 'fair', 'poor', 'critical'] },
  ],
  watering:      [
    { key: 'amount_ml', label: 'Amount (ml)', type: 'number' },
  ],
  fertilizing:   [
    { key: 'product',   label: 'Product / mix',   type: 'text' },
    { key: 'dilution',  label: 'Dilution ratio',  type: 'text' },
    { key: 'amount_ml', label: 'Amount (ml)',      type: 'number' },
  ],
  harvest:       [
    { key: 'weight_g', label: 'Weight (g)', type: 'number' },
    { key: 'count',    label: 'Count',      type: 'number' },
    { key: 'quality',  label: 'Quality',    type: 'select', options: ['excellent', 'good', 'fair', 'poor'] },
  ],
  first_harvest: [
    { key: 'weight_g', label: 'Weight (g)', type: 'number' },
    { key: 'count',    label: 'Count',      type: 'number' },
  ],
  pest_treatment: [
    { key: 'pest',      label: 'Pest / disease', type: 'text' },
    { key: 'treatment', label: 'Treatment used', type: 'text' },
  ],
}

const LOGGABLE_STATUSES = PROJECT_STATUSES.filter(s => s !== 'harvesting')

// V1.2a-2 Wave 3: harvest panel — anchored quality scale (NOT a star widget).
const HARVEST_QUALITY_LABELS = {
  1: 'inedible',
  2: 'poor',
  3: 'acceptable',
  4: 'good',
  5: 'excellent',
}

// V1.2a-2 Wave 3: observation flag — severity options. "Stale" is system-assigned
// only and is intentionally excluded from this list (see SeverityBadge.jsx).
const SEVERITY_OPTIONS = [
  { value: 1, label: 'Watch',  anchor: 'monitor only, no action today' },
  { value: 2, label: 'Issue',  anchor: 'action within 48h' },
  { value: 3, label: 'Urgent', anchor: 'action today or plant may be lost' },
]

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

// V1.2a-2 Wave 3: never render a raw server error string to the user. Map known
// server error patterns to canned, friendly copy; fall back to a safe generic.
function friendlyError(err) {
  const raw = (err && err.message) ? String(err.message) : ''
  const status = err && err.status
  if (/exceeds max for unit/i.test(raw)) {
    return 'Quantity is unusually high — double-check?'
  }
  if (/quantity must be a positive/i.test(raw)) {
    return 'Quantity doesn’t look right — check the form and try again.'
  }
  if (/severity/i.test(raw)) {
    return 'Something didn’t look right with the issue flag — check and try again.'
  }
  if (typeof status === 'number') {
    if (status >= 400 && status < 500) {
      return 'Something didn’t look right — check the form and try again.'
    }
    if (status >= 500) {
      return 'Couldn’t save — try again.'
    }
  }
  // Network errors (no status) and anything unmapped.
  return 'Couldn’t save — try again.'
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
                <select
                  value={metadataState[field.key] ?? ''}
                  onChange={e => onMetadataChange(field.key, e.target.value || undefined)}
                  style={selectStyle}
                >
                  <option value="">— optional —</option>
                  {[...field.options].sort((a, b) => String(a).localeCompare(String(b))).map(opt => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              ) : (
                <input
                  type={field.type}
                  value={metadataState[field.key] ?? ''}
                  onChange={e => onMetadataChange(field.key, e.target.value === '' ? undefined : e.target.value)}
                  style={inputStyle}
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

  const [form, setForm] = useState({
    event_type:    preselectedEventType,
    project_id:    preselectedProjectId,
    location_id:   '',
    event_date:    toDatetimeLocal(new Date()),
    notes:         '',
    private_notes: '',
    quantity:      '',
    plant_id:      '',
    is_public:     true,
  })

  // Tier 2 metadata state — { [field.key]: value } — only populated keys submitted
  const [metadataState, setMetadataState] = useState({})

  // V1.2a-2 Wave 3: harvest panel state — only submitted for event_type=harvest.
  const [harvest, setHarvest] = useState(() => ({
    quantity:       '',
    unit:           readLastHarvestUnit(),
    quality_rating: null,
  }))
  const [harvestError, setHarvestError] = useState(null)

  // V1.2a-2 Wave 3: observation flag state — only submitted for event_type=observation.
  const [flaggedAsIssue, setFlaggedAsIssue] = useState(false)
  const [severity,       setSeverity]       = useState(null)
  const [severityError,  setSeverityError]  = useState(null)
  const [severityShake,  setSeverityShake]  = useState(false)
  const severitySelectRef = useRef(null)

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

  // Reset metadata when event type changes
  useEffect(() => {
    setMetadataState({})
    // V1.2a-2 Wave 3: reset the type-specific panels too. Harvest unit is
    // re-seeded from localStorage so the user's last choice persists across types.
    setHarvest({ quantity: '', unit: readLastHarvestUnit(), quality_rating: null })
    setHarvestError(null)
    setFlaggedAsIssue(false)
    setSeverity(null)
    setSeverityError(null)
    setSeverityShake(false)
  }, [form.event_type])

  // M1 telemetry: reset the flow on mount; mark start-capture the first time the
  // event type is set to watering (the "started a watering log" signal).
  useEffect(() => { ux.reset() }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (form.event_type === 'watering') { ux.tap(); ux.step(1, 'start_capture') }
  }, [form.event_type])  // eslint-disable-line react-hooks/exhaustive-deps

  // Load plants when project selection changes
  useEffect(() => {
    if (!form.project_id) { setPlantsForProject([]); return }
    apiFetch('/api/plants?project_id=' + form.project_id)
      .then(data => setPlantsForProject(data ?? []))
      .catch(() => setPlantsForProject([]))
  }, [apiFetch, form.project_id])

  // Load projects + locations
  useEffect(() => {
    Promise.all([
      apiFetch('/api/projects'),
      apiFetch('/api/locations/with-path'),
    ]).then(([proj, locs]) => {
      const loggable = (proj ?? []).filter(p => LOGGABLE_STATUSES.includes(p.status))
      setProjects(loggable)
      setLocations((locs ?? []).filter(l => l.is_active))
      // V1.2a-2 Wave 3: deep-link safety — if a ?project= param was supplied but
      // doesn't match any loaded (active, owned) project, clear the prefill and
      // surface a non-fatal notice rather than silently POSTing a bad project_id.
      if (preselectedProjectId && !loggable.some(p => p.id === preselectedProjectId)) {
        setForm(f => (f.project_id === preselectedProjectId ? { ...f, project_id: '' } : f))
        setNotice('Project not found — pick one.')
      }
    }).catch(() => {})
  }, [apiFetch, preselectedProjectId])

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

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.event_type)  { setError('Select an event type above.'); return }
    if (!form.project_id)  { setError('Select a project.'); return }

    // V1.2a-2 Wave 3: harvest panel gate — block the POST on invalid quantity,
    // surface an inline error near the quantity field.
    if (form.event_type === 'harvest') {
      const hErr = validateHarvest()
      if (hErr) { setHarvestError(hErr); return }
      setHarvestError(null)
    }

    // V1.2a-2 Wave 3: observation flag gate — action-then-correct pattern.
    // Button stays enabled; on submit with the flag on but no severity, we show
    // an inline error, focus the select, and shake — but do NOT fire the POST.
    if (form.event_type === 'observation' && flaggedAsIssue && severity == null) {
      setSeverityError('Pick a severity to flag.')
      setSeverityShake(true)
      setTimeout(() => setSeverityShake(false), 100)
      severitySelectRef.current?.focus()
      return
    }
    setSeverityError(null)

    if (form.event_type === 'watering') ux.tap()  // submit tap (watering flow only)
    setSaving(true)
    setError(null)

    // Send date portion only — Lambda appends T12:00:00 internally
    const eventDateStr = form.event_date.split('T')[0]

    // Build metadata — only include if there are populated keys
    const metadata = Object.keys(metadataState).length > 0 ? metadataState : null

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
    // Flag fields only when the event is an observation AND the flag is on —
    // never send severity without flagged_as_issue (server rejects that).
    const flagPayload = (form.event_type === 'observation' && flaggedAsIssue)
      ? { flagged_as_issue: true, severity }
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
    // V1.2a-1 §C-V1.2a-1-D: skip success screen, navigate straight to dashboard.
    // Dashboard reads location.state.logged → refetches data + renders achievement toasts + 5s undo toast.
    const projectRow = projects.find(p => p.id === form.project_id)
    navigate('/dashboard', {
      replace: true,
      state: {
        // Stage 1 critter is now rendered via Dashboard backfill, NOT location state.
        logged: {
          id: eventId,
          project_id:                form.project_id,
          project_name:              projectRow?.name ?? null,
          event_type:                form.event_type,
          updated_streak,
          xp_gained,
          newly_earned_achievements: newly_earned_achievements ?? [],
        },
      },
    })
  }

  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      {/* V1.2a-2 Wave 3: shake animation for the severity-required nudge. */}
      <style>{`@keyframes evnew-shake {
        0% { transform: translateX(0); }
        25% { transform: translateX(-4px); }
        75% { transform: translateX(4px); }
        100% { transform: translateX(0); }
      }`}</style>
      <div style={{ maxWidth: 600, margin: '0 auto', padding: '28px 16px 60px' }}>

        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: '0.82rem', color: P.light, marginBottom: 8 }}>
            <Link to="/dashboard" style={{ color: P.green, textDecoration: 'none' }}>Dashboard</Link>
            {' › Log event'}
          </div>
          <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>
            Log an event
          </h1>
          <Link
            to="/log/many"
            style={{ display: 'inline-block', marginTop: 6, fontSize: '0.85rem', color: P.green, textDecoration: 'none', fontWeight: 600 }}
          >
            Logging the same thing across plants? Use Log Many →
          </Link>
          {voice.supported && (
            <p style={{ margin: '6px 0 0', fontSize: '0.78rem', color: P.light }}>
              🎙️ Voice input active — tap the mic button next to any field to speak
            </p>
          )}
        </div>

        {error && <ErrBanner msg={error} />}
        {notice && <ErrBanner msg={notice} />}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* ── Event type ── */}
          <Section label="What happened? *">
            <EventTypePicker
              value={form.event_type}
              onChange={v => setForm(f => ({ ...f, event_type: v }))}
            />          </Section>

          {/* ── Notes ── */}
          <Section label="Notes">
            <div style={{ position: 'relative' }}>
              <textarea
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                aria-label="Notes"
                style={{ ...inputStyle, height: 90, resize: 'vertical', paddingRight: 44 }}
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
            <select
              value={form.project_id}
              onChange={e => setForm(f => ({ ...f, project_id: e.target.value }))}
              aria-label="Project"
              style={selectStyle}
            >
              <option value="">— Select project —</option>
              <ProjectOptions projects={projects} />
            </select>
            {projects.length === 0 && (
              <small style={{ color: P.terra, fontSize: '0.75rem', display: 'block', marginTop: 6 }}>
                No active projects — <Link to="/projects/new" style={{ color: P.terra }}>create one first</Link>.
              </small>
            )}
          </Section>

          {/* ── Plant / Group — V3-EVENT-005: ever-present, disabled until project chosen ── */}
          <Section label="Plant / Group (optional)">
            <select
              value={form.plant_id}
              onChange={e => setForm(f => ({ ...f, plant_id: e.target.value }))}
              aria-label="Plant or group"
              disabled={!form.project_id}
              style={{ ...selectStyle, opacity: form.project_id ? 1 : 0.5 }}
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
            </select>
          </Section>

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
                  <label htmlFor="harvest-quantity" style={fieldLabelStyle}>
                    Quantity *
                  </label>
                  <input
                    id="harvest-quantity"
                    type="text"
                    inputMode="decimal"
                    value={harvest.quantity}
                    onChange={e => {
                      setHarvest(h => ({ ...h, quantity: e.target.value }))
                      if (harvestError) setHarvestError(null)
                    }}
                    aria-label="Harvest quantity"
                    style={inputStyle}
                    placeholder="e.g. 2.5"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label htmlFor="harvest-unit" style={fieldLabelStyle}>
                    Unit
                  </label>
                  <select
                    id="harvest-unit"
                    value={harvest.unit}
                    onChange={e => setHarvest(h => ({ ...h, unit: e.target.value }))}
                    aria-label="Harvest unit"
                    style={{ ...selectStyle, minHeight: 44, minWidth: 44 }}
                  >
                    {[...HARVEST_UNITS].sort((a, b) => a.localeCompare(b)).map(u => (
                      <option key={u} value={u}>{u}</option>
                    ))}
                  </select>
                </div>
              </div>
              {harvestError && (
                <div role="alert" style={inlineErrorStyle}>{harvestError}</div>
              )}

              <div style={{ marginTop: 16 }}>
                <label style={fieldLabelStyle}>Quality  ·  optional</label>
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

          {/* ── V1.2a-2 Wave 3: Observation flag form (observation events only) ── */}
          {form.event_type === 'observation' && (
            <Section label="Flag this observation">
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={flaggedAsIssue}
                  onChange={e => {
                    const on = e.target.checked
                    setFlaggedAsIssue(on)
                    // Toggling OFF clears severity so a stale value never reaches the POST.
                    if (!on) { setSeverity(null); setSeverityError(null) }
                  }}
                  aria-label="Flag as an issue"
                  style={{ width: 18, height: 18, cursor: 'pointer' }}
                />
                <span style={{ fontSize: '0.88rem', color: P.mid }}>Flag as an issue</span>
              </label>

              {flaggedAsIssue && (
                <div style={{ marginTop: 14 }}>
                  <label htmlFor="severity-select" style={fieldLabelStyle}>
                    Severity *
                  </label>
                  <select
                    id="severity-select"
                    ref={severitySelectRef}
                    value={severity ?? ''}
                    onChange={e => {
                      const v = e.target.value === '' ? null : Number(e.target.value)
                      setSeverity(v)
                      if (v != null && severityError) setSeverityError(null)
                    }}
                    aria-label="Severity"
                    style={{
                      ...selectStyle,
                      minHeight: 44,
                      borderColor: severityError ? P.alertBorder : P.border,
                      animation: severityShake ? 'evnew-shake 0.1s linear' : undefined,
                    }}
                  >
                    <option value="">— Pick a severity —</option>
                    {[...SEVERITY_OPTIONS].sort((a, b) => a.value - b.value).map(o => (
                      <option key={o.value} value={o.value}>
                        {o.value} · {o.label} — {o.anchor}
                      </option>
                    ))}
                  </select>
                  {severityError && (
                    <div role="alert" style={inlineErrorStyle}>{severityError}</div>
                  )}
                  <div style={{ marginTop: 8, fontSize: '0.75rem', color: P.light, lineHeight: 1.5 }}>
                    {SEVERITY_OPTIONS.map(o => (
                      <div key={o.value}>
                        <strong>{o.label}</strong> — {o.anchor}
                      </div>
                    ))}
                  </div>
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
                    <label style={fieldLabelStyle}>Quantity  ·  optional</label>
                    <div style={{ position: 'relative' }}>
                      <input
                        value={form.quantity}
                        onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))}
                        aria-label="Quantity"
                        style={{ ...inputStyle, paddingRight: 44 }}
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

                {/* Visibility */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <input
                    id="is_public"
                    type="checkbox"
                    checked={form.is_public}
                    onChange={e => setForm(f => ({ ...f, is_public: e.target.checked }))}
                    style={{ width: 18, height: 18, cursor: 'pointer' }}
                  />
                  <label htmlFor="is_public" style={{ fontSize: '0.88rem', color: P.mid, cursor: 'pointer' }}>
                    Visible on public project page
                  </label>
                </div>

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
                      <textarea
                        value={form.private_notes}
                        onChange={e => setForm(f => ({ ...f, private_notes: e.target.value }))}
                        aria-label="Private notes"
                        style={{ ...inputStyle, height: 72, resize: 'vertical', paddingRight: 44 }}
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
            <input
              type="datetime-local"
              value={form.event_date}
              onChange={e => setForm(f => ({ ...f, event_date: e.target.value }))}
              aria-label="Event date and time"
              style={inputStyle}
            />
          </Section>

          {/* ── Floating Save — V3-EVENT-005 (Dave to eyeball bottom offset) ── */}
          {/* Spacer so content isn't hidden behind the fixed button */}
          <div style={{ height: 72 }} aria-hidden="true" />
          <button
            type="submit"
            disabled={saving}
            style={{
              ...primaryBtn(saving),
              position: 'fixed',
              bottom: 68,
              right: 20,
              zIndex: 200,
              boxShadow: '0 2px 12px rgba(0,0,0,0.18)',
              minWidth: 140,
            }}
          >
            {saving ? 'Saving…' : '+ Log event'}
          </button>

        </form>
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

function ErrBanner({ msg }) {
  return (
    <div role="alert" style={{
      backgroundColor: P.alert, border: `1px solid ${P.alertBorder}`,
      borderRadius: 8, padding: '12px 16px', marginBottom: 16,
      fontSize: '0.875rem', color: '#7a2a10',
    }}>
      {msg}
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

const inputStyle = {
  width: '100%', padding: '10px 12px',
  border: `1px solid ${P.border}`,
  borderRadius: 7, fontSize: '0.9rem',
  backgroundColor: P.white,
  boxSizing: 'border-box',
  fontFamily: 'inherit',
}

// V1.2a-2 Wave 3: inline sub-field label (lighter than the Section <label>).
const fieldLabelStyle = {
  display: 'block', fontSize: '0.74rem', fontWeight: 700,
  color: P.light, marginBottom: 6,
  letterSpacing: '0.3px', textTransform: 'uppercase',
}

// V1.2a-2 Wave 3: inline validation error anchored beneath a field.
const inlineErrorStyle = {
  marginTop: 6, fontSize: '0.78rem', color: P.terra, fontWeight: 600,
}

const selectStyle = {
  ...inputStyle,
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23777' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 12px center',
  paddingRight: 36,
  cursor: 'pointer',
}

const primaryBtn = (disabled) => ({
  backgroundColor: disabled ? P.light : P.green,
  color: P.white, border: 'none', borderRadius: 8,
  padding: '13px 30px', fontSize: '0.95rem', fontWeight: 700,
  cursor: disabled ? 'not-allowed' : 'pointer',
  minWidth: 130,
})
