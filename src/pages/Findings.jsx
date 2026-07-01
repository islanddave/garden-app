import React, { useCallback, useMemo } from 'react'
import { useFindings } from '../hooks/useFindings.js'
import { useApiFetch } from '../lib/api.js'
import FindingsList from '../components/findings/FindingsList.jsx'
import TodayReasoning from '../components/findings/TodayReasoning.jsx'
import GardenVisitors from '../components/findings/GardenVisitors.jsx'
import { P } from '../lib/constants.js'

// Doctor Gardener — the DrG nav tab (/findings). Slice 8 (V4-THEME-001) "real but sparse":
// (1) honest sketch line, (2) Today's reasoning (read-only WHY from the daily plan — explains, does
// not duplicate Today's action list), (3) Health watch (findings from logged events), (4) ambient
// Garden visitors. Care plans CUT (no data source, would duplicate Today); Scan DEFERRED (no real
// entry point — anti-fabrication). Reward-UX V101: ambient only, no streak/badge/interrupt.
//
// DRG-RESOLVE-001: resolved findings are pulled OUT of the active Health watch (they were noise —
// lingered for ISSUE_WINDOW_DAYS with no owner control) and moved into a collapsed "Recently
// resolved" disclosure. The owner can also clear a live issue on their own timeline via the card's
// "Mark resolved" control (operational, not a reward), which PATCHes the source event.
export default function Findings() {
  const { data, loading, error, reload } = useFindings()
  const { fetch } = useApiFetch()

  const all = data?.findings
  const { active, resolved } = useMemo(() => {
    const list = Array.isArray(all) ? all : []
    return {
      active: list.filter(f => f.decay_state !== 'resolved'),
      resolved: list.filter(f => f.decay_state === 'resolved'),
    }
  }, [all])

  const handleResolve = useCallback(async (eventId) => {
    if (!eventId) return
    await fetch(`/api/events/${eventId}`, { method: 'PATCH', body: JSON.stringify({ resolved: true }) })
    await reload()
  }, [fetch, reload])

  return (
    <div style={{ padding: 16, paddingBottom: 32, maxWidth: 640, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: P.dark, marginBottom: 4 }}>
        Doctor Gardener
      </h1>
      <p style={{ fontSize: '0.84rem', color: P.light, marginTop: 0, marginBottom: 18, lineHeight: 1.45 }}>
        Doctor Gardener is learning your garden. Right now it explains today&rsquo;s care and flags issues worth a look &mdash; more reasoning lands as it watches longer.
      </p>

      <TodayReasoning />

      <section aria-labelledby="drg-health-h">
        <h2 id="drg-health-h" style={{ fontSize: '1rem', fontWeight: 700, color: P.dark, margin: '0 0 8px' }}>
          Health watch
        </h2>
        {loading && <div style={{ padding: 20, color: P.light, textAlign: 'center' }}>Loading&hellip;</div>}
        {error && <div style={{ padding: 20, color: P.terra, textAlign: 'center' }}>{error}</div>}
        {!loading && !error && <FindingsList findings={active} onResolve={handleResolve} />}

        {!loading && !error && resolved.length > 0 && (
          <details style={{ marginTop: 16 }}>
            <summary style={{
              cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600, color: P.light,
              listStyle: 'revert', padding: '4px 0',
            }}>
              Recently resolved ({resolved.length})
            </summary>
            <div style={{ marginTop: 10 }}>
              <FindingsList findings={resolved} />
            </div>
          </details>
        )}
      </section>

      <GardenVisitors />
    </div>
  )
}
