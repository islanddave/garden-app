// V4-CRITTERSORT-001 — pure, dependency-free sort for the Critter Collection page.
// Frontend-only: reorders a group's roster entries for display. The dex code stays bound to each
// critter's canonical roster position (computed BEFORE sorting, keyed by id) so codes never move.
//
// Modes:
//   'dex'    — canonical roster order (identity; the default, no reordering).
//   'alpha'  — by name, case-insensitive, locale-aware.
//   'recent' — most-recently first-seen first; unseen critters sink to the end keeping dex order.
//   'type'   — cluster by taxonomic type (bird/mammal/insect/…) in CRITTER_TYPE_ORDER rank, then
//              canonical dex order within a type. Reorder only (no sub-headers); a critter with a
//              missing/unknown type sinks to the end in dex order and never throws.
export const CRITTER_SORT_MODES = ['dex', 'alpha', 'recent', 'type']

export const CRITTER_SORT_LABELS = {
  dex: 'Dex order',
  alpha: 'A – Z',
  recent: 'Recently seen',
  type: 'By type',
}

// Frozen display rank for the 'type' clustering (curated field-guide order: the two dominant
// buckets lead, the novelty bucket lands last). Any type slug NOT in this list — or a missing
// type — ranks last (dex-ordered). Keep in sync with the `type` field on critters-roster.json.
export const CRITTER_TYPE_ORDER = ['bird', 'mammal', 'insect', 'amphibian', 'reptile', 'fish', 'invertebrate', 'cryptid']

// Human labels for each type slug (not rendered in the pure-cluster mode; the canonical vocabulary
// of record for the deferred type-header / dex-pill-hint follow-up).
export const CRITTER_TYPE_LABELS = {
  bird: 'Birds',
  mammal: 'Mammals',
  insect: 'Insects',
  amphibian: 'Amphibians',
  reptile: 'Reptiles',
  fish: 'Fish',
  invertebrate: 'Invertebrates',
  cryptid: 'Cryptids',
}

// firstSeen(collected, id) -> epoch ms of first sighting, or null if not collected / no date.
function firstSeenMs(collected, id) {
  const entry = collected && typeof collected.get === 'function' ? collected.get(id) : null
  const iso = entry?.firstSeenAt
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t : null
}

// typeRank(entry) -> index into CRITTER_TYPE_ORDER, or Infinity for a missing/unknown type
// (which sinks to the end). Never throws on a malformed entry.
function typeRank(entry) {
  const t = entry && typeof entry.type === 'string' ? entry.type : ''
  if (!t) return Infinity
  const i = CRITTER_TYPE_ORDER.indexOf(t)
  return i === -1 ? Infinity : i
}

// Return a NEW array of entries in the requested display order. Stable: ties keep input order
// (which is canonical dex order), so the result is deterministic. Never mutates the input.
export function sortCritters(entries, mode, collected) {
  const list = Array.isArray(entries) ? entries.slice() : []
  if (mode === 'alpha') {
    return list
      .map((c, i) => [c, i])
      .sort((a, b) => {
        const cmp = String(a[0]?.name || '').localeCompare(String(b[0]?.name || ''), undefined, { sensitivity: 'base' })
        return cmp !== 0 ? cmp : a[1] - b[1]
      })
      .map(([c]) => c)
  }
  if (mode === 'recent') {
    return list
      .map((c, i) => [c, i])
      .sort((a, b) => {
        const ta = firstSeenMs(collected, a[0]?.id)
        const tb = firstSeenMs(collected, b[0]?.id)
        // Seen-before-unseen; among seen, newest first; ties + both-unseen keep dex order.
        if (ta == null && tb == null) return a[1] - b[1]
        if (ta == null) return 1
        if (tb == null) return -1
        return tb - ta || a[1] - b[1]
      })
      .map(([c]) => c)
  }
  if (mode === 'type') {
    return list
      .map((c, i) => [c, i])
      .sort((a, b) => {
        const ra = typeRank(a[0]), rb = typeRank(b[0])
        // The ra !== rb guard is load-bearing: both-unknown gives Infinity===Infinity, routed to the
        // dex-order (index) tie-break — never Infinity - Infinity = NaN, which would corrupt the sort.
        return ra !== rb ? ra - rb : a[1] - b[1]
      })
      .map(([c]) => c)
  }
  // 'dex' (and any unknown mode) — canonical order, unchanged.
  return list
}
