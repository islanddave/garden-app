// src/components/putup/ClosedBatchesView.jsx
// V5-BATCHCLOSE-001 item C — the closed half of /put-up: the archive of kitchen_batch rows that
// have been closed out, from GET /api/kitchen-batches?state=closed, and the one door back out of a
// terminal act (per-row Reopen).
//
// WHY ITS OWN COMPONENT AND NOT A FLAG ON GoingNowView. The two lists answer different questions
// and order themselves on different columns: going-now sorts on when a batch STARTED, this one on
// when it ENDED, and partitionGoing has no closed_at notion at all. Sharing that sort would leave
// the archive silently mis-ordered — the newest thing you finished would not be at the top — so
// the ordering here is its own pure function with its own test. The PROP CONTRACT is GoingNowView's
// byte for byte ({ batches, loading, error, onReload, now }), so the page can hang either behind
// one segment without a second calling convention, and `now` is collapsed ONCE at the top for the
// same reason it is there: one instant per render, and a test pins a label to a fixed literal
// rather than to the wall clock.
//
// WHAT THIS SURFACE DOES NOT DO, and each absence is an inherited ruling rather than an omission —
// the reasons live at the top of ./goingNow.js: no readiness affordance, no countdown, no urgency
// tone, and nothing about acidification, shelf stability, or whether any of it was good. The one
// date it renders, `closed Sep 3`, is PROVENANCE and not readiness: ruling 1 constrains what the
// app may claim about a batch's future, and a list of finished batches carrying no dates is a list
// nobody can orient in. It is a past fact, never fed to a computation.
//
// THE OUTCOME IS ALWAYS RENDERED THROUGH A LABEL TABLE, never as its stored value.
// `discarded_spoiled` carries the substring `spoil`, which the shipped food-safety sweep matches
// over innerHTML — so a <option value>, a data-outcome attribute or an aria-label carrying the enum
// reds a guard on a MACHINE VALUE rather than on a claim the app made. The table is total and its
// fallback is deliberately not the value.
import React, { useState, useMemo, useCallback } from 'react'
import { useApiFetch } from '../../lib/api.js'
import { P, T } from '../../lib/tokens.js'
import { Button, ErrorBanner } from '../forms'

// The single spelling of both routes, exported because the PAGE owns the list fetch and this
// component owns the reopen. src/lib/deletedEntities.js states the rule this follows: "a route
// literal that appears in both a component and its test is not a contract, it is two guesses that
// happen to agree." Import these rather than re-typing either path.
export const CLOSED_BATCHES_PATH = '/api/kitchen-batches?state=closed'
export const reopenBatchPath = (id) => `/api/kitchen-batches/${id}/reopen`

// The six outcomes, in the final wording — do not re-word. Matches chk_kitchen_batch_outcome and
// the server's KITCHEN_OUTCOMES.
//
// INTEGRATOR NOTE: L3 owns src/components/putup/batchClose.js and exports CLOSE_OUTCOMES from it.
// That file did not exist when this lane branched, so this is the local statement of the same six
// labels. Collapse the two onto CLOSE_OUTCOMES once both lanes land, and keep the three-way parity
// test (DDL <-> KITCHEN_OUTCOMES <-> labels) pointed at whichever survives.
export const CLOSED_OUTCOME_LABELS = {
  put_up: 'Put it up',
  put_up_different: 'Put it up — but not what I set out to make',
  consumed: 'Ate it',
  given_away: 'Gave it away',
  discarded_spoiled: 'It spoiled — threw it out',
  abandoned: 'Gave up on it',
}

// The fallback for a value this client does not know — a seventh outcome added server-side, a typo,
// a stale bundle. It is NOT the raw value, and that is the whole point: echoing an unrecognised enum
// is how a machine string reaches the DOM. It is also not a verdict; "something else" is the honest
// remainder of a partition of what happened to the food.
export const UNKNOWN_OUTCOME_LABEL = 'Something else'

export function outcomeLabel(value) {
  if (value == null) return null
  return CLOSED_OUTCOME_LABELS[value] ?? UNKNOWN_OUTCOME_LABEL
}

