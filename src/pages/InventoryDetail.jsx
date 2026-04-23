import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { useInventory } from '../hooks/useInventory.js'
import { P } from '../lib/constants.js'
import FavoriteToggle from '../components/FavoriteToggle.jsx'

// ── Shared enums (mirror InventoryAdd) ───────────────────────────────────────
const CATEGORIES = [
  { v: 'seeds',                    label: 'Seeds',                 types: ['consumable'] },
  { v: 'growing_media',            label: 'Growing media',         types: ['consumable'] },
  { v: 'nutrients_and_amendments', label: 'Nutrients & amendments', types: ['consumable'] },
  { v: 'pest_control',             label: 'Pest control',          types: ['consumable'] },
  { v: 'containers',               label: 'Containers',            types: ['consumable', 'durable'] },
  { v: 'lighting',                 label: 'Lighting',              types: ['durable'] },
  { v: 'shelving',                 label: 'Shelving',              types: ['durable'] },
  { v: 'climate_control',          label: 'Climate control',       types: ['durable'] },
  { v: 'tools',                    label: 'Tools',                 types: ['durable'] },
  { v: 'other',                    label: 'Other',                 types: ['consumable', 'durable'] },
]

const UNITS       = ['each', 'packet', 'oz', 'fl oz', 'lb', 'gal', 'qt', 'bag', 'roll', 'sheet', 'other']
const CONDITIONS  = ['excellent', 'good', 'fair', 'poor']
const STATUSES    = ['active', 'depleted', 'retired', 'missing']

