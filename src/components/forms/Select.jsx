// src/components/forms/Select.jsx
// Lane D / Phase A — canonical native <select> primitive with palette chevron.
//
// Options come from EITHER an `options` prop ([{value,label}] or string[]) OR
// children <option>s. A placeholder is rendered when `placeholder` is set and the
// value is empty. Same error/aria conventions as Input. Chevron chrome is composed
// from P.light in formStyles (no hardcoded stroke).
import React from 'react'
import { selectChrome } from './formStyles.js'

function normalizeOptions(options) {
  if (!options) return null
  return options.map(o =>
    (o && typeof o === 'object') ? { value: o.value ?? o.v, label: o.label ?? String(o.value ?? o.v) }
                                 : { value: o, label: String(o) }
  )
}

// A stored value that is not in `options` used to render as the PLACEHOLDER — the select showed
// "— optional —" for a field that was in fact set, so the real value was invisible and could not be
// preserved by anyone editing the form. Worse than invisible: the obvious user response is to pick
// a value to fill the apparently-empty box, which silently REPLACES the stored one.
//
// Hit live on locations.type_label 2026-08-08: 'area' was the most common value in the data (9 of
// 21 locations, 200 live plantings) and had never been added to LOCATION_TYPE_LABELS. Because
// type_label feeds the care engine's covered/outdoor branch, "filling in" one of those boxes with
// shelf/rack/tray would have flipped a whole yard to covered — no rain credit, no frost alerts.
//
// Surfacing the value is strictly more honest than hiding it, so this is fixed in the PRIMITIVE
// rather than in one caller's option list: the same drift can happen to any select whose vocabulary
// is a hardcoded list and whose data is not. Appended, not prepended, so it never displaces a real
// option, and only when the value is non-empty — an empty value must still show the placeholder.
function withStoredValue(opts, value) {
  if (!opts || value == null || value === '') return opts
  return opts.some(o => String(o.value) === String(value))
    ? opts
    : [...opts, { value, label: String(value) }]
}

export default function Select({ value, onChange, error, errorId, options, placeholder, children, style, 'aria-invalid': ariaInvalid, 'aria-describedby': describedBy, ...rest }) {
  const hasError = Boolean(error) || ariaInvalid === true || ariaInvalid === 'true'
  const opts = withStoredValue(normalizeOptions(options), value)
  return (
    <select
      value={value}
      onChange={onChange}
      aria-invalid={hasError || undefined}
      aria-describedby={describedBy ?? (hasError && errorId ? errorId : undefined)}
      style={{ ...selectChrome(hasError), ...style }}
      {...rest}
    >
      {placeholder != null && <option value="">{placeholder}</option>}
      {opts ? opts.map(o => <option key={String(o.value)} value={o.value}>{o.label}</option>) : children}
    </select>
  )
}
