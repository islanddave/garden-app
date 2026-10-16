import React, { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { P } from '../../lib/constants.js'
import { useApiFetch } from '../../lib/api.js'
import { useOptionalToast } from '../../context/ToastContext.jsx'
import Icon from '../Icon.jsx'
import { T } from '../forms/formStyles.js'
import { dormantRows, feedSuppressedRows, FEED_SUPPRESSED_LISTED } from '../../lib/careNeeded.js'

// AmbientCareLists — the two lists of plantings that are NOT on routine care, which the redesigned Today mounts
// (Resting's rows; the "No feed schedule" line at the foot of Needs care and in the caught-up slot). Moved here
// verbatim from CareNeeded.jsx when the old Today page and its care list were removed (V5-TODAYREDESIGN-001 S8c /
// L8, plan-v2 §8). The old page's other two ambient lists did not move: the redesign's glance card renders the
// drought names itself (GlanceCard, care-drought-list) and the rain note is RainHold (care-rain-note).

// V4-DORMANTRESUME-001 — the dormant plantings the engine emits and nothing has ever rendered.
// Ambient: dormancy is not work, so this is never a card and never an interrupt.
// It exists because dormant is excluded from the care engine AND from every dashboard arm, which
// left an overwintered crop with no surface at all — and no way back, since nothing but a human
// tap clears the status.
//
// Resume writes through the SAME endpoint and payload as the hero StatusPicker
// (PUT /api/plants/:id {status}), so there is one status write path in the app, not two.
// Target is 'vegetative': the canonical growing-but-not-yet-flowering state, which is where garlic,
// asparagus, strawberry and a Christmas cactus all actually restart. Anything more specific the
// gardener can still set on the planting itself.
//
// V5-TODAYREDESIGN-001 S6 — two optional seams for the redesigned Today:
//   `bare`               the rows only — the "Dormant" heading and its explainer belong to the section holding the
//                        list (Today's Resting), and Resume meets the 44px target floor there (plan-v2 §5.8).
//   `resumed`/`onResumed` the caller holds the resumed set (a Set of planting ids). Today unmounts a closed
//                        section, and a set kept in here would forget a resume on the next open, putting the plant
//                        back with its Resume button. Without them the list keeps its own set.
export function DormantList({ plan, bare = false, resumed: resumedHeld, onResumed }) {
  const { fetch } = useApiFetch()
  const toast = useOptionalToast()
  const [resumedOwn, setResumed] = useState(() => new Set())
  const resumed = resumedHeld || resumedOwn
  const [pending, setPending] = useState(() => new Set())
  const rows = useMemo(() => dormantRows(plan).filter(r => !resumed.has(r.plantingId)), [plan, resumed])
  if (rows.length === 0) return null

  async function resume(row) {
    if (pending.has(row.plantingId)) return
    setPending(prev => new Set(prev).add(row.plantingId))
    try {
      await fetch('/api/plants/' + row.plantingId, {
        method: 'PUT',
        body: JSON.stringify({ status: 'vegetative' }),
      })
      if (onResumed) onResumed(row.plantingId)
      else setResumed(prev => new Set(prev).add(row.plantingId))
      toast?.show?.({ message: row.name + ' is growing again', tone: 'success' })
    } catch {
      // Never optimistic: a failed resume must leave the row where it was, or the planting goes
      // back to being invisible while still dormant — the exact state this list exists to end.
      toast?.show?.({ message: 'Couldn’t resume ' + row.name, tone: 'error' })
    } finally {
      setPending(prev => { const n = new Set(prev); n.delete(row.plantingId); return n })
    }
  }

  return (
    <div data-testid="care-dormant" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 2px' }}>
      {!bare && <h3 style={{ fontSize: '0.82rem', fontWeight: 700, color: P.dark, margin: 0 }}>Dormant</h3>}
      {!bare && (
      <div style={{ fontSize: '0.78rem', color: P.light, lineHeight: 1.4 }}>
        Resting — no routine care. Resume one when it starts growing again.
      </div>
      )}
      {rows.map(row => (
        <div key={row.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 8, flexWrap: 'wrap', minHeight: 44 }}>
          {/* minWidth:0 + ellipsis is what keeps an unbreakable long name from widening the page at
              390px rather than shrinking. */}
          <Link to={'/plantings/' + row.plantingId} style={{ fontSize: '0.85rem', color: P.dark,
            textDecoration: 'none', flex: '1 1 auto', minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.name}
          </Link>
          {row.resumable && (
            <button type="button" onClick={() => resume(row)} disabled={pending.has(row.plantingId)}
              aria-label={'Resume ' + row.name}
              style={{ minHeight: bare ? 44 : 32, padding: '5px 12px', borderRadius: 12, border: '1px solid ' + P.border,
                backgroundColor: P.white, color: P.dark, fontSize: '0.78rem', fontWeight: 600,
                cursor: 'pointer', opacity: pending.has(row.plantingId) ? 0.6 : 1, flex: '0 0 auto' }}>
              Resume
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

// BUG-CAREFEEDINHERIT-001 — the plantings whose profile refuses calendar feeding. Ambient, like
// DormantList: "never feed this by the calendar" is not work, so this is never a card
// and never an interrupt. It exists because a suppressed planting produces NO Feed card ever, which
// on this screen is indistinguishable from a planting everybody forgot — the engine routes it
// LOUDLY to tasks.feed_suppressed with a rule + reason and, until now, nothing read that.
//
// Renders ONLY for state 'listed'. 'absent' and 'none' both render nothing, for DIFFERENT reasons:
// absent means we do not know whether the gate ran (see feedSuppressedRows), so the surface must
// not speak; none means it ran and found nobody, so there is no planting to name. Neither may ever
// become "0 plantings are on signal-only feeding" without splitting these two apart first.
//
// COLLAPSED BY DEFAULT, via mount/unmount — not <details>, not display:none. Two reasons: nine
// unchanging information-only rows would push ~400px of non-work down Today every single day
// (the V4-TODAYVERBIAGE-001 noise budget), and a CSS/`open`-hidden list is still in the DOM, so a
// test asserting it is hidden false-passes. The summary line IS the toggle: one control, one tap,
// 44px, inline — never a modal, so this needs no DismissRegistry layer (that registry arbitrates
// Escape/Back across modal surfaces; there is no surface here to arbitrate).
// `compact` (the redesigned Today, finish plan D-5): the line reads "No feed schedule: 9 plantings" on the page's
// type ramp, and its explainer moves behind the tap with the names. Without it, the long sentence.
export function FeedSuppressedList({ plan, compact = false }) {
  const { state, rows } = useMemo(() => feedSuppressedRows(plan), [plan])
  const [open, setOpen] = useState(false)
  if (state !== FEED_SUPPRESSED_LISTED) return null
  const n = rows.length
  const label = (open ? 'Hide the ' : 'Show the ') + n + ' planting' + (n > 1 ? 's' : '') + ' with no feed schedule'
  const textSize = compact ? T.type.sm : '0.78rem'

  return (
    <div data-testid="care-feed-suppressed" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 2px' }}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label={label}
        style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, width: '100%',
          padding: '2px', border: 'none', background: 'none', textAlign: 'left', cursor: 'pointer' }}>
        {/* care.feed is the same glyph the fertilizing care chip carries, tinted P.green rather than
            the gold needTier gives a due feed row — gold in this app means "needed today", and this
            is the opposite claim. Colour is additive: the sentence says it too (SC 1.4.1). */}
        <Icon name="care.feed" size={18} decorative style={{ color: P.green, flex: '0 0 auto' }} />
        <span style={{ flex: 1, minWidth: 0, fontSize: textSize, color: compact ? P.mid : P.light, lineHeight: 1.4 }}>
          {compact
            ? `No feed schedule: ${n} planting${n > 1 ? 's' : ''}`
            : `No feed schedule for ${n} planting${n > 1 ? 's' : ''} — fed on plant signals, never by the calendar.`}
        </span>
        <span aria-hidden="true" style={{ flex: '0 0 auto', fontSize: textSize, fontWeight: 700, color: P.green }}>
          {open ? 'Hide' : 'Show'}
        </span>
      </button>
      {open && compact && (
        <p style={{ margin: 0, padding: '0 2px', fontSize: T.type.sm, color: P.mid, lineHeight: 1.4 }}>Fed on plant signals, never by the calendar.</p>
      )}
      {open && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 2px 4px' }}>
          {/* Chips, not full-width rows: nine names cost ~3 wrapped lines at 390px instead of nine
              44px rows, and each is still its own tap target INTO the planting record. Same
              minWidth:0 + ellipsis treatment as DormantList for an unbreakable long name. */}
          {rows.map(row => (
            <Link key={row.key} to={'/plantings/' + row.plantingId}
              aria-label={row.name + ' — no feed schedule'}
              style={{ display: 'inline-flex', alignItems: 'center', minHeight: 36, maxWidth: '100%',
                padding: '6px 12px', borderRadius: 999, border: '1px solid ' + P.border,
                backgroundColor: P.white, color: P.dark, fontSize: '0.8rem', textDecoration: 'none',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {row.name}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
