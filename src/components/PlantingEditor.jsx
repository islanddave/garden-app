// PlantingEditor — V3-IA: the add/edit/delete planting machinery folded out of the
// retired Plants page into the unified Garden page. Hosted by Garden.jsx, opened via
// /garden?add=1 (FAB create sheet), /garden?source_inventory_item_id=&variety_id=
// (InventoryDetail plant-from-packet), or /garden?edit=<plantingId> (PlantingDetail
// V3-EDIT-001 affordance). Owns the /api/plants wire contract previously in Plants.jsx:
// dual-write variety (variety_id canonical + flat text), COALESCE-merge PUT, '' -> null
// coercions for source/status, source_inventory_item_id passthrough on POST.
import React, { useState, useEffect, useRef } from 'react'
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

// BUG-SILENTFAILSWEEP-001 — one line per verb, each naming the state the planting is actually LEFT
// in. Not interchangeable: a failed Remove leaves a live planting in the garden, a failed Archive
// leaves it visible in the garden it was being put away from, and telling someone the wrong one
// sends them to the wrong list to check. Fixed copy rather than the raw error.message handleAdd/
// handleEdit surface, because these two are reached from a button, not a submitted form — the
// server's phrasing describes the request, not what the person is now looking at.
const PLANT_DELETE_FAILED_COPY  = "Couldn't remove this planting — it's still in your garden."
const PLANT_ARCHIVE_FAILED_COPY = "Couldn't archive this planting — it's still active."

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
  onDirty,                       // V4-PLANTEDITORDIRTY-001: (bool) => void, fires on every clean↔dirty flip
  onBusy,                        // V4-SHEETBUSY-001: (bool) => void, fires on every idle↔write-in-flight flip
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

  // V4-PLANTEDITORDIRTY-001 — every other callback on this component is lifecycle-COMPLETION
  // (onCreated/onDeleted/…), so a host could learn the editor had finished but never that it was
  // mid-edit. SowNow's stash records only WHICH packet is being sown for exactly that reason, and
  // everything typed in here dies on an exit the reload gate would otherwise have deferred. This is
  // the continuous signal that lets a host join the 3-piece dirty contract (EventNew.jsx:950-991).
  //
  // Latched off PlantForm's onChange, which is the ONLY user-input path into `form`: PlantForm's
  // `set` is called from DOM change handlers and VarietyPicker selection alone, never on mount.
  // The two prefill effects below also setForm, and they deliberately do NOT latch — a packet or
  // variety deep-link seeding fields the user never touched is not unsaved work, and counting it
  // would hold a deploy for anyone who merely opened /garden?source_inventory_item_id=…
  //
  // A latch, not a differs-from-seed diff: it can only over-report, and for a data-loss guard
  // over-reporting costs a deferred update while under-reporting costs the user's typing. Typing a
  // character and deleting it therefore still reads dirty, which is the safe direction.
  const [dirty, setDirty] = useState(false)

  // Reported through a ref rather than straight from the effect deps because this is a shared
  // component and a host may well pass an inline arrow, whose identity changes every render. With
  // `onDirty` in the deps the cleanup would fire onDirty(false) on EVERY render — and a release is
  // not inert: it NOTIFIES reloadGate's listeners, which is what registerSW reloads on.
  const onDirtyRef = useRef(onDirty)
  useEffect(() => { onDirtyRef.current = onDirty })
  useEffect(() => { onDirtyRef.current?.(dirty) }, [dirty])
  // Unmount is the ordinary close path here (hosts render this conditionally), so without a release
  // a Cancel would strand the host holding the gate with no form left to resolve it.
  useEffect(() => () => { onDirtyRef.current?.(false) }, [])

  // V4-SHEETBUSY-001 — the second continuous signal, and the one `dirty` cannot stand in for. A host
  // that renders this editor inside a <Sheet> passes this to `busy`, which is what makes
  // decideDismiss/decideBack return BLOCKED (dismissLayers.js:81, backNav.js:102) rather than
  // discarding a surface with a write already on the wire.
  //
  // `dirty` genuinely does not cover it. Dirty gates the BACKDROP TAP ONLY (Sheet.jsx:168);
  // `confirmOnDirty` is still false at both registry call sites (DismissRegistry.jsx:126,228)
  // pending the ConfirmSheet primitive, so Escape and Android Back close a saving form outright.
  // The cost is not cosmetic: onClose unmounts this component, so on the FAILURE path setErr has
  // nothing left to render and the user is told nothing about a save that did not happen.
  //
  // ALL THREE in-flight writes, not `saving` alone — delete and archive are equally on the wire and
  // delete is the destructive one, so blocking mid-save but not mid-delete would be incoherent.
  // Each clears in a `finally`, and the unmount release below is the backstop, so busy cannot stick
  // (a stuck busy would trap Escape; Back is separately bounded by MAX_CONSECUTIVE_BLOCKS).
  const busy = saving || deleting || archiving
  const onBusyRef = useRef(onBusy)
  useEffect(() => { onBusyRef.current = onBusy })
  useEffect(() => { onBusyRef.current?.(busy) }, [busy])
  useEffect(() => () => { onBusyRef.current?.(false) }, [])

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
      setDirty(false)   // saved — nothing left for a reload to destroy, even if the host keeps us mounted
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
      setDirty(false)   // saved — see handleAdd
      onUpdated?.({ ...data, project_name: data.project_name ?? plant.project_name })
      onClose?.()
    } catch (error) {
      setErr(error.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    setDeleting(true); setErr(null)
    try {
      await fetch('/api/plants/' + plant.id, { method: 'DELETE' })
      onDeleted?.(plant.id)
      onClose?.()
    } catch (error) {
      // BUG-DELCLIENT-001 — 404 = no row matched = already gone, which is what the user wanted.
      // BUG-DELNOOPOK-001 put a RETURNING gate on this route and apiFetch (src/lib/api.js:134-141)
      // throws on any non-2xx with the code on e.status. Without this branch, a re-delete would
      // skip onDeleted and leave the planting sitting in Garden's list even though the server has
      // none — the editor closes below regardless, so the stale row would look like a failed close.
      // Deliberate, 404-only, at this call site only; apiFetch must keep throwing 404s for GET/PUT.
      if (error?.status === 404) { onDeleted?.(plant.id); onClose?.() }
      // BUG-SILENTFAILSWEEP-001 — anything else now stays HERE with the reason on screen. onClose
      // used to fire from `finally`, so a failed Remove closed the editor exactly like a successful
      // one and the only tell was the planting still sitting in the list. The close moved onto the
      // two success arms rather than setErr being bolted next to it, because onClose UNMOUNTS this
      // component (see the V4-SHEETBUSY-001 note above) — an error set on the way out has nothing
      // left to render. Same `err` -> PlantForm ErrorBanner slot handleAdd/handleEdit already use.
      else setErr(PLANT_DELETE_FAILED_COPY)
    } finally {
      setDeleting(false)
    }
  }

  // V3-ARCHIVE-001: archive = hidden-but-alive (distinct from Remove/delete). Passes the
  // planting up so Garden can offer an ambient Undo. Un-archive uses {archived:false}.
  async function handleArchive() {
    setArchiving(true); setErr(null)
    try {
      await fetch('/api/plants/' + plant.id + '/archive', {
        method: 'PATCH',
        body: JSON.stringify({ archived: true }),
      })
      onArchived?.(plant)
      onClose?.()
    } catch {
      // BUG-SILENTFAILSWEEP-001 — the forward leg of the same PATCH PlantingDetail's handleArchive
      // already calls must-be-audible. Success also fires onArchived, so Garden drops the row and
      // raises the Undo strip; failure did neither, and the editor closed regardless, leaving the
      // planting in the list looking untouched. Stays open with the reason instead — see the close
      // note in handleDelete for why onClose moved onto the success arm.
      setErr(PLANT_ARCHIVE_FAILED_COPY)
    } finally {
      setArchiving(false)
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
        onChange={patch => { setForm(f => ({ ...f, ...patch })); setDirty(true) }}
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
