// V3-NAV-001 (Lane C / PR2): multi-channel planting-status badge.
// WCAG 1.4.1 (Use of Color): status is conveyed by THREE channels — an icon glyph, the text
// label, AND the badge color — never color alone. Used identically on the planting list
// (ProjectDetail) and the PlantingDetail page so the status reads the same on both surfaces.
//
// Color comes from the shared getStatusColors() (single source of truth). Unknown statuses
// fall through to a neutral glyph + the raw label, so a never-before-seen status still renders.
import React from 'react'
import { statusLabel } from '../lib/constants.js'
import { getStatusColors } from '../lib/status.js'
import { T } from './forms/formStyles.js'
import { statusGlyph } from '../lib/iconRegistry.js'
import Icon from './Icon.jsx'

// DESIGNSYS Pass A: the lifecycle-stage glyph map moved to the shared icon registry
// (src/lib/iconRegistry.js). statusIcon stays exported (no behavior change) but now
// delegates to statusGlyph there — neutral-dot fallback preserved.
export function statusIcon(status) {
  return statusGlyph(status)
}

export default function PlantStatusBadge({ status, size = 'sm' }) {
  if (!status) return null
  const sc = getStatusColors(status)
  const fontSize = size === 'lg' ? T.badgeFontLg : T.badgeFontSm
  const pad = size === 'lg' ? T.badgePadLg : T.badgePadSm
  return (
    <span
      // aria-label folds the glyph out and reads just "Status: <label>" to AT.
      // role="img" is what MAKES that true (V4-A11YGATE-001): a role-less span is role=generic,
      // generic cannot be named, and the label was being discarded in favour of the visible text —
      // so this read "Growing", not "Status: Growing", for as long as the comment above claimed
      // otherwise. img also folds the glyph + text into one atomic announcement, which is the
      // stated intent. Children are already presentational (Icon is decorative).
      role="img"
      aria-label={`Status: ${statusLabel(status)}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        fontSize, fontWeight: 600, padding: pad, borderRadius: T.radiusBadge,
        backgroundColor: sc.bg, color: sc.text, border: `1px solid ${sc.border}`,
        whiteSpace: 'nowrap', flexShrink: 0,
      }}
    >
      <Icon name={`status.${status}`} size={size === 'lg' ? 16 : 14} decorative />
      <span>{statusLabel(status)}</span>
    </span>
  )
}
