import { useState, useEffect, useRef } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { P, PROJECT_STATUSES, EVENT_TYPES, APP_URL } from '../lib/constants.js'
import { useAuth } from '../context/AuthContext.jsx'
import { updateEntityMemory, updateUserStats } from '../lib/garden-ops.js'

const EVENT_ICONS = {
  sowing:        '🌱',
  seed_soak:     '💧',
  germination:   '🌿',
  thinning:      '✂️',
  potting_up:    '🪴',
  transplant:    '🔄',
  hardening_off: '☀️',
  watering:      '💧',
  fertilizing:   '🧪',
  pest_treatment:'🐛',
  pruning:       '✂️',
  cover:         '🏕️',
  uncover:       '🌤️',
  first_harvest: '🎉',
  harvest:       '🧺',
  observation:   '👁️',
  photo:         '📷',
  other:         '📝',
}

function todayLocal() {
  // Returns YYYY-MM-DD in local time (not UTC) for date input default
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function emptyEventForm() {
  return {
    event_type:    'observation',
    event_date:    todayLocal(),
    title:         '',
    notes:         '',
    private_notes: '',
    quantity:      '',
    is_public:     true,
  }
}

function slugify(str) {
  return str.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
function generateSlug(name, startDate) {
  const year = startDate
    ? new Date(startDate + 'T00:00:00').getFullYear()
    : new Date().getFullYear()
  return `${slugify(name)}-${year}`
}

const STATUS_COLORS = {
  planning:  { bg: '#fff8e6', text: '#7a5c00', border: '#c9a84c' },
  active:    { bg: '#d8f3dc', text: '#2d6a4f', border: '#52b788' },
  harvested: { bg: '#eee',    text: '#4a4a4a', border: '#d4c9be' },
  ended:     { bg: '#eee',    text: '#777',    border: '#d4c9be' },
}

export default function ProjectDetail() {
  const { id }   = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()

  const [project,      setProject]      = useState(null)
  const [locPath,      setLocPath]      = useState(null)
  const [locations,    setLocations]    = useState([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState(null)
  const [editing,      setEditing]      = useState(false)
  const [form,         setForm]         = useState(null)
  const [saving,       setSaving]       = useState(false)
  const [saveErr,      setSaveErr]      = useState(null)

  // Event log state
  const [events,       setEvents]       = useState([])
  const [eventsLoading,setEventsLoading]= useState(true)
  const [showLogForm,  setShowLogForm]  = useState(false)
  const [eventForm,    setEventForm]    = useState(emptyEventForm())
  const [loggingEvent, setLoggingEvent] = useState(false)
  const [logErr,       setLogErr]       = useState(null)
  const [deletingId,   setDeletingId]   = useState(null)
  const logFormRef = useRef(null)

  useEffect(() => {
    let isMounted = true
    ;(async () => {
      const [{ data: proj, error: pErr }, { data: locs }] = await Promise.all([
        supabase.from('plant_projects').select('*').eq('id', id).single(),
        supabase.from('locations_with_path').select('id, full_path, is_active').order('full_path'),
      ])
      if (!isMounted) return
      if (pErr) { setError(pErr.code === 'PGRST116' ? 'Project not found.' : pErr.message); setLoading(false); return }

      setProject(proj)
      setLocations((locs ?? []).filter(l => l.is_active))

      if (proj.location_id) {
        const loc = (locs ?? []).find(l => l.id === proj.location_id)
        setLocPath(loc?.full_path ?? null)
      }
      setLoading(false)
    })()
    return () => { isMounted = false }
  }, [id])

  // Fetch events separately so they can be refreshed independently
  useEffect(() => {
    if (!id) return
    let isMounted = true
    setEventsLoading(true)
    supabase
      .from('event_log')
      .select('id, event_type, event_date, title, notes, private_notes, quantity, is_public, created_at')
      .eq('project_id', id)
      .order('event_date', { ascending: false })
      .then(({ data }) => {
        if (!isMounted) return
        setEvents(data ?? [])
        setEventsLoading(false)
      })
    return () => { isMounted = false }
  }, [id])

  async function refreshEvents() {
    const { data } = await supabase
      .from('event_log')
      .select('id, event_type, event_date, title, notes, private_notes, quantity, is_public, created_at')
      .eq('project_id', id)
      .order('event_date', { ascending: false })
    setEvents(data ?? [])
  }

  async function handleLogEvent(e) {
    e.preventDefault()
    setLoggingEvent(true)
    setLogErr(null)

    // Capture form values before any state resets
    const capturedType     = eventForm.event_type
    const capturedLocation = project?.location_id ?? null
    const eventDate = eventForm.event_date
      ? new Date(eventForm.event_date + 'T12:00:00').toISOString()
      : new Date().toISOString()

    const payload = {
      project_id:    id,
      event_type:    capturedType,
      event_date:    eventDate,
      title:         eventForm.title.trim()         || null,
      notes:         eventForm.notes.trim()         || null,
      private_notes: eventForm.private_notes.trim() || null,
      quantity:      eventForm.quantity.trim()       || null,
      is_public:     eventForm.is_public,
      logged_by:     user?.id ?? null,
      location_id:   capturedLocation,
    }

    const { data: event, error } = await supabase
      .from('event_log')
      .insert(payload)
      .select('id')
      .single()

    setLoggingEvent(false)

    if (error) {
      setLogErr(error.message)
    } else {
      setEventForm(emptyEventForm())
      setShowLogForm(false)
      await refreshEvents()

      // Non-fatal side effects — entity memory + user XP
      await Promise.all([
        updateEntityMemory(id, capturedLocation, capturedType, new Date(eventDate)),
        user?.id
          ? updateUserStats(user.id, capturedType, { eventLogId: event?.id })
          : Promise.resolve(),
      ])
    }
  }

  async function handleDeleteEvent(evId) {
    if (!window.confirm('Delete this event? This cannot be undone.')) return
    setDeletingId(evId)
    await supabase.from('event_log').delete().eq('id', evId)
    setDeletingId(null)
    await refreshEvents()
  }

  function startEdit() {
    setForm({
      name:        project.name,
      slug:        project.slug,
      variety:     project.variety     ?? '',
      species:     project.species     ?? '',
      description: project.description ?? '',
      status:      project.status,
      start_date:  project.start_date  ?? '',
      is_public:   project.is_public,
      location_id: project.location_id ?? '',
    })
    setSaveErr(null)
    setEditing(true)
  }

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    setSaveErr(null)
    const { error } = await supabase
      .from('plant_projects')
      .update({
        name:        form.name.trim(),
        slug:        form.slug.trim(),
        variety:     form.variety.trim()     || null,
        species:     form.species.trim()     || null,
        description: form.description.trim() || null,
        status:      form.status,
        start_date:  form.start_date         || null,
        is_public:   form.is_public,
        location_id: form.location_id        || null,
      })
      .eq('id', id)
    setSaving(false)
    if (error) {
      setSaveErr(error.code === '23505'
        ? `Slug "${form.slug}" is already taken.`
        : error.message)
    } else {
      // Refresh
      const { data: updated } = await supabase.from('plant_projects').select('*').eq('id', id).single()
      setProject(updated)
      const loc = locations.find(l => l.id === (form.location_id || null))
      setLocPath(loc?.full_path ?? null)
      setEditing(false)
    }
  }

  if (loading) return <Shell><Spinner /></Shell>
  if (error)   return <Shell><ErrMsg msg={error} /></Shell>
  if (!project) return null

  const sc = STATUS_COLORS[project.status] ?? STATUS_COLORS.planning

  return (
    <Shell>
      {/* Breadcrumb */}
      <div style={{ fontSize: '0.82rem', color: P.light, marginBottom: 20 }}>
        <Link to="/projects" style={{ color: P.green, textDecoration: 'none' }}>Projects</Link>
        {' › '}{project.name}
      </div>

      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, gap: 16 }}>
        <div>
          <h1 style={{ margin: '0 0 6px', color: P.green, fontSize: '1.4rem', fontWeight: 700 }}>
            {project.name}
          </h1>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{
              backgroundColor: sc.bg, color: sc.text, border: `1px solid ${sc.border}`,
              fontSize: '0.75rem', padding: '3px 10px', borderRadius: 12, fontWeight: 600,
            }}>
              {project.status}
            </span>
            {!project.is_public && (
              <span style={{ fontSize: '0.75rem', color: P.light, backgroundColor: '#eee', borderRadius: 12, padding: '3px 10px' }}>
                private
              </span>
            )}
            {project.is_public && (
              <a href={`${APP_URL}/garden/${project.slug}`} target="_blank" rel="noopener noreferrer"
                style={{ fontSize: '0.75rem', color: P.green, textDecoration: 'none' }}>
                🌐 View public page ↗
              </a>
            )}
          </div>
        </div>
        {!editing && (
          <button onClick={startEdit} style={outlineBtn}>Edit</button>
        )}
      </div>

      {/* Edit form */}
      {editing ? (
        <form onSubmit={handleSave} style={cardStyle}>
          <h2 style={{ margin: '0 0 18px', fontSize: '1rem', fontWeight: 700, color: P.dark }}>Edit project</h2>
          {saveErr && <ErrBanner msg={saveErr} />}

          <FormRow label="Name *">
            <input required value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value, slug: generateSlug(e.target.value, f.start_date) }))}
              style={inputStyle} />
          </FormRow>

          <FormRow label="Slug  ·  /garden/{slug}">
            <input value={form.slug} onChange={e => setForm(f => ({ ...f, slug: e.target.value }))} style={inputStyle} />
          </FormRow>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <FormRow label="Variety">
              <input value={form.variety} onChange={e => setForm(f => ({ ...f, variety: e.target.value }))} style={inputStyle} />
            </FormRow>
            <FormRow label="Species">
              <input value={form.species} onChange={e => setForm(f => ({ ...f, species: e.target.value }))} style={inputStyle} />
            </FormRow>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <FormRow label="Start date">
              <input type="date" value={form.start_date}
                onChange={e => setForm(f => ({ ...f, start_date: e.target.value, slug: generateSlug(f.name, e.target.value) }))}
                style={inputStyle} />
            </FormRow>
            <FormRow label="Status">
              <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} style={inputStyle}>
                {PROJECT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </FormRow>
          </div>

          <FormRow label="Location">
            <select value={form.location_id} onChange={e => setForm(f => ({ ...f, location_id: e.target.value }))} style={inputStyle}>
              <option value="">— None —</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.full_path}</option>)}
            </select>
          </FormRow>

          <FormRow label="Description">
            <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              style={{ ...inputStyle, height: 80, resize: 'vertical' }} />
          </FormRow>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <input id="edit_public" type="checkbox" checked={form.is_public}
              onChange={e => setForm(f => ({ ...f, is_public: e.target.checked }))}
              style={{ width: 16, height: 16, cursor: 'pointer' }} />
            <label htmlFor="edit_public" style={{ fontSize: '0.88rem', color: P.mid, cursor: 'pointer' }}>Public</label>
          </div>

          <div style={{ display: 'flex', gap: 12, paddingTop: 16, borderTop: `1px solid ${P.border}` }}>
            <button type="submit" disabled={saving} style={primaryBtn(saving)}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            <button type="button" onClick={() => setEditing(false)} style={ghostBtn}>Cancel</button>
          </div>
        </form>
      ) : (
        /* View mode */
        <div style={cardStyle}>
          <Fields project={project} locPath={locPath} />
        </div>
      )}

      {/* ---- Event Log ---- */}
      <div style={{ marginTop: 28 }}>
        {/* Section header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: P.dark }}>
            Event log
            {events.length > 0 && (
              <span style={{ marginLeft: 8, fontWeight: 400, fontSize: '0.82rem', color: P.light }}>
                ({events.length})
              </span>
            )}
          </h2>
          <button
            onClick={() => {
              setShowLogForm(v => !v)
              setLogErr(null)
              if (!showLogForm) setTimeout(() => logFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50)
            }}
            style={showLogForm ? ghostBtn : primaryBtn(false)}
          >
            {showLogForm ? 'Cancel' : '+ Log event'}
          </button>
        </div>

        {/* Log event form */}
        {showLogForm && (
          <form ref={logFormRef} onSubmit={handleLogEvent} style={{ ...cardStyle, marginBottom: 20 }}>
            {logErr && <ErrBanner msg={logErr} />}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <FormRow label="Event type *">
                <select
                  value={eventForm.event_type}
                  onChange={e => setEventForm(f => ({ ...f, event_type: e.target.value }))}
                  style={inputStyle}
                >
                  {EVENT_TYPES.map(t => (
                    <option key={t} value={t}>
                      {(EVENT_ICONS[t] ?? '📝') + ' ' + t.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </FormRow>

              <FormRow label="Date *">
                <input
                  type="date"
                  required
                  value={eventForm.event_date}
                  onChange={e => setEventForm(f => ({ ...f, event_date: e.target.value }))}
                  style={inputStyle}
                />
              </FormRow>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14 }}>
              <FormRow label="Title (optional)">
                <input
                  value={eventForm.title}
                  onChange={e => setEventForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="e.g. First true leaves visible"
                  style={inputStyle}
                />
              </FormRow>
              <FormRow label="Quantity (optional)">
                <input
                  value={eventForm.quantity}
                  onChange={e => setEventForm(f => ({ ...f, quantity: e.target.value }))}
                  placeholder="e.g. 6 plants"
                  style={inputStyle}
                />
              </FormRow>
            </div>

            <FormRow label="Notes (public)">
              <textarea
                value={eventForm.notes}
                onChange={e => setEventForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Visible on public page…"
                style={{ ...inputStyle, height: 64, resize: 'vertical' }}
              />
            </FormRow>

            <FormRow label="Private notes (never public)">
              <textarea
                value={eventForm.private_notes}
                onChange={e => setEventForm(f => ({ ...f, private_notes: e.target.value }))}
                placeholder="Dosage, stress signs, anything you don't want to share…"
                style={{ ...inputStyle, height: 52, resize: 'vertical', borderColor: P.warnBorder, backgroundColor: P.warn }}
              />
            </FormRow>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <input
                id="ev_public"
                type="checkbox"
                checked={eventForm.is_public}
                onChange={e => setEventForm(f => ({ ...f, is_public: e.target.checked }))}
                style={{ width: 16, height: 16, cursor: 'pointer' }}
              />
              <label htmlFor="ev_public" style={{ fontSize: '0.88rem', color: P.mid, cursor: 'pointer' }}>
                Show on public page
              </label>
            </div>

            <div style={{ display: 'flex', gap: 12, paddingTop: 14, borderTop: `1px solid ${P.border}` }}>
              <button type="submit" disabled={loggingEvent} style={primaryBtn(loggingEvent)}>
                {loggingEvent ? 'Saving…' : 'Save event'}
              </button>
              <button type="button" onClick={() => { setShowLogForm(false); setLogErr(null) }} style={ghostBtn}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {/* Timeline */}
        {eventsLoading ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: P.light, fontSize: '0.875rem' }}>Loading…</div>
        ) : events.length === 0 ? (
          <div style={{ padding: '32px 20px', textAlign: 'center', backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 8, color: P.light, fontSize: '0.875rem' }}>
            No events yet — log the first one above.
          </div>
        ) : (
          <div style={{ position: 'relative' }}>
            {/* Timeline spine */}
            <div style={{ position: 'absolute', left: 18, top: 0, bottom: 0, width: 2, backgroundColor: P.border }} />
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {events.map((ev, i) => (
                <EventRow
                  key={ev.id}
                  event={ev}
                  isLast={i === events.length - 1}
                  deleting={deletingId === ev.id}
                  onDelete={() => handleDeleteEvent(ev.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </Shell>
  )
}

function Fields({ project: p, locPath }) {
  const rows = [
    ['Variety',     p.variety],
    ['Species',     p.species],
    ['Start date',  p.start_date ? new Date(p.start_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null],
    ['Location',    locPath ? `📍 ${locPath}` : null],
    ['Slug',        `/garden/${p.slug}`],
    ['Description', p.description],
  ].filter(([, v]) => v)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {rows.map(([label, value]) => (
        <div key={label}>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: P.light, marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
          <div style={{ fontSize: '0.9rem', color: P.dark }}>{value}</div>
        </div>
      ))}
      {rows.length === 0 && <p style={{ color: P.light, margin: 0 }}>No additional details.</p>}
    </div>
  )
}

// ---- Event row ----
function EventRow({ event: ev, isLast, deleting, onDelete }) {
  const icon = EVENT_ICONS[ev.event_type] ?? '📝'
  const d = new Date(ev.event_date)
  const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  return (
    <div style={{ display: 'flex', gap: 14, paddingBottom: isLast ? 0 : 18 }}>
      {/* Icon bubble */}
      <div style={{
        width: 36, height: 36, borderRadius: '50%',
        backgroundColor: P.white, border: `2px solid ${P.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '1rem', flexShrink: 0, position: 'relative', zIndex: 1,
      }}>
        {icon}
      </div>

      {/* Content card */}
      <div style={{
        flex: 1, backgroundColor: P.white, border: `1px solid ${P.border}`,
        borderRadius: 8, padding: '10px 14px', marginBottom: isLast ? 0 : 2,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 2 }}>
              <span style={{ fontWeight: 600, color: P.dark, fontSize: '0.875rem' }}>
                {ev.title || ev.event_type.replace(/_/g, ' ')}
              </span>
              {ev.title && (
                <span style={{ fontSize: '0.75rem', color: P.light, fontStyle: 'italic' }}>
                  {ev.event_type.replace(/_/g, ' ')}
                </span>
              )}
              {ev.quantity && (
                <span style={{
                  fontSize: '0.73rem', color: P.mid,
                  backgroundColor: P.greenPale, borderRadius: 10, padding: '1px 7px',
                }}>
                  {ev.quantity}
                </span>
              )}
              {!ev.is_public && (
                <span style={{
                  fontSize: '0.7rem', color: P.light,
                  backgroundColor: '#eee', borderRadius: 10, padding: '1px 7px',
                }}>
                  private
                </span>
              )}
            </div>
            <div style={{ fontSize: '0.75rem', color: P.light, marginBottom: ev.notes || ev.private_notes ? 6 : 0 }}>
              {dateStr}
            </div>
            {ev.notes && (
              <p style={{ margin: '0 0 4px', color: P.mid, fontSize: '0.83rem', lineHeight: 1.5 }}>
                {ev.notes}
              </p>
            )}
            {ev.private_notes && (
              <p style={{
                margin: 0, color: P.mid, fontSize: '0.8rem', lineHeight: 1.5,
                backgroundColor: P.warn, borderRadius: 4, padding: '4px 8px',
                borderLeft: `3px solid ${P.warnBorder}`,
              }}>
                🔒 {ev.private_notes}
              </p>
            )}
          </div>
          <button
            onClick={onDelete}
            disabled={deleting}
            title="Delete event"
            style={{
              background: 'none', border: 'none', cursor: deleting ? 'not-allowed' : 'pointer',
              color: P.light, fontSize: '1rem', padding: '2px 4px', lineHeight: 1, flexShrink: 0,
            }}
          >
            {deleting ? '…' : '×'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---- Shared UI ----
function Shell({ children }) {
  return (
    <div style={{ minHeight: 'calc(100vh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 20px' }}>{children}</div>
    </div>
  )
}
function Spinner() { return <div style={{ padding: 48, textAlign: 'center', color: P.light }}>Loading…</div> }
function ErrMsg({ msg }) { return <div style={{ padding: 48, textAlign: 'center', color: P.terra }}>{msg}</div> }
function ErrBanner({ msg }) {
  return <div style={{ backgroundColor: P.alert, border: `1px solid ${P.alertBorder}`, borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: '0.875rem', color: '#7a2a10' }}>{msg}</div>
}
function FormRow({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: P.mid, marginBottom: 5 }}>{label}</label>
      {children}
    </div>
  )
}

const inputStyle = { width: '100%', padding: '8px 11px', border: `1px solid ${P.border}`, borderRadius: 6, fontSize: '0.88rem', backgroundColor: P.white, boxSizing: 'border-box' }
const cardStyle  = { backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: 28 }
const primaryBtn = (disabled) => ({ backgroundColor: disabled ? P.light : P.green, color: P.white, border: 'none', borderRadius: 6, padding: '9px 20px', fontSize: '0.88rem', fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer' })
const ghostBtn   = { backgroundColor: 'transparent', color: P.mid, border: `1px solid ${P.border}`, borderRadius: 6, padding: '9px 20px', fontSize: '0.88rem', cursor: 'pointer' }
const outlineBtn = { backgroundColor: 'transparent', color: P.green, border: `1px solid ${P.greenLight}`, borderRadius: 6, padding: '7px 18px', fontSize: '0.85rem', cursor: 'pointer' }
