import React from 'react'
import { facetColors } from '../../lib/facetColors.js'
import { T } from '../../lib/tokens.js'

// FacetGroupHeader — section header for one group in the faceted Garden render. Shows label +
// count; optional collapse chevron when onToggle is provided. Unsorted renders neutral + italic.
export default function FacetGroupHeader({ label, count, facet, value, collapsed = false, onToggle, isUnsorted = false, style }) {
  const c = facetColors(isUnsorted ? 'freeform' : facet, value)
  const interactive = typeof onToggle === 'function'
  return (
    <div
      data-testid="facet-group-header"
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-expanded={interactive ? !collapsed : undefined}
      onClick={interactive ? onToggle : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } } : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: T.space.sm,
        padding: `${T.space.xs}px ${T.space.sm}px`,
        backgroundColor: c.bg, color: c.text, borderLeft: `3px solid ${c.border}`,
        borderRadius: T.radiusField, fontWeight: 700, fontSize: T.type.sm,
        cursor: interactive ? 'pointer' : 'default', ...style,
      }}
    >
      {interactive && <span aria-hidden="true" style={{ fontSize: T.type.xs }}>{collapsed ? '▸' : '▾'}</span>}
      <span style={{ fontStyle: isUnsorted ? 'italic' : 'normal' }}>{label}</span>
      {typeof count === 'number' && <span style={{ marginLeft: 'auto', fontWeight: 600, opacity: 0.7 }}>{count}</span>}
    </div>
  )
}
