// V3-ORDER-001 (Lane C / PR1): shared sort-order toggle used identically on every planting/
// project list surface (Garden, ProjectDetail plantings, legacy /plants) so ordering parity is
// guaranteed by one component, not three copies. Two states: A–Z (alpha, DEFAULT) and Recent.
//
// A–Z (alphabetical) is the default everywhere per the owner override (Dave, 2026-06-04),
// overriding the Crucible's recency-default. Recency remains one tap away and persists.
// Persistence is handled by the caller via loadSortOrder/
// saveSortOrder (localStorage, tracked V4 follow-up for cross-device); this component is a
// controlled segmented control: it renders `order` and calls onChange(next).
//
// Accessibility: role=group with two role=radio buttons; each ≥ 44px tall (48 effective with
// padding) and pressed state announced via aria-checked. Tap targets are siblings with gap.
import React from 'react'
import { P } from '../lib/constants.js'
import { SORT_RECENCY, SORT_ALPHA } from '../lib/projectTree.js'

const OPTIONS = [
  { value: SORT_RECENCY, label: 'Recent', aria: 'Sort by most recent' },
  { value: SORT_ALPHA, label: 'A–Z', aria: 'Sort alphabetically' },
]

export default function SortToggle({ order = SORT_ALPHA, onChange, label = 'Sort plantings' }) {
  return (
    <div
      role="group"
      aria-label={label}
      style={{ display: 'inline-flex', gap: 4, border: `1px solid ${P.border}`, borderRadius: 8, padding: 2, backgroundColor: P.white }}
    >
      {OPTIONS.map(opt => {
        const active = order === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={opt.aria}
            onClick={() => { if (!active && onChange) onChange(opt.value) }}
            style={{
              minHeight: 36, minWidth: 56, padding: '6px 12px',
              border: 'none', borderRadius: 6, cursor: active ? 'default' : 'pointer',
              fontSize: '0.8rem', fontWeight: 600, fontFamily: 'inherit',
              backgroundColor: active ? P.green : 'transparent',
              color: active ? P.white : P.mid,
              transition: 'background-color 0.12s, color 0.12s',
            }}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
