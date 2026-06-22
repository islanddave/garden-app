// PlantingEditor — V3-IA: the add/edit/delete planting machinery folded out of the
// retired Plants page into the unified Garden page. Hosted by Garden.jsx, opened via
// /garden?add=1 (FAB create sheet), /garden?source_inventory_item_id=&variety_id=
// (InventoryDetail plant-from-packet), or /garden?edit=<plantingId> (PlantingDetail
// V3-EDIT-001 affordance). Owns the /api/plants wire contract previously in Plants.jsx:
// dual-write variety (variety_id canonical + flat text), COALESCE-merge PUT, '' -> null
// coercions for source/status, source_inventory_item_id passthrough on POST.
import React, { useState, useEffect } from 'react'
import { P } from '../lib/constants.js'
import { formatQty } from '../lib/format.js'
import ProjectOptions from './ProjectOptions.jsx'
import { PlantForm } from './forms'

const EMPTY_FORM = { name: '', variety: null, quantity: '1', notes: '', status: '', project_id: '', sown_at: '', sown_at_approx: false, qty_initial: '', source_type: '', source_ref: '', source_generation: '', lineage_note: '', parent_plant_id: '', container_type: '', container_size: '' }

function formFromPlant(plant) {
  return {
    name:     plant.name,
    variety:  plant.variety_ref ?? null,
    varietyText: plant.variety_ref?.name ?? '',
    quantity: formatQty(plant.quantity ?? 1),
    notes:    plant.notes ?? '',
    status:   plant.status ?? '',
    sown_at:           (plant.sown_at ?? '').slice(0, 10),
    sown_at_approx:    !!plant.sown_at_approx,
    qty_initial:       formatQty(plant.qty_initial),
    source_type:       plant.source_type ?? '',
    source_ref:        plant.source_ref ?? '',
    source_generation: plant.source_generation ?? '',
    lineage_note:      plant.lineage_note ?? '',
    parent_plant_id:   plant.parent_plant_id ?? '',
    container_type:    plant.container_type ?? '',
    container_size:    plant.container_size ?? '',
  }
}

