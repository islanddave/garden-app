// CatchUpBadge — V1.2a-4 S1 (PROJ-RESCOPE / V102 §5.1 #8)
// Surfaces a count of plants with incomplete lifecycle date metadata.
// "Catch-up candidate" = sown_at IS NULL AND at least one of
//   (germinated_at, transplanted_at, planted_out_at) IS NULL.
// Tap navigates to /plants/catch-up (single-page list — stub in S1, full
// editor + bulk skip in S1.1).
//
// Auto-resolve (14-day TTL + "Auto-cleaned (N)" weekly summary) is deferred
// to S1.1; see V102 §5.1 #8 + UX item 15. The badge MUST NOT appear on
// dashboard cold-open (V102 §5.1 #8 + UX item 11) — render is owned by the
// More-menu in BottomNav, never by Dashboard.

import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'

export function countCatchUpCandidates(plants) {
  if (!Array.isArray(plants)) return 0
  return plants.reduce((acc, p) => {
    const incomplete =
      p.sown_at == null &&
      (p.germinated_at == null || p.transplanted_at == null || p.planted_out_at == null)
    return incomplete ? acc + 1 : acc
  }, 0)
}

export default function CatchUpBadge({ to = '/plants/catch-up' }) {
  const { fetch } = useApiFetch()
  const [count, setCount] = useState(0)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/plants')
      .then(plants => {
        if (cancelled) return
        setCount(countCatchUpCandidates(plants ?? []))
        setLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setLoaded(true) // silent fail — badge stays hidden
      })
    return () => { cancelled = true }
  }, [fetch])

  if (!loaded || count <= 0) return null

  return (
    <Link
      to={to}
      data-testid="catch-up-badge"
      aria-label={`Catch up on ${count} plant${count === 1 ? '' : 's'} with missing dates`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: '6px 12px', borderRadius: 999,
        backgroundColor: P.greenPale,
        color: P.green, border: `1px solid ${P.greenLight}`,
        fontSize: '0.78rem', fontWeight: 600,
        textDecoration: 'none',
      }}
    >
      <span aria-hidden="true">⏱</span>
      <span>Catch up</span>
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9,
        backgroundColor: P.green, color: P.white,
        fontSize: '0.7rem', fontWeight: 700,
      }}>{count}</span>
    </Link>
  )
}
