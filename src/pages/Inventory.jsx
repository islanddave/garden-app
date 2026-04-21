import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'
import { P, INVENTORY_SUBCATEGORIES } from '../lib/constants.js'

// ============================================================
// Inventory — v0.1
//
// Two item types:
//   consumable — seeds, soil, fertilizer, pest_control, containers
//   equipment  — lighting, shelving, hand_tools, containers, misc
//
// stock_status is computed (NOT stored):
//   depleted → quantity is null or 0
//   low      → quantity <= quantity_min (and quantity_min set)
//   ok       → everything else
//
// lifecycle_status is stored:
//   active | retired
//
// current_inventory_value = SUM(purchase_price) WHERE lifecycle_status = 'active'
// This is active spend only — NOT total historical spend.
//
// RLS: permissive (auth.uid() IS NOT NULL).
// Safe ONLY because Supabase Auth is restricted to islanddave@gmail.com.
// ============================================================

// ---- Stock status computation (consumable-only) ----
function stockStatus(item) {
  if (item.item_type !== 'consumable') return null
  const q = item.quantity
  if (q === null || q === undefined || q === 0) return 'depleted'
  if (item.quantity_min !== null && item.quantity_min !== undefined && q <= item.quantity_min) return 'low'
  return 'ok'
}

// ---- Default empty form ----
function emptyForm(type = 'consumable') {
  return {
    name:          '',
    item_type:     type,
    subcategory:   '',
    quantity:      '',
    quantity_unit: '',
    quantity_min:  '',
    condition:     '',
    purchase_price:'',
    purchase_date: '',
    vendor:        '',
    vendor_url:    '',
    expires_at:    '',
    location_id:   '',
    location_note: '',
    notes:         '',
  }
}

// ---- Map form → DB row (enforce type-specific nulling) ----
function formToRow(f) {
  const isConsumable = f.item_type === 'consumable'
  const isEquipment  = f.item_type === 'equipment'
  return {
    name:          f.name.trim(),
    item_type:     f.item_type,
    subcategory:   f.subcategory  || null,
    quantity:      isConsumable ? (f.quantity !== '' ? parseFloat(f.quantity) : null) : null,
    quantity_unit: isConsumable ? (f.quantity_unit.trim() || null) : null,
    quantity_min:  isConsumable ? (f.quantity_min !== '' ? parseFloat(f.quantity_min) : null) : null,
    condition:     isEquipment  ? (f.condition    || null) : null,
    purchase_price:f.purchase_price !== '' ? parseFloat(f.purchase_price) : null,
    purchase_date: f.purchase_date  || null,
    vendor:        f.vendor.trim()  || null,
    vendor_url:    f.vendor_url.trim() || null,
    expires_at:    isConsumable ? (f.expires_at || null) : null,
    location_id:   f.location_id   || null,
    location_note: f.location_note.trim() || null,
    notes:         f.notes.trim()   || null,
  }
}

