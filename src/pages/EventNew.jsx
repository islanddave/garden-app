import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P, EVENT_TYPES, PROJECT_STATUSES } from '../lib/constants.js'

const EVENT_TYPES_UI = [
  { value: 'watering',    label: 'Watered',                emoji: '💧' },
  { value: 'transplant',  label: 'Transplanted\n/ Planted', emoji: '🌱' },
  { value: 'fertilizing', label: 'Fertilized\n/ Fed',       emoji: '🌿' },
  { value: 'observation', label: 'Observed\n/ Note',        emoji: '👁️' },
  { value: 'pruning',     label: 'Pruned\n/ Topped',        emoji: '✂️' },
]

const PRIMARY_VALUES = new Set(EVENT_TYPES_UI.map(t => t.value))

const EVENT_TYPE_META = {
  sowing:         { label: 'Sowed',          emoji: '🌰', category: 'Growth & Training' },
  seed_soak:      { label: 'Seed soak',       emoji: '💦', category: 'Growth & Training' },
  germination:    { label: 'Germination',     emoji: '🌿', category: 'Growth & Training' },
  thinning:       { label: 'Thinned',         emoji: '🪓', category: 'Growth & Training' },
  potting_up:     { label: 'Potted up',       emoji: '🪴', category: 'Growth & Training' },
  hardening_off:  { label: 'Hardening off',   emoji: '☀️', category: 'Growth & Training' },
  pest_treatment: { label: 'Pest treatment',  emoji: '🐛', category: 'Pest & Health' },
  cover:          { label: 'Covered',         emoji: '🌂', category: 'Environmental' },
  uncover:        { label: 'Uncovered',       emoji: '🌤️', category: 'Environmental' },
  first_harvest:  { label: 'First harvest',   emoji: '🌟', category: 'Harvest' },
  harvest:        { label: 'Harvested',       emoji: '🧺', category: 'Harvest' },
  photo:          { label: 'Photo only',      emoji: '📷', category: 'Pest & Health' },
  other:          { label: 'Other',           emoji: '📝', category: 'Environmental' },
}

