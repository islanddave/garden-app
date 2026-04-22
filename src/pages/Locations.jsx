import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'
import { P, LOCATION_TYPE_LABELS } from '../lib/constants.js'

const LEVEL_LABELS = ['Zone', 'Area', 'Section', 'Position']

// ---- Slug helper ----
function slugify(str) {
  return str.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// ---- Main page ----
export default function Locations() {
  const [locations,  setLocations]  = useState([])
  const [withPaths,  setWithPaths]  = useState([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(null)
  const [showForm,   setShowForm]   = useState(false)
  const [form,       setForm]       = useState(emptyForm())
  const [saving,     setSaving]     = useState(false)
  const [formError,  setFormError]  = useState(null)

  function emptyForm() {
    return { name: '', slug: '', type_label: '', parent_id: '', sort_order: '0', description: '' }
  }

  const load = useCallback(async () => {
    let isMounted = true
    const [{ data: locs, error: e1 }, { data: paths, error: e2 }] = await Promise.all([
      supabase.from('locations').select('*').order('level').order('sort_order').order('name'),
      supabase.from('locations_with_path').select('id, full_path, level, is_active').order('full_path'),
    ])
    if (!isMounted) return
    if (e1 || e2) setError((e1 || e2).message)
    else { setLocations(locs ?? []); setWithPaths(paths ?? []) }
    setLoading(false)
    return () => { isMounted = false }
  }, [])

  useEffect(() => { load() }, [load])

  function inferLevel() {
    if (!form.parent_id) return 0
    const parent = locations.find(l => l.id === form.parent_id)
    return parent ? Math.min(parent.level + 1, 3) : 0
  }

  async function handleCreate(e) {
    e.preventDefault()
    setSaving(true)
    setFormError(null)
    const { error } = await supabase.from('locations').insert({
      name:        form.name.trim(),
      slug:        form.slug.trim(),
      level:       inferLevel(),
      type_label:  form.type_label || null,
      parent_id:   form.parent_id  || null,
      sort_order:  parseInt(form.sort_order) || 0,
      description: form.description.trim() || null,
    })
    setSaving(false)
    if (error) {
      setFormError(error.code === '23505'
        ? `Slug "${form.slug}" already exists under this parent. Try a different name.`
        : error.message)
    } else {
      setForm(emptyForm())
      setShowForm(false)
      load()
    }
  }

  async function toggleActive(loc) {
    await supabase.from('locations').update({ is_active: !loc.is_active }).eq('id', loc.id)
    load()
  }

  const zones = locations.filter(l => l.level === 0)

  if (loading) return <Shell><Spinner /></Shell>
  if (error)   return <Shell><ErrMsg msg={error} /></Shell>

  return (
    <Shell>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>Locations</h1>
          <p style={{ margin: '4px 0 0', color: P.light, fontSize: '0.85rem' }}>
            Zone → Area → Section → Position
          </p>
        </div>
        <button
          onClick={() => { setShowForm(s => !s); setFormError(null); setForm(emptyForm()) }}
          style={btn(P.green)}
        >
          {showForm ? 'Cancel' : '+ Add location'}
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <form onSubmit={handleCreate} style={card}>
          <h2 style={{ margin: '0 0 18px', fontSize: '1rem', fontWeight: 700, color: P.dark }}>New location</h2>
          {formError && <ErrBanner msg={formError} />}

          <FormRow label="Name *">
            <input
              required
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value, slug: slugify(e.target.value) }))}
              style={input}
              placeholder="e.g. Indoor Rack"
            />
          </FormRow>

          <FormRow label={`Slug  ·  Level will be: ${LEVEL_LABELS[Math.min(inferLevel(), 3)]}`}>
            <input
              value={form.slug}
              onChange={e => setForm(f => ({ ...f, slug: e.target.value }))}
              style={input}
              placeholder="auto-generated from name"
            />
          </FormRow>

          <FormRow label="Parent">
            <select
              value={form.parent_id}
              onChange={e => setForm(f => ({ ...f, parent_id: e.target.value }))}
              style={input}
            >
              <option value="">— None (creates a Zone) —</option>
              {withPaths
                .filter(l => l.level < 3 && l.is_active)
                .map(l => <option key={l.id} value={l.id}>{l.full_path}</option>)}
            </select>
          </FormRow>

          <FormRow label="Type label">
            <select
              value={form.type_label}
              onChange={e => setForm(f => ({ ...f, type_label: e.target.value }))}
              style={input}
            >
              <option value="">— Optional —</option>
              {LOCATION_TYPE_LABELS.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </FormRow>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FormRow label="Sort order">
              <input
                type="number" min="0"
                value={form.sort_order}
                onChange={e => setForm(f => ({ ...f, sort_order: e.target.value }))}
                style={{ ...input, width: '100%' }}
              />
            </FormRow>
            <FormRow label="Description">
              <input
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                style={input}
                placeholder="Optional"
              />
            </FormRow>
          </div>

          <div style={{ marginTop: 20 }}>
            <button type="submit" disabled={saving} style={btn(saving ? P.light : P.green)}>
              {saving ? 'Saving…' : 'Create location'}
            </button>
          </div>
        </form>
      )}

      {/* Tree */}
      {zones.length === 0 ? (
        <Empty msg='No zones yet. Run the seed SQL in the Supabase editor to create the initial zones (Stable, Deck, Pasture, Steps, House), then add child areas here.' />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {zones.map(zone => (
            <ZoneBlock key={zone.id} zone={zone} locations={locations} toggleActive={toggleActive} />
          ))}
        </div>
      )}
    </Shell>
  )
}

