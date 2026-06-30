import React from 'react'
import { Link } from 'react-router-dom'
import { useCritterCollection } from '../../hooks/useCritterCollection.js'
import { P } from '../../lib/constants.js'

// Garden visitors — Slice 8 DrG ambient reward presence (Reward-UX V101): a single quiet line +
// link to the collection. NO count badge, NO streak, NO shame, NO interrupt. Present-when-present:
// renders NOTHING when the collection is empty (an empty "0 visitors" line reads as a pressure cue).
export default function GardenVisitors() {
  const { collected, loading } = useCritterCollection()
  if (loading) return null
  const n = collected && typeof collected.size === 'number' ? collected.size : 0
  if (n === 0) return null
  return (
    <section aria-label="Garden visitors" style={{ marginTop: 18 }}>
      <Link to="/collection" style={{
        display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none',
        color: P.green, fontSize: '0.85rem', fontWeight: 600,
        background: P.greenPale, border: '1px solid ' + P.greenLight, borderRadius: 12, padding: '10px 14px',
      }}>
        <span style={{ flex: 1 }}>Garden visitors — {n} spotted</span>
        <span aria-hidden="true">View collection ›</span>
      </Link>
    </section>
  )
}
