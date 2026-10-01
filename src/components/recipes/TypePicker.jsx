// src/components/recipes/TypePicker.jsx
// Put-Up release 4 — what a recipe makes (Dave 2026-09-30): chips of the built-in types, then the household's,
// then "New type…" which opens one inline field and find-or-creates the type (POST /api/recipes/types — an
// existing name, any case or spacing, comes back as the existing type; the crop-type precedent). Optional:
// tapping the chosen chip again clears it. Plain markup (functionality first; design pass later).
//
// Put-Up UX pass R1: sixteen built-in chips at 48 px pushed the rest of the sheet off the first screen, so the
// row opens SHORT — the type the picker opened on, then the types this household's recipes already use
// (`usedIds`) — and "More types…" brings the rest, with "New type…" at their end. Every type is still one
// more tap away at most. The order is fixed when the picker opens (recipes.js typeChips), so a chip never
// moves under a finger; a chosen chip is never off screen.
import React, { useEffect, useId, useRef, useState } from 'react'
import { P, T } from '../../lib/tokens.js'
import SelectChip from '../forms/SelectChip.jsx'
import { typeChips, NEW_TYPE_CTA, MORE_TYPES_CTA, TYPE_LABEL, RECIPE_TYPE_LABEL_MAX } from './recipes.js'

export default function TypePicker({ types, value, onChange, onCreated, fetch, usedIds = [], disabled = false }) {
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [pinned] = useState(value ?? null)            // the type it opened on: it leads, and stays put
  const inputId = `recipe-type-new-${useId()}`
  const groupRef = useRef(null)
  const focusRevealed = useRef(false)
  const { front, rest } = typeChips({ types, pinned, usedIds })
  const chosenBehind = !moreOpen && rest.find(t => t.id === value)
  const shown = moreOpen ? [...front, ...rest] : (chosenBehind ? [...front, chosenBehind] : front)

  // "More types…" leaves the row when it is tapped; focus goes to the first chip it revealed.
  useEffect(() => {
    if (!focusRevealed.current) return
    focusRevealed.current = false
    groupRef.current?.querySelector('[data-revealed="first"]')?.focus()
  })

  const create = async () => {
    const text = label.trim()
    if (!text) { setErr('Give the type a name.'); return }
    if (busy) return
    setBusy(true); setErr(null)
    try {
      const answer = await fetch('/api/recipes/types', { method: 'POST', body: JSON.stringify({ label: text }) })
      const type = answer?.type
      if (type?.id) {
        onCreated?.(type)
        onChange?.(type.id)
        setAdding(false); setLabel('')
      }
    } catch {
      setErr("Couldn't add that type — try again.")
    } finally { setBusy(false) }
  }

  return (
    <div data-testid="recipe-type-picker">
      <div ref={groupRef} role="group" aria-label={TYPE_LABEL} style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {shown.map(t => (
          <SelectChip key={t.id} small touch active={value === t.id} disabled={disabled}
            data-testid="recipe-type-chip" data-type-id={t.id} data-revealed={moreOpen && rest[0]?.id === t.id ? 'first' : undefined}
            onClick={() => onChange?.(value === t.id ? null : t.id)}>
            {t.label}
          </SelectChip>
        ))}
        {!moreOpen && (
          <SelectChip small touch active={false} disabled={disabled} data-testid="recipe-type-more"
            aria-pressed={undefined} aria-expanded="false"
            onClick={() => { focusRevealed.current = true; setMoreOpen(true) }}>
            {MORE_TYPES_CTA}
          </SelectChip>
        )}
        {moreOpen && !adding && (
          <SelectChip small touch active={false} disabled={disabled} data-testid="recipe-type-new"
            data-revealed={rest.length === 0 ? 'first' : undefined}
            onClick={() => { setAdding(true); setErr(null) }}>
            {NEW_TYPE_CTA}
          </SelectChip>
        )}
      </div>
      {adding && (
        <div style={{ marginTop: T.space.sm, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label htmlFor={inputId} style={{ fontSize: T.type.sm, color: P.mid }}>New type</label>
          <input id={inputId} data-testid="recipe-type-new-input" value={label} maxLength={RECIPE_TYPE_LABEL_MAX}
            disabled={busy} onChange={e => { setLabel(e.target.value); setErr(null) }}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); create() } }}
            style={{ minHeight: T.tapMinHeight, padding: '6px 10px', border: `1px solid ${P.border}`, borderRadius: T.radiusButton, fontFamily: 'inherit', fontSize: T.type.sm }} />
          <button type="button" data-testid="recipe-type-new-save" disabled={busy} onClick={create}
            style={{ minHeight: T.buttonMinHeight, padding: '6px 12px', background: 'none', border: `1px solid ${P.greenLight}`, borderRadius: T.radiusButton, color: P.green, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer' }}>
            {busy ? 'Adding…' : 'Add'}
          </button>
          <button type="button" data-testid="recipe-type-new-cancel" disabled={busy} onClick={() => { setAdding(false); setLabel(''); setErr(null) }}
            style={{ minHeight: T.buttonMinHeight, padding: '6px 8px', background: 'none', border: 'none', color: P.light, fontFamily: 'inherit', cursor: 'pointer' }}>
            Cancel
          </button>
        </div>
      )}
      {err && <div role="alert" data-alarm-ink-exempt="error" data-testid="recipe-type-error" style={{ marginTop: 4, color: P.terra, fontSize: T.type.sm }}>{err}</div>}
    </div>
  )
}
