import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'
import { P, LOCATION_TYPE_LABELS } from '../lib/constants.js'

const LEVEL_LABELS = ['Zone', 'Area', 'Section', 'Sub-Section']
const LEVEL_ACCENTS = [P.green, P.greenLight, P.gold, P.terra]

function slugify(str) {
  return str.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
function emptyCreateForm() {
  return { name: '', slug: '', type_label: '', parent_id: '', sort_order: '0', description: '' }
}

export default function Locations() {
  const [locations,    setLocations]    = useState([])
  const [withPaths,    setWithPaths]    = useState([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState(null)
  const [showAddForm,  setShowAddForm]  = useState(false)
  const [form,         setForm]         = useState(emptyCreateForm())
  const [saving,       setSaving]       = useState(false)
  const [formError,    setFormError]    = useState(null)
  const [menuOpenId,   setMenuOpenId]   = useState(null)
  const [editingId,    setEditingId]    = useState(null)
  const [editForm,     setEditForm]     = useState({})
  const [addChildTo,   setAddChildTo]   = useState(null)
  const [addChildForm, setAddChildForm] = useState({})
  const [opError,      setOpError]      = useState(null)

  useEffect(() => {
    if (!menuOpenId) return
    const close = () => setMenuOpenId(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuOpenId])

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

  function inferLevel(parentId) {
    if (!parentId) return 0
    const parent = locations.find(l => l.id === parentId)
    return parent ? Math.min(parent.level + 1, 3) : 0
  }

  async function handleCreate(e) {
    e.preventDefault()
    setSaving(true); setFormError(null)
    const slug = form.slug.trim() || slugify(form.name.trim())
    const { error } = await supabase.from('locations').insert({
      name:        form.name.trim(),
      slug,
      level:       inferLevel(form.parent_id),
      type_label:  form.type_label || null,
      parent_id:   form.parent_id  || null,
      sort_order:  parseInt(form.sort_order) || 0,
      description: form.description.trim() || null,
    })
    setSaving(false)
    if (error) {
      setFormError(error.code === '23505'
        ? `Slug "${slug}" already exists. Try a different name.`
        : error.message)
    } else {
      setForm(emptyCreateForm()); setShowAddForm(false); load()
    }
  }

  async function handleEdit(loc) {
    setOpError(null)
    const { error } = await supabase.from('locations').update({
      name:        editForm.name.trim(),
      type_label:  editForm.type_label || null,
      sort_order:  parseInt(editForm.sort_order) || 0,
      description: editForm.description.trim() || null,
    }).eq('id', loc.id)
    if (error) { setOpError(error.message); return }
    setEditingId(null); load()
  }

  async function handleDelete(loc) {
    setOpError(null)
    if (!window.confirm(`Delete "${loc.name}"?\n\nThis will also hide all child locations.`)) return
    const { error } = await supabase.from('locations').update({ deleted_at: new Date().toISOString() }).eq('id', loc.id)
    if (error) setOpError(error.message)
    else load()
  }

  async function toggleActive(loc) {
    await supabase.from('locations').update({ is_active: !loc.is_active }).eq('id', loc.id)
    load()
  }

  async function handleAddChild(parentLoc) {
    setOpError(null)
    const childLevel = Math.min(parentLoc.level + 1, 3)
    const slug = addChildForm.slug.trim() || slugify(addChildForm.name.trim())
    const { error } = await supabase.from('locations').insert({
      name:        addChildForm.name.trim(),
      slug,
      level:       childLevel,
      type_label:  addChildForm.type_label || null,
      parent_id:   parentLoc.id,
      sort_order:  parseInt(addChildForm.sort_order) || 0,
      description: addChildForm.description.trim() || null,
    })
    if (error) { setOpError(error.message); return }
    setAddChildTo(null); load()
  }

  const shared = {
    locations, withPaths,
    menuOpenId, setMenuOpenId,
    editingId, setEditingId, editForm, setEditForm,
    addChildTo, setAddChildTo, addChildForm, setAddChildForm,
    onEdit: handleEdit,
    onDelete: handleDelete,
    onToggleActive: toggleActive,
    onAddChild: handleAddChild,
  }

  const roots = locations.filter(l => l.level === 0)

  if (loading) return <Shell><div style={{ padding: 48, textAlign: 'center', color: P.light }}>Loading…</div></Shell>
  if (error)   return <Shell><div style={{ padding: 48, textAlign: 'center', color: P.terra }}>{error}</div></Shell>

  return (
    <Shell>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <div>
          <h1 style={{ margin: 0, color: P.green, fontSize: '1.25rem', fontWeight: 700 }}>Locations</h1>
          <p style={{ margin: '3px 0 0', color: P.light, fontSize: '0.78rem' }}>
            Zone → Area → Section → Sub-Section
          </p>
        </div>
        <button
          onClick={() => { setShowAddForm(s => !s); setFormError(null); setForm(emptyCreateForm()) }}
          style={btnStyle(P.green)}
        >
          {showAddForm ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {/* Add location form */}
      {showAddForm && (
        <AddLocationForm
          form={form} setForm={setForm}
          withPaths={withPaths}
          levelLabel={LEVEL_LABELS[Math.min(inferLevel(form.parent_id), 3)]}
          saving={saving} formError={formError}
          onSubmit={handleCreate}
        />
      )}

      {/* Global op error */}
      {opError && (
        <div style={{ background: P.alert, border: `1px solid ${P.alertBorder}`, borderRadius: 6, padding: '10px 14px', marginBottom: 14, fontSize: '0.84rem', color: '#7a2a10' }}>
          {opError}
        </div>
      )}

      {/* Tree */}
      {roots.length === 0 ? (
        <EmptyState />
      ) : (
        <div>
          {roots.map(root => (
            <LocationTree key={root.id} loc={root} depth={0} {...shared} />
          ))}
        </div>
      )}
    </Shell>
  )
}

// ---- Recursive tree ----
function LocationTree({ loc, depth, ...shared }) {
  const children = shared.locations.filter(l => l.parent_id === loc.id)
  return (
    <div style={{ marginBottom: depth === 0 ? 10 : 0 }}>
      <LocationCard loc={loc} depth={depth} hasChildren={children.length > 0} {...shared} />
      {children.length > 0 && (
        <div style={{ marginLeft: 14, borderLeft: `2px solid ${P.border}`, paddingLeft: 6, marginTop: 4, marginBottom: 4 }}>
          {children.map(child => (
            <LocationTree key={child.id} loc={child} depth={depth + 1} {...shared} />
          ))}
        </div>
      )}
    </div>
  )
}

// ---- Location card ----
function LocationCard({ loc, depth, hasChildren,
  locations, withPaths,
  menuOpenId, setMenuOpenId,
  editingId, setEditingId, editForm, setEditForm,
  addChildTo, setAddChildTo, addChildForm, setAddChildForm,
  onEdit, onDelete, onToggleActive, onAddChild,
}) {
  const isEditing     = editingId === loc.id
  const isMenuOpen    = menuOpenId === loc.id
  const isAddingChild = addChildTo === loc.id
  const levelIdx      = Math.min(loc.level, 3)
  const accent        = LEVEL_ACCENTS[levelIdx]
  const levelLabel    = LEVEL_LABELS[levelIdx]
  const bgColor       = !loc.is_active ? '#f9f7f5' : loc.level === 0 ? P.greenPale : P.white

  return (
    <div style={{ marginTop: depth > 0 ? 6 : 0 }}>
      {/* Card */}
      <div style={{
        background:   bgColor,
        border:       `1px solid ${P.border}`,
        borderLeft:   `4px solid ${accent}`,
        borderRadius: 8,
        padding:      '11px 12px',
        opacity:      loc.is_active ? 1 : 0.65,
        position:     'relative',
      }}>
        {/* Top row: name + badges + menu */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Name + type badge + inactive badge */}
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5 }}>
              <span style={{
                fontWeight: loc.level === 0 ? 700 : 500,
                fontSize:   loc.level === 0 ? '0.96rem' : '0.89rem',
                color:      P.dark,
                wordBreak:  'break-word',
              }}>
                {loc.name}
              </span>
              {loc.type_label && (
                <span style={{ fontSize: '0.67rem', background: P.border, color: P.mid, borderRadius: 10, padding: '2px 7px', flexShrink: 0 }}>
                  {loc.type_label}
                </span>
              )}
              {!loc.is_active && (
                <span style={{ fontSize: '0.67rem', background: '#e8e8e8', color: P.light, borderRadius: 10, padding: '2px 7px', flexShrink: 0 }}>
                  inactive
                </span>
              )}
            </div>
            {/* Level + slug */}
            <div style={{ fontSize: '0.71rem', color: P.light, fontFamily: 'monospace', marginTop: 3 }}>
              {levelLabel} · /{loc.slug}
            </div>
          </div>

          {/* ••• menu */}
          <div style={{ position: 'relative', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
            <button
              onClick={() => setMenuOpenId(isMenuOpen ? null : loc.id)}
              aria-label="Actions"
              style={{
                background: 'none', border: '1px solid transparent', borderRadius: 5,
                cursor: 'pointer', color: P.mid, padding: '4px 8px', fontSize: '1rem', lineHeight: 1,
                minWidth: 36, minHeight: 36,
              }}
            >
              •••
            </button>
            {isMenuOpen && (
              <ActionMenu
                loc={loc}
                canAddChild={loc.level < 3}
                onEdit={() => {
                  setEditingId(loc.id)
                  setEditForm({ name: loc.name, type_label: loc.type_label || '', sort_order: String(loc.sort_order ?? 0), description: loc.description || '' })
                  setMenuOpenId(null)
                }}
                onAddChild={() => {
                  setAddChildTo(loc.id)
                  setAddChildForm({ name: '', slug: '', type_label: '', sort_order: '0', description: '' })
                  setMenuOpenId(null)
                }}
                onToggleActive={() => { onToggleActive(loc); setMenuOpenId(null) }}
                onDelete={() => { onDelete(loc); setMenuOpenId(null) }}
              />
            )}
          </div>
        </div>

        {/* Inline edit form */}
        {isEditing && (
          <InlineEditForm
            form={editForm}
            setForm={setEditForm}
            onSave={() => onEdit(loc)}
            onCancel={() => setEditingId(null)}
          />
        )}
      </div>

      {/* Add child form */}
      {isAddingChild && (
        <div style={{ marginLeft: 18, marginTop: 5 }}>
          <AddChildForm
            parentLoc={loc}
            form={addChildForm}
            setForm={setAddChildForm}
            onSave={() => onAddChild(loc)}
            onCancel={() => setAddChildTo(null)}
          />
        </div>
      )}
    </div>
  )
}

// ---- Action menu ----
function ActionMenu({ loc, canAddChild, onEdit, onAddChild, onToggleActive, onDelete }) {
  return (
    <div style={{
      position: 'absolute', right: 0, top: '110%', zIndex: 200,
      background: P.white, border: `1px solid ${P.border}`,
      borderRadius: 8, boxShadow: '0 4px 20px rgba(0,0,0,0.14)',
      minWidth: 160, overflow: 'hidden',
    }}>
      <MenuBtn label="✏️  Edit"      onClick={onEdit} />
      {canAddChild && <MenuBtn label="➕  Add child" onClick={onAddChild} />}
      <MenuBtn label={loc.is_active ? '🌙  Deactivate' : '✅  Activate'} onClick={onToggleActive} />
      <div style={{ height: 1, background: P.border }} />
      <MenuBtn label="🗑  Delete" onClick={onDelete} danger />
    </div>
  )
}

function MenuBtn({ label, onClick, danger }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        background: 'none', border: 'none', cursor: 'pointer',
        padding: '11px 16px', fontSize: '0.875rem',
        color: danger ? P.terra : P.dark,
        fontFamily: 'inherit',
      }}
    >
      {label}
    </button>
  )
}

// ---- Inline edit form ----
function InlineEditForm({ form, setForm, onSave, onCancel }) {
  const [saving, setSaving] = useState(false)
  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${P.border}` }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9, marginBottom: 9 }}>
        <Field label="Name *">
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            style={inputSt} placeholder="Location name" autoFocus />
        </Field>
        <Field label="Type">
          <select value={form.type_label} onChange={e => setForm(f => ({ ...f, type_label: e.target.value }))} style={inputSt}>
            <option value="">— optional —</option>
            {LOCATION_TYPE_LABELS.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 9, marginBottom: 12 }}>
        <Field label="Sort order">
          <input type="number" min="0" value={form.sort_order}
            onChange={e => setForm(f => ({ ...f, sort_order: e.target.value }))} style={inputSt} />
        </Field>
        <Field label="Description">
          <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            style={inputSt} placeholder="Optional" />
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={async () => { if (!form.name.trim()) return; setSaving(true); await onSave(); setSaving(false) }}
          disabled={!form.name.trim() || saving}
          style={btnStyle(saving || !form.name.trim() ? P.light : P.green, '0.82rem')}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={onCancel} style={btnStyle('#888', '0.82rem')}>Cancel</button>
      </div>
    </div>
  )
}

// ---- Add child form ----
function AddChildForm({ parentLoc, form, setForm, onSave, onCancel }) {
  const [saving, setSaving] = useState(false)
  const childLevel = Math.min(parentLoc.level + 1, 3)
  const childLabel = LEVEL_LABELS[childLevel]
  return (
    <div style={{ background: P.white, border: `1px solid ${P.border}`, borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ fontSize: '0.79rem', fontWeight: 600, color: P.mid, marginBottom: 10 }}>
        New {childLabel} under <em style={{ color: P.dark }}>{parentLoc.name}</em>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9, marginBottom: 9 }}>
        <Field label="Name *">
          <input
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value, slug: slugify(e.target.value) }))}
            style={inputSt} placeholder={`${childLabel} name`} autoFocus
          />
        </Field>
        <Field label="Type">
          <select value={form.type_label} onChange={e => setForm(f => ({ ...f, type_label: e.target.value }))} style={inputSt}>
            <option value="">— optional —</option>
            {LOCATION_TYPE_LABELS.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
      </div>
      {form.slug && (
        <div style={{ fontSize: '0.71rem', color: P.light, fontFamily: 'monospace', marginBottom: 9 }}>
          Slug: /{form.slug}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={async () => { if (!form.name.trim()) return; setSaving(true); await onSave(); setSaving(false) }}
          disabled={!form.name.trim() || saving}
          style={btnStyle(saving || !form.name.trim() ? P.light : P.green, '0.82rem')}
        >
          {saving ? 'Saving…' : `Add ${childLabel}`}
        </button>
        <button onClick={onCancel} style={btnStyle('#888', '0.82rem')}>Cancel</button>
      </div>
    </div>
  )
}

// ---- Top-level add form ----
function AddLocationForm({ form, setForm, withPaths, levelLabel, saving, formError, onSubmit }) {
  return (
    <form onSubmit={onSubmit} style={{ background: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: '18px 16px', marginBottom: 18 }}>
      <h2 style={{ margin: '0 0 14px', fontSize: '0.92rem', fontWeight: 700, color: P.dark }}>
        Add location — will be: <span style={{ color: P.green }}>{levelLabel}</span>
      </h2>
      {formError && <ErrBanner msg={formError} />}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <Field label="Name *">
          <input
            required value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value, slug: slugify(e.target.value) }))}
            style={inputSt} placeholder="e.g. Indoor Rack"
          />
        </Field>
        <Field label="Type">
          <select value={form.type_label} onChange={e => setForm(f => ({ ...f, type_label: e.target.value }))} style={inputSt}>
            <option value="">— optional —</option>
            {LOCATION_TYPE_LABELS.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Parent">
        <select value={form.parent_id} onChange={e => setForm(f => ({ ...f, parent_id: e.target.value }))} style={inputSt}>
          <option value="">— None (creates a Zone) —</option>
          {withPaths.filter(l => l.level < 3 && l.is_active).map(l => (
            <option key={l.id} value={l.id}>{l.full_path}</option>
          ))}
        </select>
      </Field>
      {form.slug && (
        <div style={{ fontSize: '0.71rem', color: P.light, fontFamily: 'monospace', margin: '8px 0 12px' }}>
          Slug: /{form.slug}
        </div>
      )}
      <button type="submit" disabled={!form.name.trim() || saving} style={btnStyle(saving || !form.name.trim() ? P.light : P.green)}>
        {saving ? 'Creating…' : 'Create location'}
      </button>
    </form>
  )
}

// ---- Shared UI ----
function Shell({ children }) {
  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '24px 14px 88px' }}>
        {children}
      </div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: '0.74rem', fontWeight: 600, color: P.mid, marginBottom: 4 }}>
        {label}
      </label>
      {children}
    </div>
  )
}

function ErrBanner({ msg }) {
  return (
    <div style={{ background: P.alert, border: `1px solid ${P.alertBorder}`, borderRadius: 6, padding: '10px 14px', marginBottom: 14, fontSize: '0.84rem', color: '#7a2a10' }}>
      {msg}
    </div>
  )
}

function EmptyState() {
  return (
    <div style={{ textAlign: 'center', color: P.light, padding: '40px 16px', fontSize: '0.875rem', background: P.white, border: `1px solid ${P.border}`, borderRadius: 8 }}>
      No zones yet. Run the seed SQL in Supabase to create initial zones (Stable, Deck, Pasture, Steps, House), then add child areas here.
    </div>
  )
}

const inputSt = {
  width: '100%', padding: '8px 10px', border: `1px solid ${P.border}`,
  borderRadius: 6, fontSize: '0.875rem', background: P.white,
  boxSizing: 'border-box', fontFamily: 'inherit',
}

const btnStyle = (bg, size = '0.875rem') => ({
  background: bg, color: P.white, border: 'none', borderRadius: 6,
  padding: '9px 18px', fontSize: size, fontWeight: 600,
  cursor: (bg === P.light || bg === '#888') ? 'not-allowed' : 'pointer',
})
