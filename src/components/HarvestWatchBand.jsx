// src/components/HarvestWatchBand.jsx
// V4-HARVSURFACE-001 Slice 1 — SECTION 2 of the two-section Today harvest surface: the "worth
// checking" watch list. Design: `harvest-two-section-design-V100-20260811.md` §3 (+ §11 Slice 1).
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
// A wrong check-prompt costs one glance. A wrong readiness claim costs the surface's authority.
//
// REWARD-UX V102: ambient only. No toast, no sheet, no modal, no haptic, no badge, no streak, no
// celebration, no animation. The "not yet" dismissal is an OPERATIONAL control, not a reward — and
// its confirmation is a quiet in-place line, never a congratulation.
//
// THE COLOUR-WINDOW DATASET IS LAZY-LOADED AND MUST STAY THAT WAY. `src/lib/harvestWindows.js`
// statically imports a 396KB JSON (≈105KB gzip). Today is the app's landing surface, so a static
// import HERE would put the whole dataset back in the entry bundle for every user at boot —
// re-creating exactly what V4-RIPENESSCUES-001 just removed. `scripts/verify-window-chunk.sh`
// guards this: it asserts a dataset marker string appears in its own hashed chunk and in NO other
// chunk, including the entry. Never convert the dynamic import below into a static one.
//
// The fetch error is SWALLOWED and the band renders nothing, matching the shipped ambient posture
// of HarvestReadyBand / PutUpUseSoonBand: this is a supplementary glance and must never throw onto
// Today. (Design §6's explicit zero-state SENTENCE is scoped to Section 1 — the classifier — and
// ships in Slice 2 with the corrected denominator; inventing one here would put a permanent empty
// card on Today out of season, and its copy is not ratified.)
import React, { useState, useEffect, useCallback, useReducer, useRef } from 'react'
import { useOverlayLocation, useOverlayNavigate } from '../context/OverlayContext.jsx'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { MAX_WATCH_ROWS, rankWatchCandidates, watchingSinceLabel, observableFrom } from '../lib/harvestWatch.js'

// Module-scope so a second mount (in-app nav back to Today) resolves synchronously with no pop-in.
// CropCard holds its own identical cache; both await the same dynamic import, so whichever lands
// first makes the other's `import()` resolve from the module registry immediately.
let hwModule = null

