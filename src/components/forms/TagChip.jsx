import React from 'react'
import { facetColors } from '../../lib/facetColors.js'
import { T } from '../../lib/tokens.js'

// TagChip — faceted tag pill (V4-GARDENIA-001 / DESIGNSYS primitive). Colored by facet.
// Derived tags (source==='derived') are system-managed: no remove affordance even if onRemove given.
export default function TagChip({ tag, onRemove, onClick, active = false, style }) {
  if (!tag) return null
  const c = facetColors(tag.facet, tag.slug)
  const label = tag.label || tag.slug || ''
  const removable = typeof onRemove === 'function' && tag.source !== 'derived'
  return (
    <span
      data-testid="tag-chip"
      onClick={onClick}
      aria-label={`${tag.facet}: ${label}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        backgroundColor: c.bg, color: c.text,
        border: `1px solid ${active ? c.text : c.border}`,
        fontSize: T.type.xs, padding: '2px 8px', borderRadius: T.radiusBadge,
        fontWeight: 600, whiteSpace: 'nowrap', cursor: onClick ? 'pointer' : 'default', ...style,
      }}
    >
      {label}
      {removable && (
        <button
          type="button" aria-label={`Remove ${label}`}
          onClick={(e) => { e.stopPropagation(); onRemove(tag) }}
          style={{ background: 'none', border: 'none', color: c.text, cursor: 'pointer', padding: 0, lineHeight: 1, fontSize: T.type.sm }}
        >×</button>
      )}
    </span>
  )
}
