// src/components/forms/Textarea.jsx
// Lane D / Phase A — canonical <textarea> primitive (rows + vertical resize).
import React from 'react'
import { textareaChrome } from './formStyles.js'

export default function Textarea({ value, onChange, error, errorId, rows = 3, style, 'aria-invalid': ariaInvalid, 'aria-describedby': describedBy, ...rest }) {
  const hasError = Boolean(error) || ariaInvalid === true || ariaInvalid === 'true'
  return (
    <textarea
      value={value}
      onChange={onChange}
      rows={rows}
      aria-invalid={hasError || undefined}
      aria-describedby={describedBy ?? (hasError && errorId ? errorId : undefined)}
      style={{ ...textareaChrome(hasError), ...style }}
      {...rest}
    />
  )
}
