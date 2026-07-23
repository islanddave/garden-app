import React from 'react'
import { P } from '../lib/constants.js'

// QualityDots — V4-HARVESTVIEW-001 S2a. Renders a harvest's quality_rating as filled dots on a 1–max
// scale (design §3b). null / 0 / non-integer / out-of-range → renders NOTHING (a missing rating is not
// "zero quality"). a11y: one labelled group "Quality N of max"; the dots themselves are decorative.
export default function QualityDots({ value, max = 5 }) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > max) return null
  return (
    <span
      role="img"
      aria-label={`Quality ${n} of ${max}`}
      style={{ display: 'inline-flex', gap: 2, verticalAlign: 'middle' }}
    >
      {Array.from({ length: max }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          style={{
            width: 7, height: 7, borderRadius: '50%',
            backgroundColor: i < n ? P.green : P.border,
          }}
        />
      ))}
    </span>
  )
}
