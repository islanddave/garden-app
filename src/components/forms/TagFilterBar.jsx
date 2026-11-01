import React from 'react'
import TagChip from './TagChip.jsx'
import { T, P } from '../../lib/tokens.js'

// Breadcrumb of active tag filters; each pill removable (×), plus Clear all. Renders null when there
// are no active filters. Filter pills are always removable (you can filter BY a derived tag and
// still clear that filter), so source is normalized to 'user'.
//
// `clearLabel` exists because a page may carry a SECOND, narrower clear beside this one: PhotoLibrary
// renders a FilterChipRow whose own `onClear` wipes just the crop chips, above this bar whose Clear
// wipes every axis. Two buttons both reading "Clear", differing only in scope, is a control the user
// has to guess at, so the wider one may say so. The default stays 'Clear'; facetPrimitives.test.jsx's
// caller relies on it.
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
