import React, { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useInventory } from '../hooks/useInventory.js'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import FavoriteToggle from '../components/FavoriteToggle.jsx'
import PhotoUpload from '../components/PhotoUpload.jsx'
import { INVENTORY_CATEGORIES as CATEGORIES, INVENTORY_UNITS as UNITS, INVENTORY_CONDITIONS as CONDITIONS, INVENTORY_STATUSES as STATUSES } from '../lib/inventoryEnums.js'
import { EnumSelect, Field, Input, Textarea, Button } from '../components/forms'

// Inventory enums centralized in src/lib/inventoryEnums.js (live prod CHECK sets);
// the former local duplicates here were removed (Lane D dedup).

// ── Main page ─────────────────────────────────────────────────────────────────
export default function InventoryDetail() {
  const { id }       = useParams()
  const navigate     = useNavigate()
  const { updateItem, deleteItem } = useInventory()
  const { fetch } = useApiFetch()

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
    let mounted = true
    setLoading(true)
    setLoadErr(null)
    fetch('/api/inventory-items/' + id)
      .then(data => {
        if (!mounted) return
        setItem(data)
        setForm(itemToForm(data))
        setLoading(false)
      })
      .catch(err => {
        if (!mounted) return
        setLoadErr(err?.status === 404
          ? 'Item not found — it may have been removed.'
          : (err?.message ?? 'Failed to load item.'))
        setLoading(false)
      })
    return () => { mounted = false }
  }, [id, fetch])

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
    .slice().sort((a, b) => a.label.localeCompare(b.label))

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

        {/* Plant-from-packet CTA — VARIETY-REF S4b.
            Visible only for seed packets with stock on hand. Tap-target ≥44px (Jen iPhone-primary).
            Carries source_inventory_item_id + variety_id as query params; Garden reads them and
            opens the PlantingEditor add form pre-filled. */}
        {item.category === 'seeds' && Number(item.quantity_on_hand ?? 0) > 0 && (
          <PlantFromPacketCTA
            item={item}
            onClick={() => {
              const params = new URLSearchParams()
              params.set('source_inventory_item_id', item.id)
              if (item.variety_id) params.set('variety_id', item.variety_id)
              navigate(`/garden?${params.toString()}`)
            }}
          />
        )}

        {/* V2-PHOTO-F1 Session 2: inventory item photo upload.
            Belongs just below the S4b Plant-from-packet CTA per Session 2 spec.
            Useful for capturing seed-packet photos, durable-tool photos, etc. */}
        <div style={{
          marginBottom: 20, padding: '14px 16px',
          backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10,
        }}>
          <div style={{ fontSize: '0.78rem', fontWeight: 700, color: P.mid, marginBottom: 10,
                        letterSpacing: '0.3px', textTransform: 'uppercase' }}>
            Photo
          </div>
          <PhotoUpload
            keyPrefix="inventory"
            parentId={item.id}
            linkage={{ inventory_item_id: item.id }}
            errorMode="surface"
            mode="both"
            inputId={`inventory-photo-${item.id}`}
          />
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
              <Input
                value={form.name}
                onChange={e => set('name', e.target.value)}
                error={!!errors.name}
              />
            </Field>

            <Field label="Category" error={errors.category}>
              <EnumSelect
                value={form.category}
                onChange={e => set('category', e.target.value)}
                error={errors.category}
                enumValues={visibleCats}
                placeholder="— Select —"
              />
            </Field>

            <Field label="Status">
              <EnumSelect
                value={form.status}
                onChange={e => set('status', e.target.value)}
                enumValues={STATUSES}
              />
            </Field>

            {/* Consumable quantity */}
            {isConsumable && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="Qty on hand" error={errors.quantity_on_hand}>
                  <Input
                    type="number" min="0" step="any"
                    value={form.quantity_on_hand}
                    onChange={e => set('quantity_on_hand', e.target.value)}
                    error={!!errors.quantity_on_hand}
                  />
                </Field>
                <Field label="Unit">
                  <EnumSelect
                    value={form.unit}
                    onChange={e => set('unit', e.target.value)}
                    enumValues={UNITS}
                    placeholder="— Unit —"
                  />
                </Field>
              </div>
            )}

            {/* Durable quantity */}
            {!isConsumable && (
              <Field label="Quantity" error={errors.quantity}>
                <Input
                  type="number" min="1" step="1"
                  value={form.quantity}
                  onChange={e => set('quantity', e.target.value)}
                  error={!!errors.quantity}
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
                  <Input
                    type="number" min="0" step="any"
                    value={form.reorder_threshold}
                    onChange={e => set('reorder_threshold', e.target.value)}
                  />
                </Field>
                <Field label="Reorder quantity">
                  <Input
                    type="number" min="0" step="any"
                    value={form.reorder_quantity}
                    onChange={e => set('reorder_quantity', e.target.value)}
                  />
                </Field>
              </div>
            )}

            {!isConsumable && (
              <>
                <Field label="Condition">
                  <EnumSelect
                    value={form.condition}
                    onChange={e => set('condition', e.target.value)}
                    enumValues={CONDITIONS}
                    placeholder="— Optional —"
                  />
                </Field>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Field label="Brand">
                    <Input
                      value={form.brand}
                      onChange={e => set('brand', e.target.value)}
                    />
                  </Field>
                  <Field label="Model">
                    <Input
                      value={form.model}
                      onChange={e => set('model', e.target.value)}
                    />
                  </Field>
                </div>
              </>
            )}

            <Field label="Location">
              <Input
                value={form.location_text}
                onChange={e => set('location_text', e.target.value)}
                placeholder="e.g. Stable rack, shelf 2"
              />
            </Field>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Unit cost ($)">
                <Input
                  type="number" min="0" step="0.01"
                  value={form.unit_cost}
                  onChange={e => set('unit_cost', e.target.value)}
                  placeholder="0.00"
                />
              </Field>
              <Field label="Qty purchased">
                <Input
                  type="number" min="0" step="any"
                  value={form.quantity_purchased}
                  onChange={e => set('quantity_purchased', e.target.value)}
                />
              </Field>
            </div>

            <Field label="Source">
              <Input
                value={form.source}
                onChange={e => set('source', e.target.value)}
                placeholder="Store or vendor name"
              />
            </Field>

            <Field label="Source URL">
              <Input
                type="url"
                value={form.source_url}
                onChange={e => set('source_url', e.target.value)}
                placeholder="https://…"
              />
            </Field>

            <Field label="Purchase date">
              <Input
                type="date"
                value={form.purchase_date}
                onChange={e => set('purchase_date', e.target.value)}
              />
            </Field>

            <Field label="Notes">
              <Textarea
                value={form.notes}
                onChange={e => set('notes', e.target.value)}
              />
            </Field>
          </div>

          {/* ── Actions ── */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 4 }}>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
              <Button type="submit" variant="primary" loading={saving} loadingLabel="Saving…">
                Save changes
              </Button>
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
                <Button
                  variant="danger"
                  loading={deleting}
                  loadingLabel="Removing…"
                  onClick={handleDelete}
                >
                  Remove
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setConfirmDelete(false)}
                >
                  Keep it
                </Button>
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
function PlantFromPacketCTA({ item, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Plant from ${item.name}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        marginBottom: 20,
        padding: '14px 16px',
        backgroundColor: P.greenPale,
        border: `2px solid ${P.green}`,
        borderRadius: 10,
        cursor: 'pointer',
        minHeight: 56,
        textAlign: 'left',
        fontFamily: 'inherit',
      }}
    >
      <span aria-hidden="true" style={{ fontSize: '1.4rem', lineHeight: 1 }}>🌱</span>
      <span style={{ flex: 1 }}>
        <span style={{ display: 'block', fontWeight: 700, color: P.green, fontSize: '0.95rem' }}>
          Plant from this packet
        </span>
        <span style={{ display: 'block', fontSize: '0.78rem', color: P.mid, marginTop: 2 }}>
          Opens a new plant pre-filled with this variety.
        </span>
      </span>
      <span aria-hidden="true" style={{ color: P.green, fontSize: '1.1rem' }}>›</span>
    </button>
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
