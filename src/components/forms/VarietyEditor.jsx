// VarietyEditor — V4-EDITCOMPLETE-001 V3: the variety edit surface that did not exist.
//
// Before this, `plant_varieties` was reachable only through VarietyPicker's CREATE path, which
// writes name / species / crop_type_slug / lifecycle and then never offers them again — so a
// mistyped variety name, or a variety filed under the wrong crop type (and therefore missing from
// every type-grouped view), was permanent across 408 live cultivars. `useVarieties.updateVariety`
// had been complete and callerless since VARIETY-REF Session 2.
//
// Per Dave's global rule this exposes ALL 36 user-owned columns the PUT can write, not just the 4
// the create path happens to set (31 until V5-VARIETYFACTSEDIT-001 added origin country/region,
// breeding and the two "info from" sources). Deliberately absent: photo_id (needs the photo-picker
// surface, a different lane) and dtm_basis (no read path or consumer yet — V4-MATURITYBASIS-001).
// breeding_confidence and variety_rank are not PUT-writable, so there is no rank field here. The
// server decides Open-pollinated against variety_rank (chk_plant_varieties_op_requires_cultivar):
// on a variety whose rank was never recorded it saves and records the variety as a single named
// cultivar (Dave, 2026-09-21); on a market class, blend, species or placeholder it comes back as a
// plain-English save error in the banner below.
//
// The PUT is household-scoped (V4-VARIETYHOUSEHOLD-001), not owner-only. `currentUserId` gates the
// form into a read-only state rather than letting the user type a save that will 404.
//
// BUG-VARIETYEDITSTRICTER-001 — that gate used to read `variety.created_by === currentUserId`,
// which was STRICTER than the server it was predicting. The PUT and DELETE in
// lambda/varieties/index.js accept `created_by = ANY(household) OR created_by LIKE
// ANY(managedPatterns)`, so the component refused edits the API would have taken. Measured on live
// prod 2026-09-08 (garden_ro): 490 live cultivars, 23 of them locked out for Dave. Re-measured
// 2026-09-23 (read-only, server rule unchanged): 497 live cultivars, all 497 in the API's editable
// set for either household member, and the old gate locked Dave out of 25 — 24 managed-principal
// rows (rescue-intake 15 / data-audit 5 / system 3 / data-correction 1) plus 1 row the other
// household member created.
// `canEditVariety` below now mirrors the managed-principal arm exactly. The household arm is NOT
// mirrored: GARDEN_HOUSEHOLD_IDS is Lambda-side config with no VITE_ counterpart, and this
// component does not consume the one client view of that roster (GET /api/members, useMembers).
// So a row the OTHER household member created stays read-only here although the server would save
// it — 1 row from Dave's side, 472 from the other member's side (2026-09-23). That residual is
// recorded, not guessed at: an "any user_* sub is fine" predicate would be a DIFFERENT rule from
// the server's that only coincides while the household has two members. Closing it means feeding
// the members roster in here, or a `can_edit` flag on the GET.
//
// The mirror is LOOSER than the server in one place, knowingly: the server hands the managed arm
// only to a proven household member (managedPrincipalPatterns in lambda/varieties/authz.js), and
// the client cannot tell a member from a signed-in stranger either. A stranger sees a managed row
// as editable and gets the server's 404 in the error banner — a refused save, never a bad row.

import React, { useMemo, useState } from 'react'
import { P } from '../../lib/constants.js'
import { Field, Input, Select, Textarea, Button, ErrorBanner } from './index.js'
import { T } from './formStyles.js'
import { SUN_OPTIONS } from '../../lib/varietySpec.js'

// Mirrors the CHECK constraints on plant_varieties (verified against live Neon, not migrations).
// Duplicated rather than imported because src/ must not reach into lambda/; the server re-validates,
// so drift here is a 400, never a bad row — the same contract VarietyPicker's LIFECYCLE_OPTIONS uses.
const LIFECYCLE = [
  ['annual', 'Annual'], ['tender_perennial', 'Tender perennial'],
  ['perennial', 'Perennial'], ['biennial', 'Biennial'],
]
// Sun is the one list kept in lib/varietySpec.js rather than here: the planting screens print the stored
// code through the same words (sunLabel), so the word picked here is the word shown there.
const SUN = SUN_OPTIONS
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
// V5-VARIETYFACTSEDIT-001. Labels match the seed card's (seedFacts.js BREEDING_LABEL).
const BREEDING = [
  ['f1', 'F1 hybrid'], ['open_pollinated', 'Open-pollinated'],
  ['landrace', 'Landrace'], ['unknown', 'Unknown'],
]
// breeding_source and scoville_source share one six-value vocabulary. Only a heat figure has an
// "est." to show (shuLabel, for 'inference'); nothing renders breeding_source, so its list does not
// promise one.
const FACT_SOURCE = [
  ['packet_label', 'Seed packet'], ['vendor_catalog', "Supplier's catalog"],
  ['breeder', 'Breeder'], ['reference_work', 'Reference book or site'],
  ['grower_record', 'My own record'],
]
const BREEDING_SOURCE = [...FACT_SOURCE, ['inference', 'Best guess']]
const HEAT_SOURCE = [...FACT_SOURCE, ['inference', 'Best guess (shows est.)']]

