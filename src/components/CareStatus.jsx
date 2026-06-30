// CareStatus — Slice 5a shared live-care band (presentational only).
//
// Single render surface for the watering-care state of a planting, reused wherever a live
// "needs water" cue is shown. Lives OUTSIDE src/components/forms/ (top-level, like Lightbox.jsx)
// so it is NOT in the no-hex / no-emoji freeze-guard ESLint scope — but it still sources ALL
// color from the canonical SEVERITY_STYLES (object-identity, never cloned) so the band's tiers
// stay byte-identical to the Dashboard WaterMeTile / Garden Today strip (L-075).
//
// THREE STATES on top of waterDue.js (which only knows overdue tiers gold/terra/terra-bold):
//   CALM   — nextWaterAt null OR scheduled in the future  → variant='band' renders NOTHING.
//            Locked design: on calm days the hero leads; the band is ABSENT, not a green chip.
//   ACTIVE — daysOver >= 0 (due today or overdue)          → render the care band.
// The due-today vs overdue distinction and the calm state are added HERE, additively, without
// touching waterDue.js (severityTier still only ever returns gold/terra/terra-bold for rows it
// sees, which are always daysOver >= 0 by the time we call it).
//
// PURELY PRESENTATIONAL: props in, JSX out. No fetch, no effects, no reach into projectTree/
// todayBand. The owning page recomputes next_water_at after a watering log and re-passes it.
//
// A11y (SC 1.4.1 — color is never the sole channel): the ACTIVE band carries THREE channels —
// (a) a care.drop Icon in the band's text color, (b) a text headline + overdue label, and
// (c) the bg/border/text color. role=status + aria-live=polite announce the state on change.
import React from 'react'
import { severityTier, SEVERITY_STYLES, overdueLabel } from '../lib/waterDue.js'
import Icon from './Icon.jsx'

const SIZE_PX = { sm: 16, md: 20, lg: 24 }

export default function CareStatus({ nextWaterAt, locationType, size = 'md', variant = 'band' }) {
  // CALM — no schedule at all.
  if (nextWaterAt == null) return null

  const daysOver = (Date.now() - new Date(nextWaterAt).getTime()) / 86400000

  // CALM — scheduled, but in the future.
  if (daysOver < 0) return null

  // ACTIVE — due today or overdue.
  const tier = severityTier(nextWaterAt, locationType)
  const label = overdueLabel(nextWaterAt)      // 'due today' | '1 day overdue' | 'N days overdue'
  const style = SEVERITY_STYLES[tier]
  const headline = label === 'due today' ? 'Due today' : 'Overdue'
  const iconPx = SIZE_PX[size] ?? SIZE_PX.md

  if (variant !== 'band') return null

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`Watering ${label}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        borderRadius: 12,
        padding: '12px 16px',
        backgroundColor: style.bg,
        border: `1px solid ${style.border}`,
        color: style.text,
        margin: '0 0 16px',
      }}
    >
      {/* Channel (a): mono icon rendered in the band's text color (currentColor tracks style.text). */}
      <Icon name="care.drop" size={iconPx} decorative style={{ color: style.text, flexShrink: 0 }} />
      {/* Channel (b): text headline + (for overdue) the precise label. */}
      <span style={{ minWidth: 0 }}>
        <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{headline}</span>
        {label !== 'due today' && (
          <span style={{ fontWeight: 400, fontSize: '0.9rem' }}> · {label}</span>
        )}
      </span>
    </div>
  )
}
