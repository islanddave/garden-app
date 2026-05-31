import React from 'react'
import roster from '../data/critters-roster.json'
import { P } from '../lib/constants.js'
import { useCritterCollection } from '../hooks/useCritterCollection.js'

// Critter Collection — Pokédex-style preview dex.
// Spec: critter-collection-page-spec-V001-20260522 (Phase 1 — frontend-only silhouettes).
// Phase 2 wiring (Stickerbook, laughing-sleepy-gauss followup 2026-05-31):
//   - useCritterCollection() fetches per-user lifetime species summary from /api/critters/collection.
//   - isCollected(rosterEntry) returns true if the entry's roster id is in `collected` Map.
//   - Per-collected card surfaces "{N} sighting(s) · first {date}" caption.
//   - Header counter reflects real discovered / total.
//   - Loading: header reads "Loading…"; cards render as silhouettes (renderable, non-blocking).
//   - Error: subtle inline message under header; cards still render as silhouettes.
//
// Reward UX V100 conformance (still binding):
//   - Ambient passive page — no modal/toast/push/sound/haptic, no tap-to-claim.
//   - No streaks, badges, points, progress bars (reflection-only per V100 milestone separation).
//   - Per-user scope (NOT household) per Dave 2026-05-31 ("stickerbook is per person").
//   - Friendly group labels only (Jen-invisible: no tier-system jargon).
//
// Roster scope: 168 entries (144 wild + 13 legacy + 11 cryptid). The 6 Special-tier
// critters are personal/user-keyed by design and intentionally excluded from this public
// dex until the keyed-visibility mechanism exists (Phase 3).
//
// MVP awardable pool: only species_ids 3-8 (6 species) are currently in the earned pool
// per critterSpecies.js. The page intentionally shows all 168 with "the rest are out there
// waiting to be found" framing per spec V001 — V3/V4 expansion will grow the earnable subset.

const GROUP_ORDER = ['wild', 'legacy', 'cryptid']
const GROUP_LABEL = { wild: 'Around the garden', legacy: 'Legacy', cryptid: 'Curiosities' }

function formatFirstSeen(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  } catch { return '' }
}

function formatSightingCount(n) {
  if (!Number.isFinite(n) || n <= 0) return ''
  return n === 1 ? '1 sighting' : `${n} sightings`
}

export default function Collection() {
  const { collected, loading, error } = useCritterCollection()

  const byGroup = {}
  for (const c of roster) {
    const g = c.group || 'wild'
    if (!byGroup[g]) byGroup[g] = []
    byGroup[g].push(c)
  }
  const groups = GROUP_ORDER.filter(g => byGroup[g] && byGroup[g].length)
  const total = roster.length
  const discovered = roster.filter(c => collected.has(c.id)).length

  const headerCount = loading
    ? 'Loading…'
    : `${discovered} of ${total} discovered — the rest are out there waiting to be found.`

  return (
    <div style={{ padding: '20px 16px 32px', maxWidth: 820, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.4rem', color: P.dark, margin: '0 0 4px' }}>Critter Collection</h1>
      <p style={{ color: P.light, fontSize: '0.9rem', margin: '0 0 4px' }}>
        {headerCount}
      </p>
      {error && !loading && (
        <p style={{ color: P.terra, fontSize: '0.78rem', margin: '0 0 16px' }} role="status">
          {error}
        </p>
      )}
      {!error && <div style={{ height: 16 }} />}

      {groups.map(group => (
        <section key={group} style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: '0.95rem', color: P.dark, fontWeight: 700, margin: '0 0 10px' }}>
            {GROUP_LABEL[group] || group}{' '}
            <span style={{ color: P.light, fontWeight: 400, fontSize: '0.82rem' }}>({byGroup[group].length})</span>
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: 12 }}>
            {byGroup[group].map(c => {
              const entry = collected.get(c.id)
              const got = !!entry
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
                  {got && (
                    <span
                      data-testid={`sighting-caption-${c.id}`}
                      style={{ marginTop: 2, fontSize: '0.66rem', textAlign: 'center', color: P.light, lineHeight: 1.2 }}
                    >
                      {[formatSightingCount(entry.count), entry.firstSeenAt ? `first ${formatFirstSeen(entry.firstSeenAt)}` : '']
                        .filter(Boolean).join(' · ')}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
