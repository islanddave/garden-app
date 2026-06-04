// src/components/forms/ErrorBanner.jsx
// Lane D / Phase A — operational error banner (role="alert"). For form/submit
// failures and load errors ONLY — NOT a reward surface. Matches the shipped
// InventoryAdd `_form` banner chrome (alert bg + alertBorder).
import React from 'react'
import { bannerChrome } from './formStyles.js'

export default function ErrorBanner({ children, style, ...rest }) {
  if (children == null || children === false) return null
  return (
    <div role="alert" style={{ ...bannerChrome, ...style }} {...rest}>
      {children}
    </div>
  )
}
