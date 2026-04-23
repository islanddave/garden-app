import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { supabase } from '../lib/supabase.js'
import { P, PROJECT_CATEGORIES } from '../lib/constants.js'

const DEFAULT_ICONS = ['🌳','🌿','🪴','🌱','🥕','🍅','🌻','🌾','🪵','🏠','🚜','🔨','🛠️','📦','💧','🌍']

export default function ProjectTypes() {
  const { user } = useAuth()
  const [types, setTypes]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving]     = useState(false)
  const [form, setForm]         = useState({ name: '', category: 'garden', description: '', icon: '🌱' })

  async function load() {
    const { data, error } = await supabase
      .from('project_types')
      .select('*')
      .order('category').order('name')
    if (error) setError(error.message)
    else setTypes(data ?? [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function handleCreate(e) {
    e.preventDefault()
    if (!user) return
    setSaving(true)
    const { error } = await supabase.from('project_types').insert({
      name: form.name.trim(),
      category: form.category,
      description: form.description.trim() || null,
      icon: form.icon || '📋',
      created_by: user.id,
    })
    setSaving(false)
    if (error) { setError(error.message); return }
    setForm({ name: '', category: 'garden', description: '', icon: '🌱' })
    setShowForm(false)
    load()
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this project type?')) return
    const { error } = await supabase.from('project_types').delete().eq('id', id)
    if (error) setError(error.message)
    else setTypes(t => t.filter(x => x.id !== id))
  }

  const garden = types.filter(t => t.category === 'garden')
  const infra  = types.filter(t => t.category === 'infrastructure')

  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 20px' }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <div>
            <div style={{ fontSize: '0.82rem', color: P.light, marginBottom: 6 }}>
              <Link to="/projects" style={{ color: P.green, textDecoration: 'none' }}>Projects</Link>
              {' › Project Types'}
            </div>
            <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>Project Types</h1>
          </div>
          <button onClick={() => setShowForm(s => !s)} style={btnPrimary}>
            {showForm ? 'Cancel' : '+ New type'}
          </button>
        </div>

        {error && <ErrBanner msg={error} onClose={() => setError(null)} />}

        {showForm && (
          <form onSubmit={handleCreate} style={{ ...card, marginBottom: 24 }}>
            <h3 style={{ margin: '0 0 18px', color: P.mid, fontSize: '0.95rem', fontWeight: 700 }}>New project type</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
              <div>
                <label style={labelStyle}>Name *</label>
                <input required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={inputStyle} placeholder="e.g. Fruit Trees" />
              </div>
              <div>
                <label style={labelStyle}>Category *</label>
                <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} style={inputStyle}>
                  {PROJECT_CATEGORIES.map(c => <option key={c.v} value={c.v}>{c.label}</option>)}
                </select>
              </div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Description</label>
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} style={inputStyle} placeholder="Optional — shown when choosing a template" />
            </div>
            <div style={{ marginBottom: 18 }}>
              <label style={labelStyle}>Icon</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                {DEFAULT_ICONS.map(ic => (
                  <button key={ic} type="button" onClick={() => setForm(f => ({ ...f, icon: ic }))}
                    style={{ fontSize: '1.3rem', padding: '4px 8px', border: `2px solid ${form.icon === ic ? P.green : P.border}`, borderRadius: 6, background: form.icon === ic ? P.greenPale : P.white, cursor: 'pointer' }}>
                    {ic}
                  </button>
                ))}
                <input value={form.icon} onChange={e => setForm(f => ({ ...f, icon: e.target.value }))} style={{ ...inputStyle, width: 60 }} placeholder="✏️" maxLength={4} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <button type="submit" disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Create type'}</button>
            </div>
          </form>
        )}

        {loading ? <Spinner /> : (
          <>
            <Section title="🌱 Garden" types={garden} userId={user?.id} onDelete={handleDelete} />
            <Section title="🔨 Infrastructure" types={infra} userId={user?.id} onDelete={handleDelete} />
          </>
        )}
      </div>
    </div>
  )
}

function Section({ title, types, userId, onDelete }) {
  if (!types.length) return null
  return (
    <div style={{ marginBottom: 32 }}>
      <h2 style={{ margin: '0 0 12px', fontSize: '0.85rem', fontWeight: 700, color: P.mid, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {types.map(t => <TypeRow key={t.id} type={t} userId={userId} onDelete={onDelete} />)}
      </div>
    </div>
  )
}

function TypeRow({ type: t, userId, onDelete }) {
  const isOwn = t.created_by && t.created_by === userId
  const isSystem = !t.created_by
  return (
    <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px' }}>
      <span style={{ fontSize: '1.5rem', flexShrink: 0 }}>{t.icon || '📋'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, color: P.dark, fontSize: '0.95rem' }}>{t.name}</div>
        {t.description && <div style={{ fontSize: '0.8rem', color: P.light, marginTop: 2 }}>{t.description}</div>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {isSystem && <span style={{ fontSize: '0.72rem', color: P.light, background: '#eee', borderRadius: 10, padding: '2px 8px' }}>system</span>}
        {isOwn && (
          <button onClick={() => onDelete(t.id)} style={{ background: 'none', border: 'none', color: P.terra, cursor: 'pointer', fontSize: '0.82rem', padding: '4px 8px' }}>
            Delete
          </button>
        )}
      </div>
    </div>
  )
}

function ErrBanner({ msg, onClose }) {
  return (
    <div style={{ backgroundColor: P.alert, border: `1px solid ${P.alertBorder}`, borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: '0.875rem', color: '#7a2a10', display: 'flex', justifyContent: 'space-between' }}>
      {msg}
      <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#7a2a10', cursor: 'pointer', fontWeight: 700 }}>✕</button>
    </div>
  )
}

const card = { backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: 20 }
const inputStyle = { width: '100%', padding: '8px 11px', border: `1px solid ${P.border}`, borderRadius: 6, fontSize: '0.88rem', backgroundColor: P.white, boxSizing: 'border-box' }
const labelStyle = { display: 'block', fontSize: '0.8rem', fontWeight: 600, color: P.mid, marginBottom: 5 }
const btnPrimary = { backgroundColor: P.green, color: P.white, border: 'none', borderRadius: 6, padding: '9px 18px', fontSize: '0.88rem', fontWeight: 600, cursor: 'pointer' }
function Spinner() { return <div style={{ padding: 40, textAlign: 'center', color: P.light }}>Loading…</div> }