export default function HarvestWatchBand() {
  const { fetch } = useApiFetch()
  const location = useOverlayLocation()
  const overlayNavigate = useOverlayNavigate()
  const [data, setData] = useState(null)
  // plant_id -> { dismissed?: boolean, busy?: boolean, error?: string }
  const [rowUi, setRowUi] = useState({})
  const [, bumpWindow] = useReducer(t => t + 1, 0)
  const inflight = useRef(false)

  const load = useCallback(() => {
    if (inflight.current) return
    inflight.current = true
    fetch('/api/events/harvest-watch')
      .then(d => setData(d && Array.isArray(d.candidates) ? d : { candidates: [] }))
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

  // Fire the lazy chunk only when at least one row could actually use it. A payload of pure
  // calendar-anchored rows (no variety_ref) never pays for the dataset — and never suffers a
  // re-render for it either.
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
  // state that claims a write which did not land. `dismissed:false` is the undo: a mis-tap is the
  // named risk of shipping this in v1 (it teaches the calibration model a false negative), so the
  // recovery path is one tap and costs no extra endpoint.
  const setDismissed = useCallback((r, dismissed) => {
    const id = r.plant_id
    setRowUi(s => ({ ...s, [id]: { dismissed, busy: true, error: null } }))
    fetch('/api/events/harvest-watch/dismiss', {
      method: 'POST',
      body: JSON.stringify({ plant_id: id, project_id: r.project_id ?? null, dismissed }),
    })
      .then(() => setRowUi(s => ({ ...s, [id]: { dismissed, busy: false, error: null } })))
      .catch(() => setRowUi(s => ({
        ...s, [id]: { dismissed: !dismissed, busy: false, error: 'Could not save — try again.' },
      })))
  }, [fetch])

  const all = rankWatchCandidates(data?.candidates)
  // Hidden entirely when empty (or before the first load resolves) — see the header note.
  if (all.length === 0) return null
  const shown = all.slice(0, MAX_WATCH_ROWS)

  return (
    <section
      aria-label="Worth checking this week"
      style={{
        backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 12,
        padding: '14px 16px', marginTop: 16,
      }}
    >
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: P.light }}>
          Looking ahead
        </div>
        {/* Smaller than Section 1's title (1rem) — §4's weight axis, which must hold alongside the
            mood axis so neither alone carries the distinction. */}
        <div style={{ fontSize: '0.92rem', fontWeight: 700, color: P.dark }}>Worth checking this week</div>
        {/* §3.6: Section 2's consumer is the two-week plan, not tonight's dinner — and that must be
            stated in the section's own framing, or its rows get read in Section 1's action mode. */}
        <div style={{ fontSize: '0.75rem', color: P.light, marginTop: 2 }}>
          The start of a stream, not tonight&rsquo;s dinner.
        </div>
      </div>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
        {shown.map(r => {
          const ui = rowUi[r.plant_id] ?? {}
          const name = r.name || r.crop_display_name || 'Planting'
          const rowStyle = { borderTop: `1px solid ${P.border}`, padding: '10px 0' }

          if (ui.dismissed) {
            return (
              <li key={r.plant_id} style={rowStyle}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
                  <span style={{ fontSize: '0.82rem', color: P.light, minWidth: 0 }}>
                    Not checking {name} for now.
                  </span>
                  <button
                    type="button"
                    aria-label={`Undo — ${name}`}
                    disabled={!!ui.busy}
                    onClick={() => setDismissed(r, false)}
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
          // The server owns the basis sentence ("sown 118d ago; catalogue 95d from transplant").
          const meta = [since, r.basis].filter(Boolean).join(' · ')

          return (
            <li key={r.plant_id} style={rowStyle}>
              {/* THE CHECK FORM. Not "Yellow Brandywine is ready", not "your window opened". */}
              <div style={{ fontSize: '0.88rem', fontWeight: 600, color: P.dark, lineHeight: 1.35 }}>
                Start checking {name}
              </div>

              {/* §5: location on every row — you cannot walk to a crop name, and a project holds
                  multiple sibling plantings, so the name alone is ambiguous on the ground. */}
              {r.location_name && (
                <div style={{ fontSize: '0.78rem', color: P.mid, marginTop: 1 }}>{r.location_name}</div>
              )}

              {/* §3.2 THE OBSERVABLE — the row's actual unlock. Absent (no dataset coverage, or the
                  chunk has not landed) the row degrades to basis-stated calendar text below rather
                  than hiding: 51% coverage means half these rows legitimately have no window. */}
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
                  Two controls sit on one line, pushed to opposite edges — ~250px of dead space
                  between them at 390px, so neither is a mis-tap neighbour of the other. Which one
                  goes where is NOT cosmetic: "Log harvest" takes the right-hand natural thumb zone
                  and "Not yet" the harder-to-reach left. A stray thumb tap therefore lands on the
                  NAVIGATION (fully reversible with Back, writes nothing) rather than on the control
                  that writes a negative-class calibration sample and removes the row. Both are 48px
                  tall per the house touch standard. */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, marginTop: 2 }}>
                <button
                  type="button"
                  aria-label={`Not yet — ${name}`}
                  disabled={!!ui.busy}
                  onClick={() => setDismissed(r, true)}
                  style={{
                    minHeight: 48, padding: '0 2px', flexShrink: 0, background: 'none', border: 'none',
                    cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.78rem', fontWeight: 600,
                    // P.mid, NOT P.light: #777 on white is 4.48:1, a hair under WCAG AA (4.5:1), and
                    // this is an interactive label at 0.78rem. Subordination to the primary is carried
                    // by HUE (neutral vs P.green) rather than by low contrast — deliberately, because
                    // making the dismissal harder to READ is not the same as making it harder to tap
                    // reflexively, and only the second one is the risk we are managing.
                    color: P.mid,
                  }}
                >
                  Not yet
                </button>
                {/* Navigates to the prefilled harvest form — never a one-tap POST. `harvest` requires
                    quantity + unit (both NOT NULL), so a quantity-less POST would 400. Same shipped
                    `&plant=` deep-link contract HarvestReadyBand produces (pinned by a4c8c2b I-2). */}
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
        })}
      </ul>
    </section>
  )
}
