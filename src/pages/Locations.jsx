import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'
import { P, LOCATION_TYPE_LABELS } from '../lib/constants.js'
import FavoriteToggle from '../components/FavoriteToggle.jsx'

const LEVEL_LABELS = ['Zone', 'Area', 'Section', 'Position']

function slugify(str) {
  return str.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function emptyForm() {
  return { name: '', slug: '', type_label: '', parent_id: '', sort_order: '0', description: '' }
}

function locToForm(loc) {
  return {
    name:        loc.name        || '',
    slug:        loc.slug        || '',
    type_label:  loc.type_label  || '',
    parent_id:   loc.parent_id   || '',
    sort_order:  String(loc.sort_order ?? 0),
    description: loc.description || '',
  }
}

export default function Locations() {
  const [locations,       setLocations]       = useState([])
  const [withPaths,       setWithPaths]       = useState([])
  const [loading,         setLoading]         = useState(true)
  const [error,           setError]           = useState(null)
  const [showForm,        setShowForm]        = useState(false)
  const [form,            setForm]            = useState(emptyForm())
  const [saving,          setSaving]          = useState(false)
  const [formError,       setFormError]       = useState(null)
  const [editId,          setEditId]          = useState(null)
  const [editForm,        setEditForm]        = useState(emptyForm())
  const [editError,       setEditError]       = useState(null)
  const [editSaving,      setEditSaving]      = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)

  const load = useCallback(async () => {
    const [{ data: locs, error: e1 }, { data: paths, error: e2 }] = await Promise.all([
      supabase.from('locations').select('*').is('deleted_at', null).order('level').order('sort_order').order('name'),
      supabase.from('locations_with_path').select('id, full_path, level, is_active').order('full_path'),
    ])
    if (e1 || e2) setError((e1 || e2).message)
    else { setLocations(locs ?? []); setWithPaths(paths ?? []) }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function inferLevel(parent_id) {
    if (!parent_id) return 0
    const parent = locations.find(l => l.id === parent_id)
    return parent ? Math.min(parent.level + 1, 3) : 0
  }

  async function handleCreate(e) {
    e.preventDefault()
    setSaving(true); setFormError(null)
    const { error } = await supabase.from('locations').insert({
      name:        form.name.trim(),
      slug:        form.slug.trim(),
      level:       inferLevel(form.parent_id),
      type_label:  form.type_label  || null,
      parent_id:   form.parent_id   || null,
      sort_order:  parseInt(form.sort_order) || 0,
      description: form.description.trim()  || null,
    })
    setSaving(false)
    if (error) {
      setFormError(error.code === '23505'
        ? `Slug "${form.slug}" already exists. Try a different name.`
        : error.message)
    } else {
      setForm(emptyForm()); setShowForm(false); load()
    }
  }

  function startEdit(loc) {
    setEditId(loc.id); setEditForm(locToForm(loc)); setEditError(null); setConfirmDeleteId(null)
  }

  function cancelEdit() {
    setEditId(null); setEditError(null); setConfirmDeleteId(null)
  }

  async function handleUpdate(e) {
    e.preventDefault()
    setEditSaving(true); setEditError(null)
    const { error } = await supabase.from('locations').update({
      name:        editForm.name.trim(),
      slug:        editForm.slug.trim(),
      level:       inferLevel(editForm.parent_id),
      type_label:  editForm.type_label  || null,
      parent_id:   editForm.parent_id   || null,
      sort_order:  parseInt(editForm.sort_order) || 0,
      description: editForm.description.trim()  || null,
    }).eq('id', editId)
    setEditSaving(false)
    if (error) {
      setEditError(error.code === '23505'
        ? `Slug "${editForm.slug}" already exists.`
        : error.message)
    } else {
      setEditId(null); setConfirmDeleteId(null); load()
    }
  }

  async function handleDelete(locId) {
    if (confirmDeleteId !== locId) { setConfirmDeleteId(locId); return }
    await supabase.from('locations').update({ deleted_at: new Date().toISOString() }).eq('id', locId)
    setConfirmDeleteId(null); setEditId(null); load()
  }

  async function toggleActive(loc) {
    await supabase.from('locations').update({ is_active: !loc.is_active }).eq('id', loc.id)
    load()
  }

  const zones = locations.filter(l => l.level === 0)
  const editProps = {
    editId, editForm, setEditForm, editError, editSaving,
    onEditStart: startEdit, onEditCancel: cancelEdit,
    onUpdate: handleUpdate, onDelete: handleDelete,
    confirmDeleteId, withPaths, locations,
    onToggleActive: toggleActive,
  }

  if (loading) return <Shell><Spinner /></Shell>
  if (error)   return <Shell><ErrMsg msg={error} /></Shell>

  return (
    <Shell>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>Locations</h1>
          <p style={{ margin: '4px 0 0', color: P.light, fontSize: '0.85rem' }}>Zone → Area → Section → Position</p>
        </div>
        <button
          onClick={() => { setShowForm(s => !s); setFormError(null); setForm(emptyForm()) }}
          style={btn(P.green)}
        >
          {showForm ? 'Cancel' : '+ Add location'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} style={card}>
          <h2 style={{ margin: '0 0 18px', fontSize: '1rem', fontWeight: 700, color: P.dark }}>New location</h2>
          {formError && <ErrBanner msg={formError} />}
          <LocationFields
            form={form} setForm={setForm} withPaths={withPaths}
            inferLevel={() => inferLevel(form.parent_id)} excludeId={null}
          />
          <div style={{ marginTop: 20 }}>
            <button type="submit" disabled={saving} style={btn(saving ? P.light : P.green)}>
              {saving ? 'Saving…' : 'Create location'}
            </button>
          </div>
        </form>
      )}

      {zones.length === 0
        ? <Empty msg="No zones yet." />
        : <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {zones.map(zone => <ZoneBlock key={zone.id} zone={zone} locations={locations} {...editProps} />)}
          </div>
      }
    </Shell>
  )
}

