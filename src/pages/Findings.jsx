import React from 'react'
import { useFindings } from '../hooks/useFindings.js'
import FindingsList from '../components/findings/FindingsList.jsx'
import { P } from '../lib/constants.js'

// Doctor Gardener — findings read model surface (DRG-TAB-001 / slice 8). Instrumentation tab in
// the More menu, not a primary nav tab. No character (DrG-the-character is a separate V4 track).
export default function Findings() {
  const { data, loading, error } = useFindings()
  return (
    <div style={{ padding: 16, paddingBottom: 32, maxWidth: 640, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: P.dark, marginBottom: 4 }}>
        Doctor Gardener
      </h1>
      <p style={{ fontSize: '0.84rem', color: P.light, marginTop: 0, marginBottom: 16, lineHeight: 1.4 }}>
        Evidence-based care findings from what you&rsquo;ve logged. Early version &mdash; flagged issues only for now.
      </p>
      {loading && <div style={{ padding: 20, color: P.light, textAlign: 'center' }}>Loading&hellip;</div>}
      {error && <div style={{ padding: 20, color: '#b94a3a', textAlign: 'center' }}>{error}</div>}
      {!loading && !error && <FindingsList findings={data?.findings} />}
    </div>
  )
}