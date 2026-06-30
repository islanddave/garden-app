import React from 'react'
import { useFindings } from '../hooks/useFindings.js'
import FindingsList from '../components/findings/FindingsList.jsx'
import TodayReasoning from '../components/findings/TodayReasoning.jsx'
import GardenVisitors from '../components/findings/GardenVisitors.jsx'
import { P } from '../lib/constants.js'

// Doctor Gardener — the DrG nav tab (/findings). Slice 8 (V4-THEME-001) "real but sparse":
// (1) honest sketch line, (2) Today's reasoning (read-only WHY from the daily plan — explains, does
// not duplicate Today's action list), (3) Health watch (findings from logged events), (4) ambient
// Garden visitors. Care plans CUT (no data source, would duplicate Today); Scan DEFERRED (no real
// entry point — anti-fabrication). Reward-UX V101: ambient only, no streak/badge/interrupt.
export default function Findings() {
  const { data, loading, error } = useFindings()
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
        {!loading && !error && <FindingsList findings={data?.findings} />}
      </section>

      <GardenVisitors />
    </div>
  )
}