// Mirrors lambda/varieties/authz.js MANAGED_PRINCIPAL_PATTERNS verbatim — the SQL `LIKE ANY` arm of
// the PUT/DELETE predicate. Duplicated rather than imported for the same reason LIFECYCLE above is:
// src/ must not reach into lambda/, and the server re-validates, so drift here can never write a
// bad row. It can still lock a row the server would save (a pattern the Lambda gained and this
// copy lacks) — the exact bug this list closes — so VarietyEditor.test.jsx reads authz.js off disk
// and fails when the two lists differ. Kept in the SQL spelling (a trailing `%`) so a reader can
// diff it against the Lambda by eye; `system` is an exact match there and stays one here.
export const MANAGED_PRINCIPAL_PATTERNS = [
  'system',
  'rescue-intake-%',
  'data-audit-%',
  'data-correction-%',
]

// Only a trailing `%` appears in the patterns above — no `_`, no leading or interior wildcard — so
// prefix/equality is a faithful LIKE, not an approximation of one.
function matchesManagedPrincipal(createdBy) {
  return MANAGED_PRINCIPAL_PATTERNS.some(p =>
    p.endsWith('%') ? createdBy.startsWith(p.slice(0, -1)) : createdBy === p)
}

// The form's prediction of what the server will accept. Exported so the guard test can drive the
// predicate directly against real prod-shaped created_by values instead of only through a render.
export function canEditVariety(variety, currentUserId) {
  const createdBy = variety?.created_by
  if (!currentUserId || !createdBy) return true
  return createdBy === currentUserId || matchesManagedPrincipal(createdBy)
}

