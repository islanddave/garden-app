import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useInventory } from '../hooks/useInventory.js'
import { P } from '../lib/constants.js'

// ── Spec-compliant enums (inventory_items schema) ────────────────────────────
const TYPES = [
  {
    value: 'consumable',
    label: 'Consumable',
    example: 'Seeds, fertilizer, spray, grow bags',
    emoji: '🌱',
  },
  {
    value: 'durable',
    label: 'Durable',
    example: 'Tools, lights, trays, shelving',
    emoji: '🔧',
  },
]

const CATEGORIES = [
  { v: 'seeds',                   label: 'Seeds',                types: ['consumable'] },
  { v: 'growing_media',           label: 'Growing media',        types: ['consumable'] },
  { v: 'nutrients_and_amendments',label: 'Nutrients & amendments',types: ['consumable'] },
  { v: 'pest_control',            label: 'Pest control',         types: ['consumable'] },
  { v: 'containers',              label: 'Containers',           types: ['consumable', 'durable'] },
  { v: 'lighting',                label: 'Lighting',             types: ['durable'] },
  { v: 'shelving',                label: 'Shelving',             types: ['durable'] },
  { v: 'climate_control',         label: 'Climate control',      types: ['durable'] },
  { v: 'tools',                   label: 'Tools',                types: ['durable'] },
  { v: 'other',                   label: 'Other',                types: ['consumable', 'durable'] },
]

const UNITS = ['each', 'packet', 'oz', 'fl oz', 'lb', 'gal', 'qt', 'bag', 'roll', 'sheet', 'other']
const CONDITIONS = ['excellent', 'good', 'fair', 'poor']

