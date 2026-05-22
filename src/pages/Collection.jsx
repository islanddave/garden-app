import React from 'react'
import roster from '../data/critters-roster.json'
import { P } from '../lib/constants.js'

// Critter Collection — Pokédex-style preview dex (Phase 1, full roster).
// Spec: critter-collection-page-spec-V001-20260522. Full roster as a visual collection;
// collected critters render in full detail, uncollected at high-opacity silhouette
// ("you can see the shape, but haven't earned the reveal").
//
// Phase 1 is FRONTEND-ONLY: no live "collected" state yet (the critter-visit/collection
// mechanism is V2.x+ deferred). Every entry renders as an undiscovered silhouette. When
// the V2.x+ instantiation lands, swap isCollected() for a real per-user lookup and source
// canonical names/species/lore + exact sub-tiers from the critter_definitions data layer.
//
// Roster scope: 168 entries (144 wild + 13 legacy + 11 cryptid). The 6 Special-tier
// critters are personal/user-keyed by design and intentionally excluded from this public
// dex until the keyed-visibility mechanism exists (Phase 2).
//
// Reward UX V100 conformance: ambient passive page — no modal/toast/push/sound/haptic,
// no tap-to-claim. Friendly group labels only (Jen-invisible: no tier-system jargon).

const GROUP_ORDER = ['wild', 'legacy', 'cryptid']
const GROUP_LABEL = { wild: 'Around the garden', legacy: 'Legacy', cryptid: 'Curiosities' }

// Phase 1: no collected-state backend yet -> nothing is collected.
function isCollected() {
  return false
}

export default function Collection() {
  const byGroup = {}
  for (const c of roster) {
    const g = c.group || 'wild'
    if (!byGroup[g]) byGroup[g] = []
    byGroup[g].push(c)
  }
  const groups = GROUP_ORDER.filter(g => byGroup[g] && byGroup[g].length)
  const total = roster.length
  const discovered = roster.filter(isCollected).length

  return (
    <div style={{ padding: '20px 16px 32px', maxWidth: 820, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.4rem', color: P.dark, margin: '0 0 4px' }}>Critter Collection</h1>
      <p style={{ color: P.light, fontSize: '0.9rem', margin: '0 0 20px' }}>
        {discovered} of {total} discovered — the rest are out there waiting to be found.
      </p>

      {groups.map(group => (
        <section key={group} style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: '0.95rem', color: P.dark, fontWeight: 700, margin: '0 0 10px' }}>
            {GROUP_LABEL[group] || group}{' '}
            <span style={{ color: P.light, fontWeight: 400, fontSize: '0.82rem' }}>({byGroup[group].length})</span>
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: 12 }}>
            {byGroup[group].map(c => {
              const got = isCollected(c)
              return (
                <div key={c.id} style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                  padding: '10px 6px', borderRadius: 12,
                  backgroundColor: P.cream, border: `1px solid ${P.border}`,
                }}>
                  <div style={{ filter: got ? 'none' : 'brightness(0)', opacity: got ? 1 : 0.42, transition: 'opacity 200ms', width: 64, height: 64 }}>
                    <img
                      src={c.image_url}
                      alt={got ? c.name : 'Undiscovered critter'}
                      width={64} height={64} loading="lazy" draggable={false}
                      style={{ width: 64, height: 64, objectFit: 'contain', display: 'block' }}
                    />
                  </div>
                  <span style={{ marginTop: 8, fontSize: '0.76rem', textAlign: 'center', color: got ? P.dark : P.light, fontWeight: got ? 600 : 400 }}>
                    {got ? c.name : '???'}
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
