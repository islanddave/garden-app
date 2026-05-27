// Plants page — VARIETY-REF Session 4b: VarietyPicker integration + Plant-from-packet flow.
// - Replaces freeform variety text input with VarietyPicker (search/create from plant_varieties).
// - Reads ?source_inventory_item_id and ?variety_id query params (deep-link from InventoryDetail).
// - Submits variety_id (canonical) AND legacy flat variety text (Lambda dual-read compat per S2).
// - Schema columns confirmed present in prod 2026-05-13 (variety_id, source_inventory_item_id, metadata).
import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { getStatusColors } from '../lib/status.js'
import { formatQty } from '../lib/format.js'
import FavoriteToggle from '../components/FavoriteToggle.jsx'
import VarietyPicker from '../components/VarietyPicker.jsx'
import PhotoUpload from '../components/PhotoUpload.jsx'

const PLANT_STATUSES = ['seed', 'seedling', 'vegetative', 'flowering', 'fruiting', 'harvested', 'dormant', 'ended', 'failed']

function ErrBanner({ msg }) {
  return <div role="alert" style={{ padding: '10px 14px', backgroundColor: P.alert, color: P.terra, borderRadius: 8, fontSize: '0.85rem', marginBottom: 12 }}>{msg}</div>
}

export default function Plants() {
  const { fetch } = useApiFetch()
  const [searchParams, setSearchParams] = useSearchParams()
  const sourceInventoryItemId = searchParams.get('source_inventory_item_id') || null
  const queryVarietyId        = searchParams.get('variety_id') || null

  const [plants,     setPlants]     = useState([])
  const [projects,   setProjects]   = useState([])
  const [loading,    setLoading]    = useState(true)
  const [showAdd,    setShowAdd]    = useState(false)
  // form.variety holds the full variety object (or null); form.varietyText is the legacy flat string
  // captured at submission time for dual-read compat.
  const [form,       setForm]       = useState({ name: '', genus: '', species: '', variety: null, quantity: '1', notes: '', status: '', project_id: '' })
  const [saving,     setSaving]     = useState(false)
  const [err,        setErr]        = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [editForm,   setEditForm]   = useState(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editErr,    setEditErr]    = useState(null)
  const [deleting,   setDeleting]   = useState(null)
  const [showRenameNote, setShowRenameNote] = useState(() => { try { return localStorage.getItem('plantings-rename-note-dismissed') !== '1' } catch (e) { return false } })

  // Source-packet preview (when deep-linked from InventoryDetail).
  const [sourcePacket, setSourcePacket] = useState(null)
  // Track whether the user has manually changed variety after a pre-fill (so we know to clear the lock).
  const prefilledVarietyIdRef = useRef(null)

  useEffect(() => {
    let mounted = true
    Promise.all([
      fetch('/api/plants'),
      fetch('/api/projects'),
    ]).then(([plantsData, projData]) => {
      if (!mounted) return
      setPlants(plantsData ?? [])
      setProjects(projData ?? [])
      if (projData?.length) setForm(f => ({ ...f, project_id: projData[0].id }))
      setLoading(false)
    }).catch(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [fetch])

  // V1.2a-3 surface #4 fix: after a per-plant photo upload, refetch the plants list so the
  // new featured_photo_view_url (server-side auto-promote populated plants.featured_photo_id +
  // plants Lambda enrichment signs the S3 GET URL) flows into local state and the thumbnail
  // renders without a page reload. Cheap full refetch — list is small for foreseeable scale.
  const refetchPlants = useCallback(async () => {
    try {
      const fresh = await fetch('/api/plants')
      setPlants(fresh ?? [])
    } catch {
      /* non-fatal — stale list heals on next page mount */
    }
  }, [fetch])

  // Deep-link side effects: query params → open Add form, prefill variety + name from source packet.
  useEffect(() => {
    let mounted = true
    if (!sourceInventoryItemId && !queryVarietyId) return
    setShowAdd(true)
    if (sourceInventoryItemId) {
      fetch('/api/inventory-items/' + sourceInventoryItemId)
        .then(item => {
          if (!mounted || !item) return
          setSourcePacket(item)
          setForm(f => ({
            ...f,
            // Pre-fill name from packet name if user hasn't typed anything yet.
            name: f.name || item.name || '',
          }))
        })
        .catch(() => { /* non-fatal — packet preview just won't render */ })
    }
    if (queryVarietyId) {
      // Fetch the variety so VarietyPicker can render its chip. Avoid creating a fake stub
      // because the chip displays species/common_name fields.
      fetch('/api/varieties/' + queryVarietyId)
        .then(variety => {
          if (!mounted || !variety) return
          prefilledVarietyIdRef.current = variety.id
          setForm(f => ({ ...f, variety }))
        })
        .catch(() => { /* non-fatal */ })
    }
    return () => { mounted = false }
  }, [sourceInventoryItemId, queryVarietyId, fetch])

  // +LOG FAB create-sheet entry: /plants?add=1 opens the Add Planting form, then strips
  // the param (replace, no history entry) so a subsequent ?add=1 — even from the same
  // screen — is a real location change and re-triggers the open. Distinct from the
  // source_inventory_item_id / variety_id deep-link prefill above.
  useEffect(() => {
    if (searchParams.get('add') === '1') {
      setShowAdd(true)
      const next = new URLSearchParams(searchParams)
      next.delete('add')
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, setSearchParams])

  function clearQueryParams() {
    if (sourceInventoryItemId || queryVarietyId) {
      const next = new URLSearchParams(searchParams)
      next.delete('source_inventory_item_id')
      next.delete('variety_id')
      setSearchParams(next, { replace: true })
    }
    setSourcePacket(null)
    prefilledVarietyIdRef.current = null
  }

  async function handleAdd(e) {
    e.preventDefault()
    if (saving) return // guard against double-submit
    setSaving(true); setErr(null)
    const qty = parseInt(form.quantity, 10)
    // Dual-write: variety_id (canonical) + variety text (legacy flat, derived from picker selection).
    const varietyText = form.variety?.name ?? null
    const payload = {
      project_id: form.project_id,
      name:       form.name.trim(),
      genus:      form.genus.trim()    || form.variety?.genus   || null,
      species:    form.species.trim()  || form.variety?.species || null,
      variety:    varietyText,
      variety_id: form.variety?.id ?? null,
      quantity:   isNaN(qty) || qty < 1 ? 1 : qty,
      notes:      form.notes.trim()    || null,
      status:     form.status          || null,
    }
    if (sourceInventoryItemId) payload.source_inventory_item_id = sourceInventoryItemId
    try {
      const data = await fetch('/api/plants', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      // POST returns raw row without project_name JOIN — merge client-side
      const proj = projects.find(p => p.id === form.project_id)
      setPlants(p => [{ ...data, project_name: data.project_name ?? proj?.name }, ...p])
      setForm(f => ({ ...f, name: '', genus: '', species: '', variety: null, quantity: '1', notes: '', status: '' }))
      setShowAdd(false)
      clearQueryParams()
    } catch (error) {
      setErr(error.message)
    } finally {
      setSaving(false)
    }
  }

  function startEdit(plant) {
    setExpandedId(plant.id)
    // Pre-fill variety chip from plant.variety_ref (Lambda LEFT JOIN). Fallback: null
    // (legacy plants will keep their flat variety text in the locked-out path until manual change).
    setEditForm({
      name:     plant.name,
      genus:    plant.variety_ref?.genus ?? '',
      species:  plant.variety_ref?.species ?? '',
      variety:  plant.variety_ref ?? null,
      varietyText: plant.variety_ref?.name ?? '',
      quantity: String(plant.quantity ?? 1),
      notes:    plant.notes ?? '',
      status:   plant.status ?? '',
    })
    setEditErr(null)
  }

  function closeEdit() { setExpandedId(null); setEditForm(null) }

  async function handleEdit(e, id) {
    e.preventDefault()
    if (editSaving) return // guard against double-submit
    setEditSaving(true); setEditErr(null)
    const qty = parseInt(editForm.quantity, 10)
    const varietyText = editForm.variety?.name ?? editForm.varietyText?.trim() ?? null
    try {
      const data = await fetch('/api/plants/' + id, {
        method: 'PUT',
        body: JSON.stringify({
          name:       editForm.name.trim(),
          genus:      editForm.genus.trim()    || editForm.variety?.genus   || null,
          species:    editForm.species.trim()  || editForm.variety?.species || null,
          variety:    varietyText || null,
          variety_id: editForm.variety?.id ?? null,
          quantity:   isNaN(qty) || qty < 1 ? 1 : qty,
          notes:      editForm.notes.trim()    || null,
          status:     editForm.status          || null,
        }),
      })
      // PUT returns raw row without project_name — preserve existing
      setPlants(p => p.map(pl => pl.id === id ? { ...data, project_name: data.project_name ?? pl.project_name } : pl))
      closeEdit()
    } catch (error) {
      setEditErr(error.message)
    } finally {
      setEditSaving(false)
    }
  }

  async function handleDelete(id) {
    setDeleting(id)
    try {
      await fetch('/api/plants/' + id, { method: 'DELETE' })
      setPlants(p => p.filter(pl => pl.id !== id))
    } catch {
      // non-fatal
    } finally {
      setDeleting(null); closeEdit()
    }
  }

  const bdr  = `1px solid ${P.border}`
  const card = { backgroundColor: P.white, border: bdr, borderRadius: 12, padding: '14px 16px', marginBottom: 10 }
  const inp  = { width: '100%', padding: '9px 12px', border: bdr, borderRadius: 8, fontSize: '0.92rem', backgroundColor: P.white, boxSizing: 'border-box', color: P.dark }
  const pBtn = dis => ({ padding: '10px 20px', backgroundColor: dis ? P.greenLight : P.green, color: '#fff', border: 'none', borderRadius: 8, fontSize: '0.9rem', fontWeight: 600, cursor: dis ? 'not-allowed' : 'pointer' })
  const gBtn = { padding: '9px 16px', backgroundColor: 'transparent', color: P.mid, border: bdr, borderRadius: 8, fontSize: '0.9rem', cursor: 'pointer' }
  const lbl  = { fontSize: '0.8rem', color: P.mid, display: 'block', marginBottom: 4 }

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '16px 16px 32px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem', color: P.dark }}>🌿 Plantings</h1>
        <button onClick={() => { setShowAdd(v => !v); setErr(null) }}
          style={showAdd ? gBtn : { ...pBtn(false), fontSize: '0.85rem', padding: '8px 14px' }}>
          {showAdd ? 'Cancel' : '+ New Planting'}
        </button>
      </div>

      {showRenameNote && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, backgroundColor: P.greenPale, border: `1px solid ${P.green}`, borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: '0.85rem', color: P.dark }}>
          <span>{"We're calling these "}<strong>Plantings</strong>{" now — more coming."}</span>
          <button type="button" aria-label="Dismiss" onClick={() => { setShowRenameNote(false); try { localStorage.setItem('plantings-rename-note-dismissed', '1') } catch (e) {} }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: P.mid, fontSize: '1.1rem', lineHeight: 1, padding: '0 4px' }}>×</button>
        </div>
      )}

      {showAdd && (
        <form onSubmit={handleAdd} style={{ ...card, marginBottom: 20 }}>
          <div style={{ fontWeight: 600, marginBottom: 12, color: P.green }}>Add planting</div>
          {sourcePacket && (
            <div style={{
              backgroundColor: P.greenPale, border: `1px solid ${P.green}`,
              borderRadius: 8, padding: '10px 12px', marginBottom: 12,
              fontSize: '0.85rem', color: P.dark, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
            }}>
              <span>
                <span aria-hidden="true">🌱 </span>
                Planting from <strong>{sourcePacket.name}</strong>
              </span>
              <button type="button" onClick={clearQueryParams}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: P.mid, fontSize: '0.78rem', textDecoration: 'underline', padding: 0 }}>
                Clear
              </button>
            </div>
          )}
          {err && <ErrBanner msg={err} />}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="plant-name" style={lbl}>Name *</label>
              <input id="plant-name" required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Tomato" style={inp} />
            </div>
            <div>
              <label htmlFor="plant-genus" style={lbl}>Genus</label>
              <input id="plant-genus" value={form.genus} onChange={e => setForm(f => ({ ...f, genus: e.target.value }))} placeholder="e.g. Solanum" style={inp} />
            </div>
            <div>
              <label htmlFor="plant-species" style={lbl}>Species</label>
              <input id="plant-species" value={form.species} onChange={e => setForm(f => ({ ...f, species: e.target.value }))} placeholder="e.g. lycopersicum" style={inp} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="plant-variety" style={lbl}>Variety</label>
              <VarietyPicker
                id="plant-variety"
                value={form.variety}
                onChange={(variety) => setForm(f => ({ ...f, variety }))}
                placeholder="Search or create a variety…"
              />
              <div style={{ marginTop: 4, fontSize: '0.72rem', color: P.light }}>
                Optional — link a variety to enable care/maturity hints.
              </div>
            </div>
            <div>
              <label htmlFor="plant-quantity" style={lbl}>Quantity</label>
              <input id="plant-quantity" type="number" min="1" value={form.quantity} onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))} style={inp} />
            </div>
            <div>
              <label htmlFor="plant-status" style={lbl}>Status</label>
              <select id="plant-status" value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} style={inp}>
                <option value="">— none —</option>
                {PLANT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="plant-project" style={lbl}>Project *</label>
              <select id="plant-project" required value={form.project_id} onChange={e => setForm(f => ({ ...f, project_id: e.target.value }))} style={inp}>
                {projects.length === 0 && <option value="">No projects yet</option>}
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="plant-notes" style={lbl}>Notes</label>
              <input id="plant-notes" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional" style={inp} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="submit" disabled={saving} style={pBtn(saving)}>{saving ? 'Adding…' : 'Add planting'}</button>
            <button type="button" onClick={() => { setShowAdd(false); clearQueryParams() }} style={gBtn}>Cancel</button>
          </div>
        </form>
      )}

      {loading ? (
        <p style={{ color: P.light, textAlign: 'center', marginTop: 40 }}>Loading…</p>
      ) : plants.length === 0 ? (
        <p style={{ color: P.light, textAlign: 'center', marginTop: 40 }}>No plantings yet — add one above.</p>
      ) : plants.map(plant => (
        <div key={plant.id} style={card}>
          {/* I9 fix (2026-05-18, V1.2a-3 Increment C / PR-C2): alignItems 'flex-start' → 'center'
              so the camera + Edit buttons stay vertically centered against the content block,
              not pinned to the top. This stops the layout from "shifting" when a plant name
              wraps to two lines. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            {/* V1.2a-3 Increment A (I2a-display): the plant's featured photo. The
                photo→plant linkage + auto-promote already worked; this is the
                read-back surface that was missing — a photo uploaded to a plant
                now actually shows on the plant. Conditional render = no layout
                shift when a plant has no photo yet. */}
            {plant.featured_photo_view_url && (
              <img
                src={plant.featured_photo_view_url}
                alt={`${plant.name} photo`}
                loading="lazy"
                style={{ width: 44, height: 44, borderRadius: 8, objectFit: 'cover',
                         flexShrink: 0, border: `1px solid ${P.border}` }}
              />
            )}
            <div style={{ flex: 1 }}>
              {/* I7 + I9 fix (2026-05-18): use the unified status-color map so the badge
                  matches Dashboard / ProjectList / ProjectDetail. flexWrap is kept (long plant
                  names get a clean wrap to a new line), but action buttons on the outer row
                  now center-align so the camera button doesn't appear to shift. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, color: P.dark }}>🌿 {plant.name}</span>
                {plant.quantity > 1 && <span style={{ fontSize: '0.78rem', color: P.green, fontWeight: 600 }}>×{formatQty(plant.quantity)}</span>}
                {plant.status && (() => {
                  const sc = getStatusColors(plant.status)
                  return (
                    <span style={{
                      fontSize: '0.72rem',
                      backgroundColor: sc.bg, color: sc.text,
                      border: `1px solid ${sc.border}`,
                      padding: '2px 8px', borderRadius: 20,
                    }}>{plant.status}</span>
                  )
                })()}
                <FavoriteToggle entityType="plant" entityId={plant.id} />
              </div>
              {(plant.variety_ref?.genus || plant.variety_ref?.species) && (
                <div style={{ fontSize: '0.78rem', color: P.light, marginTop: 2, fontStyle: 'italic' }}>
                  {[plant.variety_ref?.genus, plant.variety_ref?.species].filter(Boolean).join(' ')}
                </div>
              )}
              {plant.variety_ref?.name && (
                <div style={{ fontSize: '0.8rem', color: P.light, marginTop: 2 }}>
                  {plant.variety_ref.name}
                </div>
              )}
              <div style={{ fontSize: '0.75rem', marginTop: 4 }}>
                <Link to={`/projects/${plant.project_id}`} style={{ color: P.green, textDecoration: 'none' }}>
                  {plant.project_name ?? 'Project'}
                </Link>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {/* V2-PHOTO-F1 S2: per-plant photo trigger. Compact icon-only button keeps
                  row layout tight; <PhotoUpload> handles the file picker + 3-step upload. */}
              <PhotoUpload
                keyPrefix="plants"
                parentId={plant.id}
                linkage={{ plant_id: plant.id, project_id: plant.project_id }}
                errorMode="surface"
                buttonLabel="📷"
                showPreview={false}
                inputId={`plant-list-photo-${plant.id}`}
                onUploadComplete={refetchPlants}
                buttonStyle={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 34, height: 34, padding: 0,
                  background: 'transparent', color: P.mid,
                  border: `1px solid ${P.border}`, borderRadius: '50%',
                  cursor: 'pointer', fontSize: '0.9rem', userSelect: 'none',
                }}
              />
              <button onClick={() => expandedId === plant.id ? closeEdit() : startEdit(plant)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: P.light, fontSize: '0.82rem', padding: '4px 8px', whiteSpace: 'nowrap' }}>
                {expandedId === plant.id ? 'Close' : 'Edit'}
              </button>
            </div>
          </div>

          {expandedId === plant.id && editForm && (
            <form onSubmit={e => handleEdit(e, plant.id)} style={{ marginTop: 14, paddingTop: 14, borderTop: bdr }}>
              {editErr && <ErrBanner msg={editErr} />}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label htmlFor="plant-edit-name" style={lbl}>Name *</label>
                  <input id="plant-edit-name" required value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} style={inp} />
                </div>
                <div>
                  <label htmlFor="plant-edit-genus" style={lbl}>Genus</label>
                  <input id="plant-edit-genus" value={editForm.genus} onChange={e => setEditForm(f => ({ ...f, genus: e.target.value }))} placeholder="e.g. Solanum" style={inp} />
                </div>
                <div>
                  <label htmlFor="plant-edit-species" style={lbl}>Species</label>
                  <input id="plant-edit-species" value={editForm.species} onChange={e => setEditForm(f => ({ ...f, species: e.target.value }))} placeholder="e.g. lycopersicum" style={inp} />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label htmlFor="plant-edit-variety" style={lbl}>Variety</label>
                  <VarietyPicker
                    id="plant-edit-variety"
                    value={editForm.variety}
                    onChange={(variety) => setEditForm(f => ({ ...f, variety }))}
                    placeholder="Search or create a variety…"
                  />
                </div>
                <div>
                  <label htmlFor="plant-edit-qty" style={lbl}>Qty</label>
                  <input id="plant-edit-qty" type="number" min="1" value={editForm.quantity} onChange={e => setEditForm(f => ({ ...f, quantity: e.target.value }))} style={inp} />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label htmlFor="plant-edit-status" style={lbl}>Status</label>
                  <select id="plant-edit-status" value={editForm.status} onChange={e => setEditForm(f => ({ ...f, status: e.target.value }))} style={inp}>
                    <option value="">— none —</option>
                    {PLANT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label htmlFor="plant-edit-notes" style={lbl}>Notes</label>
                  <input id="plant-edit-notes" value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))} style={inp} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button type="submit" disabled={editSaving} style={pBtn(editSaving)}>{editSaving ? 'Saving…' : 'Save'}</button>
                <button type="button" onClick={closeEdit} style={gBtn}>Cancel</button>
                <button type="button" disabled={deleting === plant.id} onClick={() => handleDelete(plant.id)}
                  style={{ marginLeft: 'auto', background: 'none', border: 'none', color: P.terra, fontSize: '0.82rem', cursor: 'pointer' }}>
                  {deleting === plant.id ? 'Removing…' : 'Remove'}
                </button>
              </div>
            </form>
          )}
        </div>
      ))}
    </div>
  )
}
