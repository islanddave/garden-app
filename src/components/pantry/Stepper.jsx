// src/components/pantry/Stepper.jsx
// V4 §6.6 "Count": a numeric input (min-height 44, inputmode numeric) between 48×48 − / + buttons at
// least 8 px away, named with the row ("One more — Megatron reaper"); at 1, − is aria-disabled and stays
// 48 px; no press-and-hold repeat. `min` is 1 unless the host says otherwise; `max` caps + (Gave it away
// cannot give more than are left).
import React from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { inputChrome } from '../forms/formStyles.js'

export function stepperCount(value, min = 1) {
  const n = Number(value)
  return Number.isInteger(n) && n >= min ? n : min
}

export default function Stepper({ value, onChange, name, idPrefix, disabled = false, min = 1, max = null, label = 'How many' }) {
  const count = stepperCount(value, min)
  const canDown = count > min
  const canUp = max == null || count < max
  const btn = (on) => ({ width: 48, height: 48, border: `1px solid ${P.border}`, borderRadius: T.radiusButton, background: P.white,
    color: on ? P.dark : P.light, fontSize: '1.2rem', cursor: on ? 'pointer' : 'default', fontFamily: 'inherit' })
  return (
    <div role="group" aria-label={`${label} — ${name}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button type="button" aria-label={`One fewer — ${name}`} aria-disabled={canDown ? undefined : true} disabled={disabled}
        data-testid={`${idPrefix}-minus`} onClick={() => { if (canDown) onChange(String(count - 1)) }} style={btn(canDown)}>−</button>
      <input type="text" inputMode="numeric" aria-label={`${label} — ${name}`} data-testid={`${idPrefix}-count`} value={value}
        disabled={disabled} onChange={e => onChange(e.target.value.replace(/[^0-9]/g, ''))}
        style={{ ...inputChrome(false), width: 64, minHeight: 44, textAlign: 'center' }} />
      <button type="button" aria-label={`One more — ${name}`} aria-disabled={canUp ? undefined : true} disabled={disabled}
        data-testid={`${idPrefix}-plus`} onClick={() => { if (canUp) onChange(String(count + 1)) }} style={btn(canUp)}>+</button>
    </div>
  )
}