function LocationFields({ form, setForm, withPaths, inferLevel, excludeId }) {
  return (
    <>
      <FormRow label="Name *">
        <input required value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value, slug: slugify(e.target.value) }))}
          style={input} placeholder="e.g. Indoor Rack" />
      </FormRow>
      <FormRow label={`Slug  ·  Level: ${LEVEL_LABELS[Math.min(inferLevel(), 3)]}`}>
        <input value={form.slug}
          onChange={e => setForm(f => ({ ...f, slug: e.target.value }))}
          style={input} placeholder="auto-generated from name" />
      </FormRow>
      <FormRow label="Parent">
        <select value={form.parent_id}
          onChange={e => setForm(f => ({ ...f, parent_id: e.target.value }))} style={input}>
          <option value="">— None (creates a Zone) —</option>
          {withPaths
            .filter(l => l.level < 3 && l.is_active && l.id !== excludeId)
            .map(l => <option key={l.id} value={l.id}>{l.full_path}</option>)}
        </select>
      </FormRow>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <FormRow label="Type label">
          <select value={form.type_label}
            onChange={e => setForm(f => ({ ...f, type_label: e.target.value }))} style={input}>
            <option value="">— Optional —</option>
            {LOCATION_TYPE_LABELS.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </FormRow>
        <FormRow label="Sort order">
          <input type="number" min="0" value={form.sort_order}
            onChange={e => setForm(f => ({ ...f, sort_order: e.target.value }))}
            style={{ ...input, width: '100%' }} />
        </FormRow>
      </div>
      <FormRow label="Description">
        <input value={form.description}
          onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
          style={input} placeholder="Optional" />
      </FormRow>
    </>
  )
}

