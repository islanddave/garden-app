import React from 'react'
import { useNavigate } from 'react-router-dom'
import { P } from '../lib/constants.js'
import { severityTier, SEVERITY_STYLES, overdueLabel } from '../lib/waterDue.js'

// Garden-tab "Today" strip (Inc 1). The Dashboard already surfaces watering urgency
// (WaterMeTile), but the Dashboard was dropped from the nav (NAV-IA-1) — so the primary
// Garden surface had no glance-and-act for "what needs doing now". This compact strip
// closes that reachability gap. It is an OPERATIONAL ALERT (harm-prevention: plants
// drying out), not a reward surface — ambient, in-context, no push/modal/interrupt.
// Renders NOTHING when nothing is overdue (ADHD-overwhelm: no empty clutter).
// Frontend-only: reuses /api/dashboard water_due + the shared severity single-source-of-truth.
//
// V1 scope: surfaces the single top-severity overdue watering + a "+N more" count; tapping
// logs that one (data reloads, next becomes top). The Dashboard WaterMeTile keeps the full
// expandable list. Recent-activity (Scenario B's second half) is deliberately out — it is a
// non-actionable feed and already lives on the Dashboard; the actionable glance is watering.

export default function GardenTodayStrip({ waterDue = [] }) {
  const navigate = useNavigate()
  if (!waterDue || waterDue.length === 0) return null

  const top = waterDue[0]
  const tier = severityTier(top.next_water_at, top.location_type)
  const s = SEVERITY_STYLES[tier] || SEVERITY_STYLES.gold
  const more = waterDue.length - 1

  return (
    <section aria-label="Needs attention today" style={{ marginBottom: 16 }}>
      <button
        type="button"
        onClick={() => navigate(`/log?project=${top.project_id}&event_type=watering`)}
        style={{
          display: 'block', width: '100%', textAlign: 'left',
          padding: '12px 14px', minHeight: 44,
          backgroundColor: s.bg, border: `1.5px solid ${s.border}`,
          borderRadius: 10, cursor: 'pointer',
        }}
      >
        <div style={{ fontSize: '0.72rem', color: P.mid, fontWeight: 600, marginBottom: 3, letterSpacing: '0.02em' }}>
          💧 NEEDS WATER · TODAY
        </div>
        <div style={{ fontWeight: 700, color: s.text, fontSize: '0.95rem' }}>
          {more > 0 ? `${top.project_name} + ${more} more` : top.project_name}
        </div>
        <div style={{ fontSize: '0.76rem', color: P.mid, marginTop: 2 }}>
          {overdueLabel(top.next_water_at)} · tap to log watering →
        </div>
      </button>
    </section>
  )
}
