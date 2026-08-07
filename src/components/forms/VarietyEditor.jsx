// VarietyEditor — V4-EDITCOMPLETE-001 V3: the variety edit surface that did not exist.
//
// Before this, `plant_varieties` was reachable only through VarietyPicker's CREATE path, which
// writes name / species / crop_type_slug / lifecycle and then never offers them again — so a
// mistyped variety name, or a variety filed under the wrong crop type (and therefore missing from
// every type-grouped view), was permanent across 408 live cultivars. `useVarieties.updateVariety`
// had been complete and callerless since VARIETY-REF Session 2.
//
// Per Dave's global rule this exposes ALL 31 user-owned columns the PUT can write, not just the 4
// the create path happens to set. Deliberately absent: photo_id (needs the photo-picker surface,
// a different lane) and dtm_basis (no read path or consumer yet — V4-MATURITYBASIS-001).
//
// The PUT is owner-only (created_by = JWT.sub). `currentUserId` gates the form into a read-only
// state rather than letting the user type a save that will 404 — 26 of the live rows are owned by
// intake/system subs no human can edit.

import React, { useMemo, useState } from 'react'
import { P } from '../../lib/constants.js'
import { Field, Input, Select, Textarea, Button, ErrorBanner } from './index.js'

// Mirrors the CHECK constraints on plant_varieties (verified against live Neon, not migrations).
// Duplicated rather than imported because src/ must not reach into lambda/; the server re-validates,
// so drift here is a 400, never a bad row — the same contract VarietyPicker's LIFECYCLE_OPTIONS uses.
const LIFECYCLE = [
  ['annual', 'Annual'], ['tender_perennial', 'Tender perennial'],
  ['perennial', 'Perennial'], ['biennial', 'Biennial'],
]
const SUN = [
  ['full_sun', 'Full sun'], ['part_sun', 'Part sun'],
  ['part_shade', 'Part shade'], ['full_shade', 'Full shade'],
]
const DETERMINACY = [
  ['determinate', 'Determinate'], ['semi_determinate', 'Semi-determinate'],
  ['indeterminate', 'Indeterminate'], ['dwarf', 'Dwarf'],
]
const DAY_LENGTH = [
  ['long_day', 'Long day'], ['short_day', 'Short day'],
  ['day_neutral', 'Day neutral'], ['intermediate', 'Intermediate'],
]
const START_METHOD = [
  ['start_indoors', 'Start indoors'], ['direct_sow', 'Direct sow'],
  ['both', 'Both'], ['indoors_only', 'Indoors only'],
]
const SOW_SEASON = [['cool', 'Cool'], ['warm', 'Warm'], ['cool_warm', 'Cool or warm']]

// The field table IS the contract: it drives rendering, the form seed, and the payload build, so a
// field cannot be displayed without also being saved (the failure mode called out in 5b430f4).
// kind: text | area | int | num | enum | bool | csv.  `name` is intentionally not clearable.
export const FIELDS = [
  { key: 'species',                kind: 'text', label: 'Species',            section: 'identity', placeholder: 'e.g. Capsicum annuum' },
  { key: 'genus',                  kind: 'text', label: 'Genus',              section: 'identity' },
  { key: 'lifecycle',              kind: 'enum', label: 'Lifecycle',          section: 'identity', options: LIFECYCLE },

  { key: 'days_to_maturity_min',   kind: 'int',  label: 'Days to maturity — min', section: 'maturity' },
  { key: 'days_to_maturity_max',   kind: 'int',  label: 'Days to maturity — max', section: 'maturity' },
  { key: 'expected_yield_notes',   kind: 'area', label: 'Expected yield',     section: 'maturity' },

  { key: 'sun_requirements',       kind: 'enum', label: 'Sun',                section: 'growing', options: SUN },
  { key: 'care_notes',             kind: 'area', label: 'Care notes',         section: 'growing' },
  { key: 'soil_notes',             kind: 'area', label: 'Soil notes',         section: 'growing' },
  { key: 'common_diseases',        kind: 'csv',  label: 'Common diseases',    section: 'growing', help: 'Comma-separated' },
  { key: 'source_url',             kind: 'text', label: 'Source URL',         section: 'growing', help: 'Must start with https://' },

  { key: 'start_method',           kind: 'enum', label: 'Start method',       section: 'sowing', options: START_METHOD },
  { key: 'start_indoor_weeks_min', kind: 'int',  label: 'Indoor start — weeks min', section: 'sowing' },
  { key: 'start_indoor_weeks_max', kind: 'int',  label: 'Indoor start — weeks max', section: 'sowing' },
  { key: 'direct_sow_timing',      kind: 'area', label: 'Direct sow timing',  section: 'sowing' },
  { key: 'sow_depth_in',           kind: 'num',  label: 'Sow depth (in)',     section: 'sowing' },
  { key: 'seed_spacing_in',        kind: 'num',  label: 'Seed spacing (in)',  section: 'sowing' },
  { key: 'row_spacing_in',         kind: 'num',  label: 'Row spacing (in)',   section: 'sowing' },
  { key: 'days_to_germ_min',       kind: 'int',  label: 'Days to germinate — min', section: 'sowing' },
  { key: 'days_to_germ_max',       kind: 'int',  label: 'Days to germinate — max', section: 'sowing' },
  { key: 'sow_season',             kind: 'enum', label: 'Sow season',         section: 'sowing', options: SOW_SEASON },
  { key: 'sow_notes',              kind: 'area', label: 'Sow notes',          section: 'sowing' },

  { key: 'grown_as',               kind: 'enum', label: 'Grown as',           section: 'classify', options: LIFECYCLE },
  { key: 'determinacy',            kind: 'enum', label: 'Determinacy',        section: 'classify', options: DETERMINACY },
  { key: 'day_length_response',    kind: 'enum', label: 'Day length response', section: 'classify', options: DAY_LENGTH },
  { key: 'growth_habit',           kind: 'text', label: 'Growth habit',       section: 'classify' },
  { key: 'produces_scape',         kind: 'bool', label: 'Produces scape',     section: 'classify' },
  { key: 'scoville_min',           kind: 'int',  label: 'Scoville — min',     section: 'classify' },
  { key: 'scoville_max',           kind: 'int',  label: 'Scoville — max',     section: 'classify' },
]

