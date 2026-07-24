// src/components/TreatmentDetails.jsx
// V4-TREATLOG-001 — dedicated "Treatment details" section, rendered directly below Event Type
// whenever the event is a pest treatment or a DrG "Doctored / Treated" action. Replaces the old
// pest/treatment fields that were buried in the collapsible "More details" panel.
//
// Captures: what pest/disease was targeted (free-type WITH suggestions — the old fixed list that
// blocked logging is now a datalist you can type past), what was applied (picked from inventory,
// filtered by kind, OR free-typed), what KIND it was (fertilizer vs amendment are DISTINCT per
// Dave 2026-07-14), and how much / what strength.
import React from 'react'
import { P } from '../lib/constants.js'
import { Input, Select } from './forms'
import { PEST_TARGET_SUGGESTIONS, TREATMENT_CATEGORY_OPTIONS, TREATMENT_CATEGORY_TO_INVENTORY } from '../lib/dropdownRegistry.js'

const fieldLabel = {
  display: 'block', fontSize: '0.77rem', fontWeight: 700, color: P.mid,
  marginBottom: 6, letterSpacing: '0.4px', textTransform: 'uppercase',
}

export default function TreatmentDetails({ value, onChange, inventory = [] }) {
  const v = value || {}
  const set = (patch) => onChange({ ...v, ...patch })

  // Product list, filtered by the chosen treatment kind (empty kind → all treatment-ish items).
  const invCats = TREATMENT_CATEGORY_TO_INVENTORY[v.category] || TREATMENT_CATEGORY_TO_INVENTORY.other
  const products = inventory.filter(i => invCats.includes(i.category))

  // Picking a category clears a now-out-of-list product selection (the free-typed text is kept).
  function pickCategory(cat) {
    const next = cat === v.category ? '' : cat
    const stillValid = next
      ? (TREATMENT_CATEGORY_TO_INVENTORY[next] || []).includes(products.find(p => p.id === v.product_id)?.category)
      : true
    set({ category: next, product_id: stillValid ? v.product_id : '' })
  }

  // Picking a product auto-sets the kind from the item's own category (unless already set).
  function pickProduct(id) {
    const item = inventory.find(p => p.id === id)
    const derived = item && ['fertilizer', 'amendment', 'pest_control'].includes(item.category) ? item.category : v.category
    set({ product_id: id, product_text: id ? '' : v.product_text, category: v.category || derived || '' })
  }

  return (
    <section style={{ backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: '16px 18px' }}>
      <h3 style={{ margin: '0 0 10px', fontSize: '0.77rem', fontWeight: 700, color: P.mid, letterSpacing: '0.4px', textTransform: 'uppercase' }}>
        Treatment details
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Pest / disease target — free-type with suggestions (type anything, or pick a common one). */}
        <div>
          <label htmlFor="treatlog-pest" style={fieldLabel}>Pest / disease treated</label>
          <Input
            id="treatlog-pest"
            list="treatlog-pest-suggestions"
            value={v.pest_target ?? ''}
            onChange={e => set({ pest_target: e.target.value })}
            placeholder="e.g. Japanese beetle, powdery mildew — or type your own"
          />
          <datalist id="treatlog-pest-suggestions">
            {PEST_TARGET_SUGGESTIONS.map(p => <option key={p} value={p} />)}
          </datalist>
        </div>

        {/* What kind was applied — amendment is DISTINCT from fertilizer. */}
        <div>
          <label style={fieldLabel}>What did you apply?</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {TREATMENT_CATEGORY_OPTIONS.map(opt => {
              const active = v.category === opt.value
              return (
                <button
                  key={opt.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => pickCategory(opt.value)}
                  style={{
                    padding: '7px 14px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
                    fontSize: '0.82rem', fontWeight: 600,
                    border: `1px solid ${active ? P.green : P.border}`,
                    backgroundColor: active ? P.green : P.white,
                    color: active ? P.white : P.mid,
                  }}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Product from inventory (filtered by kind) — optional. */}
        <div>
          <label htmlFor="treatlog-product" style={fieldLabel}>Product (from inventory)</label>
          <Select
            id="treatlog-product"
            value={v.product_id ?? ''}
            onChange={e => pickProduct(e.target.value)}
          >
            <option value="">{products.length ? '— pick from inventory (optional) —' : '— no matching inventory items —'}</option>
            {[...products].sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(p => (
              <option key={p.id} value={p.id}>{p.name}{p.brand ? ` — ${p.brand}` : ''}</option>
            ))}
          </Select>
          <Input
            style={{ marginTop: 8 }}
            value={v.product_text ?? ''}
            onChange={e => set({ product_text: e.target.value, product_id: e.target.value ? '' : v.product_id })}
            placeholder="Not in inventory? Type the product (e.g. Deadbug, Jack's 20-20-20)"
          />
        </div>

        {/* Amount / strength — free-form (matches how Dave logs: "half strength", "2 tbsp/gal"). */}
        <div>
          <label htmlFor="treatlog-amount" style={fieldLabel}>Amount / strength</label>
          <Input
            id="treatlog-amount"
            value={v.amount ?? ''}
            onChange={e => set({ amount: e.target.value })}
            placeholder='e.g. "half strength", "full", "2 tbsp/gal"'
          />
        </div>
      </div>
    </section>
  )
}
