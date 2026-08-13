// src/components/HarvestWatchBand.jsx
// V4-HARVSURFACE-001 — SECTION 2 of the Today harvest surface: the "worth checking" watch list.
// Design: `harvest-two-section-design-V100-20260811.md` §3, as revised by the domain panel in
// `harvest-panel-decisions-20260812.md` (Q1 heading, Q2 slot cap, Q3 bounded suppression, Q4 tail).
//
// WHAT THIS IS, AND WHAT IT IS DELIBERATELY NOT.
// Section 1 (HarvestReadyBand, above) is an ACTION surface — imperative mood, go/no-go in five
// minutes. This is a PLAN surface — declarative mood, "what changed since I last looked." §4:
// the two must differ on position/weight AND grammatical mood, because a declarative sentence is
// not answerable with "do I do this now?", so it self-classifies even if the styling is stripped.
// If they read alike, every row here becomes a candidate task and the screen silently reverts to
// the 12-row inventory Dave rejected. Hence: smaller type, below the ready band, no imperatives.
//
// THE VOICE RULE IS LOAD-BEARING AND DAVE-APPROVED — see `src/lib/harvestWatch.js` header. Every
// string is a CHECK prompt, never a readiness assertion. "Start checking X", never "X is ready" or
// "your window opened". At 11.8% calibration with a −22d median error the assertion form is
// actively dishonest; the check form stays true at ANY calibration level, which is the entire point.
//
// REWARD-UX V102: ambient only. No toast, no sheet, no modal, no haptic, no badge, no streak, no
// celebration, no animation. The "not yet" dismissal is an OPERATIONAL control, not a reward — and
// its confirmation is a quiet in-place line, never a congratulation. The tail counts are
// INFORMATIONAL and live in the button labels, never in a pill.
//
// PANEL Q4 — THE TAIL. The +N overflow is a real in-place expand control, one per section, never
// shared. Expand goes DOWNWARD only and the trigger's top edge keeps its viewport y (content is
// inserted AFTER the button). Expanded order: overflow rows grouped by location → project
// subgroups → a "Snoozed" subgroup printing each suppressed row's return date (collapsed by
// default, individually expandable) → a second collapse control at the bottom. Above 25 hidden
// rows the tail reveals 20 at a time. Expansion state is SESSION-scoped per section
// (sessionStorage — survives an in-app remount of Today, dies with the tab, never localStorage):
// a Today that opens 3,000px long is a Today that gets closed.
//
// THE COLOUR-WINDOW DATASET IS LAZY-LOADED AND MUST STAY THAT WAY. `src/lib/harvestWindows.js`
// statically imports a 396KB JSON (≈105KB gzip). Today is the app's landing surface, so a static
// import HERE would put the whole dataset back in the entry bundle for every user at boot —
// re-creating exactly what V4-RIPENESSCUES-001 just removed. `scripts/verify-window-chunk.sh`
// guards this: never convert the dynamic import below into a static one.
//
// The fetch error is SWALLOWED and the band renders nothing, matching the shipped ambient posture
// of HarvestReadyBand / PutUpUseSoonBand: this is a supplementary glance and must never throw onto
// Today.
import React, { useState, useEffect, useCallback, useReducer, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useOverlayLocation, useOverlayNavigate } from '../context/OverlayContext.jsx'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import {
  rankWatchCandidates, selectWatchDisplay, groupWatchOverflow, revealStep,
  watchingSinceLabel, monthDayLabel, observableFrom,
} from '../lib/harvestWatch.js'

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

// Shared tail-control styling: full-width <button> ≥48px (52 matches CareNeeded's group headers),
// count in the LABEL, chevron as the only ornament. Copied pattern from
// src/components/today/CareNeeded.jsx (aria-expanded + aria-controls) — copied, not refactored.
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