// The field table IS the contract: it drives rendering, the form seed, and the payload build, so a
// field cannot be displayed without also being saved (the failure mode called out in 5b430f4).
// kind: text | area | int | num | enum | bool | csv.  `name` is intentionally not clearable.
export const FIELDS = [
  { key: 'species',                kind: 'text', label: 'Species',            section: 'identity', placeholder: 'e.g. Capsicum annuum' },
  { key: 'genus',                  kind: 'text', label: 'Genus',              section: 'identity' },
  { key: 'lifecycle',              kind: 'enum', label: 'Lifecycle',          section: 'identity', options: LIFECYCLE },
  { key: 'origin_country',         kind: 'text', label: 'Country of origin',  section: 'identity' },
  { key: 'origin_region',          kind: 'text', label: 'Region of origin',   section: 'identity' },

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
  // Beside the numbers on purpose: correcting a figure without this left the card's "est." standing.
  { key: 'scoville_source',        kind: 'enum', label: 'Heat figure from',   section: 'classify', options: HEAT_SOURCE },
  { key: 'breeding_system',        kind: 'enum', label: 'Breeding',           section: 'classify', options: BREEDING },
  { key: 'breeding_source',        kind: 'enum', label: 'Breeding info from', section: 'classify', options: BREEDING_SOURCE },
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

// V4-CROPTYPEREACH-001 — the crop-type field, now with an inline mint.
//
// Until this, `＋ New crop type` existed in exactly ONE place in the app: VarietyPicker's stage 2,
// which only runs while creating a BRAND-NEW variety. So once a variety existed there was no path
// to a new crop type anywhere — an untyped variety could be edited forever and still never get a
// type, which is precisely how Kousa Dogwood sat untyped on 2026-08-17. This is the second surface,
// and the one that closes the reachability gap for rows that already exist.
//
// Modelled on PutUp's StorageField (the house pattern for inline-create beside a Select) rather
// than on VarietyPicker's panel: this is a form, so it uses the form primitives.
function CropTypeField({ idPrefix, value, onChange, cropTypes, onCreateCropType, disabled }) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [lifecycle, setLifecycle] = useState('')
  const [busy, setBusy] = useState(false)
  // Types minted in THIS session, merged into the options below. `cropTypes` is a prop owned by the
  // page's useCropTypes hook, so it can lag the mint by a render — and a <select> whose value is not
  // among its options renders BLANK. Without this the user mints "Dogwood", watches the field go
  // empty, and concludes it failed: the same "my type didn't take" outcome this item exists to end.
  const [minted, setMinted] = useState([])
  // null | { message, existing } — `existing` present means the server steered us to a type that
  // already covers this name (plural, or a synonym of a crop the derive engine special-cases).
  // Adopting it is the CORRECT outcome, so it gets a button rather than a dead error string.
  const [err, setErr] = useState(null)

  const options = useMemo(
    () => [...cropTypes, ...minted.filter(m => !cropTypes.some(c => c.slug === m.slug))],
    [cropTypes, minted],
  )

  // Derived from the live vocabulary, never hardcoded: the picker can then only offer a category
  // the server already accepts. Same contract as VarietyPicker's categoryOptions.
  const categoryOptions = useMemo(
    () => [...new Set(cropTypes.map(c => c.category).filter(Boolean))].sort(),
    [cropTypes],
  )

  const reset = () => { setAdding(false); setName(''); setCategory(''); setLifecycle(''); setErr(null) }

  async function create() {
    const display_name = name.trim()
    if (!display_name || busy) return
    setBusy(true); setErr(null)
    const res = await onCreateCropType({
      display_name,
      category: category || null,
      default_lifecycle: lifecycle || null,
    })
    setBusy(false)
    if (res?.error) { setErr({ message: res.error, existing: res.existing ?? null }); return }
    // Select what was just minted — stopping at "type created" would leave the user to hunt for it
    // in a 141-row select, which is the failure this item exists to remove.
    setMinted(m => [...m, res.cropType])
    onChange(res.cropType.slug)
    reset()
  }

  // The mint is a SIBLING of Field, not a second child: Field renders only its first focusable
  // child by contract (Field.jsx) and would silently drop anything after the Select. Same shape as
  // PutUp's StorageField.
  return (
    <div style={{ marginBottom: 14 }}>
      <Field label="Crop type" htmlFor={`${idPrefix}-crop_type_slug`} optional
        help="Filing this wrong drops the variety out of every type-grouped view.">
        <Select
          id={`${idPrefix}-crop_type_slug`}
          value={value}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
          style={disabled ? readOnlyFieldStyle : undefined}
          placeholder="— none —"
        >
          {options.map(c => <option key={c.slug} value={c.slug}>{c.display_name}</option>)}
        </Select>
      </Field>

      {onCreateCropType && !disabled && (adding ? (
        <div style={mintPanelStyle}>
          <Field label="New crop type name" htmlFor={`${idPrefix}-nc-name`} required style={{ marginBottom: 10 }}>
            <Input
              id={`${idPrefix}-nc-name`}
              type="text"
              value={name}
              onChange={e => { setName(e.target.value); setErr(null) }}
              placeholder="e.g. Dogwood"
              autoComplete="off"
            />
          </Field>
          <div style={{ display: 'flex', gap: 8 }}>
            <Field label="Category" htmlFor={`${idPrefix}-nc-cat`} optional style={{ flex: 1, marginBottom: 0 }}>
              <Select id={`${idPrefix}-nc-cat`} value={category} onChange={e => setCategory(e.target.value)} placeholder="— none —">
                {categoryOptions.map(c => (
                  <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
                ))}
              </Select>
            </Field>
            <Field label="Lifecycle" htmlFor={`${idPrefix}-nc-lc`} optional style={{ flex: 1, marginBottom: 0 }}>
              <Select id={`${idPrefix}-nc-lc`} value={lifecycle} onChange={e => setLifecycle(e.target.value)} placeholder="— none —">
                {LIFECYCLE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            </Field>
          </div>
          {err && (
            <div role="alert" style={{ color: P.terra, fontSize: '0.78rem', marginTop: 10 }}>
              <div>{err.message}</div>
              {err.existing && (
                <Button type="button" variant="secondary" style={{ marginTop: 8 }}
                  onClick={() => { onChange(err.existing.slug); reset() }}>
                  Use "{err.existing.display_name}"
                </Button>
              )}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            {/* type="button" is load-bearing: this sits INSIDE the editor's <form>, so a default
                submit button would save the variety instead of minting the type. */}
            <Button type="button" variant="primary" loading={busy} loadingLabel="Creating…"
              disabled={!name.trim()} onClick={create}>
              Create crop type
            </Button>
            <Button type="button" variant="secondary" onClick={reset}>Cancel</Button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)} style={mintLinkStyle}>
          ＋ New crop type
        </button>
      ))}
    </div>
  )
}

export default function VarietyEditor({
  variety,
  cropTypes = [],
  onCreateCropType = null,   // (payload) => { cropType } | { error, existing } — omit to hide the mint
  currentUserId = null,
  onSave,                  // (id, payload) => { variety } | { error }
  onSaved,
  onCancel,
  idPrefix = 'variety-edit',
}) {
  const [form, setForm] = useState(() => formFromVariety(variety))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  const canEdit = canEditVariety(variety, currentUserId)
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
    // V5-VARIETYFACTSEDIT-001 — a breeding call may never stand unsourced
    // (chk_plant_varieties_breeding_sourced). Stopped here, before the round trip.
    if (form.breeding_system && !form.breeding_source) {
      setErr('"Breeding info from" is required when Breeding is set.'); return
    }
    if (isEmptyPatch(patch)) { setErr('Nothing changed.'); return }
    setSaving(true); setErr(null)
    const res = await onSave?.(variety.id, patch)
    setSaving(false)
    if (res?.error) { setErr(res.error); return }
    onSaved?.(res?.variety ?? null)
  }

  const renderField = ({ key, kind, label, options, placeholder, help }) => {
    const id = `${idPrefix}-${key}`
    const common = {
      id, value: form[key] ?? '', onChange: set(key), disabled: !canEdit,
      style: canEdit ? undefined : readOnlyFieldStyle,
    }
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
        <div style={readOnlyNotice} role="status" data-testid="variety-readonly-notice">
          <div style={readOnlyNoticeHeadline}>Read-only — you can't edit this variety here</div>
          It was added by another account (<strong>{variety.created_by}</strong>). This screen can
          only save a variety you added, or one the garden's own scripts added, so every value below
          is shown but nothing you type here will save.
        </div>
      )}

      <Field label="Name" htmlFor={`${idPrefix}-name`} required style={{ marginBottom: 14 }}>
        <Input
          id={`${idPrefix}-name`}
          type="text"
          value={form.name}
          onChange={set('name')}
          disabled={!canEdit}
          style={canEdit ? undefined : readOnlyFieldStyle}
          error={!form.name.trim() || undefined}
        />
      </Field>

      <CropTypeField
        idPrefix={idPrefix}
        value={form.crop_type_slug}
        onChange={slug => setForm(f => ({ ...f, crop_type_slug: slug }))}
        cropTypes={cropTypes}
        onCreateCropType={onCreateCropType}
        disabled={!canEdit}
      />

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