const SECTIONS = [
  { id: 'maturity', title: 'Maturity & yield' },
  { id: 'growing',  title: 'Growing' },
  { id: 'sowing',   title: 'Sowing' },
  { id: 'classify', title: 'Classification' },
]

// DB value -> form string. Everything is held as a string so "" is the one unambiguous token for
// "the user emptied this", which is what buildVarietyPatch turns into an explicit clear.
function toField(kind, v) {
  if (v == null) return ''
  if (kind === 'csv') return Array.isArray(v) ? v.join(', ') : String(v)
  if (kind === 'bool') return v === true ? 'true' : v === false ? 'false' : ''
  return String(v)
}

export function formFromVariety(variety) {
  const f = { name: variety?.name ?? '', crop_type_slug: variety?.crop_type_slug ?? '' }
  for (const { key, kind } of FIELDS) f[key] = toField(kind, variety?.[key])
  return f
}

// Form string -> wire value. Returns undefined when the field is empty, so the caller can tell
// "no value" apart from a legitimate 0 / false / "".
function toWire(kind, s) {
  const t = typeof s === 'string' ? s.trim() : s
  if (t === '' || t == null) return undefined
  if (kind === 'int') { const n = parseInt(t, 10); return Number.isNaN(n) ? undefined : n }
  if (kind === 'num') { const n = Number(t);       return Number.isNaN(n) ? undefined : n }
  if (kind === 'bool') return t === 'true' ? true : t === 'false' ? false : undefined
  if (kind === 'csv') {
    const parts = String(t).split(',').map(x => x.trim()).filter(Boolean)
    return parts.length ? parts : undefined
  }
  return String(t)
}

// Arrays (common_diseases) and the numeric columns need a value compare, not ===: the form round-
// trips everything through strings, so 0.25 -> '0.25' -> 0.25 must read as unchanged.
function same(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = Array.isArray(a) ? a : [], y = Array.isArray(b) ? b : []
    return x.length === y.length && x.every((v, i) => v === y[i])
  }
  return a === b
}

// Build the PUT body. THE contract this component exists to honour:
//   value changed            -> send the key (COALESCE sets it)
//   emptied, DB had a value  -> name it in `clear` (the CASE branch NULLs it)
//   unchanged                -> omit entirely
// A key is never both sent and cleared — the Lambda 400s on that, deliberately. Only CHANGED
// fields travel: sending the whole row on every save would make `dirty` meaningless, and would
// rewrite 30 columns (and fire the audit trigger on each) to correct one typo.
export function buildVarietyPatch(form, original) {
  const body = {}
  const clear = []
  const name = (form.name ?? '').trim()
  if (name && name !== (original?.name ?? '')) body.name = name

  const cropNow = (form.crop_type_slug ?? '').trim()
  const cropWas = original?.crop_type_slug ?? null
  if (cropNow) { if (cropNow !== cropWas) body.crop_type_slug = cropNow }
  else if (cropWas != null) clear.push('crop_type_slug')

  for (const { key, kind } of FIELDS) {
    const next = toWire(kind, form[key])
    const was = original?.[key] ?? null
    if (next === undefined) { if (was != null) clear.push(key) }
    else if (!same(next, was)) body[key] = next
  }
  if (clear.length) body.clear = clear
  return body
}

