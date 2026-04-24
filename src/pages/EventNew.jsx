import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { supabase } from '../lib/supabase.js'
import { P, PHOTO_BUCKET, EVENT_TYPES, PROJECT_STATUSES } from '../lib/constants.js'
import { updateEntityMemory, updateUserStats } from '../lib/garden-ops.js'

// ---- Primary event types (shown immediately) ----
const EVENT_TYPES_UI = [
  { value: 'watering',    label: 'Watered',                emoji: '💧' },
  { value: 'transplant',  label: 'Transplanted\n/ Planted', emoji: '🌱' },
  { value: 'fertilizing', label: 'Fertilized\n/ Fed',       emoji: '🌿' },
  { value: 'observation', label: 'Observed\n/ Note',        emoji: '👁️' },
  { value: 'pruning',     label: 'Pruned\n/ Topped',        emoji: '✂️' },
]

// ---- Secondary event types (collapsible) ----
// Derived from EVENT_TYPES minus the 5 already in EVENT_TYPES_UI — no hardcoding.
// Grouped to reduce cognitive load; same tap feedback as primary buttons.
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

// Build grouped secondary types at module level (stable reference, no re-compute on render)
const SECONDARY_GROUPS = (() => {
  const cats = {}
  EVENT_TYPES.forEach(v => {
    if (PRIMARY_VALUES.has(v)) return
    const meta = EVENT_TYPE_META[v] ?? { label: v, emoji: '📌', category: 'Other' }
    if (!cats[meta.category]) cats[meta.category] = []
    cats[meta.category].push({ value: v, label: meta.label, emoji: meta.emoji })
  })
  return Object.entries(cats) // [['Growth & Training', [...]], ...]
})()

// ---- Project statuses eligible for event logging ----
// PROVISIONAL: harvesting excluded — review if users want to log against harvesting projects
const LOGGABLE_STATUSES = PROJECT_STATUSES.filter(s => s !== 'harvesting')

// ---- Format datetime-local value (YYYY-MM-DDTHH:MM) ----
function toDatetimeLocal(date) {
  const d = date || new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ---- Voice input hook ----
// One recognition session at a time. fieldKey tracks which field is active.
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

// ---- Mic button — rendered alongside any text input ----
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

// ---- Main page ----
export default function EventNew() {
  const { user }     = useAuth()
  const navigate     = useNavigate()
  const [searchParams] = useSearchParams()
  const preselectedProjectId = searchParams.get('project') || ''

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

  // Load plants when project selection changes
  useEffect(() => {
    if (!form.project_id) { setPlantsForProject([]); return }
    supabase
      .from('plants')
      .select('id, name, variety, quantity')
      .eq('project_id', form.project_id)
      .is('deleted_at', null)
      .order('created_at')
      .then(({ data }) => setPlantsForProject(data ?? []))
  }, [form.project_id])

  // Load projects + locations in one round trip
  useEffect(() => {
    Promise.all([
      supabase
        .from('plant_projects')
        .select('id, name, status')
        .in('status', LOGGABLE_STATUSES)
        .is('deleted_at', null)
        .order('name'),
      supabase
        .from('locations_with_path')
        .select('id, full_path, is_active')
        .order('full_path'),
    ]).then(([{ data: proj }, { data: locs }]) => {
      setProjects(proj ?? [])
      setLocations((locs ?? []).filter(l => l.is_active))
    })
  }, [])

  // Photo handlers
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

  // Submit
  async function handleSubmit(e) {
    e.preventDefault()
    if (!user) return

    // Client-side required checks (supplements HTML required)
    if (!form.event_type)  { setError('Select an event type above.'); return }
    if (!form.project_id)  { setError('Select a project.'); return }
    if (!form.location_id) { setError('Select a location.'); return }

    setSaving(true)
    setError(null)

    // datetime-local → ISO UTC
    const eventDate = new Date(form.event_date).toISOString()

    // 1 — Insert event
    const { data: event, error: evErr } = await supabase
      .from('event_log')
      .insert({
        project_id:    form.project_id,
        location_id:   form.location_id,
        event_type:    form.event_type,
        event_date:    eventDate,
        notes:         form.notes.trim()         || null,
        private_notes: form.private_notes.trim() || null,
        quantity:      form.quantity.trim()       || null,
        plant_id:      form.plant_id               || null,
        is_public:     form.is_public,
        logged_by:     user.id,
      })
      .select('id')
      .single()

    if (evErr) {
      setSaving(false)
      setError(evErr.message)
      return
    }

    // 2 — Upload photo (non-fatal if it fails)
    let photoUploaded = false
    if (photoFile) {
      const ext       = photoFile.name.split('.').pop().toLowerCase()
      const photoId   = crypto.randomUUID()
      const storagePath = `events/${event.id}/${photoId}.${ext}`

      const { error: upErr } = await supabase.storage
        .from(PHOTO_BUCKET)
        .upload(storagePath, photoFile, { upsert: false })

      if (!upErr) {
        await supabase.from('photos').insert({
          project_id:   form.project_id,
          event_id:     event.id,
          storage_path: storagePath,
          is_public:    form.is_public,
          uploaded_by:  user.id,
        })
        photoUploaded = true
      }
    }

    // 3 — Update entity memory + user stats; capture stats for success screen
    const [, stats] = await Promise.all([
      updateEntityMemory(form.project_id, form.location_id, form.event_type, new Date(form.event_date)),
      updateUserStats(user.id, form.event_type, { hasPhoto: photoUploaded, eventLogId: event.id }),
    ])

    setSaving(false)
    setSuccess({
      newStreak: stats?.newStreak ?? 1,
      earnedXp:  stats?.earnedXp  ?? 0,
      isLevelUp: stats?.isLevelUp ?? false,
      newLevel:  stats?.newLevel  ?? null,
      eventType: form.event_type,
    })
  }

  // Success screen — early return
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

        {/* Header */}
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

            {/* ── More event types (collapsible) ── */}
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
                            setShowMoreTypes(false) // collapse after selection
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

          {/* ── Plant / Group (optional, loads after project selected) ── */}
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

          {/* ── Location ── */}
          <Section label="Location *">
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
            {locations.length === 0 && (
              <small style={{ color: P.terra, fontSize: '0.75rem', display: 'block', marginTop: 6 }}>
                No active locations — <Link to="/locations" style={{ color: P.terra }}>add zones first</Link>.
              </small>
            )}
          </Section>

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

// ---- Event type button ----
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

// ---- Shared UI ----
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
      {/* Big event emoji + check */}
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

      {/* Stats row */}
      <div style={{
        display: 'flex', gap: 12, justifyContent: 'center', marginBottom: 28,
      }}>
        {/* Streak */}
        <div style={{
          backgroundColor: P.white, border: `1px solid ${P.border}`,
          borderRadius: 10, padding: '12px 18px', flex: 1,
        }}>
          <div style={{ fontSize: '1.4rem', marginBottom: 4 }}>🔥</div>
          <div style={{ fontSize: '1.05rem', fontWeight: 700, color: P.terra }}>{streakMsg}</div>
        </div>

        {/* XP */}
        <div style={{
          backgroundColor: P.white, border: `1px solid ${P.border}`,
          borderRadius: 10, padding: '12px 18px', flex: 1,
        }}>
          <div style={{ fontSize: '1.4rem', marginBottom: 4 }}>⚡</div>
          <div style={{ fontSize: '1.05rem', fontWeight: 700, color: P.gold }}>+{success.earnedXp} XP</div>
        </div>
      </div>

      {/* Level up */}
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

