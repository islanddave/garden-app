// src/components/HarvestReadyBand.jsx
// V4-HARVESTSURF-001 — the "ready to pick" ambient card on Today. Mirrors PutUpUseSoonBand's data
// posture exactly: self-fetching via useApiFetch, refresh on mount / in-app nav / app-foreground, and
// the fetch error is SWALLOWED (supplementary glance — it must never throw or surface onto Today).
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
import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useOverlayLocation, useOverlayNavigate } from '../context/OverlayContext.jsx'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { rankHarvestReady, lastPickedLabel } from '../lib/harvestReadiness.js'

const MAX_ROWS = 5

export default function HarvestReadyBand() {
  const { fetch } = useApiFetch()
  const location = useOverlayLocation()
  const overlayNavigate = useOverlayNavigate()
  const [data, setData] = useState(null)
  const inflight = useRef(false)

  const load = useCallback(() => {
    if (inflight.current) return
    inflight.current = true
    fetch('/api/events/harvest-ready')
      .then(d => setData(d && Array.isArray(d.candidates) ? d : { candidates: [], et_doy: null }))
      .catch(() => { /* supplementary glance — never surface a fetch error */ })
      .finally(() => { inflight.current = false })
  }, [fetch])

  useEffect(() => { load() }, [load, location.pathname])

  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') load() }
    window.addEventListener('focus', load)
    document.addEventListener('visibilitychange', onVis)
    return () => { window.removeEventListener('focus', load); document.removeEventListener('visibilitychange', onVis) }
  }, [load])

  // The server supplies the reporting-zone day-of-year; the predicate is a pure function of it.
  const ready = data ? rankHarvestReady(data.candidates, data.et_doy) : []

  // Hidden entirely when empty (or before the first load resolves).
  if (ready.length === 0) return null

  const shown = ready.slice(0, MAX_ROWS)
  const more = ready.length - shown.length

  return (
    <section
      aria-label="Ready to pick"
      style={{
        backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 12,
        padding: '14px 16px', marginTop: 16,
      }}
    >
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: P.light }}>
          In the garden
        </div>
        <div style={{ fontSize: '1rem', fontWeight: 700, color: P.dark }}>Ready to pick</div>
      </div>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {shown.map(r => (
          <li key={r.plant_id}>
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
                <span style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, color: P.dark,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.name || r.crop_display_name || 'Planting'}
                </span>
                <span style={{ display: 'block', fontSize: '0.78rem', color: P.light,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {lastPickedLabel(r.days_since_last_harvest)}
                </span>
              </span>
              <span style={{ fontSize: '0.78rem', fontWeight: 600, color: P.green, flexShrink: 0, whiteSpace: 'nowrap' }}>
                Log harvest
              </span>
            </button>
          </li>
        ))}
      </ul>

      {more > 0 && (
        <div style={{ fontSize: '0.78rem', color: P.light, marginTop: 8 }}>
          +{more} more in the garden
        </div>
      )}
    </section>
  )
}
