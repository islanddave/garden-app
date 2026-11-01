// Canonical project-status badge (single source). Color comes from getStatusColors (status.js, the
// single source); label from statusLabel (constants.js, project+plant aware).
// A11y: aria-label reads "Status: <label>". Iconless by design — projects keep their
// established pill look; plantings carry lifecycle glyphs via PlantStatusBadge.
import React from 'react'
import { statusLabel } from '../lib/constants.js'
import { getStatusColors } from '../lib/status.js'

export default function ProjectStatusBadge({ status, style }) {
  if (!status) return null
  const sc = getStatusColors(status)
  return (
    <span
      // role="img" is load-bearing, not decoration: without it this span is role=generic, which
      // cannot carry a name, so the aria-label would be dropped and AT would read the bare label
      // text.
      role="img"
      aria-label={`Status: ${statusLabel(status)}`}
      style={{
        display: 'inline-flex', alignItems: 'center',
        backgroundColor: sc.bg, color: sc.text, border: `1px solid ${sc.border}`,
        fontSize: '0.75rem', padding: '3px 10px', borderRadius: 12, fontWeight: 600,
        whiteSpace: 'nowrap', flexShrink: 0, ...style,
      }}
    >
      {statusLabel(status)}
    </span>
  )
}
