// Canonical text/number/date/url input primitive. Controlled (`value`/`onChange`); `error`
// (bool|string) drives the terra error border AND is mirrored by aria-invalid; native props pass
// through, with `...rest` spread to the <input> and a `style` merge slot. Field can also drive the
// error state by cloning aria-invalid onto this control, so `hasError` reads EITHER source.
// `error`/`errorId` are consumed here and never leak to the DOM.
import React from 'react'
import { inputChrome } from './formStyles.js'

export default function Input({ value, onChange, error, errorId, style, 'aria-invalid': ariaInvalid, 'aria-describedby': describedBy, ...rest }) {
  const hasError = Boolean(error) || ariaInvalid === true || ariaInvalid === 'true'
  return (
    <input
      value={value}
      onChange={onChange}
      aria-invalid={hasError || undefined}
      aria-describedby={describedBy ?? (hasError && errorId ? errorId : undefined)}
      style={{ ...inputChrome(hasError), ...style }}
      {...rest}
    />
  )
}
