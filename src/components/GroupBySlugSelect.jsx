// V4-FACETSLUG-001 (BD0806-21) — one tappable slug selector for the Garden group-by axis.
//
// WHY: the Garden group-by shipped as GroupByControl, a wrapping chip row with exactly one chip per
// facet. Live-measured on prod 2026-08-14 that row renders TWELVE chips (crop_type + 9 tag facets
// present across 277 live plantings + status + location), which wraps into a multi-line scrap heap
// on the 390px Android reference viewport. One tappable slug replaces the whole row.
//
// PATTERN: deliberately the SAME interaction as the planting-status control
// (components/planting/StatusPicker.jsx, V4-STATUSTAP-001): a visible face with a transparent native
// <select> overlaid at inset:0. The native select is a real combobox — TalkBack on Chrome for
// Android announces the accessible name + current value, opens the platform menu on tap, and walks
// the options with the platform picker; keyboard gets arrow/type-ahead/Enter for free; focus stays
// on the select after a choice and after dismissal. Nothing here re-implements a listbox, so there
// is no ARIA pattern to get wrong.
//
// SCOPE: GroupByControl is deliberately NOT modified. It has a second consumer — Today's CareNeeded
// (components/today/CareNeeded.jsx:344), whose 2-option row is fine as chips and whose suite pins
// role="group" + the "Group by" accessible name (__tests__/CareNeeded.test.jsx:46). Changing it in
// place would silently re-skin Today and break a test named after another surface. This is a Garden-
// only sibling; Today keeps the chip row untouched.
import React from 'react'
import { P, T } from '../lib/tokens.js'

export default function GroupBySlugSelect({ options = [], value, onChange, id = 'garden-groupby', style }) {
  if (!options.length) return null
  const current = options.find((o) => o.value === value) || options[0]

  return (
    <>
      {/* SC 2.4.7: the overlaid select is opacity:0, which hides its own focus ring, so the visible
          indicator is drawn on the WRAPPER via :focus-within. Needs a real class — inline styles
          cannot express pseudo-classes. Mirrors StatusPicker's approach, recolored for a light row. */}
      <style>{`.v4-slugselect:focus-within{outline:2px solid ${P.green};outline-offset:2px;border-radius:${T.radiusButton}px;}`}</style>
      <span
        className="v4-slugselect"
        data-testid="groupby-slug"
        style={{
          position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6,
          minHeight: 36, padding: '8px 13px',
          backgroundColor: P.white, color: P.green,
          border: `1px solid ${P.greenLight}`, borderRadius: T.radiusButton,
          fontSize: '0.85rem', fontWeight: 600, maxWidth: '100%', ...style,
        }}
      >
        {/* aria-hidden: the <select> already announces "Group by, {label}" via its accessible name
            and selected value, so the visible face is decorative to AT (avoids the SC 4.1.2 double
            announcement StatusPicker documents). */}
        <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{ color: P.mid, fontWeight: 500, whiteSpace: 'nowrap' }}>Group by</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current.label}</span>
          <svg width="12" height="12" viewBox="0 0 12 12" focusable="false" style={{ flexShrink: 0 }}>
            <path d="M2.5 4.5 L6 8 L9.5 4.5" fill="none" stroke={P.green} strokeWidth="1.6"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <select
          id={id}
          value={current.value}
          onChange={(e) => onChange && onChange(e.target.value)}
          aria-label="Group by"
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%', margin: 0, padding: 0,
            border: 'none', opacity: 0, cursor: 'pointer', appearance: 'none', WebkitAppearance: 'none',
          }}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </span>
    </>
  )
}
