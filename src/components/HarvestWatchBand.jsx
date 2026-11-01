// src/components/HarvestWatchBand.jsx
// V4-HARVSURFACE-001 — SECTION 2 of the Today harvest surface: the "worth checking" watch list.
//
// WHAT THIS IS, AND WHAT IT IS DELIBERATELY NOT.
// Section 1 (HarvestReadyBand, above) is an ACTION surface — imperative mood, go/no-go in five
// minutes. This is a PLAN surface — declarative mood, "what changed since I last looked." The two
// must differ on position/weight AND grammatical mood, because a declarative sentence is not
// answerable with "do I do this now?", so it self-classifies even if the styling is stripped. If
// they read alike, every row here becomes a candidate task. Hence: smaller type, below the ready
// band, no imperatives.
//
// THE VOICE RULE IS LOAD-BEARING — see `src/lib/harvestWatch.js` header. Every string is a CHECK
// prompt, never a readiness assertion: "Start checking X", never "X is ready" or "your window
// opened". At the current calibration the assertion form is dishonest; the check form stays true at
// ANY calibration level.
//
// REWARD-UX: ambient only. No toast, no sheet, no modal, no haptic, no badge, no streak, no
// celebration, no animation. The "not yet" dismissal is an OPERATIONAL control, not a reward, and
// its confirmation is a quiet in-place line. The tail counts are INFORMATIONAL and live in the
// button labels, never in a pill.
//
// THE TAIL. The +N overflow is a real in-place expand control, one per section, never shared.
// Expand goes DOWNWARD only and the trigger's top edge keeps its viewport y (content is inserted
// AFTER the button). Expanded order: overflow rows grouped by location → project subgroups → a
// "Snoozed" subgroup printing each suppressed row's return date (collapsed by default, individually
// expandable) → a second collapse control at the bottom. Above 25 hidden rows the tail reveals 20 at
// a time. Expansion state is SESSION-scoped per section (sessionStorage, never localStorage).
//
// THE COLOUR-WINDOW DATASET IS LAZY-LOADED AND MUST STAY THAT WAY. `src/lib/harvestWindows.js`
// statically imports a 396KB JSON (~105KB gzip). Today is the landing surface, so a static import
// HERE would put the whole dataset back in the entry bundle for every user at boot.
// `scripts/verify-window-chunk.sh` guards this: never convert the dynamic import below into a
// static one.
//
// The fetch error is SWALLOWED and the band renders nothing, matching the ambient posture of
// HarvestReadyBand / PutUpUseSoonBand: this is a supplementary glance and must never throw onto
// Today.
import React, { useState, useEffect, useCallback, useReducer, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useOverlayNavigate } from '../context/OverlayContext.jsx'
import { useApiFetch } from '../lib/api.js'
import { useAmbientBandFetch } from '../lib/useAmbientBandFetch.js'
import AmbientBandNotice from './AmbientBandNotice.jsx'
import { P } from '../lib/constants.js'
import {
  rankWatchCandidates, selectWatchDisplay, groupWatchOverflow, revealStep,
  watchingSinceLabel, monthDayLabel, observableFrom,
} from '../lib/harvestWatch.js'
import { orderByThumb } from '../lib/handedness.js'
import { useHandedness, useHandednessSync } from '../hooks/useHandedness.js'

// Module-scope so a second mount (in-app nav back to Today) resolves synchronously with no pop-in.
// CropCard holds its own identical cache; both await the same dynamic import, so whichever lands
// first makes the other's `import()` resolve from the module registry immediately.
let hwModule = null

// Session-scoped tail expansion (panel Q4). sessionStorage so the reveal survives navigating away
// and back within one app session but never persists across sessions.
const REVEAL_KEY = 'harvest-tail:watch'
function readReveal() {
  try {
    const n = Number(sessionStorage.getItem(REVEAL_KEY))
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
  } catch { return 0 }
}
function writeReveal(n) {
  try { sessionStorage.setItem(REVEAL_KEY, String(n)) } catch { /* ignore */ }
}

// Shared tail-control styling: full-width <button> ≥48px, count in the LABEL, chevron as the only
// ornament.
const tailButtonStyle = {
  display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
  minHeight: 52, padding: '12px 2px', background: 'none', border: 'none',
  borderTop: `1px solid ${P.border}`, cursor: 'pointer', fontFamily: 'inherit',
  fontSize: '0.85rem', fontWeight: 700, color: P.green,
}