export default function PlantingEditor({
  mode,                          // 'add' | 'edit'
  plant = null,                  // edit-mode target
  plants = [],
  projects = [],
  fetch,
  sourceInventoryItemId = null,  // add-mode packet deep-link
  varietyId = null,              // add-mode variety deep-link
  onCreated,
  onUpdated,
  onDeleted,
  onArchived,
  onClose,
}) {
  const isEdit = mode === 'edit'
  const [form, setForm] = useState(() => isEdit && plant
    ? formFromPlant(plant)
    : { ...EMPTY_FORM, project_id: projects[0]?.id ?? '' })
  const [saving,   setSaving]   = useState(false)
  const [err,      setErr]      = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [sourcePacket, setSourcePacket] = useState(null)

  useEffect(() => {
    if (isEdit) return
    let mounted = true
    if (sourceInventoryItemId) {
      fetch('/api/inventory-items/' + sourceInventoryItemId)
        .then(item => {
          if (!mounted || !item) return
          setSourcePacket(item)
          setForm(f => ({ ...f, name: f.name || item.name || '' }))
        })
        .catch(() => {})
    }
    if (varietyId) {
      fetch('/api/varieties/' + varietyId)
        .then(variety => {
          if (!mounted || !variety) return
          setForm(f => ({ ...f, variety }))
        })
        .catch(() => {})
    }
    return () => { mounted = false }
  }, [isEdit, sourceInventoryItemId, varietyId, fetch])

  async function handleAdd(e) {
    e.preventDefault()
    if (saving) return
    setSaving(true); setErr(null)
    const qty = parseInt(form.quantity, 10)
    const varietyText = form.variety?.name ?? null
    const payload = {
      project_id: form.project_id,
      name:       form.name.trim(),
      variety:    varietyText,
      variety_id: form.variety?.id ?? null,
      quantity:   isNaN(qty) || qty < 1 ? 1 : qty,
      notes:      form.notes.trim()    || null,
      status:     form.status          || null,
      sown_at:           form.sown_at || null,
      sown_at_approx:    !!form.sown_at_approx,
      qty_initial:       form.qty_initial.trim() ? parseInt(form.qty_initial, 10) : null,
      source_type:       form.source_type || null,
      source_ref:        form.source_ref.trim() || null,
      source_generation: form.source_generation.trim() || null,
      lineage_note:      form.lineage_note.trim() || null,
      parent_plant_id:   form.parent_plant_id || null,
      container_type:    form.container_type || null,
      container_size:    (form.container_size ?? '').trim() || null,
    }
    if (sourceInventoryItemId) payload.source_inventory_item_id = sourceInventoryItemId
    try {
      const data = await fetch('/api/plants', { method: 'POST', body: JSON.stringify(payload) })
      const proj = projects.find(p => p.id === form.project_id)
      onCreated?.({ ...data, project_name: data.project_name ?? proj?.name })
      onClose?.()
    } catch (error) {
      setErr(error.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleEdit(e) {
    e.preventDefault()
    if (saving) return
    setSaving(true); setErr(null)
    const qty = parseInt(form.quantity, 10)
    const varietyText = form.variety?.name ?? form.varietyText?.trim() ?? null
    try {
      const data = await fetch('/api/plants/' + plant.id, {
        method: 'PUT',
        body: JSON.stringify({
          name:       form.name.trim(),
          variety:    varietyText || null,
          variety_id: form.variety?.id ?? null,
          quantity:   isNaN(qty) || qty < 1 ? 1 : qty,
          notes:      form.notes.trim()    || null,
          status:     form.status          || null,
          sown_at:           form.sown_at || null,
          sown_at_approx:    !!form.sown_at_approx,
          qty_initial:       form.qty_initial.trim() ? parseInt(form.qty_initial, 10) : null,
          source_type:       form.source_type || null,
          source_ref:        form.source_ref.trim() || null,
          source_generation: form.source_generation.trim() || null,
          lineage_note:      form.lineage_note.trim() || null,
          parent_plant_id:   form.parent_plant_id || null,
          container_type:    form.container_type || null,
          container_size:    (form.container_size ?? '').trim() || null,
        }),
      })
      onUpdated?.({ ...data, project_name: data.project_name ?? plant.project_name })
      onClose?.()
    } catch (error) {
      setErr(error.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    setDeleting(true)
    try {
      await fetch('/api/plants/' + plant.id, { method: 'DELETE' })
      onDeleted?.(plant.id)
    } catch {
      // non-fatal
    } finally {
      setDeleting(false)
      onClose?.()
    }
  }

  // V3-ARCHIVE-001: archive = hidden-but-alive (distinct from Remove/delete). Passes the
  // planting up so Garden can offer an ambient Undo. Un-archive uses {archived:false}.
  async function handleArchive() {
    setArchiving(true)
    try {
      await fetch('/api/plants/' + plant.id + '/archive', {
        method: 'PATCH',
        body: JSON.stringify({ archived: true }),
      })
      onArchived?.(plant)
    } catch {
      // non-fatal
    } finally {
      setArchiving(false)
      onClose?.()
    }
  }

  return (
    <div id="planting-editor" style={{ backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 12, padding: '14px 16px', marginBottom: 20 }}>
      <div style={{ fontWeight: 600, marginBottom: 12, color: P.green }}>
        {isEdit ? `Edit ${plant?.name ?? 'planting'}` : 'Add planting'}
      </div>
      {!isEdit && sourcePacket && (
        <div style={{
          backgroundColor: P.greenPale, border: `1px solid ${P.green}`,
          borderRadius: 8, padding: '10px 12px', marginBottom: 12,
          fontSize: '0.85rem', color: P.dark, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        }}>
          <span>
            <span aria-hidden="true">🌱 </span>
            Planting from <strong>{sourcePacket.name}</strong>
          </span>
        </div>
      )}
      <PlantForm
        value={form}
        onChange={patch => setForm(f => ({ ...f, ...patch }))}
        onSubmit={isEdit ? handleEdit : handleAdd}
        submitting={saving}
        error={err}
        submitLabel={isEdit ? 'Save' : 'Add planting'}
        submittingLabel={isEdit ? 'Saving…' : 'Adding…'}
        onCancel={onClose}
        showProjectSelect={!isEdit}
        projectOptions={!isEdit ? <>{projects.length === 0 && <option value="">No projects yet</option>}<ProjectOptions projects={projects} /></> : null}
        plantingOptions={(isEdit ? plants.filter(p => p.id !== plant?.id) : plants).map(p => ({ id: p.id, name: p.name }))}
        detailsDefaultOpen={!isEdit}
        idPrefix={isEdit ? `edit-${plant?.id}` : 'add-plant'}
        extraActions={isEdit ? (
          <>
            <button type="button" disabled={archiving} onClick={handleArchive}
              style={{ marginLeft: 'auto', background: 'none', border: 'none', color: P.green, fontSize: '0.82rem', cursor: 'pointer' }}>
              {archiving ? 'Archiving…' : 'Archive'}
            </button>
            <button type="button" disabled={deleting} onClick={handleDelete}
              style={{ background: 'none', border: 'none', color: P.terra, fontSize: '0.82rem', cursor: 'pointer' }}>
              {deleting ? 'Removing…' : 'Remove'}
            </button>
          </>
        ) : null}
      />
    </div>
  )
}
