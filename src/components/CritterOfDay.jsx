import React, { useState, useEffect, useRef } from 'react'
import { useAuth } from '@clerk/react'
import roster from '../data/critters-roster.json'
import critterFacts from '../data/critter-facts.json'
import { P } from '../lib/constants.js'
import { pickCritterOfDay, todayUTCDate } from '../lib/critterOfDay.js'
import { getFeaturedOfDay, putFeaturedOfDay } from '../lib/sharedStateClient.js'

// V3-DELIGHT-001 D1 — ambient "Critter of the day" spotlight on the Collection header.
// Reward-UX (V102, BINDING): ambient presence ONLY, de-FOMO. NO interrupt/modal/toast/badge/
// sound/haptic/tap-to-claim/countdown. Discovery framing, never acquisition:
//   collected -> celebration ("You've spotted this one"); uncollected -> presence/lore
//   ("Lives in the garden") — never a "waiting"/pending/deficit frame (review L-157 fix).
// Household-coherent via the deterministic UTC-date pick; reads the shared store and PUTs the
// pick ONLY when the day is unset (protects a future themed/admin override + caps write-amp).
// Degrades to nothing (renders null) on any no-op/error; never blocks the Collection page.

const byId = new Map(roster.map(c => [c.id, c]))

// Accept a bare id string or an object carrying { id }; anything else is malformed -> null
// (treated as "no stored value" so we keep the deterministic local pick and do NOT clobber).
function resolveStored(featured) {
  if (!featured) return null
  if (typeof featured === 'string') return byId.get(featured) ?? null
  if (typeof featured === 'object' && typeof featured.id === 'string') return byId.get(featured.id) ?? null
  return null
}

function firstFact(slug) {
  const f = critterFacts?.facts?.[slug]
  if (!f) return null
  if (typeof f === 'string') return f
  if (Array.isArray(f)) return typeof f[0] === 'string' ? f[0] : (f[0]?.text ?? null)
  if (typeof f === 'object') {
    if (typeof f.fact === 'string') return f.fact
    if (typeof f.text === 'string') return f.text
    if (Array.isArray(f.facts)) return typeof f.facts[0] === 'string' ? f.facts[0] : (f.facts[0]?.text ?? null)
  }
  return null
}

export default function CritterOfDay({ collected }) {
  const { getToken } = useAuth()
  const date = todayUTCDate()
  const [critter, setCritter] = useState(() => pickCritterOfDay(roster, date))
  const ranRef = useRef(false)

  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true
    const localPick = pickCritterOfDay(roster, date)
    let alive = true
    ;(async () => {
      const res = await getFeaturedOfDay({ getToken, date })
      if (!alive || !res) return // null result (env unset / error) -> keep local pick, no PUT
      if (res.featured != null) {
        const stored = resolveStored(res.featured)
        if (stored) setCritter(stored)
        // malformed stored payload -> keep local pick, do NOT clobber a value we don't understand
        return
      }
      // featured === null -> pin today's pick (idempotent; every member computes the same id)
      if (localPick) putFeaturedOfDay({ getToken, payload: { id: localPick.id }, date })
    })()
    return () => { alive = false }
  }, [getToken, date])

  if (!critter) return null
  const got = collected instanceof Map ? collected.has(critter.id) : false
  const fact = firstFact(critter.slug)

  return (
    <section aria-label="Critter of the day" style={{
      display: 'flex', gap: 14, alignItems: 'center',
      background: P.white, border: `0.5px solid ${P.border}`, borderRadius: 14,
      padding: '14px 16px', marginBottom: 16, boxShadow: '0 1px 2px rgba(26,26,26,0.05)',
    }}>
      <div style={{
        flexShrink: 0, width: 76, height: 76, borderRadius: 12, background: P.cream,
        display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
      }}>
        <img src={critter.image_url} alt={critter.name} loading="lazy" draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'contain',
                   transform: `scale(${critter.view_scale || 1})`, transformOrigin: 'center' }} />
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase',
          color: P.gold, marginBottom: 3,
        }}>Critter of the day</div>
        <div style={{ fontSize: '1.05rem', fontWeight: 700, color: P.dark, lineHeight: 1.2,
                      letterSpacing: '-0.01em' }}>{critter.name}</div>
        {fact && (
          <p style={{ margin: '4px 0 0', fontSize: '0.84rem', color: P.mid, lineHeight: 1.4,
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {fact}
          </p>
        )}
        <div style={{ marginTop: 5, fontSize: '0.74rem', fontWeight: 600, color: got ? P.gold : P.mid }}>
          {got ? "You've spotted this one" : 'Lives in the garden'}
        </div>
      </div>
    </section>
  )
}
