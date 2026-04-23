import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { P, EVENT_TYPES } from '../lib/constants.js'
import { useAuth } from '../context/AuthContext.jsx'

const EVENT_ICONS = {
  sowing: '🌱', seed_soak: '💧', germination: '🌿', thinning: '✂️',
  potting_up: '🪴', transplant: '🔄', hardening_off: '☀️', watering: '💧',
  fertilizing: '🧪', pest_treatment: '🐛', pruning: '✂️', cover: '🏕️',
  uncover: '🌤️', first_harvest: '🎉', harvest: '🧺', observation: '👁️',
  photo: '📷', other: '📝',
}

export default function EventDetail() {
  const { id: projectId, eventId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()

  const [event, setEvent] = useState(null)
  const [project, setProject] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    let isMounted = true
    ;(async () => {
      const [{ data: ev, error: evErr }, { data: proj, error: projErr }] = await Promise.all([
        supabase
          .from('event_log')
          .select('*')
          .eq('id', eventId)
          .is('deleted_at', null)
          .single(),
        supabase
          .from('plant_projects')
          .select('id, name')
          .eq('id', projectId)
          .single(),
      ])
      if (!isMounted) return
      if (evErr) {
        setError(evErr.code === 'PGRST116' ? 'Event not found.' : evErr.message)
      } else if (projErr) {
        setError('Could not load project.')
      } else {
        setEvent(ev)
        setProject(proj)
      }
      setLoading(false)
    })()
    return () => { isMounted = false }
  }, [eventId, projectId])

  function startEdit() {
    setForm({
      event_type:    event.event_type,
      event_date:    event.event_date ? new Date(event.event_date).toISOString().split('T')[0] : '',
      title:         event.title ?? '',
      notes:         event.notes ?? '',
      private_notes: event.private_notes ?? '',
      quantity:      event.quantity ?? '',
      is_public:     event.is_public,
    })
    setSaveErr(null)
    setEditing(true)
  }

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    setSaveErr(null)
    const eventDate = new Date(form.event_date + 'T12:00:00').toISOString()
    const { error } = await supabase
      .from('event_log')
      .update({
        event_type:    form.event_type,
        event_date:    eventDate,
        title:         form.title.trim()         || null,
        notes:         form.notes.trim()         || null,
        private_notes: form.private_notes.trim() || null,
        quantity:      form.quantity.trim()       || null,
        is_public:     form.is_public,
      })
      .eq('id', eventId)
    setSaving(false)
    if (error) {
      setSaveErr(error.message)
    } else {
      const { data: updated, error: refetchErr } = await supabase
        .from('event_log')
        .select('*')
        .eq('id', eventId)
        .single()
      if (refetchErr) { setSaveErr(refetchErr.message); return }
      setEvent(updated)
      setEditing(false)
    }
  }

  async function handleDelete() {
    if (!window.confirm('Delete this event permanently?')) return
    setDeleting(true)
    const { error: delErr } = await supabase
      .from('event_log')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', eventId)
    setDeleting(false)
    if (delErr) { setError(delErr.message); return }
    navigate(`/projects/${projectId}`)
  }

  if (loading) return <Shell><div style={{ padding: 48, textAlign: 'center', color: P.light }}>Loading…</div></Shell>
  if (error) return <Shell><div style={{ padding: 48, textAlign: 'center', color: P.terra }}>{error}</div></Shell>
  if (!event || !project) return null

  const icon = EVENT_ICONS[event.event_type] ?? '📝'

  return (
    <Shell>
      <div style={{ fontSize: '0.82rem', color: P.light, marginBottom: 20 }}>
        <Link to={`/projects/${projectId}`} style={{ color: P.green, textDecoration: 'none' }}>
          {project.name}
        </Link>
        {' › Event'}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>
          {icon} {event.title || event.event_type.replace(/_/g, ' ')}
        </h1>
        {!editing && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={startEdit} style={outlineBtn}>Edit</button>
            <button onClick={handleDelete} disabled={deleting} style={{ ...outlineBtn, color: P.terra, borderColor: P.terra }}>
              {deleting ? '…' : 'Delete'}
            </button>
          </div>
        )}
      </div>

      {editing ? (
        <form onSubmit={handleSave} style={cardStyle}>
          <h2 style={{ margin: '0 0 18px', fontSize: '1rem', fontWeight: 700, color: P.dark }}>Edit event</h2>
          {saveErr && <ErrBanner msg={saveErr} />}

          <FormRow label="Event type *">
            <select
              value={form.event_type}
              onChange={e => setForm(f => ({ ...f, event_type: e.target.value }))}
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
              value={form.event_date}
              onChange={e => setForm(f => ({ ...f, event_date: e.target.value }))}
              style={inputStyle}
            />
          </FormRow>

          <FormRow label="Title (optional)">
            <input
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder="e.g. First true leaves visible"
              style={inputStyle}
            />
          </FormRow>

          <FormRow label="Quantity (optional)">
            <input
              value={form.quantity}
              onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))}
              placeholder="e.g. 6 plants"
              style={inputStyle}
            />
          </FormRow>

          <FormRow label="Notes (public)">
            <textarea
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Visible on public page…"
              style={{ ...inputStyle, height: 80, resize: 'vertical' }}
            />
          </FormRow>

          <FormRow label="Private notes (never public)">
            <textarea
              value={form.private_notes}
              onChange={e => setForm(f => ({ ...f, private_notes: e.target.value }))}
              placeholder="Dosage, stress signs, anything you don't want to share…"
              style={{ ...inputStyle, height: 72, resize: 'vertical', borderColor: P.warnBorder, backgroundColor: P.warn }}
            />
          </FormRow>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <input
              id="ev_public"
              type="checkbox"
              checked={form.is_public}
              onChange={e => setForm(f => ({ ...f, is_public: e.target.checked }))}
              style={{ width: 16, height: 16, cursor: 'pointer' }}
            />
            <label htmlFor="ev_public" style={{ fontSize: '0.88rem', color: P.mid, cursor: 'pointer' }}>
              Show on public page
            </label>
          </div>

          <div style={{ display: 'flex', gap: 12, paddingTop: 16, borderTop: `1px solid ${P.border}` }}>
            <button type="submit" disabled={saving} style={primaryBtn(saving)}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              style={{ ...primaryBtn(false), backgroundColor: 'transparent', color: P.mid, border: `1px solid ${P.border}` }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div style={cardStyle}>
          <EventFields event={event} />
        </div>
      )}
    </Shell>
  )
}

