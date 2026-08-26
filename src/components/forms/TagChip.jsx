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
      // role="group", NOT role="img" (V4-A11YGATE-001). A role-less span is role=generic and cannot
      // be named, so the facet prefix was being discarded and AT heard just the label — losing the
      // facet, which colour alone otherwise carries (WCAG 1.4.1). The obvious fix, role="img", is
      // WRONG here: img makes descendants presentational and would delete the nested Remove button
      // from the a11y tree. group supports naming and leaves children exposed.
      role="group"
      aria-label={`${tag.facet}: ${label}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        backgroundColor: c.bg, color: c.text,
        border: `1px solid ${active ? c.text : c.border}`,
        fontSize: T.type.xs, padding: T.badgePadXs, borderRadius: T.radiusBadge,
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
