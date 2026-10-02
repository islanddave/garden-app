// src/components/pantry/AmountField.jsx
// Put-Up R2a (prep) — an amount and its unit: the size of each container on a put-up, "How much" on an as-is
// item. One control for the door, the item's Edit and the jar's Edit, so there is one unit list of each kind
// and one reading of a typed number. Controlled: the host holds { value, unit } and passes its own words.
// FROZEN for the lanes of R2a; mounted nowhere by prep.
//
//   value   the typed text, as typed ('' when empty) — parseAmount reads it
//   unit    a stored unit (the server's singular: 'qt', never 'quart'), or null
//   onChange({ value, unit })
//   label / placeholder / clearLabel   the host's words (SIZE_WORDS or AMOUNT_WORDS below)
//   units / moreUnits                  [{ label, value }] — the chips shown, and the ones behind "More units…"
//
// A unit chosen from behind "More units…" stays on the row as one chip while the reveal is closed. Both
// halves are optional together; a half-filled pair is the host's to refuse, with amountError's words.
import React, { useState } from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import SelectChip from '../forms/SelectChip.jsx'
import { labelChrome, inputChrome } from '../forms/formStyles.js'

const u = (value, label = value) => Object.freeze({ label, value })
// The stored value is the server's singular (lambda/preservation/kitchenBatch.js KITCHEN_UNITS). A bare "oz"
// is never shown: an ounce here is a weight, and the fluid ounce has its own chip.
const OZ = u('oz', 'oz (weight)')

// A put-up's "Size of each container": How many counts the containers, so no bag or jar here.
export const SIZE_UNITS = Object.freeze([u('cup'), u('pint'), u('qt'), u('fl oz'), u('lb'), OZ])
export const MORE_SIZE_UNITS = Object.freeze([
  u('gal'), u('g'), u('kg'), u('ml'), u('l'), u('count'), u('peck'), u('bushel'), u('half-bushel'), u('flat'),
])
// An as-is item's "How much": it has no count, so a bag and a jar are amounts.
export const ITEM_AMOUNT_UNITS = Object.freeze([u('lb'), OZ, u('count'), u('bag'), u('jar'), u('qt')])
export const MORE_ITEM_AMOUNT_UNITS = Object.freeze([
  u('pint'), u('cup'), u('fl oz'), u('gal'), u('g'), u('kg'), u('ml'), u('l'), u('bunch'), u('head'),
  u('peck'), u('bushel'), u('half-bushel'), u('flat'),
])

export const UNIT_GROUP_LABEL = 'Unit'
export const MORE_UNITS_LABEL = 'More units…'
// The host's words for each use. `noun` is what amountError calls the pair.
export const SIZE_WORDS = Object.freeze({
  label: 'Size of each container', placeholder: 'e.g. 1', clearLabel: 'Clear the size', noun: 'size',
})
export const AMOUNT_WORDS = Object.freeze({
  label: 'How much', placeholder: 'e.g. 2', clearLabel: 'Clear the amount', noun: 'amount',
})

// numeric(10,2) on both tables, and the validators' bounds: at least a hundredth, at most 99999999.99.
const MAX_HUNDREDTHS = 9999999999n

// The typed text as a number, or null. Digits with at most one decimal mark, a point or a comma ("0,5");
// nothing else — no sign, no exponent, no thousands mark. Rounded half-up to the column's two places on the
// typed digits (never floats), then refused when it rounds to nothing or runs past the column.
export function parseAmount(text) {
  const m = /^\s*(\d*)(?:[.,](\d*))?\s*$/.exec(String(text ?? ''))
  if (!m || (!m[1] && !m[2])) return null
  const frac = m[2] ?? ''
  let hundredths = BigInt(`${m[1] || '0'}${frac.slice(0, 2).padEnd(2, '0')}`)
  if (frac.length > 2 && frac[2] >= '5') hundredths += 1n
  if (hundredths < 1n || hundredths > MAX_HUNDREDTHS) return null
  return Number(hundredths) / 100
}

// What a save says about a half-filled pair, or null. Empty is fine: the pair is optional.
export function amountError({ value, unit } = {}, words = AMOUNT_WORDS) {
  const typed = String(value ?? '').trim() !== ''
  if (!typed && unit == null) return null
  const noun = words?.noun ?? AMOUNT_WORDS.noun
  if (parseAmount(value) == null) return `Type the ${noun} as a number above 0 — or clear the ${noun}.`
  if (unit == null) return `Pick a unit for the ${noun} — or clear the ${noun}.`
  return null
}

const row = { display: 'flex', flexWrap: 'wrap', gap: 8 }
const quietLink = {
  minHeight: T.buttonMinHeight, background: 'none', border: 'none', padding: '0 4px', color: P.green, fontWeight: 600,
  fontFamily: 'inherit', fontSize: T.type.sm, textDecoration: 'underline', cursor: 'pointer',
}

export default function AmountField({
  value = '', unit = null, onChange, label, units = [], moreUnits = [], idPrefix, clearLabel, placeholder,
  disabled = false, invalid = false,
}) {
  const [moreOpen, setMoreOpen] = useState(false)
  const shown = [...units, ...(moreOpen ? moreUnits : moreUnits.filter(o => o.value === unit))]
  const inputId = `${idPrefix}-value`
  const filled = String(value ?? '') !== '' || unit != null
  return (
    <div>
      <label htmlFor={inputId} style={labelChrome}>{label}</label>
      <input id={inputId} type="text" inputMode="decimal" enterKeyHint="done" autoComplete="off" value={value ?? ''}
        maxLength={12} disabled={disabled} data-testid={inputId} placeholder={placeholder}
        aria-invalid={invalid || undefined}
        onChange={e => onChange({ value: e.target.value, unit })}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
        style={{ ...inputChrome(invalid), maxWidth: 160, marginBottom: 8, minHeight: T.buttonMinHeight }} />
      <div role="radiogroup" aria-label={UNIT_GROUP_LABEL} aria-invalid={invalid || undefined}
        data-testid={`${idPrefix}-units`} style={row}>
        {shown.map(o => (
          <SelectChip key={o.value} touch active={unit === o.value} disabled={disabled} role="radio"
            aria-checked={unit === o.value} aria-pressed={undefined} data-testid={`${idPrefix}-unit-${o.value}`}
            onClick={() => onChange({ value: value ?? '', unit: o.value })}>{o.label}</SelectChip>
        ))}
      </div>
      {!moreOpen && moreUnits.length > 0 && (
        <button type="button" data-testid={`${idPrefix}-unit-more`} disabled={disabled} onClick={() => setMoreOpen(true)}
          style={quietLink}>
          {MORE_UNITS_LABEL}
        </button>
      )}
      {filled && (
        <button type="button" data-testid={`${idPrefix}-clear`} disabled={disabled}
          onClick={() => onChange({ value: '', unit: null })}
          style={{ ...quietLink, color: P.light, fontWeight: 400 }}>
          {clearLabel}
        </button>
      )}
    </div>
  )
}