// ---- Zone block (expandable) ----
function ZoneBlock({ zone, locations, toggleActive }) {
  const [open, setOpen] = useState(true)
  const directChildren = locations.filter(l => l.parent_id === zone.id)

  return (
    <div style={{ border: `1px solid ${P.border}`, borderRadius: 8, overflow: 'hidden' }}>
      <LocRow loc={zone} indent={0} open={open} hasKids={directChildren.length > 0}
        onToggleExpand={() => setOpen(o => !o)} onToggleActive={toggleActive} />
      {open && directChildren.map(child => {
        const grandkids = locations.filter(l => l.parent_id === child.id)
        return (
          <div key={child.id}>
            <LocRow loc={child} indent={1} hasKids={false} onToggleActive={toggleActive} />
            {grandkids.map(gc => {
              const positions = locations.filter(l => l.parent_id === gc.id)
              return (
                <div key={gc.id}>
                  <LocRow loc={gc} indent={2} hasKids={false} onToggleActive={toggleActive} />
                  {positions.map(pos => (
                    <LocRow key={pos.id} loc={pos} indent={3} hasKids={false} onToggleActive={toggleActive} />
                  ))}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

// ---- Location row ----
function LocRow({ loc, indent, open, hasKids, onToggleExpand, onToggleActive }) {
  const isZone = indent === 0
  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      padding: `10px 16px 10px ${16 + indent * 20}px`,
      backgroundColor: !loc.is_active ? '#f7f7f7' : isZone ? P.greenPale : P.white,
      borderTop: isZone ? 'none' : `1px solid ${P.border}`,
      opacity: loc.is_active ? 1 : 0.6,
      gap: 8,
    }}>
      <div style={{ width: 16, flexShrink: 0 }}>
        {hasKids && onToggleExpand && (
          <button onClick={onToggleExpand} style={{ background: 'none', border: 'none', cursor: 'pointer', color: P.mid, padding: 0, fontSize: '0.85rem', lineHeight: 1 }}>
            {open ? '▾' : '▸'}
          </button>
        )}
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: isZone ? 700 : 500, color: P.dark, fontSize: isZone ? '0.95rem' : '0.88rem' }}>{loc.name}</span>
        {loc.type_label && <span style={{ fontSize: '0.7rem', color: P.mid, backgroundColor: P.border, borderRadius: 10, padding: '1px 7px' }}>{loc.type_label}</span>}
        <span style={{ fontSize: '0.7rem', color: P.light }}>{LEVEL_LABELS[loc.level]}</span>
        {!loc.is_active && <span style={{ fontSize: '0.7rem', color: P.light, backgroundColor: '#eee', borderRadius: 10, padding: '1px 7px' }}>inactive</span>}
      </div>
      <span style={{ fontSize: '0.75rem', color: P.light, fontFamily: 'monospace', marginRight: 8, flexShrink: 0 }}>/{loc.slug}</span>
      <button onClick={() => onToggleActive(loc)} style={{ fontSize: '0.75rem', color: loc.is_active ? P.terra : P.green, background: 'none', border: `1px solid ${loc.is_active ? P.alertBorder : P.greenLight}`, borderRadius: 4, padding: '2px 9px', cursor: 'pointer', flexShrink: 0 }}>
        {loc.is_active ? 'Deactivate' : 'Activate'}
      </button>
    </div>
  )
}

// ---- Shared UI ----
function Shell({ children }) {
  return <div style={{ minHeight: '100dvh', backgroundColor: P.cream }}><div style={{ maxWidth: 800, margin: '0 auto', padding: '32px 20px' }}>{children}</div></div>
}
function Spinner() { return <div style={{ padding: 48, textAlign: 'center', color: P.light }}>Loading…</div> }
function ErrMsg({ msg }) { return <div style={{ padding: 48, textAlign: 'center', color: P.terra }}>{msg}</div> }
function ErrBanner({ msg }) {
  return <div style={{ backgroundColor: P.alert, border: `1px solid ${P.alertBorder}`, borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: '0.875rem', color: '#7a2a10' }}>{msg}</div>
}
function Empty({ msg }) {
  return <div style={{ textAlign: 'center', color: P.light, padding: '40px 20px', fontSize: '0.875rem', backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 8 }}>{msg}</div>
}
function FormRow({ label, children }) {
  return <div style={{ marginBottom: 14 }}><label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: P.mid, marginBottom: 5 }}>{label}</label>{children}</div>
}

const btn = (bg) => ({ backgroundColor: bg, color: P.white, border: 'none', borderRadius: 6, padding: '9px 18px', fontSize: '0.88rem', fontWeight: 600, cursor: bg === P.light ? 'not-allowed' : 'pointer' })
const input = { width: '100%', padding: '8px 11px', border: `1px solid ${P.border}`, borderRadius: 6, fontSize: '0.88rem', backgroundColor: P.white, boxSizing: 'border-box' }
const card = { backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: 24, marginBottom: 24 }