// ── Main page ────────────────────────────────────────────────────────────────
export default function InventoryAdd() {
  const navigate = useNavigate()
  const { createItem } = useInventory()

  const [form, setForm] = useState({
    name:             '',
    type:             '',
    category:         '',
    // consumable fields
    quantity_on_hand: '',
    unit:             '',
    reorder_threshold:'',
    reorder_quantity: '',
    // durable fields
    quantity:         '',
    condition:        '',
    brand:            '',
    model:            '',
    // shared optional
    source:           '',
    source_url:       '',
    purchase_date:    '',
    unit_cost:        '',
    quantity_purchased:'',
    notes:            '',
    location_text:    '',
  })

  const [showFull,      setShowFull]      = useState(false)
  const [saving,        setSaving]        = useState(false)
  const [errors,        setErrors]        = useState({})
  const [successToast,  setSuccessToast]  = useState(false)
  const [typeWarning,   setTypeWarning]   = useState(false) // pending type switch

  const visibleCategories = form.type
    ? CATEGORIES.filter(c => c.types.includes(form.type))
    : CATEGORIES

  // Clear type-specific fields when type changes
  function applyTypeSwitch(newType) {
    setForm(f => ({
      ...f,
      type: newType,
      category:          '',
      // clear consumable-only
      quantity_on_hand:  '',
      unit:              '',
      reorder_threshold: '',
      reorder_quantity:  '',
      // clear durable-only
      quantity:          '',
      condition:         '',
    }))
    setTypeWarning(false)
  }

  function handleTypeSelect(newType) {
    if (!newType || newType === form.type) return
    // Show confirmation if user already entered qty fields
    const hasConsumableData = form.quantity_on_hand || form.unit
    const hasDurableData    = form.quantity || form.condition
    if (form.type && (hasConsumableData || hasDurableData)) {
      setTypeWarning(newType)
    } else {
      applyTypeSwitch(newType)
    }
  }

  function set(field, value) {
    setForm(f => ({ ...f, [field]: value }))
    if (errors[field]) setErrors(e => ({ ...e, [field]: null }))
  }

  function validate() {
    const e = {}
    if (!form.name.trim())    e.name     = 'Add a name so you can find this item later.'
    if (!form.type)           e.type     = 'Select Consumable or Durable to continue.'
    if (!form.category)       e.category = 'Choose a category.'
    if (form.type === 'consumable') {
      if (!form.quantity_on_hand && form.quantity_on_hand !== 0)
        e.quantity_on_hand = 'Enter a quantity — even 0 is fine.'
      if (!form.unit)
        e.unit = 'Select a unit.'
    }
    if (form.type === 'durable') {
      if (!form.quantity && form.quantity !== 0)
        e.quantity = 'How many do you have?'
    }
    return e
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const errs = validate()
    if (Object.keys(errs).length) { setErrors(errs); return }

    setSaving(true)
    try {
      const payload = buildPayload()
      const { error } = await createItem(payload)
      setSaving(false)

      if (error) {
        setErrors({ _form: error })
        return
      }

      // Success toast (2500ms) then navigate
      setSuccessToast(true)
      setTimeout(() => {
        navigate('/inventory')
      }, 2500)
    } catch (err) {
      setSaving(false)
      setErrors({ _form: err?.message || 'Unexpected error — please try again.' })
    }
  }

  function buildPayload() {
    const base = {
      name:          form.name.trim(),
      type:          form.type,
      category:      form.category,
      notes:         form.notes.trim()        || null,
      source:        form.source.trim()       || null,
      source_url:    form.source_url.trim()   || null,
      purchase_date: form.purchase_date       || null,
      unit_cost:     parseNum(form.unit_cost),
      location_text: form.location_text.trim()|| null,
      status:        'active',
    }
    if (form.type === 'consumable') {
      return {
        ...base,
        quantity_on_hand:   parseNum(form.quantity_on_hand) ?? 0,
        unit:               form.unit,
        reorder_threshold:  parseNum(form.reorder_threshold),
        reorder_quantity:   parseNum(form.reorder_quantity),
        quantity_purchased: parseNum(form.quantity_purchased),
      }
    }
    // durable
    return {
      ...base,
      quantity:           parseInt(form.quantity) || 1,
      condition:          form.condition || null,
      brand:              form.brand.trim()  || null,
      model:              form.model.trim()  || null,
      quantity_purchased: parseNum(form.quantity_purchased),
    }
  }

  function parseNum(val) {
    if (val === '' || val === null || val === undefined) return null
    const n = parseFloat(val)
    return isNaN(n) ? null : n
  }

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 600, margin: '0 auto', padding: '28px 16px 80px' }}>

        {/* Breadcrumb */}
        <div style={{ fontSize: '0.82rem', color: P.light, marginBottom: 8 }}>
          <Link to="/inventory" style={{ color: P.green, textDecoration: 'none' }}>Inventory</Link>
          {' › Add item'}
        </div>

        <h1 style={{ margin: '0 0 24px', color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>
          Add item
        </h1>

        {/* Type switch confirmation */}
        {typeWarning && (
          <div style={{
            backgroundColor: P.warn, border: `1px solid ${P.warnBorder}`,
            borderRadius: 8, padding: '14px 18px', marginBottom: 20,
          }}>
            <p style={{ margin: '0 0 12px', fontSize: '0.9rem', color: P.dark }}>
              Switching type will clear the quantity and condition fields. Name, category, and notes stay.
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => applyTypeSwitch(typeWarning)}
                style={btn(P.terra, false)}
              >
                Switch to {typeWarning === 'consumable' ? 'Consumable' : 'Durable'}
              </button>
              <button
                onClick={() => setTypeWarning(false)}
                style={{ ...btn(P.mid, false), backgroundColor: 'transparent', color: P.mid, border: `1px solid ${P.border}` }}
              >
                Keep current type
              </button>
            </div>
          </div>
        )}

        {errors._form && (
          <div style={{
            backgroundColor: P.alert, border: `1px solid ${P.alertBorder}`,
            borderRadius: 8, padding: '12px 16px', marginBottom: 20,
            fontSize: '0.875rem', color: '#7a2a10',
          }}>
            {errors._form}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* ── Required group ── */}
          <div style={card}>
            <div style={groupLabel}>Required to save</div>

            {/* Name */}
            <Field label="What's the item?" error={errors.name}>
              <input
                value={form.name}
                onChange={e => set('name', e.target.value)}
                style={inputStyle(!!errors.name)}
                placeholder="e.g. Black Krim tomato seeds"
              />
            </Field>

            {/* Type */}
            <Field label="Type" error={errors.type}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {TYPES.map(t => (
                  <TypeCard
                    key={t.value}
                    type={t}
                    selected={form.type === t.value}
                    onSelect={() => handleTypeSelect(t.value)}
                    hasError={!!errors.type}
                  />
                ))}
              </div>
            </Field>

            {/* Category */}
            <Field label="Category" error={errors.category}>
              <select
                value={form.category}
                onChange={e => set('category', e.target.value)}
                style={selectStyle(!!errors.category)}
                disabled={!form.type}
              >
                <option value="">{form.type ? '— Select category —' : '— Select type first —'}</option>
                {visibleCategories.map(c => (
                  <option key={c.v} value={c.v}>{c.label}</option>
                ))}
              </select>
            </Field>

            {/* Quantity — type-aware */}
            {form.type === 'consumable' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="Qty on hand" error={errors.quantity_on_hand}>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={form.quantity_on_hand}
                    onChange={e => set('quantity_on_hand', e.target.value)}
                    style={inputStyle(!!errors.quantity_on_hand)}
                    placeholder="0"
                  />
                </Field>
                <Field label="Unit" error={errors.unit}>
                  <select
                    value={form.unit}
                    onChange={e => set('unit', e.target.value)}
                    style={selectStyle(!!errors.unit)}
                  >
                    <option value="">— Unit —</option>
                    {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </Field>
              </div>
            )}

            {form.type === 'durable' && (
              <Field label="Quantity (how many?)" error={errors.quantity}>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={form.quantity}
                  onChange={e => set('quantity', e.target.value)}
                  style={inputStyle(!!errors.quantity)}
                  placeholder="1"
                />
              </Field>
            )}
          </div>

          {/* ── Full Add (collapsible) ── */}
          <div style={card}>
            <button
              type="button"
              onClick={() => setShowFull(s => !s)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: P.green, fontSize: '0.9rem', fontWeight: 600,
                padding: 0, display: 'flex', alignItems: 'center', gap: 6,
                width: '100%', textAlign: 'left',
              }}
            >
              <span style={{ fontSize: '0.8rem' }}>{showFull ? '▾' : '▸'}</span>
              Add more details
              <span style={{ color: P.light, fontWeight: 400, fontSize: '0.82rem' }}>
                &nbsp;— optional
              </span>
            </button>

            {showFull && (
              <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>

                {/* Consumable extras */}
                {form.type === 'consumable' && (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                      <Field label="Reorder when below">
                        <input
                          type="number" min="0" step="any"
                          value={form.reorder_threshold}
                          onChange={e => set('reorder_threshold', e.target.value)}
                          style={inputStyle(false)}
                          placeholder="e.g. 1"
                        />
                      </Field>
                      <Field label="Reorder quantity">
                        <input
                          type="number" min="0" step="any"
                          value={form.reorder_quantity}
                          onChange={e => set('reorder_quantity', e.target.value)}
                          style={inputStyle(false)}
                          placeholder="e.g. 3"
                        />
                      </Field>
                    </div>
                  </>
                )}

                {/* Durable extras */}
                {form.type === 'durable' && (
                  <>
                    <Field label="Condition">
                      <select
                        value={form.condition}
                        onChange={e => set('condition', e.target.value)}
                        style={selectStyle(false)}
                      >
                        <option value="">— Optional —</option>
                        {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </Field>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                      <Field label="Brand">
                        <input
                          value={form.brand}
                          onChange={e => set('brand', e.target.value)}
                          style={inputStyle(false)}
                          placeholder="e.g. Burpee"
                        />
                      </Field>
                      <Field label="Model">
                        <input
                          value={form.model}
                          onChange={e => set('model', e.target.value)}
                          style={inputStyle(false)}
                          placeholder="Optional"
                        />
                      </Field>
                    </div>
                  </>
                )}

                {/* Shared optional fields */}
                <Field label="Location (free text)">
                  <input
                    value={form.location_text}
                    onChange={e => set('location_text', e.target.value)}
                    style={inputStyle(false)}
                    placeholder="e.g. Stable rack, shelf 2"
                  />
                </Field>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Field label="Unit cost ($)">
                    <input
                      type="number" min="0" step="0.01"
                      value={form.unit_cost}
                      onChange={e => set('unit_cost', e.target.value)}
                      style={inputStyle(false)}
                      placeholder="0.00"
                    />
                  </Field>
                  <Field label="Total qty purchased">
                    <input
                      type="number" min="0" step="any"
                      value={form.quantity_purchased}
                      onChange={e => set('quantity_purchased', e.target.value)}
                      style={inputStyle(false)}
                      placeholder="All time"
                    />
                  </Field>
                </div>
                <Field label="Source (store / vendor)">
                  <input
                    value={form.source}
                    onChange={e => set('source', e.target.value)}
                    style={inputStyle(false)}
                    placeholder="e.g. True Leaf Market"
                  />
                </Field>
                <Field label="Source URL">
                  <input
                    type="url"
                    value={form.source_url}
                    onChange={e => set('source_url', e.target.value)}
                    style={inputStyle(false)}
                    placeholder="https://…"
                  />
                </Field>
                <Field label="Purchase date">
                  <input
                    type="date"
                    value={form.purchase_date}
                    onChange={e => set('purchase_date', e.target.value)}
                    style={inputStyle(false)}
                  />
                </Field>
                <Field label="Notes">
                  <textarea
                    value={form.notes}
                    onChange={e => set('notes', e.target.value)}
                    style={{ ...inputStyle(false), height: 80, resize: 'vertical' }}
                    placeholder="Variety, expiry, source quality…"
                  />
                </Field>
              </div>
            )}
          </div>

          {/* ── Actions ── */}
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', paddingTop: 4 }}>
            <button type="submit" disabled={saving} style={btn(P.green, saving)}>
              {saving ? 'Saving…' : 'Add item'}
            </button>
            <Link to="/inventory" style={{ color: P.mid, textDecoration: 'none', fontSize: '0.88rem' }}>
              Cancel
            </Link>
          </div>

        </form>
      </div>

      {/* Success toast */}
      {successToast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          backgroundColor: P.greenLight, color: P.white,
          padding: '12px 24px', borderRadius: 8,
          fontSize: '0.9rem', fontWeight: 600,
          boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
          zIndex: 1000, whiteSpace: 'nowrap',
        }}>
          ✓ Item added
        </div>
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────
function TypeCard({ type, selected, onSelect, hasError }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        padding: '16px 12px',
        border: `2px solid ${selected ? P.green : hasError ? P.terra : P.border}`,
        borderRadius: 10,
        backgroundColor: selected ? P.greenPale : P.white,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        transition: 'all 0.12s',
        minHeight: 90,
        textAlign: 'center',
      }}
    >
      <span style={{ fontSize: '1.8rem', lineHeight: 1 }}>{type.emoji}</span>
      <span style={{ fontSize: '0.85rem', fontWeight: 700, color: selected ? P.green : P.dark }}>
        {type.label}
      </span>
      <span style={{ fontSize: '0.72rem', color: P.light, lineHeight: 1.3 }}>
        {type.example}
      </span>
    </button>
  )
}

