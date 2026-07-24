// src/components/forms/PageShell.jsx
// Lane D / Phase A — page frame (full-viewport cream bg + centered max-width
// column) with optional breadcrumb + title and the same loading/error/empty
// states as AsyncRegion. Mirrors the InventoryAdd page outer chrome.
import React from 'react'
import { P } from '../../lib/constants.js'
import AsyncRegion from './AsyncRegion.jsx'

export default function PageShell({
  title,
  breadcrumb,
  maxWidth = 600,
  loading = false,
  error = null,
  empty = false,
  emptyLabel,
  children,
  style,
  ...rest
}) {
  return (
    <div style={{ minHeight: '100dvh', backgroundColor: P.cream, ...style }} {...rest}>
      <div style={{ maxWidth, margin: '0 auto', padding: '28px 16px 80px' }}>
        {breadcrumb && <div style={{ fontSize: '0.82rem', color: P.light, marginBottom: 8 }}>{breadcrumb}</div>}
        {title && <h1 style={{ margin: '0 0 24px', color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>{title}</h1>}
        <AsyncRegion loading={loading} error={error} empty={empty} emptyLabel={emptyLabel}>
          {children}
        </AsyncRegion>
      </div>
    </div>
  )
}
