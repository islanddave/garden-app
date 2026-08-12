// HarvestTimeframeChips — V4-HARVESTVIEW-001 S4 + V4-HARVDEFAULT-001. THE shared harvest timeframe
// control (design §2b: ONE control, never a second Totals-only selector). Extracted from
// Harvests.jsx's local TimeframeChips so the export sheet (V4-HARVEXPORT-001 §2c: "date range = the
// existing timeframe vocabulary") reuses the SAME row instead of minting a sibling. Deliberately NOT
// migrated onto FilterChipRow this release (design §1b: consolidation is a ledger follow-up).
//
// The 4th chip is the SEASON chip: it ALWAYS opens a small grow-year sheet (a tap on the
// already-active chip reopens it — no deselect ambiguity) and RELABELS itself with the chosen season.
// Canon label convention (harvest-view §4): "2026 season" = the season ENDING Oct 2026; selecting the
// current season restores "This season". Sheet rows carry the Nov–Oct span; current season first,
// prior seasons below (universe from the caller — the UNFILTERED first_pick range, design §2b, so it
// never self-collapses under a season selection). Writes the same `season:<year>` / '' vocabulary the
// server already parses — zero server change for the selector itself.
import React, { useState } from 'react'
import { P } from '../lib/constants.js'
import Sheet from './forms/Sheet.jsx'
import { currentGrowYear } from '../lib/growYear.js'

// ≥48px touch targets per the build-spec addendum (design §5.8) — the whole row moves together so
// the new season chip doesn't sit taller than its siblings.
const chipStyle = (active) => ({
  padding: '6px 14px', minHeight: 48, borderRadius: 20, fontSize: '0.82rem', fontWeight: 600,
  cursor: 'pointer', border: `1px solid ${active ? P.green : P.border}`,
  backgroundColor: active ? P.greenPale : P.white, color: active ? P.green : P.mid,
})

function seasonChipLabel(value, current) {
  const m = /^season:(\d{4})$/.exec(String(value ?? ''))
  if (!m) return 'This season'
  const y = Number(m[1])
  return y === current ? 'This season' : `${y} season`
}

function spanLabel(year) {
  const yy = (y) => String(y).slice(2)
  return `Nov '${yy(year - 1)}–Oct '${yy(year)}`
}

export default function HarvestTimeframeChips({ value, onChange, seasonYears, ariaLabel = 'Filter by timeframe' }) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const current = currentGrowYear(new Date())
  const years = Array.isArray(seasonYears) && seasonYears.length > 0 ? seasonYears : [current]
  const seasonActive = /^season:\d{4}$/.test(String(value ?? ''))
  const fixed = [
    { value: '', label: 'All time' },
    { value: '7d', label: 'Last 7 days' },
    { value: 'month', label: 'This month' },
  ]
  return (
    <>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }} role="group" aria-label={ariaLabel}>
        {fixed.map((c) => {
          const active = value === c.value
          return (
            <button key={c.value || 'all'} type="button" onClick={() => onChange(c.value)} aria-pressed={active} style={chipStyle(active)}>
              {c.label}
            </button>
          )
        })}
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          aria-pressed={seasonActive}
          aria-haspopup="dialog"
          style={chipStyle(seasonActive)}
        >
          {seasonChipLabel(value, current)}
          <span aria-hidden="true" style={{ fontSize: '0.7rem', opacity: 0.7, marginLeft: 5 }}>▾</span>
        </button>
      </div>
      <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Season" armsBack>
        <div role="listbox" aria-label="Season" style={{ padding: '2px 8px 8px', display: 'flex', flexDirection: 'column' }}>
          {years.map((y) => {
            const v = `season:${y}`
            const selected = value === v
            return (
              <button
                key={y}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => { onChange(v); setSheetOpen(false) }}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%', textAlign: 'left', padding: '12px 16px', minHeight: 48, background: selected ? P.greenPale : 'transparent', border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: '0.92rem', fontWeight: selected ? 700 : 500, color: selected ? P.green : P.dark }}
              >
                <span>
                  {y === current ? 'This season' : `${y} season`}
                  <span style={{ display: 'block', fontSize: '0.76rem', fontWeight: 500, color: P.light, marginTop: 1 }}>{spanLabel(y)}</span>
                </span>
                {selected && <span aria-hidden="true" style={{ color: P.green, fontWeight: 700 }}>✓</span>}
              </button>
            )
          })}
        </div>
      </Sheet>
    </>
  )
}
