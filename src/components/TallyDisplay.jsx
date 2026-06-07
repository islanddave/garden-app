import React, { useState, useEffect, useRef } from 'react'
import { useAuth } from '@clerk/react'
import { P } from '../lib/constants.js'
import { getTally, TALLY_SIGHTINGS } from '../lib/sharedStateClient.js'

// V3-DELIGHT-001 D2 — ambient shared "sighting tally" on the Collection header.
// Reward-UX (V102, BINDING): ambient presence ONLY — no interrupt/modal/toast/badge/sound/
// haptic/tap-to-claim, and NO animated count-up overlay (a plain rendered number only).
// de-FOMO: a quiet household stat, never a goal/deficit/"waiting" frame. Household-coherent:
// one shared counter (TALLY_SIGHTINGS), incremented server-side exactly once per genuine
// critter award (lambda/events/critterAward.js → awardCritterServer). Degrades to null on any
// no-op / error / malformed payload; never blocks the Collection page.

export default function TallyDisplay() {
  const { getToken } = useAuth()
  const [count, setCount] = useState(null)
  const ranRef = useRef(false)

  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true
    let alive = true
    ;(async () => {
      const res = await getTally({ getToken, key: TALLY_SIGHTINGS })
      if (!alive || !res) return                    // null result (env unset / error) -> render nothing
      const n = res.counter
      if (Number.isFinite(n) && n >= 0) setCount(n)  // absent/malformed counter -> stay null, render nothing
    })()
    return () => { alive = false }
  }, [getToken])

  if (count === null) return null
  const noun = count === 1 ? 'visit' : 'visits'

  return (
    <section aria-label="Garden sighting tally" style={{
      display: 'flex', alignItems: 'baseline', gap: 10,
      background: P.white, border: `0.5px solid ${P.border}`, borderRadius: 14,
      padding: '10px 16px', marginBottom: 16, boxShadow: '0 1px 2px rgba(26,26,26,0.05)',
    }}>
      <span style={{
        fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase',
        color: P.gold, flexShrink: 0,
      }}>Garden sightings</span>
      <span style={{ marginLeft: 'auto', fontSize: '0.9rem', color: P.mid, fontWeight: 500, textAlign: 'right' }}>
        <strong style={{ color: P.dark, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
          {count.toLocaleString()}
        </strong>{' '}
        {`${noun} logged across the garden`}
      </span>
    </section>
  )
}
