// Sparkline — V4-HARVESTVIEW-001 S4. Presentation-only per canon harvest-view §8:
// `Sparkline {values[]}` — palette-token stroke, NO API-shape coupling (callers map their payload to
// a bare number array; this component never sees week_start keys or crop objects). Ambient
// retrospective texture, not a chart: no axes, no labels, no interaction, no denominator.
import React from 'react'
import { P } from '../lib/constants.js'

const BAR_W = 4
const GAP = 2

export default function Sparkline({ values = [], height = 18, ariaLabel = 'Weekly harvest activity' }) {
  const vals = (Array.isArray(values) ? values : []).map(Number).filter((v) => Number.isFinite(v) && v >= 0)
  if (vals.length === 0) return null
  const max = Math.max(...vals, 1)
  const width = vals.length * (BAR_W + GAP) - GAP
  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      data-testid="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: 'block', overflow: 'visible' }}
    >
      {vals.map((v, i) => {
        // Zero-count weeks render a 1px baseline tick — a quiet week is data, not absence.
        const h = v === 0 ? 1 : Math.max(2, Math.round((v / max) * (height - 2)))
        return (
          <rect
            key={i}
            data-testid="sparkline-mark"
            x={i * (BAR_W + GAP)}
            y={height - h}
            width={BAR_W}
            height={h}
            rx={1}
            fill={P.greenLight}
          />
        )
      })}
    </svg>
  )
}