// "Sep 3". Same shape and same reasoning as GoingNowView.jsx:39-43 — month and day only, because
// the year is carried by the group heading above the row. Copied rather than imported: that module
// exports one default component and nothing else, and this lane may not widen its export surface.
function shortDate(iso) {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function closedDate(row) {
  if (!row?.closed_at) return null
  const d = new Date(row.closed_at)
  return Number.isNaN(d.getTime()) ? null : d
}

// A row with no readable closed_at cannot happen through the route — listBatches selects
// `closed_at IS NOT NULL` — so this exists for the case where it does anyway. It renders, in its
// own group, at the bottom: an absent row is unattributable, a grouped one is diagnosable.
export const UNKNOWN_MONTH_KEY = 'unknown'
export const UNKNOWN_MONTH_LABEL = 'Date not recorded'

// LOCAL month, never UTC. A timestamptz renders its own calendar day in the reader's zone, and the
// group a batch lands in is the month the cook remembers, not the month at Greenwich.
function monthKey(row) {
  const d = closedDate(row)
  if (!d) return UNKNOWN_MONTH_KEY
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// The year is dropped INSIDE the current year and kept outside it — the same judgement shortDate
// makes about a card, one level up: "August" needs no year while you are still in that year, and
// needs one the moment you are not. `now` is what decides, which is why it is an injected prop and
// not a Date.now() call: the wall-clock version of this test passes all year and reds on Jan 1.
function monthLabel(row, nowMs) {
  const d = closedDate(row)
  if (!d) return UNKNOWN_MONTH_LABEL
  const sameYear = d.getFullYear() === new Date(nowMs).getFullYear()
  return d.toLocaleDateString(undefined, sameYear ? { month: 'long' } : { month: 'long', year: 'numeric' })
}

// closed_at DESC — the newest thing you finished, first. NOT sortGoing: that mirrors the server's
// `started_at DESC NULLS LAST, first_recorded_at DESC`, which is a claim about when work BEGAN and
// is uncorrelated with when it ended (a mash started in June and closed in September sits below a
// syrup pot started and closed in August). An unreadable closed_at sorts LAST, the same NULLS LAST
// ruling the server applies to an unknown start: an unknown date must not outrank a measured one.
// Ties keep the server's order — Array.prototype.sort is stable.
export function sortClosed(rows) {
  const list = Array.isArray(rows) ? rows.slice() : []
  return list.sort((a, b) => {
    const am = closedDate(a)?.getTime() ?? null
    const bm = closedDate(b)?.getTime() ?? null
    if (am == null && bm == null) return 0
    if (am == null) return 1
    if (bm == null) return -1
    return bm - am
  })
}

// Month groups, newest first, each holding its rows in closed_at DESC. A flat unbounded scroll is
// the failure mode this exists to avoid: the traced path to "the batch I closed six weeks ago" is
// otherwise four taps and a linear hunt. Grouping is a fold over the sorted list rather than a
// keyed map so the groups inherit the row ordering instead of restating it.
export function groupClosedByMonth(rows, nowMs) {
  const groups = []
  let current = null
  for (const row of sortClosed(rows)) {
    const key = monthKey(row)
    if (!current || current.key !== key) {
      current = { key, label: monthLabel(row, nowMs), batches: [] }
      groups.push(current)
    }
    current.batches.push(row)
  }
  return groups
}

// output_count arrives as a STRING — it is an uncast bigint count in the view, and JSON gives those
// back as strings. Number() first, never === across that boundary. "put-up" and not "jar": seven of
// the nineteen put-up methods produce no jar, and "put up" is the word the whole tab already uses.
function outputText(row) {
  const n = Number(row?.output_count)
  if (!Number.isFinite(n) || n <= 0) return null
  return n === 1 ? '1 put-up' : `${n} put-ups`
}

// ── one closed batch ─────────────────────────────────────────────────────────────────────────────
// The meta line is ONE joined string on purpose, the same reason GoingNowView gives: it is the thing
// a test can assert as a full literal with every separator, which is the standard this repo adopted
// after shipping an assertion that passed on a value ten days wrong.
function ClosedBatchRow({ batch, busy, onReopen }) {
  const closed = shortDate(batch.closed_at)
  const meta = [closed ? `closed ${closed}` : null, outcomeLabel(batch.outcome), outputText(batch)]
    .filter(Boolean).join(' · ')

  return (
    <div data-testid="closed-batch" data-batch-id={batch.id}
      style={{ display: 'flex', alignItems: 'center', gap: T.space.sm, flexWrap: 'wrap',
        marginBottom: T.space.sm, padding: '12px 14px', backgroundColor: P.white,
        border: `1px solid ${P.border}`, borderRadius: T.radiusBadge }}>
      <div style={{ minWidth: 0, flex: '1 1 60%' }}>
        <div data-testid="closed-batch-title"
          style={{ fontWeight: 700, color: P.dark, fontSize: T.type.md }}>{batch.label}</div>
        {meta && (
          <div data-testid="closed-batch-meta"
            style={{ marginTop: 3, color: P.mid, fontSize: '0.82rem' }}>{meta}</div>
        )}
      </div>
      {/* The reversal, following the shipped Restore idiom (RecentlyDeleted.jsx:80-87): the safe
          action is allowed to be the easy one, it carries the row's name in its aria-label so a
          screen-reader user hears WHICH batch it acts on, and it wraps to its own line rather than
          shrinking below the tap floor. Never the danger variant — reopening destroys nothing.
          UNCONDITIONAL: it does not read output_count. A rule the user has to compute ("reversible
          unless I linked jars") is a working-memory tax levied at the exact moment it cannot be
          paid, and the jars are untouched by a reopen either way. */}
      <Button variant="secondary" data-testid="closed-batch-reopen"
        onClick={() => onReopen(batch)} loading={busy} loadingLabel="Reopening…"
        aria-label={busy ? undefined : `Reopen ${batch.label}`}
        style={{ minWidth: 96, marginLeft: 'auto' }}>
        Reopen
      </Button>
    </div>
  )
}

export default function ClosedBatchesView({ batches, loading, error, onReload, now }) {
  const { fetch } = useApiFetch()
  const nowMs = now ?? Date.now()
  const [reopeningId, setReopeningId] = useState(null)
  const [reopenError, setReopenError] = useState(null)
  const groups = useMemo(() => groupClosedByMonth(batches, nowMs), [batches, nowMs])
  const empty = !loading && !error && groups.length === 0

  // One reopen at a time, and a second tap while one is in flight is a no-op rather than a second
  // POST — the shipped restore guard (RecentlyDeleted.jsx:176). On success the PAGE refetches:
  // `batches` is a prop, so there is no local optimistic mutation to get wrong, which is the same
  // contract every write on the going-now card already follows.
  const reopen = useCallback(async (batch) => {
    if (reopeningId) return
    setReopeningId(batch.id)
    setReopenError(null)
    try {
      await fetch(reopenBatchPath(batch.id), { method: 'POST' })
      onReload?.()
    } catch {
      setReopenError(`Couldn't reopen "${batch.label}" — try again.`)
    } finally {
      setReopeningId(null)
    }
  }, [fetch, onReload, reopeningId])

  return (
    <div data-testid="closed-batches-view">
      {loading && <div style={{ padding: 24, textAlign: 'center', color: P.light }}>Loading&hellip;</div>}
      {error && <ErrorBanner>Couldn&rsquo;t load your closed batches — try again.</ErrorBanner>}
      {reopenError && <ErrorBanner>{reopenError}</ErrorBanner>}

      {empty && (
        <div data-testid="closed-empty" style={{ padding: '28px 18px', textAlign: 'center', color: P.mid,
          background: P.white, border: `1px solid ${P.border}`, borderRadius: T.radiusBadge }}>
          <div style={{ fontWeight: 700, color: P.dark, marginBottom: 6 }}>Nothing closed yet.</div>
          <div style={{ fontSize: '0.85rem', color: P.light }}>
            When you close a batch out it moves here, with what happened to it.
          </div>
        </div>
      )}

      {/* States the reopen's real effect once, at the top, rather than promising it per row. A close
          sets suspended_at = NULL alongside closed_at, so a paused batch that is closed and then
          reopened comes back ACTIVE — a user-visible state change caused by the undo. The copy says
          so plainly instead of implying the prior state comes back with it. */}
      {groups.length > 0 && (
        <div data-testid="closed-reopen-note"
          style={{ marginBottom: T.space.md, color: P.light, fontSize: '0.78rem' }}>
          Reopening a batch puts it back in Going now. One you had paused comes back going, not paused.
        </div>
      )}

      {groups.map(g => (
        <React.Fragment key={g.key}>
          <h2 data-testid="closed-month-heading"
            style={{ margin: `${T.space.md}px 0 ${T.space.sm}px`, fontSize: '0.82rem', fontWeight: 700,
              color: P.light, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {g.label}
          </h2>
          {g.batches.map(b => (
            <ClosedBatchRow key={b.id} batch={b} busy={reopeningId === b.id} onReopen={reopen} />
          ))}
        </React.Fragment>
      ))}
    </div>
  )
}
