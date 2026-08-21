// src/components/HarvestReadyBand.jsx
// V4-HARVESTSURF-001 — the "ready to pick" ambient card on Today. Mirrors PutUpUseSoonBand's data
// posture exactly: self-fetching, refresh on mount / in-app nav / app-foreground, and the fetch error
// is still SWALLOWED (supplementary glance — it must never throw or surface onto Today).
//
// BUG-READYBANDFETCH-001: swallowing is not the same as rendering nothing. A failed fetch used to
// leave state null, which renders identically to an empty queue — an outage was indistinguishable
// from "nothing to pick" on the exact surface whose job is to answer that question. The fetch now
// runs through useAmbientBandFetch, which retries once and then reports `failed`, and this band
// renders one muted ambient line instead of vanishing. Still no toast, modal, banner or alert colour.
//
// Deliberately NOT routed through the daily-plan engine: PLAN_SCHEMA_VERSION is pinned across four
// files behind a lockstep anti-drift test, the parity golden harness blocks on any added key, and a
// nightly batch cannot reflect a harvest logged at 9am. A self-fetching band is fresh every load.
//
// Reward-UX V102 compliance: ambient only. No push, no modal, no toast/snackbar/sheet, no haptic, no
// streak, no numeric count badge. Neutral cadence framing ("last picked N days ago") — no
// loss-aversion, no countdown, no urgency colour. Renders nothing at all when nothing is ready.
//
// The row action NAVIGATES to the prefilled harvest form; it never one-tap POSTs. `harvest` requires
// quantity + unit (both NOT NULL), so a quantity-less POST would 400, and `harvest` is in
// BATCH_EXCLUDED_TYPES so no bulk affordance may exist here.
import React, { useState, useCallback } from 'react'
import { useOverlayNavigate } from '../context/OverlayContext.jsx'
import { P } from '../lib/constants.js'
import { rankHarvestReady, rollUpByCrop, cropSubLabel } from '../lib/harvestReadiness.js'
import { revealStep } from '../lib/harvestWatch.js'
import { useAmbientBandFetch } from '../lib/useAmbientBandFetch.js'
import AmbientBandNotice from './AmbientBandNotice.jsx'

const MAX_ROWS = 5

// PANEL Q4 (harvest-panel-decisions-20260812.md): "+{N} more in the garden" was dead text on the
// exact band Dave named ("that can't be lost there anywhere"). It is now a real in-place expand —
// a pure client change: this band already holds every candidate and computes the overflow in the
// browser. Expansion is SESSION-scoped (sessionStorage: survives an in-app remount of Today, dies
// with the tab, never localStorage) and reveals 20 at a time above 25 hidden. The payload carries
// no location_name, so the reveal is flat in rank order — grouping stays the watch band's affair.
const REVEAL_KEY = 'harvest-tail:ready'
function readReveal() {
  try {
    const n = Number(sessionStorage.getItem(REVEAL_KEY))
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
  } catch { return 0 }
}
function writeReveal(n) {
  try { sessionStorage.setItem(REVEAL_KEY, String(n)) } catch { /* ignore */ }
}

// Full-width tail control, ≥48px (52 matches CareNeeded's group headers); count in the LABEL,
// never a pill. Pattern copied from src/components/today/CareNeeded.jsx — copied, not refactored.
const tailButtonStyle = {
  display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
  minHeight: 52, padding: '12px 2px', background: 'none', border: 'none',
  borderTop: `1px solid ${P.border}`, cursor: 'pointer', fontFamily: 'inherit',
  fontSize: '0.85rem', fontWeight: 700, color: P.green,
}

// Module-level so the hook's load callback stays referentially stable across renders.
const normalize = (d) => (d && Array.isArray(d.candidates) ? d : { candidates: [], et_doy: null })

