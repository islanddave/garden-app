// V3-NAV-001 (Lane C / PR2): multi-channel planting-status badge.
// WCAG 1.4.1 (Use of Color): status is conveyed by THREE channels — an icon glyph, the text
// label, AND the badge color — never color alone. Used identically on the planting list
// (ProjectDetail) and the PlantingDetail page so the status reads the same on both surfaces.
//
// Color comes from the shared getStatusColors() (single source of truth). Unknown statuses
// fall through to a neutral glyph + the raw label, so a never-before-seen status still renders.
import React from 'react'
import { P } from '../lib/constants.js'
import { getStatusColors } from '../lib/status.js'

// Lifecycle-stage glyphs. Covers plant statuses (seed…failed) and project stages that may
// appear on a planting. Anything unmapped uses the neutral dot.
const STATUS_ICONS = {
  seed: '🌰', seedling: '🌱', sprouting: '🌱', seeding: '🌱',
  vegetative: '🌿', growing: '🌿', active: '🌿',
  flowering: '🌸', fruiting: '🍅', harvesting: '🧺', harvested: '✅',
  dormant: '💤', planning: '📋', ended: '⏹️', failed: '✕', dead: '✕',
}

export function statusIcon(status) {
  return STATUS_ICONS[status] ?? '•'
}

export default function PlantStatusBadge({ status, size = 'sm' }) {
  if (!status) return null
  const sc = getStatusColors(status)
  const icon = statusIcon(status)
  const fontSize = size === 'lg' ? '0.85rem' : '0.73rem'
  const pad = size === 'lg' ? '4px 12px' : '2px 9px'
  return (
    <span
      // aria-label folds the glyph out and reads just "Status: <label>" to AT.
      aria-label={`Status: ${status}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        fontSize, fontWeight: 600, padding: pad, borderRadius: 12,
        backgroundColor: sc.bg, color: sc.text, border: `1px solid ${sc.border}`,
        whiteSpace: 'nowrap', flexShrink: 0,
      }}
    >
      <span aria-hidden="true">{icon}</span>
      <span>{status}</span>
    </span>
  )
}
