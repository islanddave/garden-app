// src/components/forms/TileGrid.jsx
// V4-THEME-001 (V200 Pass B) — responsive tile-grid LAYOUT primitive. The §12 "2-col photo
// grid" (Garden Plants) and "3-col square wall" (Photos) both compose from this. It owns the
// grid container only (columns, gap, responsive auto-fit, empty state) — NOT the image tile
// itself (image lazy-load / thumbnail / fallback stays in the consumer or the still-deferred
// MediaTile slot, FROZEN.md). a11y: role=list + listitem so a tile collection is announced as
// a list; pass `ariaLabel`. Empty state (RES-2) shows the `empty` node instead of a blank grid.
// Ships DARK (no runtime importer until the adopting slice).
import React from 'react'
import { P } from '../../lib/constants.js'

export default function TileGrid({
  items = [],
  renderItem,
  columns = 2,
  minTileWidth,          // when set, auto-fit: repeat(auto-fill, minmax(minTileWidth, 1fr))
  gap = 12,
  empty = null,
  ariaLabel,
  style,
  ...rest
}) {
  if (!items.length) {
    if (empty == null) return null
    return (
      <div style={{ padding: '24px 16px', textAlign: 'center', color: P.light, fontSize: '0.9rem' }}>
        {empty}
      </div>
    )
  }
  const gridTemplateColumns = minTileWidth
    ? `repeat(auto-fill, minmax(${typeof minTileWidth === 'number' ? minTileWidth + 'px' : minTileWidth}, 1fr))`
    : `repeat(${columns}, minmax(0, 1fr))`
  return (
    <div
      role="list"
      aria-label={ariaLabel}
      style={{ display: 'grid', gridTemplateColumns, gap, ...style }}
      {...rest}
    >
      {items.map((item, i) => (
        <div role="listitem" key={item?.id ?? item?.key ?? i} style={{ minWidth: 0 }}>
          {renderItem ? renderItem(item, i) : null}
        </div>
      ))}
    </div>
  )
}