export default function HarvestReadyBand() {
  const overlayNavigate = useOverlayNavigate()
  const [revealed, setRevealed] = useState(readReveal)
  const { data, failed, reload } = useAmbientBandFetch('/api/events/harvest-ready', normalize)

  const setReveal = useCallback((n) => { writeReveal(n); setRevealed(n) }, [])

  // The server supplies the reporting-zone day-of-year; the predicate is a pure function of it.
  // ONE ROW PER CROP, not per planting (crucible 2026-08-20 — see rollUpByCrop's header). Applied as
  // a post-filter on the ranked output so the ranker, the score and READY_MODEL_VERSION are all
  // untouched and EventNew's live harvest tray keeps consuming the flat list.
  const ready = data ? rollUpByCrop(rankHarvestReady(data.candidates, data.et_doy)) : []

  // BUG-READYBANDFETCH-001 — before the empty check, because "we could not ask" is not "nothing is
  // ready". Only reachable on a second consecutive failure with no data in hand.
  if (failed && !data) return <AmbientBandNotice eyebrow="In the garden" onRetry={reload} />

  // Hidden entirely when empty (or before the first load resolves).
  if (ready.length === 0) return null

  const shown = ready.slice(0, MAX_ROWS)
  const overflow = ready.slice(MAX_ROWS)
  const shownOverflow = overflow.slice(0, revealed)
  const hidden = overflow.length - shownOverflow.length
  const expanded = revealed > 0

  const renderRow = (r) => (
    <li key={r.plant_id}>
      {/* The tap target is the crop's REPRESENTATIVE — its most-overdue planting, which is the member
          that won the crop its position. No `&crop=` param is invented for this: both shipped entry
          points to the harvest session are `/log?session=harvest` with no plant scope, so a crop
          filter would be a new server contract, not a presentation rollup. */}
      <button
        type="button"
        onClick={() => overlayNavigate(`/log?project=${r.project_id}&plant=${r.plant_id}&event_type=harvest`)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          width: '100%', textAlign: 'left', minHeight: 44, padding: '6px 0',
          background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        <span style={{ minWidth: 0 }}>
          {/* The row's unit is the CROP, so the crop name leads — a row folding seven tomato
              plantings must not be headlined with one cultivar's name. Also the only form legible to
              a four-harvest user: "Tomato" reads, "Kori Sitakame" does not. Falls back to the
              planting name so a payload without a crop label still renders what it has. */}
          <span style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, color: P.dark,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {r.crop_display_name || r.name || 'Planting'}
          </span>
          <span style={{ display: 'block', fontSize: '0.78rem', color: P.light,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {cropSubLabel(r)}
          </span>
        </span>
        <span style={{ fontSize: '0.78rem', fontWeight: 600, color: P.green, flexShrink: 0, whiteSpace: 'nowrap' }}>
          Log harvest
        </span>
      </button>
    </li>
  )

  return (
    <section
      aria-label="Due for a pick"
      style={{
        backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 12,
        padding: '14px 16px', marginTop: 16,
      }}
    >
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: P.light }}>
          In the garden
        </div>
        {/* Panel Q1 heading: "Due for a pick" — true by construction (every row has a recorded
            cadence it is past), where "Ready to pick" asserted ripeness the model cannot know. */}
        <div style={{ fontSize: '1rem', fontWeight: 700, color: P.dark }}>Due for a pick</div>
      </div>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {shown.map(renderRow)}
      </ul>

      {/* THE TAIL (panel Q4) — the discharge of R8, on the band Dave actually named. Trigger first,
          content AFTER it, so the button's top edge keeps its viewport y when it expands.
          SINCE THE CROP ROLLUP the count is CROPS, not plantings (on prod today: 11 crop rows over 29
          ready plantings, so "Show 6 more" rather than "Show 24 more"). Individual cultivar rows are
          no longer reachable from this band at all — the sibling count in each row's label carries
          the magnitude, and the per-planting list lives in EventNew's harvest tray, unchanged. */}
      {hidden > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls="harvest-ready-tail"
          onClick={() => setReveal(revealed + revealStep(hidden))}
          style={tailButtonStyle}
        >
          <span style={{ flex: 1 }}>Show {hidden} more due for a pick</span>
          <span aria-hidden="true" style={{ color: P.light, transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
        </button>
      )}

      {expanded && (
        <div id="harvest-ready-tail">
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {shownOverflow.map(renderRow)}
          </ul>
          {/* Second collapse control at the bottom (panel Q4). */}
          <button
            type="button"
            aria-expanded={true}
            aria-controls="harvest-ready-tail"
            onClick={() => setReveal(0)}
            style={tailButtonStyle}
          >
            <span style={{ flex: 1 }}>Show fewer</span>
            <span aria-hidden="true" style={{ color: P.light, transform: 'rotate(180deg)', transition: 'transform 0.15s' }}>▾</span>
          </button>
        </div>
      )}
    </section>
  )
}
