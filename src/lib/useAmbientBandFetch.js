// src/lib/useAmbientBandFetch.js
// BUG-READYBANDFETCH-001 — the three ambient Today bands (harvest-ready, harvest-watch, put-up
// use-soon) each carried a byte-identical load block whose .catch() swallowed the error and left
// state at null. Every one of them renders nothing when state is null, so a FAILED fetch rendered
// IDENTICALLY to an EMPTY queue: the band whose whole job is to say "there is nothing to pick" said
// exactly the same thing when it had never managed to ask.
//
// The swallow itself is correct and STAYS. Reward-UX V102 forbids a toast/modal/sheet/banner on these
// surfaces and a supplementary glance must never throw onto Today. What changes is that failure is
// now DISTINGUISHABLE from emptiness, so a caller can render an ambient muted line instead of
// silently rendering nothing. Nothing here surfaces an error object, a status code, or a stack.
//
// ONE transient retry before failure is declared. A single dropped request on a phone waking from
// sleep is the common case and must not put a "couldn't check" line on Today; only a second
// consecutive failure is reported. `inflight` deliberately stays held across the retry gap so a
// focus/visibilitychange event mid-retry does not start a competing chain.
//
// A refresh that fails while data is ALREADY held keeps the stale data — setData is never called on
// the error path. That was already correct before this fix and is preserved on purpose: stale rows
// beat blank rows for a glance surface, and `failed` alone tells the caller which it is holding.
import { useState, useEffect, useCallback, useRef } from 'react'
import { useOverlayLocation } from '../context/OverlayContext.jsx'
import { useApiFetch } from './api.js'

export const RETRY_DELAY_MS = 1500

// `normalize` maps the raw response to band state and MUST be total — it is called inside the
// success path, so a throw there lands in the same .catch() and would be miscounted as a fetch
// failure. Held in a ref so an inline arrow at the call site cannot destabilise `load` and put the
// mount effect into a refetch loop.
export function useAmbientBandFetch(path, normalize) {
  const { fetch } = useApiFetch()
  const location = useOverlayLocation()
  const [data, setData] = useState(null)
  const [failed, setFailed] = useState(false)
  const inflight = useRef(false)
  const timer = useRef(null)
  const alive = useRef(true)
  const normRef = useRef(normalize)
  normRef.current = normalize

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; if (timer.current) clearTimeout(timer.current) }
  }, [])

  const load = useCallback(() => {
    if (inflight.current) return
    inflight.current = true
    let retried = false
    const settle = () => { inflight.current = false }
    const attempt = () => {
      fetch(path)
        .then(d => {
          if (alive.current) { setData(normRef.current(d)); setFailed(false) }
          settle()
        })
        .catch(() => {
          if (!alive.current) { settle(); return }
          if (!retried) {
            retried = true
            timer.current = setTimeout(() => {
              timer.current = null
              if (alive.current) attempt(); else settle()
            }, RETRY_DELAY_MS)
            return // lock deliberately HELD across the gap: a focus event mid-retry must not race
          }
          setFailed(true)
          settle()
        })
    }
    attempt()
  }, [fetch, path])

  useEffect(() => { load() }, [load, location.pathname])

  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') load() }
    window.addEventListener('focus', load)
    document.addEventListener('visibilitychange', onVis)
    return () => { window.removeEventListener('focus', load); document.removeEventListener('visibilitychange', onVis) }
  }, [load])

  return { data, failed, reload: load }
}
