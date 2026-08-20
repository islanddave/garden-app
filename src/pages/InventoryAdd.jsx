import React from 'react'
import { useState, useEffect, useId, useRef } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useInventory } from '../hooks/useInventory.js'
import { P } from '../lib/constants.js'
import { useToast } from '../context/ToastContext.jsx'
import VarietyPicker from '../components/VarietyPicker.jsx'
import { readDraft, writeDraft, clearDraft } from '../lib/draftStash.js'
import { useReportOverlayDirty } from '../context/OverlayContext.jsx'
import { setReloadBlocked } from '../lib/reloadGate.js'

import { INVENTORY_TYPES as TYPES, INVENTORY_CATEGORIES as CATEGORIES, INVENTORY_UNITS as UNITS, INVENTORY_CONDITIONS as CONDITIONS } from '../lib/inventoryEnums.js'
import { EnumSelect, Field, Input, Textarea, Button } from '../components/forms'
import ChoiceGrid from '../components/forms/ChoiceGrid.jsx'

// V4-DIRTYGUARDSWEEP-001 — draft-stash route key (siblings: 'logone', 'logmany').
const DRAFT_KEY = 'inventoryadd'

// The free-text fields, named once. Consumed by the guard predicate only — the stash is broader and
// takes the whole form object.
const TEXT_FIELDS = ['name', 'brand', 'model', 'source', 'source_url', 'notes', 'location_text']

