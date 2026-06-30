import React from 'react'
import { useDailyPlan } from '../../hooks/useDailyPlan.js'
import { P } from '../../lib/constants.js'
import { buildReasoningLines } from '../../lib/drgReasoning.js'

// Today's reasoning — Slice 8 DrG read-only rationale ("Why today looks like this"). Assembled
// purely from the daily-plan data via buildReasoningLines (anti-fabrication). No tappable tasks
// (Today owns actions). Ambient: no reward/celebration. Quiet card; honest no-plan/steady states.
export default function TodayReasoning() {
  const { data, loading } = useDailyPlan()
  if (loading) return null
  const { state, lines } = buildReasoningLines(data)

  return (
    <section aria-labelledby="drg-reasoning-h" style={{ marginBottom: 18 }}>
      <h2 id="drg-reasoning-h" style={{ fontSize: '1rem', fontWeight: 700, color: P.dark, margin: '0 0 8px' }}>
        Why today looks like this
      </h2>
      <div style={{ background: P.white, border: '1px solid ' + P.border, borderRadius: 12, padding: '12px 14px' }}>
        {state === 'noplan' && (
          <p style={{ margin: 0, fontSize: '0.85rem', color: P.mid, lineHeight: 1.5 }}>
            No plan yet for today — Doctor Gardener builds this from your plantings and the weather. Add plantings or log care to see reasoning here.
          </p>
        )}
        {state === 'steady' && (
          <p style={{ margin: 0, fontSize: '0.85rem', color: P.mid, lineHeight: 1.5 }}>
            Everything&rsquo;s steady today — nothing weather- or care-driven to flag.
          </p>
        )}
        {state === 'plan' && (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.85rem', color: P.mid, lineHeight: 1.55 }}>
            {lines.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        )}
      </div>
    </section>
  )
}
