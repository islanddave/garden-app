import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { supabase } from '../lib/supabase.js'
import { P, PROJECT_STATUSES } from '../lib/constants.js'

// ---- Slug helpers ----
function slugify(str) {
  return str.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
function generateSlug(name, startDate) {
  const year = startDate
    ? new Date(startDate + 'T00:00:00').getFullYear()
    : new Date().getFullYear()
  const base = slugify(name)
  // Don't double-append year if the name already ends with it (e.g. "Peppers 2026" → "peppers-2026" not "peppers-2026-2026")
  return base.endsWith(`-${year}`) ? base : `${base}-${year}`
}

export default function ProjectNew() {
  const { user } = useAuth()
  const navigate  = useNavigate()

  const today = new Date().toISOString().split('T')[0]

  const [form, setForm] = useState({
    name:        '',
    slug:        '',
    variety:     '',
    species:     '',
    description: '',
    status:      'planning',
    start_date:  today,
    is_public:   true,
    location_id: '',
  })
  const [locations, setLocations] = useState([])
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState(null)

  // Load location options
  useEffect(() => {
    supabase
      .from('locations_with_path')
      .select('id, full_path, is_active')
      .order('full_path')
      .then(({ data }) => setLocations((data ?? []).filter(l => l.is_active)))
  }, [])

  // Update slug when name or start_date changes
  function handleNameChange(name) {
    setForm(f => ({ ...f, name, slug: generateSlug(name, f.start_date) }))
  }
  function handleDateChange(start_date) {
    setForm(f => ({ ...f, start_date, slug: generateSlug(f.name, start_date) }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!user) return
    setSaving(true)
    setError(null)

    const { data, error } = await supabase
      .from('plant_projects')
      .insert({
        name:         form.name.trim(),
        slug:         form.slug.trim(),
        variety:      form.variety.trim()     || null,
        species:      form.species.trim()     || null,
        description:  form.description.trim() || null,
        status:       form.status,
        start_date:   form.start_date         || null,
        is_public:    form.is_public,
        location_id:  form.location_id        || null,
        created_by:   user.id,
      })
      .select('id')
      .single()

    setSaving(false)
    if (error) {
      if (error.code === '23505')
        setError(`A project with slug "${form.slug}" already exists. Try a different name or change the year.`)
      else
        setError(error.message)
    } else {
      navigate(`/projects/${data.id}`)
    }
  }

  return (
    <div style={{ minHeight: 'calc(100vh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '32px 20px' }}>

        {/* Breadcrumb */}
        <div style={{ fontSize: '0.82rem', color: P.light, marginBottom: 20 }}>
          <Link to="/projects" style={{ color: P.green, textDecoration: 'none' }}>Projects</Link>
          {' › New project'}
        </div>

        <h1 style={{ margin: '0 0 24px', color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>
          New project
        </h1>

        {error && <ErrBanner msg={error} />}

        <form onSubmit={handleSubmit} style={cardStyle}>

          {/* Name */}
          <FormRow label="Project name *">
            <input
              required
              value={form.name}
              onChange={e => handleNameChange(e.target.value)}
              style={inputStyle}
              placeholder="e.g. Peppers 2026"
            />
          </FormRow>

          {/* Slug */}
          <FormRow label="Slug  ·  used in public URL: /garden/{slug}">
            <input
              value={form.slug}
              onChange={e => setForm(f => ({ ...f, slug: e.target.value }))}
              style={inputStyle}
              placeholder="auto-generated"
            />
            <small style={{ fontSize: '0.75rem', color: P.light }}>
              URL: garden.futureishere.net/garden/{form.slug || '…'}
            </small>
          </FormRow>

          {/* Variety + species side by side */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <FormRow label="Variety">
              <input
                value={form.variety}
                onChange={e => setForm(f => ({ ...f, variety: e.target.value }))}
                style={inputStyle}
                placeholder="e.g. Shishito"
              />
            </FormRow>
            <FormRow label="Species">
              <input
                value={form.species}
                onChange={e => setForm(f => ({ ...f, species: e.target.value }))}
                style={inputStyle}
                placeholder="e.g. Capsicum annuum"
              />
            </FormRow>
          </div>

          {/* Start date + status side by side */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <FormRow label="Start date">
              <input
                type="date"
                value={form.start_date}
                onChange={e => handleDateChange(e.target.value)}
                style={inputStyle}
              />
            </FormRow>
            <FormRow label="Status">
              <select
                value={form.status}
                onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                style={inputStyle}
              >
                {PROJECT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </FormRow>
          </div>

          {/* Location */}
          <FormRow label="Location">
            <select
              value={form.location_id}
              onChange={e => setForm(f => ({ ...f, location_id: e.target.value }))}
              style={inputStyle}
            >
              <option value="">— None —</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.full_path}</option>)}
            </select>
            {locations.length === 0 && (
              <small style={{ fontSize: '0.75rem', color: P.terra }}>
                No locations yet — <Link to="/locations" style={{ color: P.terra }}>create zones first</Link>.
              </small>
            )}
          </FormRow>

          {/* Description */}
          <FormRow label="Description  ·  shown on public page">
            <textarea
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              style={{ ...inputStyle, height: 80, resize: 'vertical' }}
              placeholder="Optional — shown publicly if project is public"
            />
          </FormRow>

          {/* Public toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <input
              id="is_public"
              type="checkbox"
              checked={form.is_public}
              onChange={e => setForm(f => ({ ...f, is_public: e.target.checked }))}
              style={{ width: 16, height: 16, cursor: 'pointer' }}
            />
            <label htmlFor="is_public" style={{ fontSize: '0.88rem', color: P.mid, cursor: 'pointer' }}>
              Public — visible at /garden/{form.slug || '…'}
            </label>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 12, marginTop: 8, paddingTop: 20, borderTop: `1px solid ${P.border}` }}>
            <button type="submit" disabled={saving} style={primaryBtn(saving)}>
              {saving ? 'Creating…' : 'Create project'}
            </button>
            <Link to="/projects" style={cancelLink}>Cancel</Link>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---- Shared UI ----
function ErrBanner({ msg }) {
  return (
    <div style={{ backgroundColor: P.alert, border: `1px solid ${P.alertBorder}`, borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: '0.875rem', color: '#7a2a10' }}>
      {msg}
    </div>
  )
}
function FormRow({ label, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: P.mid, marginBottom: 5 }}>{label}</label>
      {children}
    </div>
  )
}

const primaryBtn = (disabled) => ({
  backgroundColor: disabled ? P.light : P.green,
  color: P.white, border: 'none', borderRadius: 6,
  padding: '10px 22px', fontSize: '0.9rem', fontWeight: 600,
  cursor: disabled ? 'not-allowed' : 'pointer',
})
const cancelLink = {
  display: 'inline-flex', alignItems: 'center',
  color: P.mid, textDecoration: 'none', fontSize: '0.9rem',
}
const inputStyle = {
  width: '100%', padding: '8px 11px', border: `1px solid ${P.border}`,
  borderRadius: 6, fontSize: '0.88rem', backgroundColor: P.white, boxSizing: 'border-box',
}
const cardStyle = {
  backgroundColor: P.white, border: `1px solid ${P.border}`,
  borderRadius: 10, padding: 28,
}
