// V3-RELEASENOTES-001 — Release Notes tab. Reads /releases.json (a static asset shipped
// with the SPA, newest-first) and renders the latest 10 releases as plain-language cards.
// releases.json is updated on every prod push by scripts/add-release.mjs (run as part of
// the mandatory version bump), so this surface auto-updates without touching the deploy YAML.
import React, { useEffect, useState } from 'react'
import { P } from '../lib/constants.js'
import { writeSeen } from '../lib/whatsNew.js'

// Pure + testable: newest-first list -> the most recent n entries.
export function latestReleases(list, n = 10) {
  return Array.isArray(list) ? list.slice(0, n) : []
}

// BUG-RELNOTES-001: the fetch is bounded so a hung network path shows the error state (with a
// retry) instead of "Loading…" forever — an unbounded fetch here never settles on a stalled CDN
// connection and the page looks dead with no diagnostic.
export const RELEASES_FETCH_TIMEOUT_MS = 10000

export default function ReleaseNotes() {
  const [releases, setReleases] = useState(null)
  const [err, setErr] = useState(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let on = true
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), RELEASES_FETCH_TIMEOUT_MS) : null
    setErr(null)
    setReleases(null)
    fetch('/releases.json', { cache: 'no-cache', signal: controller ? controller.signal : undefined })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then(d => {
        if (!on) return
        setReleases(latestReleases(d, 10))
        // V4-WHATSNEW-001: viewing this page marks the newest release seen (clears the ambient dot,
        // cross-instance via the SEEN_EVENT). localStorage-only; cross-device sync = V4-WHATSNEW-002.
        const newest = Array.isArray(d) && d[0] && d[0].version ? d[0].version : null
        writeSeen(newest)
      })
      .catch(e => { if (on) setErr(e && e.name === 'AbortError' ? 'timeout' : e.message) })
      .then(() => { if (timer) clearTimeout(timer) })
    return () => { on = false; if (timer) clearTimeout(timer) }
  }, [attempt])

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '20px 16px' }}>
      <h1 style={{ fontSize: '1.4rem', color: P.green, margin: '0 0 4px' }}>What's New</h1>
      <p style={{ color: P.mid, fontSize: '0.9rem', margin: '0 0 18px' }}>The latest updates to the garden app.</p>

      {err && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <p style={{ color: P.light, fontSize: '0.9rem', margin: 0 }}>Couldn't load release notes right now.</p>
          <button onClick={() => setAttempt(a => a + 1)} style={{
            backgroundColor: P.white, color: P.green, border: `1px solid ${P.border}`, borderRadius: 8,
            padding: '6px 12px', fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer',
          }}>
            Try again
          </button>
        </div>
      )}
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
