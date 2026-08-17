// Sort control for Harvests → Totals. Applies to the crop list AND to the variety sub-rows inside
// each expanded crop — one control, one mental model, per Dave: "both for the main list (the crop
// type main view) as well as the inside-a-type (where each tomato is listed)".
//
// Mode uses the canonical SegmentedControl (exactly-one-active view switch, which this is). The
// direction toggle is a separate button rather than a fourth segment: mode and direction are two
// independent axes, and folding "Z→A" in beside "Name / Weight / Picks" would make six segments
// that can express contradictory states on a 390px screen.
import React from 'react'
import { P } from '../lib/constants.js'
import SegmentedControl from './forms/SegmentedControl.jsx'
import { HARVEST_SORT_MODES } from '../lib/harvestSort.js'

// Direction reads in the vocabulary of the ACTIVE axis, not as a bare arrow. "A→Z" and "Most first"
// say what will happen; an unlabelled ↑ on a list sorted by weight does not — up could mean
// heaviest-first or lightest-first and the user has to tap it to find out.
function dirLabel(mode, dir) {
  if (mode === 'name') return dir === 'asc' ? 'A→Z' : 'Z→A'
  return dir === 'desc' ? 'Most first' : 'Least first'
}

export default function HarvestSortControl({ mode, dir, onModeChange, onDirChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: '0.78rem', color: P.mid, flexShrink: 0 }}>Sort</span>
      <div style={{ flex: '1 1 auto', minWidth: 150 }}>
        <SegmentedControl
          small
          options={HARVEST_SORT_MODES}
          value={mode}
          onChange={onModeChange}
          ariaLabel="Sort totals by name, weight or pick count"
        />
      </div>
      <button
        type="button"
        onClick={() => onDirChange(dir === 'asc' ? 'desc' : 'asc')}
        // The label already names the CURRENT order, so it doubles as the state readout; aria-label
        // spells out that pressing it reverses, which the visible text alone does not convey.
        aria-label={`Sorted ${dirLabel(mode, dir)} — reverse the order`}
        style={{
          flexShrink: 0, minHeight: 34, padding: '0 10px',
          background: P.white, color: P.mid,
          border: `1px solid ${P.border}`, borderRadius: 8,
          fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 5,
        }}
      >
        <span aria-hidden="true">{dir === 'asc' ? '↑' : '↓'}</span>
        {dirLabel(mode, dir)}
      </button>
    </div>
  )
}
