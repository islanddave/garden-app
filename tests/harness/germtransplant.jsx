// V4-GERMVSTRANSPLANT-001 — the two glyphs at the size the claim is actually about.
//
// The whole finding is "indistinguishable at 22px", and jsdom cannot render, so no vitest assertion
// can either confirm the defect or confirm the fix. This page puts germination, transplant and
// care.plantedOut side by side at 22px in the arrangement that matters — ADJACENT TIMELINE ROWS,
// which is the one place a reader compares them — and again at 56px to check the drawing itself.
//
// The row order below is deliberate: sowing sits first because germination now carries a seed and
// must not collapse into sowing's bare bean either. Four glyphs, one axis: what each does with the
// soil line.
import React from 'react'
import { createRoot } from 'react-dom/client'
import Icon from '../../src/components/Icon.jsx'
import { P } from '../../src/lib/constants.js'

const ROWS = [
  { name: 'event.sowing', label: 'Sowed', note: 'bare bean, no line' },
  { name: 'event.germination', label: 'Germinated', note: 'seed BELOW the line, one cotyledon' },
  { name: 'event.transplant', label: 'Transplanted', note: 'sprout ON the line, two cotyledons' },
  { name: 'care.plantedOut', label: 'Planted out', note: 'sprout IN a hollow in the line' },
]

// Mirrors the life-story timeline: a 22px glyph, a label, tight vertical rhythm. This is the
// comparison that matters — isolated glyphs always look more distinct than stacked ones do.
const Timeline = () => (
  <div className="timeline">
    {ROWS.map(r => (
      <div className="row" key={r.name}>
        <Icon name={r.name} size={22} decorative style={{ color: P.greenDeep }} />
        <span className="label">{r.label}</span>
        <span className="note">{r.note}</span>
      </div>
    ))}
  </div>
)

const Big = ({ size }) => (
  <div className="big">
    {ROWS.map(r => (
      <figure key={r.name}>
        <Icon name={r.name} size={size} decorative style={{ color: P.greenDeep }} />
        <figcaption>{r.label}</figcaption>
      </figure>
    ))}
  </div>
)

createRoot(document.getElementById('root')).render(
  <>
    <h2>As a timeline — 22px, the size that ships</h2>
    <p className="note">Adjacent rows, which is how they are actually read.</p>
    <Timeline />

    <h2>22px, isolated</h2>
    <Big size={22} />

    <h2>18px master</h2>
    <p className="note">Below 21px Icon.jsx swaps to svg18. transplant&rsquo;s 18 drops its ground
      line; germination&rsquo;s keeps line and seed, so the pair diverges further here, not less.</p>
    <Big size={18} />

    <h2>56px — the drawing itself</h2>
    <Big size={56} />
  </>
)