const SECONDARY_GROUPS = (() => {
  const cats = {}
  EVENT_TYPES.forEach(v => {
    if (PRIMARY_VALUES.has(v)) return
    const meta = EVENT_TYPE_META[v] ?? { label: v, emoji: '📌', category: 'Other' }
    if (!cats[meta.category]) cats[meta.category] = []
    cats[meta.category].push({ value: v, label: meta.label, emoji: meta.emoji })
  })
  return Object.entries(cats)
})()

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
  const fields = EVENT_METADATA_FIELDS[eventType]
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
                  {field.options.map(opt => (
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
  const { fetch: apiFetch } = useApiFetch()

  const voice = useVoiceInput()

  const [form, setForm] = useState({
    event_type:    '',
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

  const [photoFile,    setPhotoFile]    = useState(null)
  const [photoPreview, setPhotoPreview] = useState(null)
  const [projects,     setProjects]     = useState([])
  const [locations,    setLocations]    = useState([])
  const [saving,       setSaving]       = useState(false)
  const [error,        setError]        = useState(null)
  const [showPrivate,  setShowPrivate]  = useState(false)
  const [showMoreTypes, setShowMoreTypes] = useState(false)
  const [success,      setSuccess]      = useState(null)
  const [plantsForProject, setPlantsForProject] = useState([])

  // Reset metadata when event type changes
  useEffect(() => {
    setMetadataState({})
  }, [form.event_type])

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
      setProjects((proj ?? []).filter(p => LOGGABLE_STATUSES.includes(p.status)))
      setLocations((locs ?? []).filter(l => l.is_active))
    }).catch(() => {})
  }, [apiFetch])

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

  function clearPhoto() {
    setPhotoFile(null)
    if (photoPreview) URL.revokeObjectURL(photoPreview)
    setPhotoPreview(null)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.event_type)  { setError('Select an event type above.'); return }
    if (!form.project_id)  { setError('Select a project.'); return }

    setSaving(true)
    setError(null)

    // Send date portion only — Lambda appends T12:00:00 internally
    const eventDateStr = form.event_date.split('T')[0]

    // Build metadata — only include if there are populated keys
    const metadata = Object.keys(metadataState).length > 0 ? metadataState : null

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
          quantity:      form.quantity.trim()       || null,
          plant_id:      form.plant_id               || null,
          is_public:     form.is_public,
          has_photo:     !!photoFile,
          metadata,
        }),
      })
    } catch (err) {
      setSaving(false)
      setError(err.message)
      return
    }

    const { eventId, stats } = result

    // 2 — Upload photo via pre-signed S3 URL (non-fatal)
    if (photoFile) {
      try {
        const ext      = photoFile.name.split('.').pop().toLowerCase()
        const photoId  = crypto.randomUUID()
        const key      = `events/${eventId}/${photoId}.${ext}`
        const mimeType = photoFile.type || 'image/jpeg'

        const { upload_url } = await apiFetch(
          `/api/photos/upload-url?key=${encodeURIComponent(key)}&content_type=${encodeURIComponent(mimeType)}`
        )

        // Direct S3 PUT — no auth header, no JSON
        const s3Res = await window.fetch(upload_url, {
          method: 'PUT',
          body: photoFile,
          headers: { 'Content-Type': mimeType },
        })

        if (s3Res.ok) {
          await apiFetch('/api/photos', {
            method: 'POST',
            body: JSON.stringify({
              storage_path: key,
              project_id:   form.project_id,
              event_id:     eventId,
              is_public:    form.is_public,
            }),
          })
        }
      } catch {
        // Photo upload is non-fatal — event was logged successfully
      }
    }

    setSaving(false)
    setSuccess({
      newStreak: 1,                      // Lambda doesn't track streaks yet
      earnedXp:  stats?.xp_earned ?? 0,
      isLevelUp: false,                  // Lambda doesn't signal level-up yet
      newLevel:  stats?.level    ?? null,
      eventType: form.event_type,
    })
  }

  if (success) {
    return (
      <div style={{
        minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <SuccessScreen success={success} onDashboard={() => navigate('/dashboard')} />
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
          {voice.supported && (
            <p style={{ margin: '6px 0 0', fontSize: '0.78rem', color: P.light }}>
              🎙️ Voice input active — tap the mic button next to any field to speak
            </p>
          )}
        </div>

        {error && <ErrBanner msg={error} />}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* ── Event type ── */}
          <Section label="What happened? *">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
              {EVENT_TYPES_UI.slice(0, 3).map(t => (
                <TypeBtn key={t.value} type={t} selected={form.event_type} onSelect={v => setForm(f => ({ ...f, event_type: v }))} />
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginTop: 10 }}>
              {EVENT_TYPES_UI.slice(3).map(t => (
                <TypeBtn key={t.value} type={t} selected={form.event_type} onSelect={v => setForm(f => ({ ...f, event_type: v }))} />
              ))}
            </div>

            <button
              type="button"
              onClick={() => setShowMoreTypes(s => !s)}
              style={{
                marginTop: 12, background: 'none', border: 'none',
                cursor: 'pointer', color: P.green, fontSize: '0.82rem',
                fontWeight: 600, padding: '4px 0',
                display: 'flex', alignItems: 'center', gap: 5,
              }}
            >
              <span>{showMoreTypes ? '▾' : '▸'}</span>
              <span>More event types</span>
            </button>

            {showMoreTypes && (
              <div style={{ marginTop: 8 }}>
                {SECONDARY_GROUPS.map(([category, types]) => (
                  <div key={category} style={{ marginBottom: 14 }}>
                    <div style={{
                      fontSize: '0.7rem', fontWeight: 700, color: P.light,
                      letterSpacing: '0.4px', textTransform: 'uppercase',
                      marginBottom: 8,
                    }}>
                      {category}
                    </div>
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: `repeat(${Math.min(types.length, 3)}, 1fr)`,
                      gap: 8,
                    }}>
                      {types.map(t => (
                        <TypeBtn
                          key={t.value}
                          type={t}
                          selected={form.event_type}
                          onSelect={v => {
                            setForm(f => ({ ...f, event_type: v }))
                            setShowMoreTypes(false)
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
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
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {projects.length === 0 && (
              <small style={{ color: P.terra, fontSize: '0.75rem', display: 'block', marginTop: 6 }}>
                No active projects — <Link to="/projects/new" style={{ color: P.terra }}>create one first</Link>.
              </small>
            )}
          </Section>

          {/* ── Plant / Group (optional) ── */}
          {plantsForProject.length > 0 && (
            <Section label="Plant / Group (optional)">
              <select
                value={form.plant_id}
                onChange={e => setForm(f => ({ ...f, plant_id: e.target.value }))}
                aria-label="Plant or group"
                style={selectStyle}
              >
                <option value="">— All plants (project level) —</option>
                {plantsForProject.map(pl => (
                  <option key={pl.id} value={pl.id}>
                    {pl.name}{pl.quantity > 1 ? ` ×${pl.quantity}` : ''}{pl.variety ? ` — ${pl.variety}` : ''}
                  </option>
                ))}
              </select>
            </Section>
          )}

          {/* ── Location (optional — informational) ── */}
          {locations.length > 0 && (
            <Section label="Location  ·  optional">
              <select
                value={form.location_id}
                onChange={e => setForm(f => ({ ...f, location_id: e.target.value }))}
                aria-label="Location"
                style={selectStyle}
              >
                <option value="">— Select location —</option>
                {locations.map(l => (
                  <option key={l.id} value={l.id}>{l.full_path}</option>
                ))}
              </select>
            </Section>
          )}

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

          {/* ── Notes ── */}
          <Section label="Notes">
            <div style={{ position: 'relative' }}>
              <textarea
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                aria-label="Notes"
                style={{ ...inputStyle, height: 90, resize: 'vertical', paddingRight: 44 }}
                placeholder="What did you do? What did you observe?"
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

          {/* ── Tier 2: per-type metadata enrichment (collapsible) ── */}
          <MetadataSection
            eventType={form.event_type}
            metadataState={metadataState}
            onMetadataChange={handleMetadataChange}
          />

          {/* ── Quantity ── */}
          <Section label="Quantity  ·  optional">
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
          </Section>

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
              <label style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
                padding: '22px 16px',
                border: `2px dashed ${P.border}`, borderRadius: 8,
                cursor: 'pointer', backgroundColor: P.white,
                color: P.mid, fontSize: '0.88rem',
              }}>
                <span style={{ fontSize: '1.5rem' }}>📷</span>
                <span>Tap to take or choose a photo</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handlePhotoChange}
                  style={{ display: 'none' }}
                />
              </label>
            )}
          </Section>

          {/* ── Visibility ── */}
          <div style={{
            backgroundColor: P.white, border: `1px solid ${P.border}`,
            borderRadius: 10, padding: '14px 18px',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
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

          {/* ── Private notes (collapsible) ── */}
          <div style={{ backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: '12px 18px' }}>
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

          {/* ── Submit ── */}
          <div style={{
            paddingTop: 12, marginTop: 4,
            borderTop: `1px solid ${P.border}`,
            display: 'flex', gap: 14, alignItems: 'center',
          }}>
            <button type="submit" disabled={saving} style={primaryBtn(saving)}>
              {saving ? 'Saving…' : '+ Log event'}
            </button>
            <Link to="/dashboard" style={{ color: P.mid, textDecoration: 'none', fontSize: '0.88rem' }}>
              Cancel
            </Link>
          </div>

        </form>
      </div>
    </div>
  )
}

function TypeBtn({ type, selected, onSelect }) {
  const isSelected = selected === type.value
  return (
    <button
      type="button"
      onClick={() => onSelect(type.value)}
      style={{
        padding: '14px 6px 12px',
        border: `2px solid ${isSelected ? P.green : P.border}`,
        borderRadius: 10,
        backgroundColor: isSelected ? P.greenPale : P.white,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 7,
        transition: 'all 0.12s',
        minHeight: 80,
      }}
    >
      <span style={{ fontSize: '1.7rem', lineHeight: 1 }}>{type.emoji}</span>
      <span style={{
        fontSize: '0.73rem',
        fontWeight: 600,
        color: isSelected ? P.green : P.mid,
        textAlign: 'center',
        lineHeight: 1.25,
        whiteSpace: 'pre-line',
      }}>
        {type.label}
      </span>
    </button>
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
