// V4-CRITTERSORT-001 (partial) — pure, dependency-free sort for the Critter Collection page.
// Frontend-only: reorders a group's roster entries for display. The dex code stays bound to each
// critter's canonical roster position (computed BEFORE sorting, keyed by id) so codes never move.
//
// Modes:
//   'dex'    — canonical roster order (identity; the default, no reordering).
//   'alpha'  — by name, case-insensitive, locale-aware.
//   'recent' — most-recently first-seen first; unseen critters sink to the end keeping dex order.
//
// The 'by type' mode (bird/reptile/etc — the ledger's must-have) is intentionally NOT here: it
// needs a taxonomic `type` field on the roster (168 critters) that doesn't exist yet. Deferred.
export const CRITTER_SORT_MODES = ['dex', 'alpha', 'recent']

export const CRITTER_SORT_LABELS = {
  dex: 'Dex order',
  alpha: 'A – Z',
  recent: 'Recently seen',
}

// firstSeen(collected, id) -> epoch ms of first sighting, or null if not collected / no date.
function firstSeenMs(collected, id) {
  const entry = collected && typeof collected.get === 'function' ? collected.get(id) : null
  const iso = entry?.firstSeenAt
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t : null
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
  // 'dex' (and any unknown mode) — canonical order, unchanged.
  return list
}
