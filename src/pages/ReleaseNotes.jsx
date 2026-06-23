// V3-RELEASENOTES-001 — Release Notes tab. Reads /releases.json (a static asset shipped
// with the SPA, newest-first) and renders the latest 10 releases as plain-language cards.
// releases.json is updated on every prod push by scripts/add-release.mjs (run as part of
// the mandatory version bump), so this surface auto-updates without touching the deploy YAML.
import React, { useEffect, useState } from 'react'
import { P } from '../lib/constants.js'

// Pure + testable: newest-first list -> the most recent n entries.
export function latestReleases(list, n = 10) {
  return Array.isArray(list) ? list.slice(0, n) : []
}

export default function ReleaseNotes() {
  const [releases, setReleases] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let on = true
    fetch('/releases.json', { cache: 'no-cache' })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then(d => { if (on) setReleases(latestReleases(d, 10)) })
      .catch(e => { if (on) setErr(e.message) })
    return () => { on = false }
  }, [])

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '20px 16px' }}>
      <h1 style={{ fontSize: '1.4rem', color: P.green, margin: '0 0 4px' }}>What's New</h1>
      <p style={{ color: P.mid, fontSize: '0.9rem', margin: '0 0 18px' }}>The latest updates to the garden app.</p>

      {err && <p style={{ color: P.light, fontSize: '0.9rem' }}>Couldn't load release notes right now.</p>}
      {!err && releases === null && <p style={{ color: P.light, fontSize: '0.9rem' }}>Loading…</p>}
      {!err && releases && releases.length === 0 && <p style={{ color: P.light, fontSize: '0.9rem' }}>No releases yet.</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {releases && releases.map(rel => (
          <div key={rel.version} style={{
            backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 12, padding: '14px 16px',
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
              <span style={{ fontWeight: 700, color: P.dark, fontSize: '1.02rem' }}>v{rel.version}</span>
              {rel.date && <span style={{ color: P.light, fontSize: '0.8rem' }}>{rel.date}</span>}
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, color: P.mid, fontSize: '0.9rem', lineHeight: 1.5 }}>
              {(rel.highlights || []).map((h, i) => <li key={i}>{h}</li>)}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}
