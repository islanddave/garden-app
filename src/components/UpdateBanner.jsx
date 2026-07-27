// UpdateBanner — BUG-STALECLIENT-001. Fixed banner offering an explicit Refresh when a new
// version is available (waiting SW or stale shell, via useAppUpdate). Renders nothing when
// current. Dismiss hides that specific version for this page lifetime; a NEWER version found
// later re-shows. Sits above the bottom nav; role=status so screen readers announce it once.
import React, { useState } from 'react'
import { P } from '../lib/constants.js'
import { useAppUpdate } from '../hooks/useAppUpdate.js'

export default function UpdateBanner() {
  const { update, apply } = useAppUpdate()
  const [dismissed, setDismissed] = useState(null) // version string or '' (no-number dismiss)

  if (!update) return null
  const key = update.version || ''
  if (dismissed !== null && dismissed === key) return null

  return (
    <div role="status" style={{
      position: 'fixed', left: 12, right: 12, zIndex: 60,
      bottom: 'calc(var(--bottom-nav-height, 0px) + env(safe-area-inset-bottom) + 12px)',
      maxWidth: 520, margin: '0 auto',
      display: 'flex', alignItems: 'center', gap: 12,
      backgroundColor: P.dark, color: P.cream, borderRadius: 12,
      padding: '10px 14px', boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
      fontSize: '0.9rem',
    }}>
      <span style={{ flex: 1 }}>
        {update.version ? `Update available — v${update.version} is ready.` : 'A new version of the app is ready.'}
      </span>
      <button onClick={apply} style={{
        backgroundColor: P.cream, color: P.dark, border: 'none', borderRadius: 8,
        padding: '8px 14px', fontWeight: 700, fontSize: '0.9rem', cursor: 'pointer',
      }}>
        Refresh
      </button>
      <button onClick={() => setDismissed(key)} aria-label="Dismiss update notice" style={{
        background: 'none', border: 'none', color: P.cream, opacity: 0.7,
        fontSize: '1rem', cursor: 'pointer', padding: '4px 6px', lineHeight: 1,
      }}>
        ✕
      </button>
    </div>
  )
}
