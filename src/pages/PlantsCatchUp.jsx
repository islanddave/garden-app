// PlantsCatchUp — V1.2a-4 S1 stub.
// Full implementation (inline approximate-date editor, skip-per-row, bulk skip,
// 14-day auto-resolve, weekly "Auto-cleaned (N)" summary) deferred to S1.1
// per V102 §5.1 #8 + UX item 15. This stub exists so the CatchUpBadge link
// resolves to a real route instead of a 404.

import React from 'react'
import { Link } from 'react-router-dom'
import { P } from '../lib/constants.js'

export default function PlantsCatchUp() {
  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '32px 20px' }}>
        <div style={{ fontSize: '0.82rem', color: P.light, marginBottom: 20 }}>
          <Link to="/garden" style={{ color: P.green, textDecoration: 'none' }}>Garden</Link>
          {' › Catch up'}
        </div>
        <h1 style={{ margin: '0 0 12px', color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>
          Catch up — coming soon
        </h1>
        <p style={{ fontSize: '0.9rem', color: P.mid, lineHeight: 1.5 }}>
          The catch-up editor lets you backfill missing sown / germinated / transplanted dates
          for plants you added in a hurry. Inline approximate-date editor, skip-per-row, and
          bulk skip ship in V1.2a-4 S1.1.
        </p>
        <p style={{ marginTop: 16, fontSize: '0.85rem', color: P.light }}>
          For now, edit individual plants from their project page.
        </p>
      </div>
    </div>
  )
}