// ============================================================
// Main page
// ============================================================
export default function Inventory() {
  const [items,        setItems]        = useState([])
  const [locations,    setLocations]    = useState([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState(null)
  const [showForm,     setShowForm]     = useState(false)
  const [editItem,     setEditItem]     = useState(null)   // null = create; item = edit
  const [showRetired,  setShowRetired]  = useState(false)
  const [typeFilter,   setTypeFilter]   = useState('all')  // 'all'|'consumable'|'equipment'
  const [saving,       setSaving]       = useState(false)
  const [formError,    setFormError]    = useState(null)
  const [form,         setForm]         = useState(emptyForm())
  const [toast,        setToast]        = useState(null)   // { msg, color }

  // ---- Toast helper (3-second auto-dismiss) ----
  function showToast(msg, color = P.green) {
    setToast({ msg, color })
    setTimeout(() => setToast(null), 3000)
  }

  // ---- Load ----
  const load = useCallback(async () => {
    const [
      { data: invData, error: invErr },
      { data: locData, error: locErr },
    ] = await Promise.all([
      supabase
        .from('inventory')
        .select('*')
        .order('name', { ascending: true }),
      supabase
        .from('locations_with_path')
        .select('id, full_path, level, is_active')
        .eq('is_active', true)
        .in('level', [0, 1])
        .order('full_path'),
    ])
    if (invErr || locErr) {
      setError((invErr || locErr).message)
    } else {
      setItems(invData ?? [])
      setLocations(locData ?? [])
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // ---- CRUD handlers ----
  async function handleCreate(e) {
    e.preventDefault()
    setSaving(true)
    setFormError(null)
    const { error } = await supabase.from('inventory').insert(formToRow(form))
    setSaving(false)
    if (error) {
      setFormError(error.message)
    } else {
      setShowForm(false)
      setForm(emptyForm())
      showToast(`"${form.name}" added to inventory`)
      load()
    }
  }

  async function handleUpdate(e) {
    e.preventDefault()
    setSaving(true)
    setFormError(null)
    const { error } = await supabase
      .from('inventory')
      .update(formToRow(form))
      .eq('id', editItem.id)
    setSaving(false)
    if (error) {
      setFormError(error.message)
    } else {
      setEditItem(null)
      setShowForm(false)
      setForm(emptyForm())
      showToast(`"${form.name}" updated`)
      load()
    }
  }

  async function handleRetire(item) {
    await supabase.from('inventory').update({ lifecycle_status: 'retired' }).eq('id', item.id)
    showToast(`"${item.name}" retired`, P.light)
    load()
  }

  async function handleReactivate(item) {
    await supabase.from('inventory').update({ lifecycle_status: 'active' }).eq('id', item.id)
    showToast(`"${item.name}" restored to active`)
    load()
  }

  function openEdit(item) {
    setEditItem(item)
    setForm({
      name:          item.name          ?? '',
      item_type:     item.item_type     ?? 'consumable',
      subcategory:   item.subcategory   ?? '',
      quantity:      item.quantity      != null ? String(item.quantity) : '',
      quantity_unit: item.quantity_unit ?? '',
      quantity_min:  item.quantity_min  != null ? String(item.quantity_min) : '',
      condition:     item.condition     ?? '',
      purchase_price:item.purchase_price != null ? String(item.purchase_price) : '',
      purchase_date: item.purchase_date ?? '',
      vendor:        item.vendor        ?? '',
      vendor_url:    item.vendor_url    ?? '',
      expires_at:    item.expires_at    ?? '',
      location_id:   item.location_id   ?? '',
      location_note: item.location_note ?? '',
      notes:         item.notes         ?? '',
    })
    setShowForm(true)
    setFormError(null)
  }

  function cancelForm() {
    setShowForm(false)
    setEditItem(null)
    setForm(emptyForm())
    setFormError(null)
  }

  // ---- Partition items ----
  const activeItems  = items.filter(i => i.lifecycle_status === 'active')
  const retiredItems = items.filter(i => i.lifecycle_status === 'retired')

  const filteredActive = typeFilter === 'all'
    ? activeItems
    : activeItems.filter(i => i.item_type === typeFilter)

  const needsReorder = activeItems.filter(i => {
    const s = stockStatus(i)
    return s === 'depleted' || s === 'low'
  })

  const totalValue = activeItems.reduce((sum, i) => sum + (i.purchase_price ?? 0), 0)

  const locMap = Object.fromEntries(locations.map(l => [l.id, l.full_path]))

  if (loading) return <Shell><Spinner /></Shell>
  if (error)   return <Shell><ErrMsg msg={error} /></Shell>

  return (
    <Shell>
      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: 16, right: 20, zIndex: 9999,
          backgroundColor: toast.color, color: P.white,
          padding: '10px 18px', borderRadius: 8,
          fontSize: '0.88rem', fontWeight: 600,
          boxShadow: '0 2px 12px rgba(0,0,0,0.15)',
        }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>Inventory</h1>
          <p style={{ margin: '4px 0 0', color: P.light, fontSize: '0.85rem' }}>
            {activeItems.length} active items · ${totalValue.toFixed(2)} value
            {needsReorder.length > 0 && (
              <span style={{ color: P.terra, marginLeft: 8, fontWeight: 600 }}>
                · {needsReorder.length} need reorder
              </span>
            )}
          </p>
        </div>
        <button
          onClick={() => {
            if (showForm && !editItem) { cancelForm() } else { cancelForm(); setShowForm(true) }
          }}
          style={btn(showForm && !editItem ? P.light : P.green)}
        >
          {showForm && !editItem ? 'Cancel' : '+ Add item'}
        </button>
      </div>

      {/* Reorder banner */}
      {needsReorder.length > 0 && (
        <div style={{
          backgroundColor: '#fde8e0', border: `1px solid ${P.alertBorder}`,
          borderRadius: 8, padding: '10px 16px', marginBottom: 16,
          fontSize: '0.85rem', color: '#7a2a10',
        }}>
          <strong>Needs reorder:</strong>{' '}
          {needsReorder.map(i => (
            <span key={i.id} style={{ marginRight: 10 }}>
              {stockStatus(i) === 'depleted' ? '🔴' : '🟡'} {i.name}
            </span>
          ))}
        </div>
      )}

      {/* Create / Edit form */}
      {showForm && (
        <ItemForm
          form={form} setForm={setForm}
          locations={locations}
          saving={saving} formError={formError}
          isEdit={!!editItem}
          onSubmit={editItem ? handleUpdate : handleCreate}
          onCancel={cancelForm}
        />
      )}

      {/* Filter bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <TypeFilterBar value={typeFilter} onChange={setTypeFilter} />
      </div>

      {/* Active items */}
      {filteredActive.length > 0 ? (
        <section style={{ marginBottom: 24 }}>
          {filteredActive.map(item => (
            <ItemCard
              key={item.id}
              item={item}
              locMap={locMap}
              onEdit={openEdit}
              onRetire={handleRetire}
            />
          ))}
        </section>
      ) : (
        <Empty msg={
          typeFilter !== 'all'
            ? `No active ${typeFilter} items. Hit '+ Add item' to get started.`
            : "No inventory items yet. Hit '+ Add item' to add your first."
        } />
      )}

      {/* Retired items (collapsed by default) */}
      {retiredItems.length > 0 && (
        <section style={{ marginTop: 8 }}>
          <button
            onClick={() => setShowRetired(s => !s)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: P.mid, fontSize: '0.8rem', padding: '4px 0',
              textDecoration: 'underline',
            }}
          >
            {showRetired
              ? `Hide retired items (${retiredItems.length})`
              : `Show retired items (${retiredItems.length})`}
          </button>
          {showRetired && retiredItems.map(item => (
            <ItemCard
              key={item.id}
              item={item}
              locMap={locMap}
              onReactivate={handleReactivate}
              retired
            />
          ))}
        </section>
      )}
    </Shell>
  )
}

// ============================================================
// Item form — progressive disclosure
// Required fields shown first; optional details behind "Add details" toggle
// ============================================================
function ItemForm({ form, setForm, locations, saving, formError, isEdit, onSubmit, onCancel }) {
  const [showDetails, setShowDetails] = useState(isEdit)

  const isConsumable = form.item_type === 'consumable'
  const isEquipment  = form.item_type === 'equipment'

  const filteredSubs = INVENTORY_SUBCATEGORIES.filter(s => s.types.includes(form.item_type))

  return (
    <form onSubmit={onSubmit} style={card}>
      <h2 style={{ margin: '0 0 18px', fontSize: '1rem', fontWeight: 700, color: P.dark }}>
        {isEdit ? 'Edit item' : 'Add inventory item'}
      </h2>
      {formError && <ErrBanner msg={formError} />}

      {/* Type selector — tile buttons */}
      {!isEdit && (
        <FormRow label="Item type *">
          <div style={{ display: 'flex', gap: 8 }}>
            {[
              { v: 'consumable', label: '🌱 Supplies', sub: 'seeds, soil, fertilizer…' },
              { v: 'equipment',  label: '🔧 Equipment', sub: 'lights, shelves, tools…' },
            ].map(opt => (
              <button
                key={opt.v}
                type="button"
                onClick={() => setForm(f => ({
                  ...emptyForm(opt.v),
                  name: f.name,  // preserve name across type switch
                }))}
                style={{
                  flex: 1, padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                  border: `2px solid ${form.item_type === opt.v ? P.green : P.border}`,
                  backgroundColor: form.item_type === opt.v ? P.greenPale : P.white,
                  textAlign: 'left',
                }}
              >
                <div style={{ fontWeight: 700, fontSize: '0.88rem', color: form.item_type === opt.v ? P.green : P.dark }}>
                  {opt.label}
                </div>
                <div style={{ fontSize: '0.75rem', color: P.light, marginTop: 2 }}>{opt.sub}</div>
              </button>
            ))}
          </div>
        </FormRow>
      )}

      {/* Name (always required) */}
      <FormRow label="Name *">
        <input
          required
          value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          style={input}
          placeholder={isConsumable ? 'e.g. Stupice tomato seeds' : 'e.g. Barrina T5 grow light'}
        />
      </FormRow>

      {/* Consumable quantity row */}
      {isConsumable && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <FormRow label="Quantity *">
            <input
              type="number" min="0" step="any"
              required
              value={form.quantity}
              onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))}
              style={{ ...input, width: '100%' }}
              placeholder="e.g. 50"
            />
          </FormRow>
          <FormRow label="Unit">
            <input
              value={form.quantity_unit}
              onChange={e => setForm(f => ({ ...f, quantity_unit: e.target.value }))}
              style={{ ...input, width: '100%' }}
              placeholder="seeds, oz, g, pkg…"
            />
          </FormRow>
          <FormRow label="Reorder at (min)">
            <input
              type="number" min="0" step="any"
              value={form.quantity_min}
              onChange={e => setForm(f => ({ ...f, quantity_min: e.target.value }))}
              style={{ ...input, width: '100%' }}
              placeholder="e.g. 10"
            />
          </FormRow>
        </div>
      )}

      {/* Equipment condition */}
      {isEquipment && (
        <FormRow label="Condition">
          <select
            value={form.condition}
            onChange={e => setForm(f => ({ ...f, condition: e.target.value }))}
            style={input}
          >
            <option value="">— Select condition —</option>
            <option value="new">New</option>
            <option value="good">Good</option>
            <option value="fair">Fair</option>
            <option value="poor">Poor</option>
          </select>
        </FormRow>
      )}

      {/* Progressive disclosure toggle */}
      {!showDetails && (
        <button
          type="button"
          onClick={() => setShowDetails(true)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: P.green, fontSize: '0.82rem', fontWeight: 600,
            padding: '4px 0', marginBottom: 8, textDecoration: 'underline',
          }}
        >
          + Add details (subcategory, cost, location…)
        </button>
      )}

      {/* Details section */}
      {showDetails && (
        <>
          <FormRow label="Subcategory">
            <select
              value={form.subcategory}
              onChange={e => setForm(f => ({ ...f, subcategory: e.target.value }))}
              style={input}
            >
              <option value="">— None —</option>
              {filteredSubs.map(s => (
                <option key={s.v} value={s.v}>{s.label}</option>
              ))}
            </select>
          </FormRow>

          {isConsumable && (
            <FormRow label="Expires">
              <input
                type="date"
                value={form.expires_at}
                onChange={e => setForm(f => ({ ...f, expires_at: e.target.value }))}
                style={{ ...input, width: '100%' }}
              />
            </FormRow>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <FormRow label="Purchase price ($)">
              <input
                type="number" min="0" step="0.01"
                value={form.purchase_price}
                onChange={e => setForm(f => ({ ...f, purchase_price: e.target.value }))}
                style={{ ...input, width: '100%' }}
                placeholder="0.00"
              />
            </FormRow>
            <FormRow label="Purchase date">
              <input
                type="date"
                value={form.purchase_date}
                onChange={e => setForm(f => ({ ...f, purchase_date: e.target.value }))}
                style={{ ...input, width: '100%' }}
              />
            </FormRow>
            <FormRow label="Vendor">
              <input
                value={form.vendor}
                onChange={e => setForm(f => ({ ...f, vendor: e.target.value }))}
                style={{ ...input, width: '100%' }}
                placeholder="e.g. Johnny's Seeds"
              />
            </FormRow>
          </div>

          <FormRow label="Vendor URL">
            <input
              type="url"
              value={form.vendor_url}
              onChange={e => setForm(f => ({ ...f, vendor_url: e.target.value }))}
              style={input}
              placeholder="https://…"
            />
          </FormRow>

          <FormRow label="Location">
            <select
              value={form.location_id}
              onChange={e => setForm(f => ({ ...f, location_id: e.target.value }))}
              style={input}
            >
              <option value="">— No location —</option>
              {locations.map(l => (
                <option key={l.id} value={l.id}>{l.full_path}</option>
              ))}
            </select>
          </FormRow>

          <FormRow label="Location note (shelf/bin/slot)">
            <input
              value={form.location_note}
              onChange={e => setForm(f => ({ ...f, location_note: e.target.value }))}
              style={input}
              placeholder="e.g. Shelf 2, left bin"
            />
          </FormRow>

          <FormRow label="Notes">
            <textarea
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              style={{ ...input, minHeight: 64, resize: 'vertical' }}
              placeholder="Any notes about this item…"
            />
          </FormRow>
        </>
      )}

      <div style={{ marginTop: 20, display: 'flex', gap: 10 }}>
        <button type="submit" disabled={saving} style={btn(saving ? P.light : P.green)}>
          {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add to inventory'}
        </button>
        <button type="button" onClick={onCancel} style={btn(P.mid)}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// ============================================================
// Item card
// ============================================================
function ItemCard({ item, locMap, onEdit, onRetire, onReactivate, retired = false }) {
  const status = stockStatus(item)

  const stockBadge = {
    depleted: { bg: P.alert,     color: '#7a2a10', border: P.alertBorder, label: '🔴 depleted' },
    low:      { bg: '#fff8e6',   color: '#7a5c00', border: P.warnBorder,  label: '🟡 low stock' },
    ok:       { bg: P.greenPale, color: P.green,   border: P.greenLight,  label: '✓ ok' },
  }
  const sb = status ? stockBadge[status] : null

  const conditionColor = {
    new:  P.green,
    good: P.greenLight,
    fair: P.gold,
    poor: P.terra,
  }

  return (
    <div style={{
      backgroundColor: retired ? '#fafafa' : P.white,
      border: `1px solid ${retired ? '#e0e0e0' : P.border}`,
      borderRadius: 8, padding: '12px 16px', marginBottom: 8,
      display: 'flex', alignItems: 'flex-start', gap: 12,
      opacity: retired ? 0.7 : 1,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Name + badges */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, color: retired ? P.light : P.dark, fontSize: '0.92rem' }}>
            {item.name}
          </span>
          {/* Type badge */}
          <span style={{
            fontSize: '0.7rem', fontWeight: 600, borderRadius: 10, padding: '1px 7px',
            backgroundColor: item.item_type === 'consumable' ? P.greenPale : '#eef2ff',
            color: item.item_type === 'consumable' ? P.green : P.blue,
            border: `1px solid ${item.item_type === 'consumable' ? P.greenLight : '#93afd8'}`,
          }}>
            {item.item_type === 'consumable' ? '🌱 supplies' : '🔧 equipment'}
          </span>
          {/* Stock badge (consumable only) */}
          {sb && (
            <span style={{
              fontSize: '0.7rem', fontWeight: 600, borderRadius: 10, padding: '1px 7px',
              backgroundColor: sb.bg, color: sb.color, border: `1px solid ${sb.border}`,
            }}>
              {sb.label}
            </span>
          )}
          {/* Condition badge (equipment only) */}
          {item.condition && (
            <span style={{
              fontSize: '0.7rem', fontWeight: 600, borderRadius: 10, padding: '1px 7px',
              backgroundColor: '#f5f5f5', color: conditionColor[item.condition] ?? P.mid,
              border: `1px solid ${conditionColor[item.condition] ?? P.border}`,
            }}>
              {item.condition}
            </span>
          )}
          {retired && (
            <span style={{
              fontSize: '0.7rem', fontWeight: 600, borderRadius: 10, padding: '1px 7px',
              backgroundColor: '#f0f0f0', color: P.light, border: '1px solid #ccc',
            }}>
              retired
            </span>
          )}
        </div>

        {/* Meta row */}
        <div style={{ display: 'flex', gap: 14, marginTop: 5, flexWrap: 'wrap' }}>
          {item.subcategory && (
            <span style={{ fontSize: '0.78rem', color: P.mid }}>
              {subcategoryLabel(item.subcategory)}
            </span>
          )}
          {item.item_type === 'consumable' && item.quantity !== null && (
            <span style={{ fontSize: '0.78rem', color: P.mid }}>
              Qty: <strong>{item.quantity}</strong>{item.quantity_unit ? ` ${item.quantity_unit}` : ''}
              {item.quantity_min !== null && ` (min: ${item.quantity_min})`}
            </span>
          )}
          {item.purchase_price !== null && (
            <span style={{ fontSize: '0.78rem', color: P.mid }}>
              ${Number(item.purchase_price).toFixed(2)}
              {item.vendor ? ` · ${item.vendor}` : ''}
            </span>
          )}
          {item.location_id && locMap[item.location_id] && (
            <span style={{ fontSize: '0.78rem', color: P.mid }}>
              📍 {locMap[item.location_id]}
              {item.location_note ? ` · ${item.location_note}` : ''}
            </span>
          )}
          {item.expires_at && (
            <span style={{ fontSize: '0.78rem', color: isExpiringSoon(item.expires_at) ? P.terra : P.light }}>
              Exp: {item.expires_at}
            </span>
          )}
        </div>

        {item.notes && (
          <p style={{ margin: '6px 0 0', fontSize: '0.82rem', color: P.mid, lineHeight: 1.4 }}>
            {item.notes}
          </p>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {!retired ? (
          <>
            <button onClick={() => onEdit(item)} style={actionBtn(P.mid)}>Edit</button>
            <button onClick={() => onRetire(item)} style={actionBtn(P.light)}>Retire</button>
          </>
        ) : (
          <button onClick={() => onReactivate(item)} style={actionBtn(P.green)}>Restore</button>
        )}
      </div>
    </div>
  )
}

// ============================================================
// Type filter bar
// ============================================================
function TypeFilterBar({ value, onChange }) {
  const opts = [
    { v: 'all',        label: 'All' },
    { v: 'consumable', label: '🌱 Supplies' },
    { v: 'equipment',  label: '🔧 Equipment' },
  ]
  return (
    <div style={{ display: 'flex', gap: 4, backgroundColor: P.border, borderRadius: 6, padding: 3 }}>
      {opts.map(o => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          style={{
            background: value === o.v ? P.white : 'none',
            border: 'none', borderRadius: 4,
            padding: '4px 12px',
            fontSize: '0.8rem',
            fontWeight: value === o.v ? 600 : 400,
            color: value === o.v ? P.dark : P.mid,
            cursor: 'pointer',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ============================================================
// Helpers
// ============================================================
function subcategoryLabel(v) {
  const found = INVENTORY_SUBCATEGORIES.find(s => s.v === v)
  return found ? found.label : v
}

function isExpiringSoon(dateStr) {
  if (!dateStr) return false
  const expires = new Date(dateStr)
  const now = new Date()
  const days = (expires - now) / (1000 * 60 * 60 * 24)
  return days < 60
}

// ============================================================
// Shared UI primitives
// ============================================================
function Shell({ children }) {
  return (
    <div style={{ minHeight: 'calc(100vh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 800, margin: '0 auto', padding: '32px 20px' }}>{children}</div>
    </div>
  )
}
function Spinner() {
  return <div style={{ padding: 48, textAlign: 'center', color: P.light }}>Loading…</div>
}
function ErrMsg({ msg }) {
  return <div style={{ padding: 48, textAlign: 'center', color: P.terra }}>{msg}</div>
}
function ErrBanner({ msg }) {
  return (
    <div style={{
      backgroundColor: P.alert, border: `1px solid ${P.alertBorder}`,
      borderRadius: 6, padding: '10px 14px', marginBottom: 16,
      fontSize: '0.875rem', color: '#7a2a10',
    }}>
      {msg}
    </div>
  )
}
function Empty({ msg }) {
  return (
    <div style={{
      textAlign: 'center', color: P.light, padding: '40px 20px',
      fontSize: '0.875rem', backgroundColor: P.white,
      border: `1px solid ${P.border}`, borderRadius: 8,
    }}>
      {msg}
    </div>
  )
}
function FormRow({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: P.mid, marginBottom: 5 }}>
        {label}
      </label>
      {children}
    </div>
  )
}

const btn = (bg) => ({
  backgroundColor: bg, color: P.white, border: 'none', borderRadius: 6,
  padding: '9px 18px', fontSize: '0.88rem', fontWeight: 600,
  cursor: bg === P.light ? 'default' : 'pointer',
  whiteSpace: 'nowrap',
})
const actionBtn = (color) => ({
  background: 'none', border: `1px solid ${color}`, color,
  borderRadius: 5, padding: '4px 11px',
  fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
  whiteSpace: 'nowrap',
})
const input = {
  width: '100%', padding: '8px 11px', border: `1px solid ${P.border}`,
  borderRadius: 6, fontSize: '0.88rem', backgroundColor: P.white,
  boxSizing: 'border-box',
}
const card = {
  backgroundColor: P.white, border: `1px solid ${P.border}`,
  borderRadius: 10, padding: 24, marginBottom: 24,
}
