// src/components/AmbientBandNotice.jsx
// BUG-READYBANDFETCH-001 — what an ambient Today band renders when it could not ask, as opposed to
// when it asked and the answer was "nothing". Before this, both were the empty render.
//
// Reward-UX V102 compliance is the whole design constraint here. This is NOT an error banner: no
// alert colour (P.alert / P.terra are deliberately unused), no icon, no status code, no error text
// from the server, no count, no urgency framing, no toast/modal/sheet. It is one muted line in the
// band's own shell, at the band's own position, plus a plain retry affordance — the quietest thing
// that is still honest. "Couldn't check just now" claims only what is true: we do not know.
//
// It renders ONLY on a second consecutive failure with no data in hand (see useAmbientBandFetch), so
// a phone waking from sleep does not put this on Today. When stale rows exist the band keeps showing
// them and never mounts this.
import React from 'react'
import { P } from '../lib/constants.js'

export default function AmbientBandNotice({ eyebrow, onRetry }) {
  return (
    <section
      aria-label={`${eyebrow} — unavailable`}
      style={{
        backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 12,
        padding: '14px 16px', marginTop: 16,
      }}
    >
      <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: P.light }}>
        {eyebrow}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 44 }}>
        <span style={{ fontSize: '0.9rem', color: P.light }}>Couldn&rsquo;t check just now.</span>
        <button
          type="button"
          onClick={onRetry}
          style={{
            background: 'none', border: 'none', padding: '10px 2px', minHeight: 44,
            fontFamily: 'inherit', fontSize: '0.85rem', fontWeight: 700, color: P.green,
            cursor: 'pointer', flexShrink: 0,
          }}
        >
          Try again
        </button>
      </div>
    </section>
  )
}
