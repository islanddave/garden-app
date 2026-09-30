// src/components/pantry/DoorParts.jsx
// Put-Up B′ release 2 — the chip rows Put something up and Walk a place share (V4 §6.4, Appendix B):
// the place chips, the method row (required: role=radiogroup + aria-required, role=radio chips) and the
// discard-by choice. Plain SelectChip touch chips (48 px, 8 px gaps); no new visual design.
import React, { useState } from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import SelectChip from '../forms/SelectChip.jsx'
import { labelChrome, requiredMarkChrome, inputChrome } from '../forms/formStyles.js'
import { AS_IS, methodLabel } from './putSomethingUp.js'

const row = { display: 'flex', flexWrap: 'wrap', gap: 8 }

// Appendix B's "＋ Somewhere else" (a name + a kind), and Cellar among its kinds. The new place is a chip
// with no id; the write that uses it finds or creates it (pantryApi.ensurePlaceId, or the route's own
// find-or-create for a jar move).
export const NEW_PLACE_KINDS = [
  { kind: 'fridge', label: 'Fridge' }, { kind: 'deep_freezer', label: 'Freezer' },
  { kind: 'pantry', label: 'Pantry shelf' }, { kind: 'cold_storage', label: 'Cellar' },
  { kind: 'other', label: 'Counter or other' },
]
const quietLink = {
  minHeight: 48, background: 'none', border: 'none', padding: '0 4px', color: P.green, fontWeight: 600,
  fontFamily: 'inherit', fontSize: T.type.sm, textDecoration: 'underline', cursor: 'pointer',
}

// Required single-select of a place chip ({key, id?, label, kind}).
export function PlaceChipRow({ chips, value, onChange, idPrefix, label = 'Where does it live?', required = true, disabled = false, invalid = false }) {
  const [adding, setAdding] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newKind, setNewKind] = useState(null)
  const options = [...(chips ?? [])]
  if (value && !options.some(c => c.key === value.key)) options.push(value)
  return (
    <div>
      <span style={labelChrome} aria-hidden="true">{label}{required && <span style={requiredMarkChrome}>*</span>}</span>
      <div role="radiogroup" aria-label={label} aria-required={required ? 'true' : undefined} aria-invalid={invalid || undefined}
        data-testid={`${idPrefix}-places`} style={row}>
        {options.map(c => (
          <SelectChip key={c.key} touch active={value?.key === c.key} disabled={disabled} role="radio"
            aria-checked={value?.key === c.key} aria-pressed={undefined} data-testid={`${idPrefix}-place-${c.key}`}
            onClick={() => onChange(c)}>{c.label}</SelectChip>
        ))}
      </div>
      {!adding ? (
        <button type="button" style={quietLink} disabled={disabled} data-testid={`${idPrefix}-place-new`}
          onClick={() => setAdding(true)}>＋ Somewhere else</button>
      ) : (
        <div data-testid={`${idPrefix}-place-new-editor`} style={{ marginTop: 8 }}>
          <input type="text" aria-label="Name of the place" value={newLabel} maxLength={60} disabled={disabled}
            data-testid={`${idPrefix}-place-new-label`} placeholder="e.g. Garage fridge" onChange={e => setNewLabel(e.target.value)}
            style={{ ...inputChrome(false), marginBottom: 8, minHeight: 44 }} />
          <div role="radiogroup" aria-label="What kind of place?" style={row}>
            {NEW_PLACE_KINDS.map(k => (
              <SelectChip key={k.kind} touch active={newKind === k.kind} disabled={disabled} role="radio"
                aria-checked={newKind === k.kind} aria-pressed={undefined} data-testid={`${idPrefix}-place-new-kind-${k.kind}`}
                onClick={() => setNewKind(k.kind)}>{k.label}</SelectChip>
            ))}
          </div>
          <button type="button" disabled={disabled || !newLabel.trim() || !newKind} data-testid={`${idPrefix}-place-new-use`}
            style={quietLink} onClick={() => {
              const l = newLabel.trim()
              onChange({ key: `new:${newKind}:${l.toLowerCase()}`, id: null, label: l, kind: newKind })
              setAdding(false); setNewLabel(''); setNewKind(null)
            }}>Use this place</button>
          <button type="button" disabled={disabled} onClick={() => setAdding(false)}
            style={{ ...quietLink, color: P.light, fontWeight: 400 }}>Cancel</button>
        </div>
      )}
    </div>
  )
}