// ── Main page ────────────────────────────────────────────────────────────────
export default function InventoryAdd() {
  const navigate = useNavigate()
  const { createItem } = useInventory()
  const { show } = useToast()

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
    // Variety reference (CHECK constraint chk_inventory_seed_requires_variety:
    // category='seeds' requires variety_id NOT NULL).
    variety:          null, // full variety object — flattens to variety_id on submit
  })

  const [showFull,      setShowFull]      = useState(false)
  const [saving,        setSaving]        = useState(false)
  const [errors,        setErrors]        = useState({})
  const [typeWarning,   setTypeWarning]   = useState(false) // pending type switch

  // V4-DIRTYGUARDSWEEP-001 — restore an interrupted draft, one-shot on mount. `showFull` rides along
  // so a restored draft whose only content is inside the collapsed "Add more details" pane does not
  // come back invisible (same failure EventNew guards with showAddDetails/showHarvestMore).
  useEffect(() => {
    const draft = readDraft(DRAFT_KEY)
    if (!draft?.form) return
    setForm(f => ({ ...f, ...draft.form }))
    if (draft.showFull) setShowFull(true)
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // STASH predicate — BROAD, and unusually simple here because EVERY field of this form is empty on
  // a pristine mount (19 keys: 18 empty strings and `variety: null`). Nothing is seeded, so "any
  // field at all" is both the broadest and the narrowest honest predicate, and over-capturing costs
  // nothing: handleSubmit clears the draft on success, so there is no stale post-save rewrite.
  const hasDraftContent = Object.values(form).some(v => (v ?? '') !== '')

  useEffect(() => {
    if (hasDraftContent) writeDraft(DRAFT_KEY, { form, showFull })
  }, [hasDraftContent, form, showFull])

  // GUARD predicate — SEPARATE and NARROWER: free text plus the staged variety object. The enum
  // pickers (type/category/unit/condition) and the numeric fields are excluded, not because losing
  // them is fine but because the stash above already restores them and each extra term is another
  // chance to hold a service-worker update for a user who only tapped "Consumable" and walked away.
  // A false-positive guard costs a held update and a dead backdrop; that is the expensive direction.
  const hasUnsavedInput = !!(
    TEXT_FIELDS.some(k => (form[k] ?? '').trim()) || form.variety
  )

  useReportOverlayDirty(hasUnsavedInput)

  // /inventory/add is not an overlayable route today, so the hook above is a strict no-op and the
  // reload gate below is what actually protects this page. Per-instance key + BOOLEAN dep for the
  // reasons EventNew.jsx:933-941 records.
  const reloadGateKey = `inventory-add:${useId()}`
  useEffect(() => {
    setReloadBlocked(reloadGateKey, hasUnsavedInput)
    return () => setReloadBlocked(reloadGateKey, false)
  }, [reloadGateKey, hasUnsavedInput])

  // BUG-INVADDNAVLEAK-001 — the post-toast navigate is component-lifetime-owned, same shape as
  // Garden.jsx's editorScrollTimerRef. `useNavigate()`'s function dispatches through the router's
  // shared history and does NOT care whether this component is still mounted, so an uncleared timer
  // does not warn or throw — it silently yanks the user back to /inventory 2.5s after they tapped
  // away from the toast, which is exactly the freedom a non-blocking toast is supposed to buy them.
  const navTimerRef = useRef(null)
  useEffect(() => () => clearTimeout(navTimerRef.current), [])

  const visibleCategories = (form.type
    ? CATEGORIES.filter(c => c.types.includes(form.type))
    : CATEGORIES
  ).slice().sort((a, b) => a.label.localeCompare(b.label))

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
    // CHECK chk_inventory_seed_requires_variety — UI enforcement.
    if (form.category === 'seeds' && !form.variety) {
      e.variety = 'Pick or create the seed variety so the packet links to a plant.'
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

      clearDraft(DRAFT_KEY)   // the item exists — the working draft is spent

      // Operational confirmation via the GLOBAL toast layer (2500ms), then navigate.
      show({ message: '✓ Item added' })
      navTimerRef.current = setTimeout(() => {
        navTimerRef.current = null
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
      const payload = {
        ...base,
        quantity_on_hand:   parseNum(form.quantity_on_hand) ?? 0,
        unit:               form.unit,
        reorder_threshold:  parseNum(form.reorder_threshold),
        reorder_quantity:   parseNum(form.reorder_quantity),
        quantity_purchased: parseNum(form.quantity_purchased),
      }
      // Seeds require variety_id (DB CHECK). Always include the field so the
      // server sees null vs missing the same way.
      if (form.category === 'seeds') {
        payload.variety_id = form.variety?.id ?? null
      }
      return payload
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
              <Button
                variant="danger"
                onClick={() => applyTypeSwitch(typeWarning)}
              >
                Switch to {typeWarning === 'consumable' ? 'Consumable' : 'Durable'}
              </Button>
              <Button
                variant="secondary"
                onClick={() => setTypeWarning(false)}
              >
                Keep current type
              </Button>
            </div>
          </div>
        )}

        {errors._form && (
          <div role="alert" style={{
            backgroundColor: P.alert, border: `1px solid ${P.alertBorder}`,
            borderRadius: 8, padding: '12px 16px', marginBottom: 20,
            fontSize: '0.875rem', color: P.bannerInk,
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
              <Input
                value={form.name}
                onChange={e => set('name', e.target.value)}
                error={!!errors.name}
                placeholder="e.g. Black Krim tomato seeds"
              />
            </Field>

            {/* Type */}
            <Field label="Type" error={errors.type}>
              <ChoiceGrid
                layout="grid"
                columns={2}
                ariaLabel="Type"
                value={form.type}
                onChange={handleTypeSelect}
                error={errors.type}
                options={TYPES.map(t => ({ value: t.value, label: t.label, icon: t.emoji, description: t.example }))}
              />
            </Field>

            {/* Category */}
            <Field label="Category" error={errors.category}>
              <EnumSelect
                value={form.category}
                onChange={e => {
                  set('category', e.target.value)
                  // When category changes away from seeds, clear variety selection.
                  if (e.target.value !== 'seeds' && form.variety) {
                    setForm(f => ({ ...f, variety: null }))
                  }
                }}
                error={errors.category}
                enumValues={visibleCategories}
                placeholder={form.type ? '— Select category —' : '— Select type first —'}
                disabled={!form.type}
              />
            </Field>

            {/* Variety picker — required when category is seeds (DB CHECK chk_inventory_seed_requires_variety) */}
            {form.category === 'seeds' && (
              <Field label="Variety" error={errors.variety}>
                <VarietyPicker
                  value={form.variety}
                  onChange={(variety) => {
                    setForm(f => ({ ...f, variety }))
                    if (errors.variety) setErrors(e => ({ ...e, variety: null }))
                  }}
                  required
                  placeholder="Search or create a variety…"
                />
                <div style={{ marginTop: 6, fontSize: '0.74rem', color: P.light }}>
                  Linking the variety lets future plants and harvest events trace back to this packet.
                </div>
              </Field>
            )}

            {/* Quantity — type-aware */}
            {form.type === 'consumable' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="Qty on hand" error={errors.quantity_on_hand}>
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    value={form.quantity_on_hand}
                    onChange={e => set('quantity_on_hand', e.target.value)}
                    error={!!errors.quantity_on_hand}
                    placeholder="0"
                  />
                </Field>
                <Field label="Unit" error={errors.unit}>
                  <EnumSelect
                    value={form.unit}
                    onChange={e => set('unit', e.target.value)}
                    error={errors.unit}
                    enumValues={UNITS}
                    placeholder="— Unit —"
                  />
                </Field>
              </div>
            )}

            {form.type === 'durable' && (
              <Field label="Quantity (how many?)" error={errors.quantity}>
                <Input
                  type="number"
                  min="1"
                  step="1"
                  value={form.quantity}
                  onChange={e => set('quantity', e.target.value)}
                  error={!!errors.quantity}
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
                        <Input
                          type="number" min="0" step="1"
                          value={form.reorder_threshold}
                          onChange={e => set('reorder_threshold', e.target.value)}
                          placeholder="e.g. 1"
                        />
                      </Field>
                      <Field label="Reorder quantity">
                        <Input
                          type="number" min="0" step="1"
                          value={form.reorder_quantity}
                          onChange={e => set('reorder_quantity', e.target.value)}
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
                          placeholder="e.g. Burpee"
                        />
                      </Field>
                      <Field label="Model">
                        <Input
                          value={form.model}
                          onChange={e => set('model', e.target.value)}
                          placeholder="Optional"
                        />
                      </Field>
                    </div>
                  </>
                )}

                {/* Shared optional fields */}
                <Field label="Location (free text)">
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
                  <Field label="Total qty purchased">
                    <Input
                      type="number" min="0" step="1"
                      value={form.quantity_purchased}
                      onChange={e => set('quantity_purchased', e.target.value)}
                      placeholder="All time"
                    />
                  </Field>
                </div>
                <Field label="Source (store / vendor)">
                  <Input
                    value={form.source}
                    onChange={e => set('source', e.target.value)}
                    placeholder="e.g. True Leaf Market"
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
                    placeholder="Variety, expiry, source quality…"
                  />
                </Field>
              </div>
            )}
          </div>

          {/* ── Actions ── */}
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', paddingTop: 4 }}>
            <Button type="submit" variant="primary" loading={saving} loadingLabel="Saving…">
              Add item
            </Button>
            <Link to="/inventory" style={{ color: P.mid, textDecoration: 'none', fontSize: '0.88rem' }}>
              Cancel
            </Link>
          </div>

        </form>
      </div>

    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────
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
