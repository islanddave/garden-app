// CritterArrivalController — global manager for Stage 1 flash (Phase B++ redesign 2026-05-30).
// Mounted ONCE at App.jsx level, fires regardless of which route the user is on.
//
// Replaces the Dashboard-only stage1Critter backfill effect.
//
// Behavior:
// - On mount + on every location change, fetch /api/critters/active
// - Filter for critters earned within the fresh window, not viewed,
//   not already shown this session (sessionStorage de-dup key gardenApp.stage1ShownIds).
//   V101 (2026-06-01): baseline residents RETIRED — robin/honeybee (1,2) now animate like
//   any earned critter (removed the species_id<=2 exclusion).
// - Pick the freshest qualifying critter; render <CritterArrival> with it
// - When the animation finishes (~3s), clear local state; sessionStorage records the id
//   so it doesn't re-fire on the next location change
//
// Fire-and-forget — silent no-op when VITE_API_CRITTERS unset or getToken returns null.

import React, { useEffect, useRef, useState } from 'react'
import { useOverlayLocation, useOpenOverlayPath } from '../context/OverlayContext.jsx'
import { useApiFetch } from '../lib/api.js'
import { fetchActiveCritters } from '../lib/critterClient.js'
import CritterArrival from './CritterArrival.jsx'

const FRESH_WINDOW_MS = 5 * 60 * 1000  // 5 minutes — accommodate nav delay + auth hydration + cold-start (Dave smoke surfaced 30s was too tight)
const SHOWN_KEY = 'gardenApp.stage1ShownIds'
const SHOWN_CAP = 50

export default function CritterArrivalController() {
  const { getToken } = useApiFetch()
  const location = useOverlayLocation()
  const [arrivingCritter, setArrivingCritter] = useState(null)
  // V4-OVERLAY-001 Slice 2 (§7): a reward must NEVER pop over an open capture form. While a /log or
  // /log/many overlay is open, a fresh critter is suppressed-and-queued (never dropped — dropping is
  // its own dopamine-loop defect) and flushed on dismiss. Mirrors LogMany's "wake the controller
  // AFTER the result screen" precedent: rewards fire on completion, never initiation.
  const openOverlayPath = useOpenOverlayPath()
  const formOverlayOpen = openOverlayPath === '/log' || openOverlayPath === '/log/many'
  const queuedRef = useRef(null)

  // Flush a queued critter once the form overlay closes.
  useEffect(() => {
    if (!formOverlayOpen && queuedRef.current) {
      setArrivingCritter(queuedRef.current)
      queuedRef.current = null
    }
  }, [formOverlayOpen])

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
          if (!Number.isInteger(c.species_id)) return false
          if (c.viewed_at) return false
          if (shown.includes(c.id)) return false
          const t = c.earned_at ? Date.parse(c.earned_at) : NaN
          return Number.isFinite(t) && t >= cutoff
        })
        if (candidates.length === 0) return
        candidates.sort((a, b) => Date.parse(b.earned_at) - Date.parse(a.earned_at))
        const fresh = candidates[0]
        if (!on) return
        // Suppress-and-queue while a capture form overlay is open; else present immediately.
        if (formOverlayOpen) queuedRef.current = fresh
        else setArrivingCritter(fresh)
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
  }, [getToken, location.pathname, location.state, formOverlayOpen])

  return <CritterArrival critter={arrivingCritter} onDone={() => setArrivingCritter(null)} />
}
