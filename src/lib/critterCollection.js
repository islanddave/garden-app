// Bridge between MVP-Critter SPECIES_POOL and the 168-entry critters-roster.json.
// Phase 2 wiring (Stickerbook): translate per-user backend rows into roster lookups.
// Pure, no side effects. Frozen exports. Tested via src/__tests__/critterCollection.test.js.
//
// Why this bridge exists:
//   SPECIES_POOL entries carry sprite_filename like 'C013-american-robin.svg'.
//   critters-roster.json entries are keyed by id like 'C013'.
//   The naming is intentionally aligned (one source of truth, no duplication) but the
//   page renders from the roster while the backend writes/reads species_id. This module
//   maps the two so Collection.jsx can look up "is roster entry C013 collected?" without
//   knowing about species_id internally.

import { SPECIES_POOL } from './critterSpecies.js'

// Pure string transform: sprite_filename → roster id.
// Returns null when input is not a non-empty string or doesn't match 'C{NNN}-...' shape.
export function rosterIdFromSpriteFilename(filename) {
  if (typeof filename !== 'string' || filename.length === 0) return null
  const m = filename.match(/^(C\d+)-/)
  return m ? m[1] : null
}

// Pre-computed: species_id (int) → roster id (string). Frozen at module load.
// Baseline residents (species_id 1, 2) are present here — their roster entries WILL render
// as "collected" if the user has rows for them (which they typically don't, since baseline
// residents are client-side ambient + never persisted per revision §3.14). Future-proof:
// if Stage 5 ever persists baselines, the bridge already handles them.
export const ROSTER_ID_BY_SPECIES_ID = Object.freeze(
  Object.fromEntries(
    SPECIES_POOL.map(s => [s.species_id, rosterIdFromSpriteFilename(s.sprite_filename)])
  )
)

// Normalize a /api/critters/collection response array into a Map keyed by roster id.
// Input rows: [{species_id, count, first_seen_at, last_seen_at}, ...]
// Output: Map<rosterId, {speciesId, count, firstSeenAt, lastSeenAt}>
//
// Rows whose species_id is not in SPECIES_POOL are dropped silently. Forward-compat:
// if a future critter Lambda emits species_id outside the current pool (e.g., V3 expansion
// before the frontend pool catches up), the page degrades gracefully rather than crashing
// on an undefined roster lookup.
export function indexCollectionRows(rows) {
  const out = new Map()
  if (!Array.isArray(rows)) return out
  for (const r of rows) {
    const rid = ROSTER_ID_BY_SPECIES_ID[r?.species_id]
    if (!rid) continue
    out.set(rid, {
      speciesId: r.species_id,
      count: Number.isFinite(r.count) ? r.count : 0,
      firstSeenAt: r.first_seen_at ?? null,
      lastSeenAt: r.last_seen_at ?? null,
    })
  }
  return out
}
