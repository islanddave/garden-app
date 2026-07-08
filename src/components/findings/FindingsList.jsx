import React from 'react'
import { sortFindings } from '../../lib/findingsSort.js'
import FindingCard from './FindingCard.jsx'
import { P } from '../../lib/constants.js'

export default function FindingsList({ findings, onResolve, caretakerFor = () => null }) {
  const sorted = sortFindings(findings)
  if (sorted.length === 0) {
    return (
      <div data-testid="findings-empty" style={{ padding: '28px 16px', textAlign: 'center', color: P.light }}>
        <div style={{ fontSize: '0.95rem', fontWeight: 600, color: P.mid, marginBottom: 6 }}>
          Nothing needs attention right now.
        </div>
        <div style={{ fontSize: '0.82rem', lineHeight: 1.4 }}>
          Doctor Gardener surfaces care issues from what you log. Flag an event as an issue and it shows up here.
        </div>
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {sorted.map(f => <FindingCard key={f.finding_id} finding={f} onResolve={onResolve} caretaker={caretakerFor(f)} />)}
    </div>
  )
}
