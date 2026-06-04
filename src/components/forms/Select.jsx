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

export default function Select({ value, onChange, error, errorId, options, placeholder, children, style, 'aria-invalid': ariaInvalid, 'aria-describedby': describedBy, ...rest }) {
  const hasError = Boolean(error) || ariaInvalid === true || ariaInvalid === 'true'
  const opts = normalizeOptions(options)
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
