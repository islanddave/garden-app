// The cultivation region of Today: an unlabelled lead line of one or two imperative lines, NO
// heading, NO count, capped at 2. A heading plus denominator costs ~64px at 390px and evicts a row,
// and a third heading is a third orient decision. It shows no tail control, by rule rather than
// exception: a region shows a tail iff rows are hidden, and nothing here is hidden; the full story
// lives one tap away on /sow.
//
// CONTENT IS A READ OF AN EXISTING ENGINE, NEVER AN INVENTION. The lines come from the same
// sow-candidates payload and the same pure `bucketize` the /sow page runs; only entries the engine
// itself marks `window_closing` (its own fall-sow latest-safe math, latestSafeMs) qualify. No other
// cue is computable from existing data without fabrication, so no other cue ships.
//
// THIS FILE HAS NO QUANTITY PREDICATE OF ITS OWN, ON PURPOSE. A depleted packet
// (quantity_on_hand <= 0) is diverted to `sowed_previously` inside bucketize itself, so it can never
// reach `window_closing` and can never become a line here. Both surfaces read the same payload
// through the same bucketizer; a predicate duplicated here is how the two would disagree later.
//
// Two deliberate choices, both about discoverability of Sow Now:
//   1. PLACEMENT. The region renders down with the ambient bands, not at the very top of Today: it
//      does not earn the FIRST screen.
//   2. The link row is UNCONDITIONAL (no "renders nothing when empty"). Otherwise, on every day the
//      engine had no closing window (most of the year), Today would offer no route to /sow at all.
//      The empty state is one compact link, not a blank strip with a heading over silence.
//
// The urgency lines are present only when the engine marks a window closing, capped at 2, most
// urgent first. Only the door below them is unconditional.
//
// Ambient posture otherwise: self-fetching, error swallowed (a failed fetch degrades to the bare
// link, never an error onto Today). Reward-UX: imperative + a date is information; no urgency copy,
// no countdown, no exclamation.
import React, { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../../lib/api.js'
import { P } from '../../lib/constants.js'
import { T } from '../forms/formStyles.js'
import { bucketize } from '../../lib/sowEngine.js'
import { seedsHref } from '../../lib/seedsRoutes.js'
import Icon from '../Icon.jsx'
import { todayLocalISO } from '../../lib/dateLocal.js'

export const CULTIVATION_LEAD_CAP = 2

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

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

// THE DATA HOOK, split out of the band so the redesigned Today can run it at the page and hand the
// result in as `data`. `enabled: false` asks nothing: while the 2027 sowing freeze holds the
// redesigned Today shows no dated line, so it does not fetch the candidates at all (featureFlags
// SOW_DATED_LINES_FROZEN). `settled` = the first request answered or failed (or nothing was asked);
// nothing here renders it; the V2 ready point waits on it.
export function useCultivationFeed({ enabled = true } = {}) {
  const { fetch } = useApiFetch()
  const [items, setItems] = useState(null)
  const [settled, setSettled] = useState(!enabled)

  useEffect(() => {
    if (!enabled) return undefined
    let alive = true
    fetch('/api/inventory-items/sow-candidates')
      .then(d => { if (alive) setItems(Array.isArray(d?.items) ? d.items : []) })
      .catch(() => { /* ambient lead line — never surface a fetch error onto Today */ })
      .finally(() => { if (alive) setSettled(true) })
    return () => { alive = false }
  }, [fetch, enabled])

  return { items, settled }
}

// `data` = useCultivationFeed()'s result, fetched by the caller; `bare` = the redesigned Today's Sow
// link row (sprout + "All sow windows ›", a link, not a section, no card), with the dated lines,
// when there are any, above that door. With neither prop, the band as it always was.
export default function CultivationLead({ todayISO = null, data, bare = false }) {
  return data
    ? <Lead feed={data} todayISO={todayISO} bare={bare} />
    : <OwnLead todayISO={todayISO} bare={bare} />
}

function OwnLead({ todayISO, bare }) {
  return <Lead feed={useCultivationFeed()} todayISO={todayISO} bare={bare} />
}

function Lead({ feed, todayISO, bare }) {
  const items = feed.items
  const day = todayISO ?? todayLocalISO()
  const lines = useMemo(() => cultivationLines(items, day), [items, day])

  if (bare) {
    return (
      <Link to={seedsHref('sow')} data-testid="cultivation-lead" style={bareRow}>
        <Icon name="lifecycle.sprout" size={20} decorative style={{ flexShrink: 0 }} />
        {lines.length ? (
          <span style={{ flex: 1, minWidth: 0 }}>
            {lines.map((l, i) => <span key={i} style={bareLine}>{l}</span>)}
            <span style={{ display: 'block' }}>All sow windows ›</span>
          </span>
        ) : <span>All sow windows ›</span>}
      </Link>
    )
  }

  // The whole region is the tap target, lines included: tapping an urgency line goes to the page
  // listing the packet it is about, which is what a line saying "Sow X by Aug 18" makes you want to
  // do. A separate link underneath would read as a second, unrelated control.
  return (
    // Seeds › Sow now: the same list as /sow.
    <Link
      to={seedsHref('sow')}
      data-testid="cultivation-lead"
      style={{
        display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none',
        // An explicit ink is REQUIRED on any <Link> containing an <Icon>. Icon renders
        // `<svg stroke="currentColor">` and substitutes a palette hex only on elements carrying
        // data-region, so inside an <a> with no color of its own every unregioned stroke inherits
        // the browser's default link blue (#0000EE, measured) and a mono icon comes out ENTIRELY
        // blue. textDecoration:'none' does not cover this: it kills the underline, not the colour.
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
            this is about, and repeating "Sow now" under them would be a redundant second heading,
            so it drops to a quiet subtitle instead. */}
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

// The bare row: a text-link row, minHeight T.tapMinHeight, P.green 600 T.type.sm, with the explicit
// ink that any <Link> holding an <Icon> requires (see above).
const bareRow = {
  display: 'flex', alignItems: 'center', gap: T.space.sm, minHeight: T.tapMinHeight, textDecoration: 'none',
  color: P.green, fontWeight: 600, fontSize: T.type.sm,
}
const bareLine = { display: 'block', fontSize: T.type.base, fontWeight: 600, color: P.dark, lineHeight: 1.4 }