// A save with an empty body would be a wasted round-trip that still reports success — the user
// would learn nothing about whether their edit landed.
export function isEmptyPatch(patch) {
  return Object.keys(patch).length === 0
}

export default function VarietyEditor({
  variety,
  cropTypes = [],
  currentUserId = null,
  onSave,                  // (id, payload) => { variety } | { error }
  onSaved,
  onCancel,
  idPrefix = 'variety-edit',
}) {
  const [form, setForm] = useState(() => formFromVariety(variety))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  const canEdit = !currentUserId || !variety?.created_by || variety.created_by === currentUserId
  const patch = useMemo(() => buildVarietyPatch(form, variety), [form, variety])
  const dirty = !isEmptyPatch(patch)

  const set = (key) => (e) => {
    const v = e?.target?.type === 'checkbox' ? String(e.target.checked) : e.target.value
    setForm(f => ({ ...f, [key]: v }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (saving || !canEdit) return
    if (!form.name.trim()) { setErr('Name is required.'); return }
    if (isEmptyPatch(patch)) { setErr('Nothing changed.'); return }
    setSaving(true); setErr(null)
    const res = await onSave?.(variety.id, patch)
    setSaving(false)
    if (res?.error) { setErr(res.error); return }
    onSaved?.(res?.variety ?? null)
  }

  const renderField = ({ key, kind, label, options, placeholder, help }) => {
    const id = `${idPrefix}-${key}`
    const common = { id, value: form[key] ?? '', onChange: set(key), disabled: !canEdit }
    let control
    if (kind === 'area') control = <Textarea rows={3} {...common} />
    else if (kind === 'enum') {
      control = (
        <Select {...common} placeholder="— none —">
          {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      )
    } else if (kind === 'bool') {
      control = (
        <Select {...common} placeholder="— unknown —">
          <option value="true">Yes</option>
          <option value="false">No</option>
        </Select>
      )
    } else if (kind === 'int' || kind === 'num') {
      control = <Input type="number" inputMode="decimal" min="0" step={kind === 'int' ? '1' : 'any'} {...common} />
    } else {
      control = <Input type="text" placeholder={placeholder} {...common} />
    }
    return (
      <Field key={key} label={label} htmlFor={id} optional help={help} style={{ marginBottom: 14 }}>
        {control}
      </Field>
    )
  }

  return (
    <form onSubmit={handleSubmit} style={{ padding: '0 16px 16px' }}>
      {!canEdit && (
        <div style={readOnlyNotice} role="status">
          This variety was created by <strong>{variety.created_by}</strong>, not by you. The server
          only accepts edits from the row's owner, so this form is read-only.
        </div>
      )}

      <Field label="Name" htmlFor={`${idPrefix}-name`} required style={{ marginBottom: 14 }}>
        <Input
          id={`${idPrefix}-name`}
          type="text"
          value={form.name}
          onChange={set('name')}
          disabled={!canEdit}
          error={!form.name.trim() || undefined}
        />
      </Field>

      <Field label="Crop type" htmlFor={`${idPrefix}-crop_type_slug`} optional style={{ marginBottom: 14 }}
        help="Filing this wrong drops the variety out of every type-grouped view.">
        <Select
          id={`${idPrefix}-crop_type_slug`}
          value={form.crop_type_slug}
          onChange={set('crop_type_slug')}
          disabled={!canEdit}
          placeholder="— none —"
        >
          {cropTypes.map(c => <option key={c.slug} value={c.slug}>{c.display_name}</option>)}
        </Select>
      </Field>

      {FIELDS.filter(f => f.section === 'identity').map(renderField)}

      {SECTIONS.map(({ id, title }) => (
        <details key={id} data-testid={`variety-section-${id}`} style={{ marginBottom: 14 }}>
          <summary style={summaryStyle}>{title}</summary>
          <div style={{ paddingTop: 10 }}>
            {FIELDS.filter(f => f.section === id).map(renderField)}
          </div>
        </details>
      ))}

      {err && <ErrorBanner style={{ marginBottom: 12 }}>{err}</ErrorBanner>}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Button type="submit" variant="primary" disabled={!canEdit || !dirty}
          loading={saving} loadingLabel="Saving…">
          Save
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}

const summaryStyle = {
  cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600,
  padding: '8px 0', minHeight: 44, display: 'flex', alignItems: 'center', color: P.dark,
}

// overflowWrap: a Clerk sub is a 32-char unbroken token and this renders one inline — without it
// the notice pushes the whole form wider than a 390px viewport.
const readOnlyNotice = {
  backgroundColor: P.cream, border: `1px solid ${P.border}`, borderRadius: 8,
  padding: '10px 12px', marginBottom: 14, fontSize: '0.82rem', color: P.mid,
  overflowWrap: 'anywhere',
}
