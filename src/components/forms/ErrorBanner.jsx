// Operational error banner (role="alert") for form/submit failures and load errors ONLY; NOT a
// reward surface.
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
