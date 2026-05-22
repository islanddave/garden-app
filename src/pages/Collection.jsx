import React from 'react'
import crittersData from '../data/critters-launch-5.json'
import CritterImage from '../components/CritterImage.jsx'
import { P } from '../lib/constants.js'

// Critter Collection — Pokédex-style preview dex (Phase 1).
// Spec: critter-collection-page-spec-V001-20260522. Full roster as a visual collection;
// collected critters render in full detail, uncollected at high-opacity silhouette
// ("you can see the shape, but haven't earned the reveal").
//
// Phase 1 is FRONTEND-ONLY: no live "collected" state source yet (the critter-visit/
// collection mechanism is deferred to V2.x+). Every entry renders as an undiscovered
// silhouette. When the V2.x+ instantiation lands, swap isCollected() to read real
// per-user collected-state; collected entries then flip to full detail.
//
// Reward UX V100 conformance: ambient passive page — no modal/toast/push/sound/haptic,
// no tap-to-claim. No tier-system jargon or debug internals surface (Jen-invisible rule):
// tiers group the grid but show as plain friendly labels, not system terminology.

const TIER_ORDER = ['common', 'uncommon', 'rare', 'extremely_rare', 'legendary', 'special', 'legacy', 'cryptid']
const TIER_LABEL = {
  common: 'Around the garden',
  uncommon: 'Less common visitors',
  rare: 'Rare finds',
  extremely_rare: 'Very rare',
  legendary: 'Legendary',
  special: 'Special',
  legacy: 'Legacy',
  cryptid: 'Curiosities',
}

// Phase 1: no collected-state backend yet -> nothing is collected.
// V2.x+ instantiation replaces this with a real per-user lookup.
function isCollected() {
  return false
}

export default function Collection() {
  const byTier = {}
  for (const c of crittersData) {
    const t = c.tier || 'common'
    if (!byTier[t]) byTier[t] = []
    byTier[t].push(c)
  }
  const tiers = TIER_ORDER.filter(t => byTier[t] && byTier[t].length)
  const total = crittersData.length
  const discovered = crittersData.filter(isCollected).length

  return (
    <div style={{ padding: '20px 16px 32px', maxWidth: 760, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.4rem', color: P.dark, margin: '0 0 4px' }}>Critter Collection</h1>
      <p style={{ color: P.light, fontSize: '0.9rem', margin: '0 0 20px' }}>
        {discovered} of {total} discovered — the rest are out there waiting to be found.
      </p>

      {tiers.map(tier => (
        <section key={tier} style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: '0.95rem', color: P.dark, fontWeight: 700, margin: '0 0 10px' }}>
            {TIER_LABEL[tier] || tier}
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 12 }}>
            {byTier[tier].map(c => {
              const got = isCollected(c)
              return (
                <div key={c.id} style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                  padding: '10px 6px', borderRadius: 12,
                  backgroundColor: P.cream, border: `1px solid ${P.border}`,
                }}>
                  <div style={{ filter: got ? 'none' : 'brightness(0)', opacity: got ? 1 : 0.42, transition: 'opacity 200ms' }}>
                    <CritterImage slug={c.slug} size={72} alt={got ? undefined : 'Undiscovered critter'} />
                  </div>
                  <span style={{ marginTop: 8, fontSize: '0.78rem', textAlign: 'center', color: got ? P.dark : P.light, fontWeight: got ? 600 : 400 }}>
                    {got ? c.common_name : '???'}
                  </span>
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
