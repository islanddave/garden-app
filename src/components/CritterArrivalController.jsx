// CritterArrivalController — global manager for Stage 1 flash (Phase B++ redesign 2026-05-30).
// Mounted ONCE at App.jsx level, fires regardless of which route the user is on.
//
// Replaces the Dashboard-only stage1Critter backfill effect.
//
// Behavior:
// - On mount + on every location change, fetch /api/critters/active
// - Filter for non-baseline (species_id > 2) critters earned within last 30s, not viewed,
//   not already shown this session (sessionStorage de-dup key gardenApp.stage1ShownIds)
// - Pick the freshest qualifying critter; render <CritterArrival> with it
// - When the animation finishes (~3s), clear local state; sessionStorage records the id
//   so it doesn't re-fire on the next location change
//
// Fire-and-forget — silent no-op when VITE_API_CRITTERS unset or getToken returns null.

import React, { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { fetchActiveCritters } from '../lib/critterClient.js'
import CritterArrival from './CritterArrival.jsx'

const FRESH_WINDOW_MS = 5 * 60 * 1000  // 5 minutes — accommodate nav delay + auth hydration + cold-start (Dave smoke surfaced 30s was too tight)
const SHOWN_KEY = 'gardenApp.stage1ShownIds'
const SHOWN_CAP = 50

export default function CritterArrivalController() {
  const { getToken } = useApiFetch()
  const location = useLocation()
  const [arrivingCritter, setArrivingCritter] = useState(null)

  useEffect(() => {
    let on = true
    async function poll() {
      try {
        const list = await fetchActiveCritters({ getToken })
        if (!on || !Array.isArray(list) || list.length === 0) return
        const cutoff = Date.now() - FRESH_WINDOW_MS
        // Read shown-ids from sessionStorage.
        let shown = []
        try { shown = JSON.parse(sessionStorage.getItem(SHOWN_KEY) ?? '[]') } catch { shown = [] }
        const candidates = list.filter(c => {
          if (!Number.isInteger(c.species_id) || c.species_id <= 2) return false
          if (c.viewed_at) return false
          if (shown.includes(c.id)) return false
          const t = c.earned_at ? Date.parse(c.earned_at) : NaN
          return Number.isFinite(t) && t >= cutoff
        })
        if (candidates.length === 0) return
        candidates.sort((a, b) => Date.parse(b.earned_at) - Date.parse(a.earned_at))
        const fresh = candidates[0]
        if (!on) return
        setArrivingCritter(fresh)
        // Record immediately (don't wait for animation done) to avoid duplicate fires.
        try {
          shown.push(fresh.id)
          if (shown.length > SHOWN_CAP) shown = shown.slice(-SHOWN_CAP)
          sessionStorage.setItem(SHOWN_KEY, JSON.stringify(shown))
        } catch { /* sessionStorage unavailable */ }
      } catch {
        // Silent — never crash the app on critter polling failure.
      }
    }
    poll()
    return () => { on = false }
  }, [getToken, location.pathname, location.state])

  return <CritterArrival critter={arrivingCritter} onDone={() => setArrivingCritter(null)} />
}