// V4-CROPTYPEREACH-001 — inline mint affordance. Matches PutUp's StorageField "＋ New location"
// link (PutUp.jsx:760-766) so the two inline-create surfaces read identically.
const mintLinkStyle = {
  background: 'none', border: 'none', color: P.green, cursor: 'pointer', fontSize: '0.82rem',
  fontWeight: 600, padding: '8px 0 0', textDecoration: 'underline', minHeight: 44,
}

const mintPanelStyle = {
  marginTop: 12, border: `1px solid ${P.border}`, borderRadius: 8,
  padding: '12px 14px', backgroundColor: P.cream,
}

// BUG-VARIETYREADONLYINVISIBLE-001 — the notice was cream fill + P.border on a cream page, at the
// same weight as the `help` text under every Field, so it read as a hint rather than as a blocker.
// Now the house warning surface (P.warn + P.warnBorder + a bolded headline), the same one
// ComposeHarvestBand.jsx:404 and StorageDeadlineAlert.jsx:141 use. No new primitive: this is a
// styled div, exactly as it was.
//
// The copy states what THIS SCREEN will do and never predicts the server. The old sentence ("the
// server only accepts edits from the row's owner") had been false since V4-VARIETYHOUSEHOLD-001, and
// "the server will refuse any change" would be false too: after the widening, the one place a
// household member still meets this notice is a row the OTHER member created — a row the server
// would save. The client cannot tell that row from a stranger's, so it says only what it knows.
//
// overflowWrap: a Clerk sub is a 32-char unbroken token and this renders one inline — without it
// the notice pushes the whole form wider than a 390px viewport.
const readOnlyNotice = {
  backgroundColor: P.warn, border: `1px solid ${P.warnBorder}`, borderRadius: 8,
  padding: '10px 12px', marginBottom: 14, fontSize: '0.82rem', color: P.mid,
  overflowWrap: 'anywhere',
}

// T.space.xs (5) rather than a raw 4: the designsys rule caps this file's dimensional literals and
// a one-pixel gap is not worth spending the budget on.
const readOnlyNoticeHeadline = {
  fontWeight: 700, color: P.gold, marginBottom: T.space.xs,
}

// The other half of BUG-VARIETYREADONLYINVISIBLE-001, and the half the notice alone could not fix:
// inputChrome/selectChrome carry NO disabled treatment at all, so a `disabled` field rendered
// P.dark ink on a P.white box — pixel-identical to an editable one. A user who scrolled past the
// notice (four fields is enough on a 390px screen) saw a normal-looking box that silently ate
// keystrokes. Merged through each primitive's `style` slot, so the frozen primitives are untouched.
//
// Four independent channels, not colour alone: recessed fill, muted ink, a DASHED border (shape,
// which survives greyscale and every colour-vision deficiency), and the not-allowed cursor.
const readOnlyFieldStyle = {
  backgroundColor: P.cream,
  color: P.light,
  borderStyle: 'dashed',
  cursor: 'not-allowed',
}