function EventFields({ event: ev }) {
  const d = new Date(ev.event_date)
  const dateStr = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

  const rows = [
    ['Date', dateStr],
    ['Type', ev.event_type.replace(/_/g, ' ')],
    ev.quantity && ['Quantity', ev.quantity],
    ['Visibility', ev.is_public ? 'Public' : 'Private'],
    ev.notes && ['Notes', ev.notes],
    ev.private_notes && ['Private notes', ev.private_notes],
  ].filter(Boolean)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {rows.map(([label, value]) => (
        <div key={label}>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: P.light, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            {label}
          </div>
          <div style={{ fontSize: '0.9rem', color: P.dark, lineHeight: 1.5 }}>
            {label === 'Private notes' ? (
              <div style={{ backgroundColor: P.warn, borderRadius: 4, padding: '8px 10px', borderLeft: `3px solid ${P.warnBorder}` }}>
                🔒 {value}
              </div>
            ) : (
              value
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 20px' }}>
        {children}
      </div>
    </div>
  )
}

function ErrBanner({ msg }) {
  return (
    <div style={{ backgroundColor: P.alert, border: `1px solid ${P.alertBorder}`, borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: '0.875rem', color: '#7a2a10' }}>
      {msg}
    </div>
  )
}

function FormRow({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: P.mid, marginBottom: 5 }}>
        {label}
      </label>
      {children}
    </div>
  )
}

const inputStyle = { width: '100%', padding: '8px 11px', border: `1px solid ${P.border}`, borderRadius: 6, fontSize: '0.88rem', backgroundColor: P.white, boxSizing: 'border-box' }
const cardStyle = { backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: 24 }
const primaryBtn = (disabled) => ({ backgroundColor: disabled ? P.light : P.green, color: P.white, border: 'none', borderRadius: 6, padding: '9px 20px', fontSize: '0.88rem', fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer' })
const outlineBtn = { backgroundColor: 'transparent', color: P.green, border: `1px solid ${P.greenLight}`, borderRadius: 6, padding: '7px 18px', fontSize: '0.85rem', cursor: 'pointer' }