// The method row: ≤ 4 seeded chips + As is (or Fresh, as picked) + More…; nothing preselected. More…
// reveals every other method inside the same radiogroup. `groupRef` receives the radiogroup so a Save
// with no method can move focus to its first chip (V4 §2.2; focusFirstRadio).
export function MethodRow({ choices, value, onChange, what, idPrefix, disabled = false, invalid = false, groupRef = null, label = 'How was it put up?' }) {
  const [moreOpen, setMoreOpen] = useState(false)
  const showMore = moreOpen || (value && value !== AS_IS && !choices.chips.includes(value))
  const all = [...choices.chips, ...(showMore ? choices.more : [])]
  const chip = (m) => (
    <SelectChip key={m} touch active={value === m} disabled={disabled} role="radio" aria-checked={value === m}
      aria-pressed={undefined} data-testid={`${idPrefix}-method-${m}`}
      onClick={() => onChange(m)}>{methodLabel(m, what)}</SelectChip>
  )
  return (
    <div>
      <span style={labelChrome} aria-hidden="true">{label}<span style={requiredMarkChrome}>*</span></span>
      <div role="radiogroup" aria-label={label} aria-required="true" aria-invalid={invalid || undefined}
        data-testid={`${idPrefix}-methods`} ref={groupRef} style={row}>
        {all.map(chip)}
        {choices.asIs && (
          <SelectChip touch active={value === AS_IS} disabled={disabled} role="radio" aria-checked={value === AS_IS}
            aria-pressed={undefined} data-testid={`${idPrefix}-method-as_is`}
            onClick={() => onChange(AS_IS)}>{choices.asIs}</SelectChip>
        )}
      </div>
      {!showMore && choices.more.length > 0 && (
        <button type="button" data-testid={`${idPrefix}-method-more`} disabled={disabled} onClick={() => setMoreOpen(true)}
          style={{ minHeight: 48, background: 'none', border: 'none', padding: '0 4px', color: P.green, fontWeight: 600,
            fontFamily: 'inherit', fontSize: T.type.sm, textDecoration: 'underline', cursor: 'pointer' }}>
          More…
        </button>
      )}
    </div>
  )
}

export function focusFirstRadio(groupRef) {
  const el = groupRef?.current?.querySelector?.('[role="radio"]')
  if (el && typeof el.focus === 'function') el.focus()
}

// Discard by: worked out (the engine) · a date from the label · no date (V4 §3.1). A bought item offers
// only the label date (a discard date only if typed, §2.5), so `itemMode` hides the other two.
export function DiscardChoice({ value, onChange, idPrefix, itemMode = false, disabled = false }) {
  const opts = itemMode
    ? [{ id: 'auto', label: 'No discard date' }, { id: 'date', label: 'A date from the label' }]
    : [{ id: 'auto', label: 'Work it out' }, { id: 'date', label: 'A date from the label' }, { id: 'none', label: 'No date' }]
  return (
    <div>
      <span style={labelChrome} aria-hidden="true">Discard by</span>
      <div role="radiogroup" aria-label="Discard by" style={row}>
        {opts.map(o => (
          <SelectChip key={o.id} touch active={value.mode === o.id} disabled={disabled} role="radio" aria-checked={value.mode === o.id}
            aria-pressed={undefined} data-testid={`${idPrefix}-discard-${o.id}`}
            onClick={() => onChange({ ...value, mode: o.id })}>{o.label}</SelectChip>
        ))}
      </div>
      {value.mode === 'date' && (
        <input type="date" aria-label="Discard date from the label" data-testid={`${idPrefix}-discard-date`} value={value.date}
          disabled={disabled} onChange={e => onChange({ ...value, date: e.target.value })}
          style={{ ...inputChrome(false), maxWidth: 220, marginTop: 8, minHeight: 44 }} />
      )}
    </div>
  )
}