function ZoneBlock({ zone, locations, ...editProps }) {
  const [open, setOpen] = useState(true)
  const directChildren = locations.filter(l => l.parent_id === zone.id)
  return (
    <div style={{ border: `1px solid ${P.border}`, borderRadius: 8, overflow: 'hidden' }}>
      <LocRow loc={zone} indent={0} open={open} hasKids={directChildren.length > 0}
        onToggleExpand={() => setOpen(o => !o)} {...editProps} locations={locations} />
      {open && directChildren.map(child => {
        const grandkids = locations.filter(l => l.parent_id === child.id)
        return (
          <div key={child.id}>
            <LocRow loc={child} indent={1} hasKids={false} {...editProps} locations={locations} />
            {grandkids.map(gc => {
              const positions = locations.filter(l => l.parent_id === gc.id)
              return (
                <div key={gc.id}>
                  <LocRow loc={gc} indent={2} hasKids={false} {...editProps} locations={locations} />
                  {positions.map(pos =>
                    <LocRow key={pos.id} loc={pos} indent={3} hasKids={false} {...editProps} locations={locations} />
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

function LocRow({
  loc, indent, open, hasKids, onToggleExpand,
  editId, editForm, setEditForm, editError, editSaving,
  onEditStart, onEditCancel, onUpdate, onDelete, confirmDeleteId,
  withPaths, locations, onToggleActive,
}) {
  const isZone    = indent === 0
  const isEditing = editId === loc.id

  function inferEditLevel() {
    if (!editForm.parent_id) return 0
    const parent = locations.find(l => l.id === editForm.parent_id)
    return parent ? Math.min(parent.level + 1, 3) : 0
  }

  if (isEditing) {
    return (
      <div style={{
        padding: 16,
        backgroundColor: P.greenPale,
        borderTop: isZone ? 'none' : `1px solid ${P.border}`,
      }}>
        <form onSubmit={onUpdate}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <span style={{ fontWeight: 700, color: P.dark, fontSize: '0.9rem' }}>Edit: {loc.name}</span>
            <button type="button" onClick={onEditCancel}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: P.mid, fontSize: '0.85rem' }}>
              ✕ Cancel
            </button>
          </div>
          {editError && <ErrBanner msg={editError} />}
          <LocationFields
            form={editForm} setForm={setEditForm} withPaths={withPaths}
            inferLevel={inferEditLevel} excludeId={loc.id}
          />
          <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="submit" disabled={editSaving}
              style={btn(editSaving ? P.light : P.green, '0.82rem')}>
              {editSaving ? 'Saving…' : 'Save changes'}
            </button>
            <button type="button" onClick={() => onDelete(loc.id)}
              style={btn(confirmDeleteId === loc.id ? P.terra : '#999', '0.82rem')}>
              {confirmDeleteId === loc.id ? 'Confirm delete?' : 'Delete'}
            </button>
            {confirmDeleteId === loc.id && (
              <span style={{ fontSize: '0.78rem', color: P.light }}>Sets deleted_at — removes from tree.</span>
            )}
          </div>
        </form>
      </div>
    )
  }

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
          <button onClick={onToggleExpand}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: P.mid, padding: 0, fontSize: '0.85rem', lineHeight: 1 }}>
            {open ? '▾' : '▸'}
          </button>
        )}
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: isZone ? 700 : 500, color: P.dark, fontSize: isZone ? '0.95rem' : '0.88rem' }}>
          {loc.name}
        </span>
        {loc.type_label && (
          <span style={{ fontSize: '0.7rem', color: P.mid, backgroundColor: P.border, borderRadius: 10, padding: '1px 7px' }}>
            {loc.type_label}
          </span>
        )}
        <span style={{ fontSize: '0.7rem', color: P.light }}>{LEVEL_LABELS[loc.level]}</span>
        {!loc.is_active && (
          <span style={{ fontSize: '0.7rem', color: P.light, backgroundColor: '#eee', borderRadius: 10, padding: '1px 7px' }}>
            inactive
          </span>
        )}
      </div>
      <span style={{ fontSize: '0.75rem', color: P.light, fontFamily: 'monospace', marginRight: 8, flexShrink: 0 }}>
        /{loc.slug}
      </span>
      <FavoriteToggle entityType="location" entityId={loc.id} />
      <button onClick={() => onEditStart(loc)}
        style={{ fontSize: '0.75rem', color: P.blue, background: 'none', border: `1px solid ${P.blue}`, borderRadius: 4, padding: '2px 9px', cursor: 'pointer', flexShrink: 0 }}>
        Edit
      </button>
      <button onClick={() => onToggleActive(loc)}
        style={{ fontSize: '0.75rem', color: loc.is_active ? P.terra : P.green, background: 'none', border: `1px solid ${loc.is_active ? P.alertBorder : P.greenLight}`, borderRadius: 4, padding: '2px 9px', cursor: 'pointer', flexShrink: 0 }}>
        {loc.is_active ? 'Deactivate' : 'Activate'}
      </button>
    </div>
  )
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: '100dvh', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 800, margin: '0 auto', padding: '32px 20px' }}>{children}</div>
    </div>
  )
}
function Spinner() { return <div style={{ padding: 48, textAlign: 'center', color: P.light }}>Loading…</div> }
function ErrMsg({ msg }) { return <div style={{ padding: 48, textAlign: 'center', color: P.terra }}>{msg}</div> }
function ErrBanner({ msg }) {
  return (
    <div style={{ backgroundColor: P.alert, border: `1px solid ${P.alertBorder}`, borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: '0.875rem', color: '#7a2a10' }}>
      {msg}
    </div>
  )
}
function Empty({ msg }) {
  return (
    <div style={{ textAlign: 'center', color: P.light, padding: '40px 20px', fontSize: '0.875rem', backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 8 }}>
      {msg}
    </div>
  )
}
function FormRow({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: P.mid, marginBottom: 5 }}>{label}</label>
      {children}
    </div>
  )
}

const btn = (bg, size = '0.88rem') => ({
  backgroundColor: bg, color: P.white, border: 'none', borderRadius: 6,
  padding: '9px 18px', fontSize: size, fontWeight: 600,
  cursor: bg === P.light ? 'not-allowed' : 'pointer',
})
const input = {
  width: '100%', padding: '8px 11px', border: `1px solid ${P.border}`,
  borderRadius: 6, fontSize: '0.88rem', backgroundColor: P.white, boxSizing: 'border-box',
}
const card = {
  backgroundColor: P.white, border: `1px solid ${P.border}`,
  borderRadius: 10, padding: 24, marginBottom: 24,
}
