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
//
// `lastWateredAt` (additive) answers "when did I last water this" IN PLACE. It had exactly two
// render sites in all of src/ — the Dashboard More-menu and the PlantingDetail Care tab, which sits
// inside a Sheet that opens closed on a non-default tab: five taps, and until the tab reset at
// PlantingDetail's HeroPhoto was removed the Care tab could not even become sticky, so the route
// was unlearnable. The value already rides in the same planting payload as next_water_at, so this
// costs no request. Rendered as an ABSOLUTE date, not "N days ago": the band's own overdue label is
// already a days count measured from next_water_at, and two adjacent day-counts that legitimately
// differ by the watering interval would read as a contradiction.
//
// The CALM states above still render nothing — that is the locked Slice 5a design (on calm days the
// hero leads), and this is a fact ADDED to an existing band, not a reason to introduce a new one.
//
// `intervalDays` (additive, BUG-CADENCEONEDAY-001) collapses the ACTIVE band to its due-today form
// for a one-day cadence: gold, headline "Due today", qualified "· daily" so the reader learns WHY
// this band is here every single morning instead of reading it as a debt that keeps growing. The
// elapsed-time fact survives verbatim in the "Last watered {date}" line the band already carries —
// which is why the band can drop the days-overdue count without dropping any information.
import React from 'react'
import { severityTier, SEVERITY_STYLES, overdueLabel, isDailyCadence } from '../lib/waterDue.js'
import Icon from './Icon.jsx'

const SIZE_PX = { sm: 16, md: 20, lg: 24 }

function fmtShortDate(value) {
  if (!value) return null
  const d = new Date(typeof value === 'string' && value.length === 10 ? value + 'T00:00:00' : value)
  if (isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function CareStatus({ nextWaterAt, lastWateredAt, locationType, intervalDays, size = 'md', variant = 'band' }) {
  // CALM — no schedule at all.
  if (nextWaterAt == null) return null

  const daysOver = (Date.now() - new Date(nextWaterAt).getTime()) / 86400000

  // CALM — scheduled, but in the future.
  if (daysOver < 0) return null

  // ACTIVE — due today or overdue.
  const daily = isDailyCadence(intervalDays)
  const tier = severityTier(nextWaterAt, locationType, intervalDays)
  const label = overdueLabel(nextWaterAt, intervalDays)   // 'due today' | '1 day overdue' | 'N days overdue'
  const style = SEVERITY_STYLES[tier]
  const headline = label === 'due today' ? 'Due today' : 'Overdue'
  const iconPx = SIZE_PX[size] ?? SIZE_PX.md
  const lastWatered = fmtShortDate(lastWateredAt)

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
      {/* Channel (b): text headline + (for overdue) the precise label, then the last-watered fact. */}
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block' }}>
          <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{headline}</span>
          {label !== 'due today' && (
            <span style={{ fontWeight: 400, fontSize: '0.9rem' }}> · {label}</span>
          )}
          {daily && (
            <span style={{ fontWeight: 400, fontSize: '0.9rem' }}> · daily</span>
          )}
        </span>
        {lastWatered && (
          <span style={{ display: 'block', fontWeight: 400, fontSize: '0.78rem', opacity: 0.85 }}>
            Last watered {lastWatered}
          </span>
        )}
      </span>
    </div>
  )
}
