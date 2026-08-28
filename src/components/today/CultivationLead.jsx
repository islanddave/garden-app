// src/components/today/CultivationLead.jsx
// PANEL Q1 (harvest-panel-decisions-20260812.md): the cultivation region of Today, DEMOTED to an
// unlabelled lead line. One or two imperative lines — NO heading, NO count, capped at 2. A heading
// plus denominator costs ~64px at 390px and evicts a row; scanning cost scales with orient
// decisions, and a third heading is a third orient decision. It shows no tail control either, and
// by rule rather than exception: a region shows a tail iff rows are hidden, and nothing here is
// hidden — the full story lives one tap away on /sow.
//
// CONTENT IS A READ OF AN EXISTING ENGINE, NEVER AN INVENTION. The lines come from the same
// sow-candidates payload and the same pure `bucketize` the /sow page runs; only entries the engine
// itself marks `window_closing` (its own fall-sow latest-safe math, latestSafeMs) qualify. No other
// cue is computable from existing data without fabrication (phenology capture has lapsed —
// panel-verified), so no other cue ships.
//
// V4-SEEDZEROVIEW-001 — THIS FILE HAS NO QUANTITY PREDICATE OF ITS OWN, ON PURPOSE. A depleted
// packet (quantity_on_hand <= 0) is diverted to `sowed_previously` inside bucketize itself, so it
// can never reach `window_closing` and can never become a line here. This surface was the second,
// unfiled half of that defect — the ledger row named only /sow, and both surfaces read the same
// payload through the same bucketizer — and it is fixed by the engine rather than by a filter
// duplicated here, because two copies of one predicate is how the two surfaces disagree later.
//
// V4-SOWMOREMENU-001 (BD-067) — TWO PANEL Q1 DECISIONS ARE DELIBERATELY REVERSED HERE, both on
// Dave's own report that he could not find Sow Now AT ALL ("I don't remember even where it used to
// be"). Say what changed and why, because both were reasoned calls, not defaults:
//
//   1. PLACEMENT. This region no longer sits at the very top of Today. Dave: "making the top of the
//      today show the sow now should disappear, that doesn't need to be up there." It now renders
//      down with the ambient bands. The panel's ~64px argument was about what earns the FIRST
//      screen; it never argued this content was worthless, and moving it costs none of the value.
//
//   2. "RENDERS NOTHING WHEN EMPTY" IS GONE — the link row is now UNCONDITIONAL. This is the real
//      reversal and it is a discoverability fix, not a layout preference. The old contract meant
//      that on every day the engine had no closing window (most of the year) Today offered no route
//      to /sow whatsoever, and the panel's own "the full story lives one tap away on /sow" was
//      false on those days — the lines were plain <p> text with no tap target at all, so it was
//      never one tap away from here on ANY day. A durable, findable door is the thing Dave asked
//      for; an intermittent one does not fix "I can't find it anywhere". The empty state is one
//      compact link, not a blank strip with a heading over silence, so the panel's actual objection
//      (an empty labelled container) still holds — it just is not what this renders.
//
// The urgency lines keep their old conditional behaviour: present only when the engine marks a
// window closing, capped at 2, most urgent first. Only the door below them is unconditional.
//
// Ambient posture otherwise unchanged: self-fetching, error swallowed (a failed fetch degrades to
// the bare link, never an error onto Today). Reward-UX: imperative + a date is information; no
// urgency copy, no countdown, no exclamation.
import React, { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../../lib/api.js'
import { P } from '../../lib/constants.js'
import { bucketize } from '../../lib/sowEngine.js'
import Icon from '../Icon.jsx'

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

  // The whole region is the tap target, lines included — tapping an urgency line goes to the packet
  // it is about (well, to the page listing it), which is what a line saying "Sow X by Aug 18" makes
  // you want to do. A separate link underneath would read as a second, unrelated control.
  return (
    <Link
      to="/sow"
      data-testid="cultivation-lead"
      style={{
        display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none',
        // BUG-LINKICONBLUE-001 — an explicit ink is REQUIRED on any <Link> containing an <Icon>, and
        // this shipped wrong in v4.58.0. Icon renders `<svg stroke="currentColor">` and substitutes a
        // palette hex only on elements carrying data-region, so inside an <a> with no color of its
        // own every unregioned stroke inherits the browser's default link blue (#0000EE, measured).
        // A mono icon comes out ENTIRELY blue. textDecoration:'none' does not cover this — it kills
        // the underline and leaves the colour, which is why it read as fixed.
        color: P.dark,
        padding: '10px 12px', marginBottom: 12,
        background: P.white, border: `1px solid ${P.border}`, borderRadius: 10,
        minHeight: 44, // T.tapMinHeight — this is a real navigation control, not a chip
      }}
    >
      <Icon name="lifecycle.sprout" size={20} decorative style={{ flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        {lines.map((l, i) => (
          <span key={i} style={{ display: 'block', fontSize: '0.92rem', fontWeight: 600, color: P.dark, lineHeight: 1.4 }}>
            {l}
          </span>
        ))}
        {/* The label carries the destination's NAME whenever it is the only thing here, so the row
            is self-explanatory on a cold open. When urgency lines are present they already say what
            this is about, and repeating "Sow now" under them is the redundant second heading PANEL
            Q1 was right to refuse — so it drops to a quiet subtitle instead. */}
        <span style={{
          display: 'block',
          fontSize: lines.length ? '0.76rem' : '0.92rem',
          fontWeight: lines.length ? 500 : 600,
          color: lines.length ? P.light : P.dark,
          lineHeight: 1.4,
          marginTop: lines.length ? 2 : 0,
        }}>
          {lines.length ? 'See all sow windows' : 'Sow now'}
        </span>
      </span>
    </Link>
  )
}