export default function HarvestWatchBand() {
  const { fetch } = useApiFetch()
  const location = useOverlayLocation()
  const overlayNavigate = useOverlayNavigate()
  const [data, setData] = useState(null)
  // plant_id -> { dismissed?: boolean, busy?: boolean, error?: string, dismissalId, suppressedUntil }
  const [rowUi, setRowUi] = useState({})
  const [revealed, setRevealed] = useState(readReveal)
  const [snoozedOpen, setSnoozedOpen] = useState(false) // defaults collapsed every mount (panel Q4)
  const [, bumpWindow] = useReducer(t => t + 1, 0)
  const inflight = useRef(false)

  const setReveal = useCallback((n) => { writeReveal(n); setRevealed(n) }, [])

  const load = useCallback(() => {
    if (inflight.current) return
    inflight.current = true
    // limit=200: the tail expands in place, so the band needs the whole queue in one response
    // (panel Q4 contract change — the server's default limit stays 5 for any client that forgets).
    fetch('/api/harvests/watch?limit=200')
      .then(d => setData(d && Array.isArray(d.candidates) ? d : { candidates: [], snoozed: [] }))
      .catch(() => { /* supplementary glance — never surface a fetch error onto Today */ })
      .finally(() => { inflight.current = false })
  }, [fetch])

  useEffect(() => { load() }, [load, location.pathname])

  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') load() }
    window.addEventListener('focus', load)
    document.addEventListener('visibilitychange', onVis)
    return () => { window.removeEventListener('focus', load); document.removeEventListener('visibilitychange', onVis) }
  }, [load])

  // Fire the lazy chunk only when at least one row could actually use it.
  const needsWindows = Array.isArray(data?.candidates) && data.candidates.some(c => c?.variety_ref)
  useEffect(() => {
    if (!needsWindows || hwModule) return
    let alive = true
    import('../lib/harvestWindows.js')
      .then(m => { hwModule = m; if (alive) bumpWindow() })
      // Chunk miss (offline, purged cache) → rows degrade to basis-stated calendar text, which §3.2
      // specifies as the honest fallback anyway. hwModule stays null so the next mount retries.
      .catch(() => {})
    return () => { alive = false }
  }, [needsWindows])

  // The dismissal write. OPTIMISTIC, then reverted on failure — the UI must never come to rest in a
  // state that claims a write which did not land. The response's dismissal id + suppressed_until are
  // kept so the collapsed line can name the RETURN DATE (panel Q3) and the undo can retract exactly
  // this row by id.
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

  // Undo. PANEL Q3 (blocking prereq): retraction must hit ONLY the dismissal that was just made —
  // by id when the write handed one back (DELETE /watch/dismissals/:id, the preferred path), else
  // the boolean toggle, which the server now scopes to the single most recent active row. A 404 on
  // the DELETE means the row is already retracted, which is the outcome the tap wanted.
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

  const all = rankWatchCandidates(data?.candidates)
  const snoozed = Array.isArray(data?.snoozed) ? data.snoozed.filter(s => s && s.plant_id != null) : []
  // Hidden entirely when there is nothing to show (or before the first load resolves). A non-empty
  // snoozed list keeps the band alive: R6 — the list must still be knowably complete while rows are
  // suppressed.
  if (all.length === 0 && snoozed.length === 0) return null

  // PANEL Q2: slot allocation — 5 slots, any one project capped at 2 of them. A display device,
  // not grouping; the capped-out rows are first in the tail.
  const { visible, overflow } = selectWatchDisplay(all)
  const shownOverflow = overflow.slice(0, revealed)
  const hidden = overflow.length - shownOverflow.length
  const expanded = revealed > 0

  const renderRow = (r) => {
    const ui = rowUi[r.plant_id] ?? {}
    const name = r.name || r.crop_display_name || 'Planting'
    const rowStyle = { borderTop: `1px solid ${P.border}`, padding: '10px 0' }

    if (ui.dismissed) {
      // Names the return date (panel Q3 — copy changed from "for now"): the tap is a snooze with a
      // stated end, not an ambiguous exit. Falls back to the old copy only if the write's response
      // carried no date (an older Lambda during a deploy window).
      const back = monthDayLabel(ui.suppressedUntil)
      return (
        <li key={r.plant_id} style={rowStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <span style={{ fontSize: '0.82rem', color: P.light, minWidth: 0 }}>
              {back ? `Not checking ${name} — back ${back}.` : `Not checking ${name} for now.`}
            </span>
            <button
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
            </button>
          </div>
        </li>
      )
    }

    const obs = (r.variety_ref && hwModule)
      ? observableFrom(hwModule.resolveHarvestWindow(r.variety_ref))
      : null
    const since = watchingSinceLabel(r.watching_since)
    // §3.4 anchor hierarchy: a calendar-inferred row may be shown ONLY with its basis visible.
    // The server owns the basis sentence (incl. the sibling planting-date offset, panel Q2).
    const meta = [since, r.basis].filter(Boolean).join(' · ')

    return (
      <li key={r.plant_id} style={rowStyle}>
        {/* THE CHECK FORM. Not "Yellow Brandywine is ready", not "your window opened".
            BD-007 / V4-BANDROWTAP-001 — the headline is the row's navigation to the planting
            detail (/plantings/:plantingId, the canonical UN-scoped route, V4-UNSCOPEDROUTES-001).
            A plain react-router Link, deliberately NOT useOverlayNavigate: the detail route is not
            in the overlayable set (/log, /log/many, /put-up, /search only), so a background-
            carrying navigate would leave the overlay tree with no matching route. Same row-body
            Link convention as CareNeeded. minHeight 44 = the touch floor for a secondary target
            (the two write/nav controls below keep their own 48px row); typography unchanged so
            the check-form voice reads exactly as before. */}
        <Link
          to={`/plantings/${r.plant_id}`}
          style={{
            display: 'flex', alignItems: 'center', minHeight: 44, textDecoration: 'none',
            fontSize: '0.88rem', fontWeight: 600, color: P.dark, lineHeight: 1.35,
          }}
        >
          Start checking {name}
        </Link>

        {/* §5: location on every row — you cannot walk to a crop name, and a project holds
            multiple sibling plantings, so the name alone is ambiguous on the ground. */}
        {r.location_name && (
          <div style={{ fontSize: '0.78rem', color: P.mid, marginTop: 1 }}>{r.location_name}</div>
        )}

        {/* §3.2 THE OBSERVABLE — the row's actual unlock (panel Q2 keeps it: at 11.8% calibration
            the observable is the only part carrying weight). Absent coverage → the row degrades to
            basis-stated calendar text below rather than hiding. */}
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
            Two controls on one line, pushed to opposite edges — neither is a mis-tap neighbour of
            the other. "Log harvest" takes the right-hand natural thumb zone and "Not yet" the
            harder-to-reach left, so a stray thumb tap lands on the NAVIGATION (reversible, writes
            nothing) rather than the control that writes a calibration sample. Both 48px tall. */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, marginTop: 2 }}>
          <button
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
          </button>
          {/* Navigates to the prefilled harvest form — never a one-tap POST. */}
          <button
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
          </button>
        </div>
      </li>
    )
  }

  const groups = groupWatchOverflow(shownOverflow)

  return (
    <section
      aria-label="Worth checking soon"
      style={{
        backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 12,
        padding: '14px 16px', marginTop: 16,
      }}
    >
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: P.light }}>
          Looking ahead
        </div>
        {/* Panel Q1 heading: "Worth checking soon" — matches the "start checking {name}" rows
            beneath it. Smaller than Section 1's title (1rem) — §4's weight axis. NO denominator
            sentence anywhere in this band: the count lives on the tail button only. */}
        <div style={{ fontSize: '0.92rem', fontWeight: 700, color: P.dark }}>Worth checking soon</div>
        {/* §3.6: Section 2's consumer is the two-week plan, not tonight's dinner. */}
        <div style={{ fontSize: '0.75rem', color: P.light, marginTop: 2 }}>
          The start of a stream, not tonight&rsquo;s dinner.
        </div>
      </div>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
        {visible.map(renderRow)}
      </ul>

      {/* THE TAIL (panel Q4). Trigger first, content AFTER it, so the button's top edge keeps its
          viewport y when it expands. Label carries scope + count + action; above 25 hidden it
          reveals 20 at a time, so the remaining count keeps living on this same button. */}
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
          {/* Overflow rows grouped by location, then project subgroups (panel Q4). */}
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

          {/* "Snoozed" subgroup (panel Q3/Q4): every suppressed row prints its return date.
              Defaults collapsed, individually expandable — R6 stays reachable without revealing
              the whole overflow. Rows are read-only prints; the in-session Undo lives on the row
              that was just dismissed, above. */}
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
                    return (
                      <li key={s.plant_id} style={{ borderTop: `1px solid ${P.border}`, padding: '8px 0' }}>
                        <span style={{ fontSize: '0.8rem', color: P.mid }}>
                          {s.name || s.crop_display_name || 'Planting'}
                        </span>
                        <span style={{ fontSize: '0.74rem', color: P.light }}>
                          {s.location_name ? ` · ${s.location_name}` : ''}
                          {back ? ` · back ${back}` : ' · snoozed for the season'}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </>
          )}

          {/* Second collapse control at the bottom (panel Q4). */}
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
