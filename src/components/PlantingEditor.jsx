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
import { PROJECTS_HIDDEN } from '../lib/featureFlags.js'
import { clearPatch, SERVER_CLEARABLE } from '../lib/clearKeys.js'

// BUG-COALESCECLEAR-001 — the keys PlantForm RENDERS an input for. This is the render manifest, and
// it is deliberately the full rendered set rather than the clearable subset: `clearPatch` filters it
// against the server allowlist itself, so the two lists stay honest independently. Adding a field to
// PlantForm and forgetting it here means that field silently keeps the old no-op behaviour; adding
// one here that PlantForm does not render is what the helper's safety rule forbids, because a form
// must never be able to NULL a column it does not show. Kept next to formFromPlant, whose keys it
// mirrors exactly.
//
// Seven of these (name, variety, varietyText, quantity, status, container_type, location_id) are NOT
// on the plants allowlist and are dropped client-side rather than sent — status and container_type
// because clearing them changes a watering or protection recommendation (validate.js tier 2), and
// location_id because it belongs to BUG-NOLOCOUTDOOR-001's own sentinel, not this channel.
const PLANT_FORM_FIELDS = [
  'name', 'variety', 'varietyText', 'quantity', 'notes', 'status',
  'sown_at', 'sown_at_approx', 'qty_initial',
  'source_type', 'source_ref', 'source_generation', 'lineage_note',
  'parent_plant_id', 'container_type', 'container_size', 'location_id',
]

const EMPTY_FORM = { name: '', variety: null, quantity: '1', notes: '', status: '', project_id: '', sown_at: '', sown_at_approx: false, qty_initial: '', source_type: '', source_ref: '', source_generation: '', lineage_note: '', parent_plant_id: '', container_type: '', container_size: '', location_id: '' }

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
    location_id:       plant.location_id ?? '',
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
  addDefaults = null,            // add-mode: field seeds merged over EMPTY_FORM (e.g. { status:'seed', sown_at, source_type:'seed_packet' } from the Sow flow); null = none
  onCreated,
  onUpdated,
  onDeleted,
  onArchived,
  onClose,
}) {
  const isEdit = mode === 'edit'
  const [form, setForm] = useState(() => isEdit && plant
    ? formFromPlant(plant)
    : { ...EMPTY_FORM, project_id: projects[0]?.id ?? '', ...(addDefaults ?? {}) })
  const [saving,   setSaving]   = useState(false)
  const [err,      setErr]      = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [sourcePacket, setSourcePacket] = useState(null)
  const [locations, setLocations] = useState([])

  useEffect(() => {
    let mounted = true
    fetch('/api/locations/with-path')
      .then(locs => { if (mounted) setLocations((locs ?? []).filter(l => l.is_active)) })
      .catch(() => {})
    return () => { mounted = false }
  }, [fetch])

  useEffect(() => {
    if (isEdit) return
    let mounted = true
    if (sourceInventoryItemId) {
      fetch('/api/inventory-items/' + sourceInventoryItemId)
        .then(item => {
          if (!mounted || !item) return
          setSourcePacket(item)
          // V4-SOWSOURCE-001: carry the packet's provenance onto the planting. Clean vendor/brand
          // -> source_ref; acquisition/haul (source, minus internal-note cruft after ';') + purchase
          // date -> a notes line. Fills EMPTY fields ONLY — never overwrites what the user typed.
          // Full detail always stays linked via source_inventory_item_id regardless.
          const vendor = item.metadata?.vendor || item.brand || ''
          const haul = String(item.source || '').split(';')[0].trim()
          const pdate = item.purchase_date ? String(item.purchase_date).slice(0, 10) : ''
          const haulLine = haul ? `Seed source: ${haul}${pdate ? ` (purchased ${pdate})` : ''}` : ''
          setForm(f => ({
            ...f,
            name: f.name || item.name || '',
            source_ref: f.source_ref || vendor || haul || '',
            notes: f.notes || haulLine || '',
          }))
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
      location_id:       form.location_id || null,
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
          location_id:       form.location_id || null,
          // Every `|| null` above is indistinguishable from "field not supplied" once it reaches the
          // handler's COALESCE, so an emptied box has always saved as a silent no-op. `clear` is the
          // only way to say NULL. Spread LAST and only when non-empty, so a save with nothing to
          // clear stays byte-identical to one from before this channel existed.
          ...clearPatch(PLANT_FORM_FIELDS, form, plant, { allowed: SERVER_CLEARABLE.plants }),
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
    } catch (error) {
      // BUG-DELCLIENT-001 — 404 = no row matched = already gone, which is what the user wanted.
      // BUG-DELNOOPOK-001 put a RETURNING gate on this route and apiFetch (src/lib/api.js:134-141)
      // throws on any non-2xx with the code on e.status. Without this branch, a re-delete would
      // skip onDeleted and leave the planting sitting in Garden's list even though the server has
      // none — the editor closes below regardless, so the stale row would look like a failed close.
      // Deliberate, 404-only, at this call site only; apiFetch must keep throwing 404s for GET/PUT.
      if (error?.status === 404) onDeleted?.(plant.id)
      // Anything else stays non-fatal exactly as before: no onDeleted, onClose() still fires.
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
        locations={locations}
        onSubmit={isEdit ? handleEdit : handleAdd}
        submitting={saving}
        error={err}
        submitLabel={isEdit ? 'Save' : 'Add planting'}
        submittingLabel={isEdit ? 'Saving…' : 'Adding…'}
        onCancel={onClose}
        /* V4-PROJHIDE-001: hide the project chooser when projects aren't user-facing. project_id still
           defaults to projects[0]?.id (see initial form state) so the add POST satisfies the FK with no
           visible project step. Flag OFF passes the exact prior !isEdit values (byte-identical). */
        showProjectSelect={PROJECTS_HIDDEN ? false : !isEdit}
        projectOptions={PROJECTS_HIDDEN ? null : (!isEdit ? <>{projects.length === 0 && <option value="">No projects yet</option>}<ProjectOptions projects={projects} /></> : null)}
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
