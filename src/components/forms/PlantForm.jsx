// src/components/forms/PlantForm.jsx
// Lane D / Phase E (E1) — unified create/edit plant form. UNION of the field-sets
// previously hand-rolled in ProjectDetail (add-plant) and Plants (add + edit):
// core (name / quantity / variety / notes) + status + an optional project picker +
// a collapsed "Planting details" block (sown date / initial qty / source / lineage).
//
// Presentational + controlled ONLY. The host page owns its submit handler and payload
// builder, so the /api/plants wire contract is unchanged (verified against the plants
// Lambda 2026-06-04: POST treats missing status as NULL; PUT is a COALESCE merge so a
// blank field is a no-op; qty_initial server-defaults to quantity; source_type '' must
// be coerced to null by the host or it 400s). Legacy genus/species free-text are
// intentionally DROPPED — the Lambda neither writes nor returns plants.genus/species;
// taxonomy lives on the linked variety (variety_id -> plant_varieties via VarietyPicker).
//
// Built on the Phase A primitives (Field/Input/Select/Textarea/Button/StatusSelect/
// ErrorBanner) + VarietyPicker, so all surfaces share one chrome + a11y wiring.
//
// Controlled contract:
//   value     object  — { name, quantity, variety, notes, status, project_id?,
//                         sown_at, sown_at_approx, qty_initial, source_type,
//                         source_ref, source_generation, lineage_note }
//   onChange  (patch) => void   — host merges: onChange={p => setForm(f => ({ ...f, ...p }))}
//   onSubmit  (e) => void       — host's existing submit handler (builds + sends payload)
//   submitting bool             — disables submit + swaps label
//   error     string|null       — submit/load error (operational, NOT a reward surface)
//   submitLabel / submittingLabel string
//   onCancel  () => void | undefined
//   showProjectSelect bool      — global create path; ProjectDetail injects project_id from route
//   projects  [{ id, name }]    — options when showProjectSelect
//   idPrefix  string            — unique id namespace (Plants edit renders one PlantForm per row)
//   detailsDefaultOpen bool     — open the planting-details disclosure initially (default false)
import React from 'react'
import { Field, Input, Select, Textarea, Button, StatusSelect, ErrorBanner } from './index.js'
import VarietyPicker from '../VarietyPicker.jsx'

// Mirrors the plants Lambda ALLOWED_SOURCE enum verbatim (empty -> "not specified";
// host coerces '' -> null before sending so the != null validation passes).
export const PLANT_SOURCE_OPTIONS = [
  { value: '', label: '— Not specified —' },
  { value: 'seed_packet', label: 'Seed packet' },
  { value: 'nursery_transplant', label: 'Bought as transplant' },
  { value: 'division', label: 'Divided from another plant' },
  { value: 'volunteer', label: 'Volunteer / self-sown' },
  { value: 'gift', label: 'Gift' },
  { value: 'saved_seed', label: 'Saved seed' },
  { value: 'cutting_taken', label: 'Cutting taken' },
  { value: 'rescued', label: 'Rescued' },
  { value: 'unknown', label: 'Not sure' },
]

