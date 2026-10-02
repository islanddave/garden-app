// src/components/pantry/WhereFromField.jsx
// Put-Up R2a (prep) — "where it's from", the one control the door, the jar's Edit and the item's Edit share.
// Controlled: the host holds { kind, label } and passes the heading (its own words for the question, which
// differ between a put-up and an as-is item). FROZEN for the lanes of R2a; mounted nowhere by prep.
//
//   kind    one of the server's source kinds (lambda/preservation/provenance.js VALID_SOURCE_KINDS), or null
//   label   the typed name ('' when none)
//   onChange({ kind, label })
//
// Four chips first, the other four behind one reveal; a kind chosen from behind the reveal stays on the row
// as one chip while it is closed. Every chip's word is read from PUTUP_SOURCE_LABELS. Nothing is preselected,
// and a second tap on the chosen chip un-chooses it. The garden has no name to type, so choosing it (or
// un-choosing) empties the name; between the other kinds a typed name stays. Other needs its name:
// whereFromError says so, and the host decides when to show it.
import React, { useState } from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import SelectChip from '../forms/SelectChip.jsx'
import { labelChrome, optionalMarkChrome, requiredMarkChrome, inputChrome } from '../forms/formStyles.js'
import { PUTUP_SOURCE_LABELS } from '../../lib/dropdownRegistry.js'

export const FIRST_SOURCE_KINDS = Object.freeze(['own_garden', 'farm_stand', 'store', 'gift'])
export const MORE_SOURCE_KINDS = Object.freeze(['u_pick', 'csa', 'foraged', 'other'])
export const MORE_SOURCES_LABEL = 'U-pick, CSA share, foraged, other…'
export const WHICH_ONE_LABEL = 'Which one?'
export const WHICH_ONE_PLACEHOLDER = 'e.g. Warner Farms'
export const WHERE_EXACTLY_LABEL = 'Where exactly?'
export const WHERE_EXACTLY_ERROR = 'Where exactly is it from? Type it — or pick another.'
// chk_preservation_log_source_label_len (provenance.js SOURCE_LABEL_MAX).
export const SOURCE_LABEL_MAX = 120

const row = { display: 'flex', flexWrap: 'wrap', gap: 8 }
const quietLink = {
  minHeight: T.buttonMinHeight, background: 'none', border: 'none', padding: '0 4px', color: P.green, fontWeight: 600,
  fontFamily: 'inherit', fontSize: T.type.sm, textDecoration: 'underline', cursor: 'pointer',
}

// The one thing a save can refuse here: Other with no name. Null when there is nothing to say.
export function whereFromError({ kind, label } = {}) {
  return kind === 'other' && String(label ?? '').trim() === '' ? WHERE_EXACTLY_ERROR : null
}

export default function WhereFromField({ kind = null, label = '', onChange, heading, idPrefix, disabled = false, invalid = false }) {
  const [moreOpen, setMoreOpen] = useState(false)
  const kinds = [...FIRST_SOURCE_KINDS, ...(moreOpen ? MORE_SOURCE_KINDS : MORE_SOURCE_KINDS.filter(k => k === kind))]
  const named = kind != null && kind !== 'own_garden'
  const isOther = kind === 'other'
  const nameId = `${idPrefix}-source-label`
  function pick(k) {
    if (k === kind) onChange({ kind: null, label: '' })
    else onChange({ kind: k, label: k === 'own_garden' ? '' : (label ?? '') })
  }
  return (
    <div>
      <span style={labelChrome} aria-hidden="true">{heading}</span>
      <div role="radiogroup" aria-label={heading} data-testid={`${idPrefix}-source`} style={row}>
        {kinds.map(k => (
          <SelectChip key={k} touch active={kind === k} disabled={disabled} role="radio" aria-checked={kind === k}
            aria-pressed={undefined} data-testid={`${idPrefix}-source-${k}`}
            onClick={() => pick(k)}>{PUTUP_SOURCE_LABELS[k]}</SelectChip>
        ))}
      </div>
      {!moreOpen && (
        <button type="button" data-testid={`${idPrefix}-source-more`} disabled={disabled} onClick={() => setMoreOpen(true)}
          style={quietLink}>
          {MORE_SOURCES_LABEL}
        </button>
      )}
      {named && (
        <div style={{ marginTop: 8 }}>
          <label htmlFor={nameId} style={labelChrome}>
            {isOther ? WHERE_EXACTLY_LABEL : WHICH_ONE_LABEL}
            {isOther ? <span style={requiredMarkChrome} aria-hidden="true">*</span> : <span style={optionalMarkChrome}>optional</span>}
          </label>
          <input id={nameId} type="text" value={label ?? ''} maxLength={SOURCE_LABEL_MAX} disabled={disabled}
            data-testid={nameId} placeholder={isOther ? undefined : WHICH_ONE_PLACEHOLDER} enterKeyHint="done"
            aria-required={isOther ? 'true' : undefined} aria-invalid={(isOther && invalid) || undefined}
            onChange={e => onChange({ kind, label: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
            style={{ ...inputChrome(isOther && invalid), minHeight: T.buttonMinHeight }} />
        </div>
      )}
    </div>
  )
}
