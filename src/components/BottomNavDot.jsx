// Stage 3: BottomNav dot — MVP-Critter.
// Canonical spec: revision §1.8 (Session 2 scope), §3.6 (server-side dot_visible_after),
//                 §3.12 (300ms opacity fade on clear, not silent disappear).
// V100 binding: §5 Stage 3 ambient dot, NEVER an interrupt / count / badge.
//
// Self-contained: fetches /api/critters/active on mount + on visibilitychange,
// derives dot visibility from: now() >= dot_visible_after AND viewed_at IS NULL.
// NO client-side setTimeout for quiet hours (server-side dot_visible_after per §3.6).
//
// HARD RULES (V100 + project CLAUDE.md Reward UX Rule):
//   - 6-8px accent-color circle, NO count, NO badge, NO number
//   - aria-hidden=true on the visual element (decorative; not announced)
//   - 300ms opacity fade on clear per revision §3.12
//   - No tap-to-claim — entering /garden eventually marks viewed (handled elsewhere)
//
// Props:
//   getToken      — async () => string | null
//   color         — CSS color (default: accent sage)
//   size          — px (default: 7)
//   testFetchActiveCritters — test seam; defaults to lib import

import React, { useEffect, useState, useCallback } from 'react'
import { fetchActiveCritters as defaultFetch } from '../lib/critterClient.js'

export default function BottomNavDot({
  getToken,
  color = '#b5a04a', // soft gold accent — distinct from green active-tab color
  size = 7,
  testFetchActiveCritters = null,
}) {
  const [showDot, setShowDot] = useState(false)
  const fetchImpl = testFetchActiveCritters ?? defaultFetch

  const refresh = useCallback(async () => {
    if (typeof getToken !== 'function') {
      setShowDot(false)
      return
    }
    const critters = await fetchImpl({ getToken })
    const now = Date.now()
    const visible = critters.some(c => {
      if (c.viewed_at) return false
      const dva = c.dot_visible_after ? Date.parse(c.dot_visible_after) : 0
      return Number.isFinite(dva) && now >= dva
    })
    setShowDot(visible)
  }, [getToken, fetchImpl])

  // Mount + visibility-change refresh.
  useEffect(() => {
    refresh()
    if (typeof document === 'undefined') return undefined
    function onVisibility() {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [refresh])

  // Refresh on a slow interval as well (quiet-hours expiry doesn't fire visibilitychange).
  // 60s is well below the typical quiet-hours window and far above any user-tap cadence.
  // Battery (DRG-BATTERY-001): gate the interval's network call on document visibility so a
  // hidden/backgrounded PWA stops waking the radio every 60s. The mount + visibilitychange
  // handlers already refresh on return-to-foreground, so a hidden tick misses nothing and the
  // reward dot is not delayed on resume.
  useEffect(() => {
    const t = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') refresh()
    }, 60_000)
    return () => clearInterval(t)
  }, [refresh])

  return (
    <span
      aria-hidden="true"
      data-testid="bottom-nav-dot"
      data-visible={showDot ? 'true' : 'false'}
      style={{
        position: 'absolute',
        top: 4,
        right: 'calc(50% - 14px)', // offset right of the centered emoji
        width: size,
        height: size,
        borderRadius: '50%',
        backgroundColor: color,
        opacity: showDot ? 1 : 0,
        transition: 'opacity 300ms ease-out',
        pointerEvents: 'none',
      }}
    />
  )
}