// ── Main page ─────────────────────────────────────────────────────────────────
export default function InventoryDetail() {
  const { id }       = useParams()
  const navigate     = useNavigate()
  const { updateItem, deleteItem } = useInventory()

  const [item,         setItem]         = useState(null)
  const [form,         setForm]         = useState(null)
  const [loading,      setLoading]      = useState(true)
  const [loadErr,      setLoadErr]      = useState(null)
  const [saving,       setSaving]       = useState(false)
  const [errors,       setErrors]       = useState({})
  const [savedToast,   setSavedToast]   = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting,     setDeleting]     = useState(false)

  // ── Load item ──────────────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      const { data, error } = await supabase
        .from('inventory_items')
        .select('*')
        .eq('id', id)
        .single()
      if (error) {
        setLoadErr(error.message)
      } else {
        setItem(data)
        setForm(itemToForm(data))
      }
      setLoading(false)
    }
    load()
  }, [id])

  // ── Helpers ────────────────────────────────────────────────────────────────
  function itemToForm(i) {
    return {
      name:               i.name              ?? '',
      type:               i.type              ?? 'consumable',
      category:           i.category          ?? '',
      status:             i.status            ?? 'active',
      quantity_on_hand:   i.quantity_on_hand  != null ? String(i.quantity_on_hand) : '',
      quantity:           i.quantity          != null ? String(i.quantity)          : '',
      unit:               i.unit              ?? '',
      reorder_threshold:  i.reorder_threshold != null ? String(i.reorder_threshold) : '',
      reorder_quantity:   i.reorder_quantity  != null ? String(i.reorder_quantity)  : '',
      condition:          i.condition         ?? '',
      unit_cost:          i.unit_cost         != null ? String(i.unit_cost)         : '',
      quantity_purchased: i.quantity_purchased!= null ? String(i.quantity_purchased): '',
      purchase_date:      i.purchase_date     ?? '',
      source:             i.source            ?? '',
      source_url:         i.source_url        ?? '',
      brand:              i.brand             ?? '',
      model:              i.model             ?? '',
      location_text:      i.location_text     ?? '',
      notes:              i.notes             ?? '',
    }
  }

  function set(field, value) {
    setForm(f => ({ ...f, [field]: value }))
    if (errors[field]) setErrors(e => ({ ...e, [field]: null }))
  }

  function validate() {
    const e = {}
    if (!form.name.trim()) e.name     = 'Name is required.'
    if (!form.category)    e.category = 'Choose a category.'
    if (form.type === 'consumable' && form.quantity_on_hand === '' && form.quantity_on_hand !== 0)
      e.quantity_on_hand = 'Enter a quantity (0 is fine).'
    if (form.type === 'durable' && form.quantity === '')
      e.quantity = 'Enter quantity.'
    return e
  }

  function buildChanges() {
    const base = {
      name:          form.name.trim(),
      category:      form.category,
      status:        form.status,
      notes:         form.notes.trim()         || null,
      source:        form.source.trim()        || null,
      source_url:    form.source_url.trim()    || null,
      purchase_date: form.purchase_date        || null,
      unit_cost:     parseNum(form.unit_cost),
      location_text: form.location_text.trim() || null,
      quantity_purchased: parseNum(form.quantity_purchased),
    }
    if (form.type === 'consumable') {
      return {
        ...base,
        quantity_on_hand:  parseNum(form.quantity_on_hand) ?? 0,
        unit:              form.unit || null,
        reorder_threshold: parseNum(form.reorder_threshold),
        reorder_quantity:  parseNum(form.reorder_quantity),
        // null out durable-only
        quantity:  null,
        condition: null,
        brand:     null,
        model:     null,
      }
    }
    // durable
    return {
      ...base,
      quantity:  parseInt(form.quantity) || 1,
      condition: form.condition || null,
      brand:     form.brand.trim()  || null,
      model:     form.model.trim()  || null,
      // null out consumable-only
      quantity_on_hand:  null,
      unit:              null,
      reorder_threshold: null,
      reorder_quantity:  null,
    }
  }

  function parseNum(val) {
    if (val === '' || val == null) return null
    const n = parseFloat(val)
    return isNaN(n) ? null : n
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  async function handleSave(e) {
    e.preventDefault()
    const errs = validate()
    if (Object.keys(errs).length) { setErrors(errs); return }

    setSaving(true)
    const { error } = await updateItem(id, buildChanges())
    setSaving(false)

    if (error) {
      setErrors({ _form: error })
    } else {
      setSavedToast(true)
      setTimeout(() => setSavedToast(false), 2500)
    }
  }

  // ── Delete (soft) ──────────────────────────────────────────────────────────
  async function handleDelete() {
    setDeleting(true)
    const { error } = await deleteItem(id)
    setDeleting(false)
    if (error) {
      setErrors({ _form: error })
      setConfirmDelete(false)
    } else {
      navigate('/inventory')
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loading) return <Shell><Spinner /></Shell>
  if (loadErr) return <Shell><ErrMsg msg={loadErr} /></Shell>
  if (!item)   return <Shell><ErrMsg msg="Item not found." /></Shell>

  const isConsumable = form.type === 'consumable'
  const visibleCats  = CATEGORIES.filter(c => c.types.includes(form.type))

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 600, margin: '0 auto', padding: '28px 16px 80px' }}>

        {/* Breadcrumb */}
        <div style={{ fontSize: '0.82rem', color: P.light, marginBottom: 8 }}>
          <Link to="/inventory" style={{ color: P.green, textDecoration: 'none' }}>Inventory</Link>
          {' › '}{item.name}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700, flex: 1 }}>
            {item.name}
          </h1>
          <FavoriteToggle entityType="inventory_item" entityId={id} />
        </div>

        {errors._form && (
          <div style={{
            backgroundColor: P.alert, border: `1px solid ${P.alertBorder}`,
            borderRadius: 8, padding: '12px 16px', marginBottom: 20,
            fontSize: '0.875rem', color: '#7a2a10',
          }}>
            {errors._form}
          </div>
        )}

        <form onSubmit={handleSave} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* ── Core fields ── */}
          <div style={card}>
            <div style={groupLabel}>Item details</div>

            <Field label="Name" error={errors.name}>
              <input
                value={form.name}
                onChange={e => set('name', e.target.value)}
                style={inputStyle(!!errors.name)}
              />
            </Field>

            <Field label="Category" error={errors.category}>
              <select
                value={form.category}
                onChange={e => set('category', e.target.value)}
                style={selectStyle(!!errors.category)}
              >
                <option value="">— Select —</option>
                {visibleCats.map(c => (
                  <option key={c.v} value={c.v}>{c.label}</option>
                ))}
              </select>
            </Field>

            <Field label="Status">
              <select
                value={form.status}
                onChange={e => set('status', e.target.value)}
                style={selectStyle(false)}
              >
                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>

            {/* Consumable quantity */}
            {isConsumable && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="Qty on hand" error={errors.quantity_on_hand}>
                  <input
                    type="number" min="0" step="any"
                    value={form.quantity_on_hand}
                    onChange={e => set('quantity_on_hand', e.target.value)}
                    style={inputStyle(!!errors.quantity_on_hand)}
                  />
                </Field>
                <Field label="Unit">
                  <select
                    value={form.unit}
                    onChange={e => set('unit', e.target.value)}
                    style={selectStyle(false)}
                  >
                    <option value="">— Unit —</option>
                    {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </Field>
              </div>
            )}

            {/* Durable quantity */}
            {!isConsumable && (
              <Field label="Quantity" error={errors.quantity}>
                <input
                  type="number" min="1" step="1"
                  value={form.quantity}
                  onChange={e => set('quantity', e.target.value)}
                  style={inputStyle(!!errors.quantity)}
                />
              </Field>
            )}
          </div>

          {/* ── Optional details ── */}
          <div style={card}>
            <div style={groupLabel}>Details</div>

            {isConsumable && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="Reorder when below">
                  <input
                    type="number" min="0" step="any"
                    value={form.reorder_threshold}
                    onChange={e => set('reorder_threshold', e.target.value)}
                    style={inputStyle(false)}
                  />
                </Field>
                <Field label="Reorder quantity">
                  <input
                    type="number" min="0" step="any"
                    value={form.reorder_quantity}
                    onChange={e => set('reorder_quantity', e.target.value)}
                    style={inputStyle(false)}
                  />
                </Field>
              </div>
            )}

            {!isConsumable && (
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
                    />
                  </Field>
                  <Field label="Model">
                    <input
                      value={form.model}
                      onChange={e => set('model', e.target.value)}
                      style={inputStyle(false)}
                    />
                  </Field>
                </div>
              </>
            )}

            <Field label="Location">
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
              <Field label="Qty purchased">
                <input
                  type="number" min="0" step="any"
                  value={form.quantity_purchased}
                  onChange={e => set('quantity_purchased', e.target.value)}
                  style={inputStyle(false)}
                />
              </Field>
            </div>

            <Field label="Source">
              <input
                value={form.source}
                onChange={e => set('source', e.target.value)}
                style={inputStyle(false)}
                placeholder="Store or vendor name"
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
              />
            </Field>
          </div>

          {/* ── Actions ── */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 4 }}>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
              <button type="submit" disabled={saving} style={btn(P.green, saving)}>
                {saving ? 'Saving…' : 'Save changes'}
              </button>
              <Link to="/inventory" style={{ color: P.mid, textDecoration: 'none', fontSize: '0.88rem' }}>
                Cancel
              </Link>
            </div>
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: P.light, fontSize: '0.82rem', textDecoration: 'underline', padding: 0,
              }}
            >
              Remove item
            </button>
          </div>
        </form>

        {/* Delete confirmation */}
        {confirmDelete && (
          <div style={{
            position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 500, padding: 20,
          }}>
            <div style={{
              backgroundColor: P.white, borderRadius: 12,
              padding: '28px 24px', maxWidth: 380, width: '100%',
              boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
            }}>
              <h2 style={{ margin: '0 0 10px', fontSize: '1.1rem', color: P.dark }}>Remove item?</h2>
              <p style={{ margin: '0 0 24px', fontSize: '0.88rem', color: P.mid }}>
                "{item.name}" will be hidden from your inventory. This can't be undone from the app.
              </p>
              <div style={{ display: 'flex', gap: 12 }}>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  style={btn(P.terra, deleting)}
                >
                  {deleting ? 'Removing…' : 'Remove'}
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  style={{
                    ...btn(P.mid, false),
                    backgroundColor: 'transparent', color: P.mid,
                    border: `1px solid ${P.border}`,
                  }}
                >
                  Keep it
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Saved toast */}
      {savedToast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          backgroundColor: P.green, color: P.white,
          padding: '12px 24px', borderRadius: 8,
          fontSize: '0.9rem', fontWeight: 600,
          boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
          zIndex: 1000, whiteSpace: 'nowrap',
        }}>
          ✓ Saved
        </div>
      )}
    </div>
  )
}