function Chevron({ open }) {
  return (
    <span aria-hidden="true" style={{ color: P.light, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
  )
}

// Module-level so the hook's load callback stays referentially stable across renders.
const normalize = (d) => (d && Array.isArray(d.candidates) ? d : { candidates: [], snoozed: [] })

// THE DATA HOOK, split out of the band. Today fetches at the PAGE: its Harvest section's presence and
// header summary are read while the section's body (this band) is unmounted, so the page calls this
// and hands the result in as `data`. Without `data` the band calls it itself; the fetch, the retry
// and the refresh-on-return are this one call either way (useAmbientBandFetch).
export function useHarvestWatchFeed() {
  return useAmbientBandFetch('/api/harvests/watch?limit=200', normalize)
}

// The band's OWN selection, exported so a header summary names exactly the rows the band lists:
// the ranked candidates, the snoozed rows, and the slot allocation.
export function watchSelection(data) {
  const all = rankWatchCandidates(data?.candidates)
  const snoozed = Array.isArray(data?.snoozed) ? data.snoozed.filter(s => s && s.plant_id != null) : []
  return { all, snoozed, ...selectWatchDisplay(all) }
}

// `data` = useHarvestWatchFeed()'s result, fetched by the caller; `bare` = the band's rows only — no eyebrow,
// title, card or outer margin — for a surface that is itself the band's heading (Today V2's Harvest section).
// With neither, the render is the band as it always was.
export default function HarvestWatchBand({ data, bare = false }) {
  return data ? <WatchBand feed={data} bare={bare} /> : <OwnWatchBand bare={bare} />
}

function OwnWatchBand({ bare }) {
  return <WatchBand feed={useHarvestWatchFeed()} bare={bare} />
}

function WatchBand({ feed, bare }) {
  const { fetch, getToken } = useApiFetch()
  const overlayNavigate = useOverlayNavigate()
  // The local handedness read is synchronous, so the controls are in their final positions on the
  // FIRST paint (a control that moves after first paint is a mis-tap hazard). The sync is the
  // module-latched cross-device adopt; it lives here because this band's SAFETY depends on the value
  // being right. Both hooks precede every early return below.
  const hand = useHandedness()
  useHandednessSync(getToken)
  // plant_id -> { dismissed?: boolean, busy?: boolean, error?: string, dismissalId, suppressedUntil }
  const [rowUi, setRowUi] = useState({})
  const [revealed, setRevealed] = useState(readReveal)
  const [snoozedOpen, setSnoozedOpen] = useState(false) // defaults collapsed every mount
  // plant_id -> { busy?: boolean, restored?: boolean, error?: string } for the Snoozed subgroup.
  // Deliberately NOT rowUi: that map drives the candidate rows' dismissed/undo branch, and a plant_id
  // is only ever in one of the two lists (the server marks a suppressed planting eligible:false and
  // moves it to `snoozed`).
  const [snoozeUi, setSnoozeUi] = useState({})
  const [, bumpWindow] = useReducer(t => t + 1, 0)

  const setReveal = useCallback((n) => { writeReveal(n); setRevealed(n) }, [])

  // limit=200: the tail expands in place, so the band needs the whole queue in one response (the
  // server's default limit stays 5 for any client that forgets). The fetch itself is
  // useHarvestWatchFeed() (above), run by the caller or by OwnWatchBand.
  const { data, failed, reload: load } = feed

  // Fire the lazy chunk only when at least one row could actually use it.
  const needsWindows = Array.isArray(data?.candidates) && data.candidates.some(c => c?.variety_ref)
  useEffect(() => {
    if (!needsWindows || hwModule) return
    let alive = true
    import('../lib/harvestWindows.js')
      .then(m => { hwModule = m; if (alive) bumpWindow() })
      // Chunk miss (offline, purged cache) → rows degrade to basis-stated calendar text. hwModule
      // stays null so the next mount retries.
      .catch(() => {})
    return () => { alive = false }
  }, [needsWindows])

  // The dismissal write. OPTIMISTIC, then reverted on failure: the UI must never come to rest claiming
  // a write that did not land. The response's dismissal id + suppressed_until are kept so the
  // collapsed line can name the RETURN DATE and the undo can retract exactly this row by id.
  const dismissRow = useCallback((r) => {
    const id = r.plant_id
    setRowUi(s => ({ ...s, [id]: { dismissed: true, busy: true, error: null } }))
    fetch('/api/harvests/watch/dismiss', {
      method: 'POST',
      body: JSON.stringify({ plant_id: id, project_id: r.project_id ?? null, dismissed: true }),
    })
      .then(res => setRowUi(s => ({
        ...s,
        [id]: {
          dismissed: true, busy: false, error: null,
          dismissalId: res?.dismissal?.id ?? null,
          suppressedUntil: res?.dismissal?.suppressed_until ?? null,
        },
      })))
      .catch(() => setRowUi(s => ({
        ...s, [id]: { dismissed: false, busy: false, error: 'Could not save — try again.' },
      })))
  }, [fetch])

  // Undo. Retraction must hit ONLY the dismissal that was just made: by id when the write handed one
  // back (DELETE /watch/dismissals/:id, the preferred path), else the boolean toggle, which the
  // server scopes to the single most recent active row. A 404 on the DELETE means the row is already
  // retracted, which is the outcome the tap wanted.
  const undoDismiss = useCallback((r) => {
    const id = r.plant_id
    const dismissalId = rowUi[id]?.dismissalId ?? null
    setRowUi(s => ({ ...s, [id]: { ...s[id], dismissed: false, busy: true, error: null } }))
    const req = dismissalId
      ? fetch(`/api/harvests/watch/dismissals/${dismissalId}`, { method: 'DELETE' })
      : fetch('/api/harvests/watch/dismiss', {
        method: 'POST',
        body: JSON.stringify({ plant_id: id, project_id: r.project_id ?? null, dismissed: false }),
      })
    req
      .then(() => setRowUi(s => ({ ...s, [id]: { dismissed: false, busy: false, error: null } })))
      .catch((e) => {
        if (e?.status === 404) {
          setRowUi(s => ({ ...s, [id]: { dismissed: false, busy: false, error: null } }))
        } else {
          setRowUi(s => ({ ...s, [id]: { ...s[id], dismissed: true, busy: false, error: 'Could not save — try again.' } }))
        }
      })
  }, [fetch, rowUi])

  // THE UNDO GAP (BD-045 D1). "Not yet" writes suppressed_until = observed_on + 10 days
  // (WATCH_SUPPRESS_DAYS, lambda/harvests/watch.js), and a returning planting with a byte-identical
  // basis is suppressed one more cycle, so worst case 20 days invisible. The in-place Undo above
  // renders from `rowUi`, which is lost on navigation or reload, and the row is no longer in
  // `candidates` (server: eligible:false, reason:'dismissed'), so it lands in Snoozed. Without a
  // control there, one stray tap would remove a planting from the watch list for 10-20 days with no
  // way back.
  //
  // WHY THE BOOLEAN TOGGLE AND NOT DELETE /watch/dismissals/:id. The by-id path needs the dismissal
  // id, which only the dismissal RESPONSE hands back; projectSnoozedRow (watch.js) projects no
  // dismissal id. The toggle is exact regardless: handleDismissToggle scopes its UPDATE to user_id
  // AND plant_id and takes the single newest active dismissal, which is the row holding this
  // planting's live suppression.
  //
  // SOFT UNDO, never a delete: it sets undone_at and leaves the row, its frozen model snapshot and
  // its observed_on intact. A retracted observation is itself labelled data for the calibration
  // refit; handleDismissToggle's header names the hard DELETE as the one invariant this path must
  // never acquire.
  //
  // Reload rather than splice the row out locally: whether an un-suppressed planting is a CANDIDATE
  // again is the server's verdict (eligibility, ranking, basis), not something the band can infer.
  const restoreSnoozed = useCallback((s) => {
    const id = s.plant_id
    setSnoozeUi(u => ({ ...u, [id]: { busy: true, error: null } }))
    fetch('/api/harvests/watch/dismiss', {
      method: 'POST',
      body: JSON.stringify({ plant_id: id, project_id: s.project_id ?? null, dismissed: false }),
    })
      .then(() => {
        setSnoozeUi(u => ({ ...u, [id]: { busy: false, restored: true, error: null } }))
        load()
      })
      // Same posture as dismissRow: never come to rest claiming a write that did not land.
      .catch(() => setSnoozeUi(u => ({ ...u, [id]: { busy: false, error: 'Could not save — try again.' } })))
  }, [fetch, load])

  // Slot allocation: 5 slots, any one project capped at 2 of them (watchSelection →
  // selectWatchDisplay). A display device, not grouping; the capped-out rows are first in the tail.
  const { all, snoozed, visible, overflow } = watchSelection(data)

  // BUG-READYBANDFETCH-001 — before the empty check: "could not ask" is not "nothing is coming".
  if (failed && !data) return <AmbientBandNotice eyebrow="Looking ahead" onRetry={load} bare={bare} />

  // Hidden entirely when there is nothing to show (or before the first load resolves). A non-empty
  // snoozed list keeps the band alive: the list must still be knowably complete while rows are
  // suppressed.
  if (all.length === 0 && snoozed.length === 0) return null

  const shownOverflow = overflow.slice(0, revealed)
  const hidden = overflow.length - shownOverflow.length
  const expanded = revealed > 0

  const renderRow = (r) => {
    const ui = rowUi[r.plant_id] ?? {}
    const name = r.name || r.crop_display_name || 'Planting'
    const rowStyle = { borderTop: `1px solid ${P.border}`, padding: '10px 0' }

    if (ui.dismissed) {
      // Names the return date: the tap is a snooze with a stated end, not an ambiguous exit. Falls
      // back to the "for now" copy only if the write's response carried no date (an older Lambda
      // during a deploy window).
      const back = monthDayLabel(ui.suppressedUntil)
      return (
        <li key={r.plant_id} style={rowStyle}>
          {/* Undo is the only control on this row and it RETRACTS the tap that got here, so it is the
              last thing that should be out of thumb reach. It follows the handedness setting for the
              same reason the pair below does. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            {orderByThumb(
              hand,
              <button
                key="undo"
                type="button"
                aria-label={`Undo — ${name}`}
                disabled={!!ui.busy}
                onClick={() => undoDismiss(r)}
                style={{
                  minHeight: 48, padding: '0 2px', flexShrink: 0, background: 'none', border: 'none',
                  cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.78rem', fontWeight: 600,
                  color: P.green,
                }}
              >
                Undo
              </button>,
              <span key="ack" style={{ fontSize: '0.82rem', color: P.light, minWidth: 0 }}>
                {back ? `Not checking ${name} — back ${back}.` : `Not checking ${name} for now.`}
              </span>,
            )}
          </div>
        </li>
      )
    }

    const obs = (r.variety_ref && hwModule)
      ? observableFrom(hwModule.resolveHarvestWindow(r.variety_ref))
      : null
    const since = watchingSinceLabel(r.watching_since)
    // A calendar-inferred row may be shown ONLY with its basis visible. The server owns the basis
    // sentence (incl. the sibling planting-date offset).
    const meta = [since, r.basis].filter(Boolean).join(' · ')

    return (
      <li key={r.plant_id} style={rowStyle}>
        {/* THE CHECK FORM. Not "Yellow Brandywine is ready", not "your window opened".
            BD-007 / V4-BANDROWTAP-001 — the headline is the row's navigation to the planting detail
            (/plantings/:plantingId, the canonical UN-scoped route). A plain react-router Link,
            deliberately NOT useOverlayNavigate: the detail route is not in the overlayable set
            (/log, /log/many, /put-up, /search only), so a background-carrying navigate would leave
            the overlay tree with no matching route. minHeight 44 = the touch floor for a secondary
            target (the two write/nav controls below keep their own 48px row). */}
        <Link
          to={`/plantings/${r.plant_id}`}
          style={{
            display: 'flex', alignItems: 'center', minHeight: 44, textDecoration: 'none',
            fontSize: '0.88rem', fontWeight: 600, color: P.dark, lineHeight: 1.35,
          }}
        >
          Start checking {name}
        </Link>

        {/* Location on every row: you cannot walk to a crop name, and a project holds multiple
            sibling plantings, so the name alone is ambiguous on the ground. */}
        {r.location_name && (
          <div style={{ fontSize: '0.78rem', color: P.mid, marginTop: 1 }}>{r.location_name}</div>
        )}

        {/* THE OBSERVABLE — the row's actual unlock, since at low calibration it is the only part
            carrying weight. Absent coverage → the row degrades to basis-stated calendar text below
            rather than hiding. */}
        {obs && (
          <div style={{ fontSize: '0.82rem', color: P.mid, marginTop: 3, lineHeight: 1.4 }}>
            Look for: <span style={{ color: P.dark }}>{obs.at}</span>
            {obs.qualifier && (
              <span style={{ color: P.light }}> ({obs.qualifier})</span>
            )}
          </div>
        )}

        {meta && (
          <div style={{ fontSize: '0.72rem', color: P.light, marginTop: 4, lineHeight: 1.4 }}>{meta}</div>
        )}

        {ui.error && (
          <div style={{ fontSize: '0.72rem', color: P.terra, marginTop: 4 }}>{ui.error}</div>
        )}

        {/* CONTROL PLACEMENT IS A DELIBERATE MOBILE DECISION (Chrome/Android, ~390px).
            Two controls on one line, pushed to opposite edges — neither is a mis-tap neighbour of the
            other. The INVARIANT is about consequence, not compass direction: the control under the
            natural thumb must be the NAVIGATION ("Log harvest" — reversible, writes nothing), and the
            control that writes a calibration sample and snoozes the row for 10-20 days ("Not yet")
            must sit on the harder-to-reach edge. Both 48px tall.

            V4-HANDEDNESSCONTROLS-001 (BD-054): orderByThumb names the two controls by consequence and
            derives the edges from the handedness setting, so the safety property holds for a left
            thumb as well as a right one. DOM order is the only mechanism (see handedness.js). */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, marginTop: 2 }}>
          {orderByThumb(
            hand,
            // Navigates to the prefilled harvest form — never a one-tap POST. This is the one that
            // belongs under the thumb.
            <button
              key="log"
              type="button"
              aria-label={`Log harvest — ${name}`}
              onClick={() => overlayNavigate(`/log?project=${r.project_id}&plant=${r.plant_id}&event_type=harvest`)}
              style={{
                minHeight: 48, padding: '0 2px', flexShrink: 0, background: 'none', border: 'none',
                cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.78rem', fontWeight: 600,
                color: P.green,
              }}
            >
              Log harvest
            </button>,
            <button
              key="notyet"
              type="button"
              aria-label={`Not yet — ${name}`}
              disabled={!!ui.busy}
              onClick={() => dismissRow(r)}
              style={{
                minHeight: 48, padding: '0 2px', flexShrink: 0, background: 'none', border: 'none',
                cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.78rem', fontWeight: 600,
                // P.mid, NOT P.light: subordination to the primary is carried by HUE, not by low
                // contrast — making the dismissal harder to READ is not the risk being managed.
                color: P.mid,
              }}
            >
              Not yet
            </button>,
          )}
        </div>
      </li>
    )
  }

  const groups = groupWatchOverflow(shownOverflow)

  // `bare`: no card, no eyebrow / title / subtitle and no aria-label — the section that holds it is
  // the heading and the landmark (an unnamed <section> is not a region). Rows unchanged.
  return (
    <section
      aria-label={bare ? undefined : 'Worth checking soon'}
      // V5-TODAYSHAPE-001 — the Today layout gate's region anchor. Its ordered census identifies this
      // band by testid, not by heading text, so a copy rename cannot silently drop it.
      data-testid="today-watch-band"
      style={bare ? undefined : {
        backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 12,
        padding: '14px 16px', marginTop: 16,
      }}
    >
      {!bare && (
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: P.light }}>
          Looking ahead
        </div>
        {/* Heading "Worth checking soon" matches the "start checking {name}" rows beneath it. Smaller
            than Section 1's title (1rem). NO denominator sentence anywhere in this band: the count
            lives on the tail button only. */}
        <div style={{ fontSize: '0.92rem', fontWeight: 700, color: P.dark }}>Worth checking soon</div>
        {/* Section 2's consumer is the two-week plan, not tonight's dinner. */}
        <div style={{ fontSize: '0.75rem', color: P.light, marginTop: 2 }}>
          The start of a stream, not tonight&rsquo;s dinner.
        </div>
      </div>
      )}

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
        {visible.map(renderRow)}
      </ul>

      {/* THE TAIL. Trigger first, content AFTER it, so the button's top edge keeps its viewport y when
          it expands. Label carries scope + count + action; above 25 hidden it reveals 20 at a time. */}
      {hidden > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls="harvest-watch-tail"
          onClick={() => setReveal(revealed + revealStep(hidden))}
          style={tailButtonStyle}
        >
          <span style={{ flex: 1 }}>Show {hidden} more worth checking</span>
          <Chevron open={expanded} />
        </button>
      )}

      {(expanded || (overflow.length === 0 && snoozed.length > 0)) && (
        <div id="harvest-watch-tail">
          {/* Overflow rows grouped by location, then project subgroups. */}
          {groups.map(g => (
            <div key={g.key}>
              <div style={{ padding: '8px 0 0', fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', color: P.light }}>
                {g.label}
              </div>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
                {g.entries.map(e => (e.type === 'project'
                  ? (
                    <li key={`proj-${e.key}`} style={{ borderTop: `1px solid ${P.border}`, paddingTop: 2 }}>
                      <div style={{ padding: '6px 0 0', fontSize: '0.72rem', fontWeight: 600, color: P.mid }}>
                        {e.label}
                      </div>
                      <ul style={{ listStyle: 'none', margin: 0, padding: '0 0 0 10px', display: 'flex', flexDirection: 'column' }}>
                        {e.rows.map(renderRow)}
                      </ul>
                    </li>
                  )
                  : renderRow(e.row)))}
              </ul>
            </div>
          ))}

          {/* "Snoozed" subgroup: every suppressed row prints its return date. Defaults collapsed,
              individually expandable, so the list stays knowably complete without revealing the whole
              overflow. Each row carries "Bring back" (see restoreSnoozed): the ONLY retraction that
              survives leaving the page, placed here because this list is the one place a snoozed
              planting is visible at all. It mirrors the in-session Undo's geometry (48px, thumb-side
              of the line), derived from the handedness setting. */}
          {snoozed.length > 0 && (
            <>
              <button
                type="button"
                aria-expanded={snoozedOpen}
                aria-controls="harvest-watch-snoozed"
                onClick={() => setSnoozedOpen(o => !o)}
                style={{ ...tailButtonStyle, color: P.mid, fontWeight: 600 }}
              >
                <span style={{ flex: 1 }}>Snoozed ({snoozed.length})</span>
                <Chevron open={snoozedOpen} />
              </button>
              {snoozedOpen && (
                <ul id="harvest-watch-snoozed" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
                  {snoozed.map(s => {
                    const back = monthDayLabel(s.suppressed_until)
                    const name = s.name || s.crop_display_name || 'Planting'
                    const ui = snoozeUi[s.plant_id] ?? {}
                    return (
                      <li key={s.plant_id} style={{ borderTop: `1px solid ${P.border}`, padding: '8px 0' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
                          {orderByThumb(
                            hand,
                            ui.restored
                              ? (
                                // Declarative, quiet, in place (no toast, no celebration). The reload
                                // this kicked off will drop the row.
                                <span key="ctl" style={{ fontSize: '0.74rem', color: P.light, flexShrink: 0 }}>Back on the list.</span>
                              )
                              : (
                                <button
                                  key="ctl"
                                  type="button"
                                  aria-label={`Bring back ${name}`}
                                  disabled={!!ui.busy}
                                  onClick={() => restoreSnoozed(s)}
                                  style={{
                                    minHeight: 48, padding: '0 2px', flexShrink: 0, background: 'none', border: 'none',
                                    cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.78rem', fontWeight: 600,
                                    color: P.green,
                                  }}
                                >
                                  Bring back
                                </button>
                              ),
                            <span key="label" style={{ minWidth: 0 }}>
                              <span style={{ fontSize: '0.8rem', color: P.mid }}>{name}</span>
                              <span style={{ fontSize: '0.74rem', color: P.light }}>
                                {s.location_name ? ` · ${s.location_name}` : ''}
                                {back ? ` · back ${back}` : ' · snoozed for the season'}
                              </span>
                            </span>,
                          )}
                        </div>
                        {ui.error && (
                          <div role="alert" style={{ fontSize: '0.74rem', color: P.terra, paddingTop: 2 }}>{ui.error}</div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </>
          )}

          {/* Second collapse control at the bottom. */}
          {expanded && (
            <button
              type="button"
              aria-expanded={true}
              aria-controls="harvest-watch-tail"
              onClick={() => { setReveal(0); setSnoozedOpen(false) }}
              style={tailButtonStyle}
            >
              <span style={{ flex: 1 }}>Show fewer</span>
              <Chevron open={true} />
            </button>
          )}
        </div>
      )}
    </section>
  )
}