export default function PlantForm({
  value,
  onChange,
  onSubmit,
  submitting = false,
  error = null,
  submitLabel = 'Save',
  submittingLabel,
  onCancel,
  showProjectSelect = false,
  projects = [],
  plantingOptions = [],    // V3-LINEAGE-001: [{id,name}] candidate source plantings; picker hidden when empty
  projectOptions = null,   // optional <option> children (e.g. hierarchical <ProjectOptions/>); overrides flat `projects`
  extraActions = null,     // optional node appended to the button row (e.g. a Remove button on edit)
  idPrefix = 'plant',
  detailsDefaultOpen = false,
}) {
  const v = value
  const set = (patch) => onChange(patch)
  const pid = idPrefix

  return (
    <form onSubmit={onSubmit}>
      <ErrorBanner>{error}</ErrorBanner>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14, marginBottom: 14 }}>
        <Field label="Name" htmlFor={`${pid}-name`} required>
          <Input id={`${pid}-name`} required value={v.name}
            onChange={e => set({ name: e.target.value })}
            placeholder={'e.g. "Megatron Jalapeno" or "Serrano seedlings"'} />
        </Field>
        <Field label="Quantity" htmlFor={`${pid}-qty`}>
          <Input id={`${pid}-qty`} type="number" min="1" value={v.quantity}
            onChange={e => set({ quantity: e.target.value })} />
        </Field>
      </div>

      {showProjectSelect && (
        <Field label="Project" htmlFor={`${pid}-project`} required style={{ marginBottom: 14 }}>
          {projectOptions
            ? (
              <Select id={`${pid}-project`} required value={v.project_id ?? ''}
                onChange={e => set({ project_id: e.target.value })}>
                {projectOptions}
              </Select>
            ) : (
              <Select id={`${pid}-project`} required value={v.project_id ?? ''}
                onChange={e => set({ project_id: e.target.value })}
                placeholder="— Select a project —"
                options={projects.map(p => ({ value: p.id, label: p.name }))} />
            )}
        </Field>
      )}

      <Field label="Variety" htmlFor={`${pid}-variety`} optional style={{ marginBottom: 14 }}>
        <VarietyPicker
          id={`${pid}-variety`}
          value={v.variety}
          onChange={(variety) => set({ variety })}
          placeholder="Search or create a variety…"
        />
      </Field>

      <Field label="Status" htmlFor={`${pid}-status`} optional style={{ marginBottom: 14 }}>
        <StatusSelect id={`${pid}-status`} kind="plant" value={v.status ?? ''}
          onChange={e => set({ status: e.target.value })} />
      </Field>

      <Field label="Notes" htmlFor={`${pid}-notes`} optional style={{ marginBottom: 14 }}>
        <Input id={`${pid}-notes`} value={v.notes}
          onChange={e => set({ notes: e.target.value })}
          placeholder="Anything distinctive about this plant or group" />
      </Field>

      <details data-testid="planting-details" open={detailsDefaultOpen} style={{ marginBottom: 14 }}>
        <summary style={{ cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600, padding: '6px 0' }}>
          Planting details — optional
        </summary>
        <div style={{ paddingTop: 10, display: 'grid', gap: 14 }}>
          <div>
            <Field label="Sown date" htmlFor={`${pid}-sown`} optional>
              <Input id={`${pid}-sown`} type="date" value={v.sown_at}
                onChange={e => set({ sown_at: e.target.value })} />
            </Field>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: '0.78rem', cursor: 'pointer' }}>
              <input type="checkbox" checked={!!v.sown_at_approx}
                onChange={e => set({ sown_at_approx: e.target.checked })}
                data-testid="sown-at-approx" style={{ width: 14, height: 14, cursor: 'pointer' }} />
              Approximate date
            </label>
          </div>

          <Field label="Initial quantity" htmlFor={`${pid}-qtyinit`} optional
            help="Defaults to the quantity above.">
            <Input id={`${pid}-qtyinit`} type="number" min="1" value={v.qty_initial}
              onChange={e => set({ qty_initial: e.target.value })}
              placeholder="defaults to quantity above" />
          </Field>

          <Field label="Source" htmlFor={`${pid}-source`} optional>
            <Select id={`${pid}-source`} value={v.source_type ?? ''}
              onChange={e => set({ source_type: e.target.value })}
              options={PLANT_SOURCE_OPTIONS} />
          </Field>

          <Field label="Source reference" htmlFor={`${pid}-sref`} optional>
            <Input id={`${pid}-sref`} value={v.source_ref}
              onChange={e => set({ source_ref: e.target.value })}
              placeholder="e.g. Johnny's Lot 4421" />
          </Field>

          <Field label="Generation" htmlFor={`${pid}-sgen`} optional>
            <Input id={`${pid}-sgen`} value={v.source_generation}
              onChange={e => set({ source_generation: e.target.value })}
              placeholder="e.g. F2, third gen saved" />
          </Field>

          <Field label="Lineage note" htmlFor={`${pid}-lin`} optional>
            <Textarea id={`${pid}-lin`} rows={2} value={v.lineage_note}
              onChange={e => set({ lineage_note: e.target.value })}
              placeholder="e.g. Dave's Glass Gem F4 selection" />
          </Field>

          {/* V3-LINEAGE-001: link this planting to the source planting it was cloned/cut from.
              Optional; rendered only when candidate plantings are supplied. The parent_plant_id
              write path already exists in lambda/plants (POST+PUT). */}
          {plantingOptions.length > 0 && (
            <Field label="Source planting" htmlFor={`${pid}-parent`} optional>
              <Select id={`${pid}-parent`} value={v.parent_plant_id ?? ''}
                onChange={e => set({ parent_plant_id: e.target.value || null })}
                options={[{ value: '', label: '— None —' }, ...plantingOptions.map(p => ({ value: p.id, label: p.name }))]} />
            </Field>
          )}
        </div>
      </details>

      <div style={{ display: 'flex', gap: 12, paddingTop: 14 }}>
        <Button type="submit" variant="primary" loading={submitting}
          loadingLabel={submittingLabel ?? 'Saving…'}>
          {submitLabel}
        </Button>
        {onCancel && <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>}
        {extraActions}
      </div>
    </form>
  )
}
