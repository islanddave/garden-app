// V3-FORMSYS-001 Phase F — canonical project-status badge (single source).
// Replaces four divergent inline status pills (ProjectList / Garden / ProjectDetail,
// all rendering the RAW lowercase status) and ProjectPublic's own hardcoded 4-status
// color map (which missed every in-progress stage — seeding/growing/flowering/fruiting —
// and fell through to planning-gold). Color comes from getStatusColors (status.js, the
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
      // role="img" is load-bearing, not decoration (V4-A11YGATE-001): without it this span is
      // role=generic, which cannot carry a name, so the aria-label was dropped and AT read the
      // bare label text — see the header note above, which described the intent, not the behavior.
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
