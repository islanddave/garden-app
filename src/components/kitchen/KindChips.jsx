// src/components/kitchen/KindChips.jsx
// Put-Up 1a (V4 §2.3) — "What kind of batch?", asked as ONE OPTIONAL TAP, never as a required field.
//
// WHY IT EXISTS NOW. `kind` has been nullable since V5-INFLIGHTBATCH-001 and nothing in the client
// could write it, so every batch the app ever created carried kind NULL — and the shipped submersion,
// pH-cadence and stall prompts are all gated on kind = 'ferment' (goingNow.js). They could never fire
// on a real batch. One tap here is what wakes them, and it is the only thing that does.
//
// SIX CHIPS, stored in the live chk_kitchen_batch_kind vocabulary (the labels are the V4 names, the
// values are the column's). `age` is still a valid stored value and is deliberately NOT offered: a
// row already carrying it reads back fine, and nothing asks it again.
//
// "OTHER" NEEDS NO TEXT FROM RELEASE 1b (V4 §2.3). In 1a chk_kitchen_batch_kind_other refused kind
// 'other' without a non-blank kind_other; 1b relaxes it (v5-putupmake-001/0a) and the Lambda twin with
// it (contract-F §2.1 "kind 'other' with no text"). The Other chip still reveals its short text field,
// now optional: a name typed there rides along as kind_other, and a blank one sends kind alone.
//
// OPTIONAL SINGLE-SELECT, so role="group" + aria-pressed (V4 §6.4) — never a radiogroup, which would
// announce a required choice. 48px touch chips with 8px gaps, the house SelectChip `touch` variant.
import React from 'react'
import { P, T } from '../../lib/tokens.js'
import SelectChip from '../forms/SelectChip.jsx'
import { inputChrome } from '../forms/formStyles.js'

export const KIND_CHIPS = Object.freeze([
  { value: 'ferment',   label: 'Ferment' },
  { value: 'dehydrate', label: 'Dry' },
  { value: 'candy',     label: 'Candy' },
  { value: 'cure',      label: 'Cure' },
  { value: 'infuse',    label: 'Infuse' },
  { value: 'other',     label: 'Other' },
])

export const KIND_OTHER_PLACEHOLDER = 'e.g. vinegar'

// The body a chosen kind puts on the wire, or null when the choice cannot commit yet. `kind` null is
// NOT an error: it is the unanswered state, and it contributes no keys at all — the merge PUT leaves
// an absent key alone and the create route stores NULL, which is exactly "nobody said".
export function kindBody(kind, otherText) {
  if (kind == null) return {}
  if (kind === 'other') {
    const text = String(otherText ?? '').trim()
    return text ? { kind: 'other', kind_other: text } : { kind: 'other' }
  }
  return KIND_CHIPS.some(c => c.value === kind) ? { kind } : null
}

export default function KindChips({
  value = null, onChange, otherText = '', onOtherTextChange, disabled = false,
  idPrefix = 'kind', ariaLabel = 'What kind of batch?',
}) {
  return (
    <div data-testid={`${idPrefix}-chips`}>
      <div role="group" aria-label={ariaLabel} style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {KIND_CHIPS.map(c => (
          <SelectChip key={c.value} touch active={value === c.value} disabled={disabled}
            data-testid={`${idPrefix}-${c.value}`}
            onClick={() => onChange?.(value === c.value ? null : c.value)}>
            {c.label}
          </SelectChip>
        ))}
      </div>
      {value === 'other' && (
        <input type="text" data-testid={`${idPrefix}-other-text`} aria-label="What kind is it? (optional)"
          value={otherText} placeholder={KIND_OTHER_PLACEHOLDER} maxLength={60} disabled={disabled}
          onChange={e => onOtherTextChange?.(e.target.value)}
          style={{ ...inputChrome(false), marginTop: T.space.sm, color: P.dark }} />
      )}
    </div>
  )
}
