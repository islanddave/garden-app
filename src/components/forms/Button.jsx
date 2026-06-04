// src/components/forms/Button.jsx
// Lane D / Phase A — canonical button primitive.
// Variants: primary (green) | secondary (outline) | danger (terra). minHeight
// frozen at 48. ONE disabled convention everywhere: P.light fill + not-allowed
// cursor + aria-disabled (set here so consumers can't re-invent it). `loading`
// disables and swaps the label to `loadingLabel` while keeping width stable-ish.
import React from 'react'
import { buttonChrome } from './formStyles.js'

export default function Button({ variant = 'primary', disabled = false, loading = false, loadingLabel, type = 'button', children, style, ...rest }) {
  const isDisabled = disabled || loading
  return (
    <button
      type={type}
      disabled={isDisabled}
      aria-disabled={isDisabled || undefined}
      aria-busy={loading || undefined}
      style={{ ...buttonChrome(variant, isDisabled), ...style }}
      {...rest}
    >
      {loading ? (loadingLabel ?? '…') : children}
    </button>
  )
}
