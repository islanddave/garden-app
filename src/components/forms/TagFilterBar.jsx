import React from 'react'
import TagChip from './TagChip.jsx'
import { T, P } from '../../lib/tokens.js'

// TagFilterBar — breadcrumb of active tag filters; each pill removable (×), plus Clear all.
// Renders null when there are no active filters. Filter pills are always removable (you can
// filter BY a derived tag and still clear that filter), so source is normalized to 'user'.
//
// V5-PHOTOFILTERPARITY-001 — `clearLabel` (additive; omit it and the render is byte-identical, which
// is what keeps facetPrimitives.test.jsx's caller unchanged). It exists because a page may carry a
// SECOND, narrower clear beside this one: PhotoLibrary renders a FilterChipRow whose own `onClear`
// wipes just the crop chips, above this bar whose Clear wipes every axis. Two buttons both reading
// "Clear", differing only in scope, is a control the user has to guess at — so the wider one is
// allowed to say so. Not a per-caller string free-for-all: the default stays 'Clear'.
export default function TagFilterBar({ filters = [], onRemove, onClear, clearLabel = 'Clear', style }) {
  if (!filters.length) return null
  return (
    <div data-testid="tag-filter-bar" role="region" aria-label="Active filters"
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: T.space.xs, ...style }}>
      {filters.map((t) => (
        <TagChip key={`${t.facet}:${t.slug}`} tag={{ ...t, source: 'user' }} onRemove={onRemove} active />
      ))}
      {typeof onClear === 'function' && (
        <button type="button" onClick={onClear}
          style={{ background: 'none', border: 'none', color: P.mid, cursor: 'pointer', fontSize: T.type.xs, textDecoration: 'underline' }}>
          {clearLabel}
        </button>
      )}
    </div>
  )
}
