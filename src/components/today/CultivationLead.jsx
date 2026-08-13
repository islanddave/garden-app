// src/components/today/CultivationLead.jsx
// PANEL Q1 (harvest-panel-decisions-20260812.md): the cultivation region of Today, DEMOTED to an
// unlabelled lead line. One or two imperative lines at the very top of Today — NO heading, NO
// count, capped at 2, rendering NOTHING when empty. A heading plus denominator costs ~64px at
// 390px and evicts a row; scanning cost scales with orient decisions, and a third heading is a
// third orient decision. It shows no tail control either, and by rule rather than exception:
// a region shows a tail iff rows are hidden, and nothing here is hidden — the full story lives
// one tap away on /sow.
//
// CONTENT IS A READ OF AN EXISTING ENGINE, NEVER AN INVENTION. The lines come from the same
// sow-candidates payload and the same pure `bucketize` the /sow page runs; only entries the engine
// itself marks `window_closing` (its own fall-sow latest-safe math, latestSafeMs) qualify. No other
// cue is computable from existing data without fabrication (phenology capture has lapsed —
// panel-verified), so no other cue ships. If the engine yields nothing, the region renders nothing
// — the panel accepted an empty container as the cost of shipping the shape before the content.
//
// Ambient posture, same as every band below it: self-fetching, error swallowed, hidden when empty.
// Reward-UX: imperative + a date is information; no urgency copy, no countdown, no exclamation.
import React, { useState, useEffect, useMemo } from 'react'
import { useApiFetch } from '../../lib/api.js'
import { P } from '../../lib/constants.js'
import { bucketize } from '../../lib/sowEngine.js'

export const CULTIVATION_LEAD_CAP = 2

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Same local-ISO convention as CareNeeded: the engine buckets against the day Dave is looking at.
function todayLocalISO() {
  const d = new Date()
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 10)
}

// today + daysLeft -> "Sep 20", UTC-anchored like sowEngine's own date math (no zone drift).
function closeDateLabel(todayISO, daysLeft) {
  const m = String(todayISO ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const n = Number(daysLeft)
  if (!m || !Number.isFinite(n)) return null
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + Math.trunc(n) * 86400000)
  return `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}`
}

// Pure line builder, exported for tests. Only the engine's own `window_closing` bucket qualifies;
// most-urgent first; capped. Each line is one imperative with the close date — no count, no
// denominator, no "days left" countdown.
export function cultivationLines(items, todayISO, cap = CULTIVATION_LEAD_CAP) {
  if (!Array.isArray(items) || items.length === 0) return []
  let buckets
  try { buckets = bucketize(items, todayISO) } catch { return [] }
  const closing = (Array.isArray(buckets?.window_closing) ? buckets.window_closing : [])
    .filter(e => e && e.candidate && Number.isFinite(Number(e.daysLeft)) && Number(e.daysLeft) >= 0)
    .sort((a, b) => Number(a.daysLeft) - Number(b.daysLeft))
  return closing.slice(0, cap).map(e => {
    const name = e.candidate.variety_name || e.candidate.item_name || 'seeds'
    const by = closeDateLabel(todayISO, e.daysLeft)
    const verb = e.action === 'start_indoors' ? `Start ${name} indoors` : `Sow ${name}`
    return by ? `${verb} by ${by}.` : `${verb} soon.`
  })
}

export default function CultivationLead({ todayISO = null }) {
  const { fetch } = useApiFetch()
  const [items, setItems] = useState(null)

  useEffect(() => {
    let alive = true
    fetch('/api/inventory-items/sow-candidates')
      .then(d => { if (alive) setItems(Array.isArray(d?.items) ? d.items : []) })
      .catch(() => { /* ambient lead line — never surface a fetch error onto Today */ })
    return () => { alive = false }
  }, [fetch])

  const day = todayISO ?? todayLocalISO()
  const lines = useMemo(() => cultivationLines(items, day), [items, day])

  // Renders NOTHING when empty — never a blank strip, never a heading over silence.
  if (lines.length === 0) return null

  return (
    <div data-testid="cultivation-lead" style={{ marginBottom: 12 }}>
      {lines.map((l, i) => (
        <p key={i} style={{ margin: '0 0 4px', fontSize: '0.92rem', fontWeight: 600, color: P.dark, lineHeight: 1.4 }}>
          {l}
        </p>
      ))}
    </div>
  )
}
