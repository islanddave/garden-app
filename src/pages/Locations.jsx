import React, { useState, useEffect, useCallback, useId } from 'react'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P, LOCATION_TYPE_LABELS } from '../lib/constants.js'
import { Field, Input, Select, Button, ErrorBanner } from '../components/forms'
import SharedEmptyState from '../components/forms/EmptyState.jsx'
import Icon from '../components/Icon.jsx'
import { clearPatch, SERVER_CLEARABLE } from '../lib/clearKeys.js'
import { useReportOverlayDirty } from '../context/OverlayContext.jsx'
import { setReloadBlocked } from '../lib/reloadGate.js'

const LEVEL_LABELS = ['Zone', 'Area', 'Section', 'Sub-Section']
const LEVEL_ACCENTS = [P.green, P.greenLight, P.gold, P.terra]

function slugify(str) {
  return str.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
function emptyCreateForm() {
  return { name: '', slug: '', type_label: '', parent_id: '', sort_order: '0', description: '' }
}

export default function Locations() {
  const { fetch } = useApiFetch()
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
    try {
      const [locs, paths] = await Promise.all([
        fetch('/api/locations'),
        fetch('/api/locations/with-path'),
      ])
      setLocations(Array.isArray(locs) ? locs : (locs?.locations ?? []))
      setWithPaths(Array.isArray(paths) ? paths : (paths?.locations_with_path ?? []))
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [fetch])

  useEffect(() => { load() }, [load])

  // V4-DIRTYGUARDSWEEP-001 — this page carries THREE independent forms that can all be open at once,
  // so the guard is their union. Each asks a different question, because each is seeded differently.
  //
  // The inline EDIT form is seeded from its row (LocationCard's onEdit below), so every field is
  // non-empty the instant it opens and truthiness is meaningless here. The only honest test is
  // "does it still match the row" — which also gives the right behaviour on a reverted edit: type,
  // undo, and the hold releases. Seed shape MUST mirror the setEditForm call that fills it; drift
  // between the two would read as permanently dirty.
  const editingLoc = editingId ? locations.find(l => l.id === editingId) : null
  const editDirty = !!editingLoc && (
    editForm.name        !== editingLoc.name ||
    editForm.type_label  !== (editingLoc.type_label || '') ||
    editForm.sort_order  !== String(editingLoc.sort_order ?? 0) ||
    editForm.description !== (editingLoc.description || '') ||
    // V4-COVEREDNOTMODELLED-001. Same `== null ? '' : String(...)` shape as the seed below, per this
    // block's own rule: drift between the two reads as permanently dirty. `== null` catches both
    // null and undefined, which matters because the GET omitted this column until this row shipped
    // and a cached client can still be holding a row that has no `covered` key at all.
    editForm.covered     !== (editingLoc.covered == null ? '' : String(editingLoc.covered))
  )

  // The two ADD forms start empty, so `name` is the whole of their typed content: `slug` is derived
  // from name by the same onChange (never typed independently), type_label/parent_id are Selects
  // (one tap to redo — counting a pick is the false positive this row exists to avoid), sort_order
  // seeds to '0', and neither add form renders a description input at all.
  const hasUnsavedInput = !!(
    (showAddForm && form.name.trim()) ||
    (addChildTo && addChildForm.name?.trim()) ||
    editDirty
  )

  useReportOverlayDirty(hasUnsavedInput)

  // /locations is not an overlayable route today, so the hook above is a strict no-op and the gate
  // below is what protects this page. Per-instance key + BOOLEAN dep per EventNew.jsx:985-991.
  const reloadGateKey = `locations:${useId()}`
  useEffect(() => {
    setReloadBlocked(reloadGateKey, hasUnsavedInput)
    return () => setReloadBlocked(reloadGateKey, false)
  }, [reloadGateKey, hasUnsavedInput])

  function inferLevel(parentId) {
    if (!parentId) return 0
    const parent = locations.find(l => l.id === parentId)
    return parent ? Math.min(parent.level + 1, 3) : 0
  }

  async function handleCreate(e) {
    e.preventDefault()
    setSaving(true); setFormError(null)
    const slug = form.slug.trim() || slugify(form.name.trim())
    try {
      await fetch('/api/locations', {
        method: 'POST',
        body: JSON.stringify({
          name:        form.name.trim(),
          slug,
          level:       inferLevel(form.parent_id),
          type_label:  form.type_label || null,
          parent_id:   form.parent_id  || null,
          sort_order:  parseInt(form.sort_order) || 0,
          description: form.description.trim() || null,
        }),
      })
      setForm(emptyCreateForm()); setShowAddForm(false); load()
    } catch (err) {
      const msg = err.message ?? ''
      setFormError(msg.includes('already exists') || msg.includes('duplicate') || msg.includes('23505')
        ? `Slug "${slug}" already exists. Try a different name.`
        : msg)
    } finally {
      setSaving(false)
    }
  }

  async function handleEdit(loc) {
    setOpError(null)
    try {
      await fetch('/api/locations/' + loc.id, {
        method: 'PUT',
        body: JSON.stringify({
          name:        editForm.name.trim(),
          slug:        loc.slug,
          level:       loc.level,
          parent_id:   loc.parent_id || null,
          type_label:  editForm.type_label || null,
          is_active:   loc.is_active,
          sort_order:  parseInt(editForm.sort_order) || 0,
          description: editForm.description.trim() || null,
          // V4-COVEREDNOTMODELLED-001. Tri-state carried through the form as a STRING, because a
          // <select> value is a string and '' is the only honest rendering of "not stated". Mapped
          // back to a real boolean here; '' sends null, which the server's COALESCE treats as absent
          // — so a location nobody has classified stays unclassified rather than being asserted
          // open-to-the-sky by the act of editing its name.
          covered:     editForm.covered === '' ? null : editForm.covered === 'true',
          // BUG-COALESCECLEAR-001. `|| null` above is the bug: the server binds these through
          // COALESCE, where null and absent are one token, so emptying the description box
          // returned 200 and kept the old text. `clear` is the only way to say NULL.
          //
          // ONLY `description` is on the server's allowlist, and `type_label` is deliberately NOT —
          // it is a care-engine input (the coverage derivation reads it), so clearing it would opt
          // up to 16 indoor plantings into every frost alert. The allowed filter below means that
          // even though this form renders a type_label box, emptying it is dropped here rather than
          // 400-ing the whole save. Emptying type_label therefore stays a no-op, deliberately and
          // consistently with the server.
          ...clearPatch(
            ['description', 'type_label'],
            editForm, loc, { allowed: SERVER_CLEARABLE.locations }),
        }),
      })
      setEditingId(null); load()
    } catch (err) {
      setOpError(err.message)
    }
  }

  async function handleDelete(loc) {
    setOpError(null)
    if (!window.confirm(`Delete "${loc.name}"?\n\nThis will also hide all child locations.`)) return
    try {
      await fetch('/api/locations/' + loc.id, { method: 'DELETE' })
    } catch (err) {
      // BUG-DELCLIENT-001 — a DELETE that matched no row is SUCCESS from the user's seat.
      // BUG-DELNOOPOK-001 changed this route from an unconditional {ok:true} to 404-when-nothing-
      // matched. apiFetch (src/lib/api.js:134-141) throws on every non-2xx and hangs the status on
      // e.status, so without this the "already gone" case — double-submit, retry after a network
      // blip, a second device, a stale list — would raise a red banner over an outcome the user
      // already has. The tolerance is DELIBERATE and scoped to 404 on this one DELETE; do not
      // widen it into apiFetch, which would mask genuine not-founds on GET/PUT app-wide.
      // Anything else (403, 500, timeout status 0, network) still surfaces exactly as before.
      if (err?.status !== 404) { setOpError(err.message); return }
    }
    // Runs on both paths on purpose: the refetch is what makes the vanished row leave the tree.
    load()
  }

  // PUT the collection route, not a /active sub-route: /api/locations/:id routes GET/PUT/DELETE
  // only and 405s everything else. The PUT SET-list is COALESCE(body.x, x) per column and
  // is_active is in it, so a body carrying only is_active flips it and preserves the rest — and a
  // boolean false survives COALESCE, so this works in both directions.
  async function toggleActive(loc) {
    setOpError(null)
    try {
      await fetch('/api/locations/' + loc.id, {
        method: 'PUT',
        body: JSON.stringify({ is_active: !loc.is_active }),
      })
      load()
    } catch (err) {
      setOpError(err.message)
    }
  }

  async function handleAddChild(parentLoc) {
    setOpError(null)
    const childLevel = Math.min(parentLoc.level + 1, 3)
    const slug = addChildForm.slug.trim() || slugify(addChildForm.name.trim())
    try {
      await fetch('/api/locations', {
        method: 'POST',
        body: JSON.stringify({
          name:        addChildForm.name.trim(),
          slug,
          level:       childLevel,
          type_label:  addChildForm.type_label || null,
          parent_id:   parentLoc.id,
          sort_order:  parseInt(addChildForm.sort_order) || 0,
          description: addChildForm.description?.trim() || null,
        }),
      })
      setAddChildTo(null); load()
    } catch (err) {
      setOpError(err.message)
    }
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
          style={{
            background: P.green, color: P.white, border: 'none', borderRadius: 6,
            padding: '9px 18px', fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer',
          }}
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
        <ErrorBanner style={{ marginBottom: 14 }}>{opError}</ErrorBanner>
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
              <Link to={`/locations/${loc.id}`} style={{
                fontWeight: loc.level === 0 ? 700 : 500,
                fontSize:   loc.level === 0 ? '0.96rem' : '0.89rem',
                color:      P.dark,
                wordBreak:  'break-word',
                textDecoration: 'none',
              }}>
                {loc.name}
              </Link>
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
                  setEditForm({ name: loc.name, type_label: loc.type_label || '', sort_order: String(loc.sort_order ?? 0), description: loc.description || '', covered: loc.covered == null ? '' : String(loc.covered) })
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
      <MenuBtn iconName="action.edit" label="Edit" onClick={onEdit} />
      {canAddChild && <MenuBtn iconName="nav.plus" label="Add child" onClick={onAddChild} />}
      {/* The glyph tracks the TARGET state, exactly as the emoji pair did — moon/dormant for the
          row that puts a zone to sleep, active for the one that wakes it. */}
      <MenuBtn
        iconName={loc.is_active ? 'status.dormant' : 'status.active'}
        label={loc.is_active ? 'Deactivate' : 'Activate'}
        onClick={onToggleActive}
      />
      <div style={{ height: 1, background: P.border }} />
      <MenuBtn iconName="action.remove" label="Delete" onClick={onDelete} danger />
    </div>
  )
}

// V4-ICON-001: `label` is now plain text and the glyph arrives as a registry key. The icon is
// decorative — the label is the accessible name of the menu item, and `danger` still tints BOTH
// (Icon draws in currentColor), so the destructive row is never signalled by hue alone.
function MenuBtn({ iconName, label, onClick, danger }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        width: '100%', textAlign: 'left',
        background: 'none', border: 'none', cursor: 'pointer',
        padding: '11px 16px', fontSize: '0.875rem',
        color: danger ? P.terra : P.dark,
        fontFamily: 'inherit',
      }}
    >
      <Icon name={iconName} size={18} decorative />
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
        <Field label="Name" htmlFor="inline-edit-name" required>
          <Input
            id="inline-edit-name"
            required
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="Location name"
            autoFocus
          />
        </Field>
        <Field label="Type" htmlFor="inline-edit-type">
          <Select
            id="inline-edit-type"
            value={form.type_label}
            onChange={e => setForm(f => ({ ...f, type_label: e.target.value }))}
            placeholder="— optional —"
            options={LOCATION_TYPE_LABELS}
          />
        </Field>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 9, marginBottom: 12 }}>
        <Field label="Sort order" htmlFor="inline-edit-sort">
          <Input
            id="inline-edit-sort"
            type="number"
            min="0"
            value={form.sort_order}
            onChange={e => setForm(f => ({ ...f, sort_order: e.target.value }))}
          />
        </Field>
        <Field label="Description" htmlFor="inline-edit-desc">
          <Input
            id="inline-edit-desc"
            value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            placeholder="Optional"
          />
        </Field>
      </div>
      {/* V4-COVEREDNOTMODELLED-001 — the rain-shelter flag the care engine reads.
          A SELECT and not a checkbox, because the value is a TRI-state: a checkbox can only render
          two of the three, and it would render "not stated" as unchecked — a positive claim that the
          bed is open to the sky, which is exactly the wrong thing to assert on a bed nobody has
          classified. Deliberately plain and unadorned: this is an operational property of a bed,
          not a reward surface.
          Edit-only, not on either ADD form. A location's cover is something Dave knows after he has
          built the bed, and adding a third decision to the create path to save one later tap is a bad
          trade — a new location's NULL resolves through the type_label heuristic exactly as it did
          before this row. */}
      <div style={{ marginBottom: 12 }}>
        <Field label="Rain shelter" htmlFor="inline-edit-covered">
          <Select
            id="inline-edit-covered"
            value={form.covered}
            onChange={e => setForm(f => ({ ...f, covered: e.target.value }))}
            placeholder="— not set —"
            options={[
              { value: 'true',  label: 'Under cover — rain does not reach it' },
              { value: 'false', label: 'Open to the sky — gets the rain' },
            ]}
          />
        </Field>
        <div style={{ fontSize: '0.71rem', color: P.light, marginTop: 4 }}>
          Under cover means watering never counts rainfall here — a low tunnel, a cold frame, a shelf indoors.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button
          type="button"
          variant="primary"
          disabled={!form.name.trim() || saving}
          loading={saving}
          loadingLabel="Saving…"
          onClick={async () => { if (!form.name.trim()) return; setSaving(true); await onSave(); setSaving(false) }}
        >
          Save
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
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
        <Field label="Name" htmlFor="add-child-name" required>
          <Input
            id="add-child-name"
            required
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value, slug: slugify(e.target.value) }))}
            placeholder={`${childLabel} name`}
            autoFocus
          />
        </Field>
        <Field label="Type" htmlFor="add-child-type">
          <Select
            id="add-child-type"
            value={form.type_label}
            onChange={e => setForm(f => ({ ...f, type_label: e.target.value }))}
            placeholder="— optional —"
            options={LOCATION_TYPE_LABELS}
          />
        </Field>
      </div>
      {form.slug && (
        <div style={{ fontSize: '0.71rem', color: P.light, fontFamily: 'monospace', marginBottom: 9 }}>
          Slug: /{form.slug}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button
          type="button"
          variant="primary"
          disabled={!form.name.trim() || saving}
          loading={saving}
          loadingLabel="Saving…"
          onClick={async () => { if (!form.name.trim()) return; setSaving(true); await onSave(); setSaving(false) }}
        >
          Add {childLabel}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
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
      <ErrorBanner style={{ marginBottom: 14 }}>{formError}</ErrorBanner>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <Field label="Name" htmlFor="add-loc-name" required>
          <Input
            id="add-loc-name"
            required
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value, slug: slugify(e.target.value) }))}
            placeholder="e.g. Indoor Rack"
          />
        </Field>
        <Field label="Type" htmlFor="add-loc-type">
          <Select
            id="add-loc-type"
            value={form.type_label}
            onChange={e => setForm(f => ({ ...f, type_label: e.target.value }))}
            placeholder="— optional —"
            options={LOCATION_TYPE_LABELS}
          />
        </Field>
      </div>
      <Field label="Parent" htmlFor="add-loc-parent" style={{ marginBottom: form.slug ? 0 : 12 }}>
        <Select
          id="add-loc-parent"
          value={form.parent_id}
          onChange={e => setForm(f => ({ ...f, parent_id: e.target.value }))}
          placeholder="— None (creates a Zone) —"
          options={withPaths.filter(l => l.level < 3 && l.is_active).map(l => ({ value: l.id, label: l.full_path }))}
        />
      </Field>
      {form.slug && (
        <div style={{ fontSize: '0.71rem', color: P.light, fontFamily: 'monospace', margin: '8px 0 12px' }}>
          Slug: /{form.slug}
        </div>
      )}
      <Button
        type="submit"
        variant="primary"
        disabled={!form.name.trim() || saving}
        loading={saving}
        loadingLabel="Creating…"
      >
        Create location
      </Button>
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

// V4-EMPTYSTATE-001: chrome from the shared primitive. Body-only — this page has no glyph and
// its one instruction ("use the form above") is not a title/body pair.
function EmptyState() {
  return (
    <SharedEmptyState body="No zones yet. Use the form above to add your first zone (e.g. Stable, Deck, Pasture, Steps, House), then add child areas under it." />
  )
}