function Field({ label, children, error }) {
  return (
    <div style={{ marginBottom: 0 }}>
      <label style={{
        display: 'block',
        fontSize: '0.78rem', fontWeight: 700, color: P.mid,
        marginBottom: 6, letterSpacing: '0.3px', textTransform: 'uppercase',
      }}>
        {label}
      </label>
      {children}
      {error && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5,
          marginTop: 5, fontSize: '0.78rem', color: P.terra,
        }}>
          <span>⚠</span> {error}
        </div>
      )}
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────
const card = {
  backgroundColor: P.white,
  border: `1px solid ${P.border}`,
  borderRadius: 10,
  padding: '20px 18px',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
}

const groupLabel = {
  fontSize: '0.7rem', fontWeight: 700, color: P.greenLight,
  letterSpacing: '0.8px', textTransform: 'uppercase',
  marginBottom: 4,
}

const inputStyle = (hasErr) => ({
  width: '100%',
  padding: '10px 12px',
  border: `1px solid ${hasErr ? P.terra : P.border}`,
  borderRadius: 7,
  fontSize: '0.9rem',
  backgroundColor: P.white,
  boxSizing: 'border-box',
  fontFamily: 'inherit',
})

const selectStyle = (hasErr) => ({
  ...inputStyle(hasErr),
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23777' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 12px center',
  paddingRight: 36,
  cursor: 'pointer',
})

const btn = (bg, disabled) => ({
  backgroundColor: disabled ? P.light : bg,
  color: P.white,
  border: 'none',
  borderRadius: 8,
  padding: '13px 30px',
  fontSize: '0.95rem',
  fontWeight: 700,
  cursor: disabled ? 'not-allowed' : 'pointer',
  minHeight: 48,
})
