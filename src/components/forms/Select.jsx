// Canonical native <select> primitive with palette chevron. Options come from EITHER an `options`
// prop ([{value,label}] or string[]) OR children <option>s. A placeholder is rendered when
// `placeholder` is set and the value is empty. Same error/aria conventions as Input. Chevron chrome
// is composed from P.light in formStyles (no hardcoded stroke).
import React from 'react'
import { selectChrome } from './formStyles.js'

function normalizeOptions(options) {
  if (!options) return null
  return options.map(o =>
    (o && typeof o === 'object') ? { value: o.value ?? o.v, label: o.label ?? String(o.value ?? o.v) }
                                 : { value: o, label: String(o) }
  )
}

// A stored value that is not in `options` must not render as the PLACEHOLDER: the box would look
// empty for a field that is set, the value could not be preserved by anyone editing, and the
// obvious response (pick a value to fill the box) silently REPLACES the stored one. The case that
// mattered: locations.type_label values missing from LOCATION_TYPE_LABELS, where type_label feeds
// the care engine's covered/outdoor branch, so "filling in" the box could flip a whole yard to
// covered (no rain credit, no frost alerts).
// Fixed in the PRIMITIVE, since any select with a hardcoded vocabulary over unconstrained data can
// drift the same way. Appended, not prepended, so it never displaces a real option, and only when
// the value is non-empty (an empty value must still show the placeholder).
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