// ── Shared primitives ─────────────────────────────────────────────────────────
function Field({ label, children, error }) {
  return (
    <div>
      <label style={{
        display: 'block', fontSize: '0.78rem', fontWeight: 700, color: P.mid,
        marginBottom: 6, letterSpacing: '0.3px', textTransform: 'uppercase',
      }}>
        {label}
      </label>
      {children}
      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 5, fontSize: '0.78rem', color: P.terra }}>
          <span>⚠</span> {error}
        </div>
      )}
    </div>
  )
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: '100dvh', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 600, margin: '0 auto', padding: '28px 16px' }}>{children}</div>
    </div>
  )
}
function Spinner() {
  return <div style={{ padding: 48, textAlign: 'center', color: P.light }}>Loading…</div>
}
function ErrMsg({ msg }) {
  return <div style={{ padding: 48, textAlign: 'center', color: P.terra }}>{msg}</div>
}

const card = {
  backgroundColor: P.white, border: `1px solid ${P.border}`,
  borderRadius: 10, padding: '20px 18px',
  display: 'flex', flexDirection: 'column', gap: 16,
}
const groupLabel = {
  fontSize: '0.7rem', fontWeight: 700, color: P.greenLight,
  letterSpacing: '0.8px', textTransform: 'uppercase', marginBottom: 4,
}
const inputStyle = hasErr => ({
  width: '100%', padding: '10px 12px',
  border: `1px solid ${hasErr ? P.terra : P.border}`,
  borderRadius: 7, fontSize: '0.9rem',
  backgroundColor: P.white, boxSizing: 'border-box', fontFamily: 'inherit',
})
const selectStyle = hasErr => ({
  ...inputStyle(hasErr),
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23777' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center',
  paddingRight: 36, cursor: 'pointer',
})
const btn = (bg, disabled) => ({
  backgroundColor: disabled ? P.light : bg,
  color: P.white, border: 'none', borderRadius: 8,
  padding: '13px 30px', fontSize: '0.95rem', fontWeight: 700,
  cursor: disabled ? 'not-allowed' : 'pointer', minHeight: 48,
})
