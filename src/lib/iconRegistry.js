// src/lib/iconRegistry.js — DESIGNSYS Pass A shared icon registry.
// Lifts the status glyph map out of PlantStatusBadge into one place so future facet
// surfaces (TAGSUB) reuse the same glyph vocabulary. Each entry carries an
// accessibleName for AT (the rendered glyph itself stays aria-hidden; consumers own
// the aria-label/title wiring). Facet glyphs are placeholders — unused until TAGSUB.
//
// status glyphs are COPIED VERBATIM from the prior PlantStatusBadge STATUS_ICONS map
// (parity-preserving — visual output unchanged).
export const ICONS = {
  status: {
    seed:       { glyph: '🌰', accessibleName: 'Seed' },
    rooting:    { glyph: '🫚', accessibleName: 'Rooting' },
    seedling:   { glyph: '🌱', accessibleName: 'Seedling' },
    sprouting:  { glyph: '🌱', accessibleName: 'Sprouting' },
    seeding:    { glyph: '🌱', accessibleName: 'Seeding' },
    vegetative: { glyph: '🌿', accessibleName: 'Vegetative' },
    growing:    { glyph: '🌿', accessibleName: 'Growing' },
    active:     { glyph: '🌿', accessibleName: 'Active' },
    flowering:  { glyph: '🌸', accessibleName: 'Flowering' },
    fruiting:   { glyph: '🍅', accessibleName: 'Fruiting' },
    harvesting: { glyph: '🧺', accessibleName: 'Harvesting' },
    harvested:  { glyph: '✅', accessibleName: 'Harvested' },
    dormant:    { glyph: '💤', accessibleName: 'Dormant' },
    planning:   { glyph: '📋', accessibleName: 'Planning' },
    ended:      { glyph: '⏹️', accessibleName: 'Ended' },
    failed:     { glyph: '✕', accessibleName: 'Failed' },
    dead:       { glyph: '✕', accessibleName: 'Dead' },
  },
  // Facet glyphs — placeholders, unused until TAGSUB. lifecycle reuses getStatusColors
  // + status glyphs above; its registry entry here is a generic stand-in.
  facet: {
    type:      { glyph: '🏷️', accessibleName: 'Type' },
    group:     { glyph: '📦', accessibleName: 'Group' },
    lifecycle: { glyph: '🌿', accessibleName: 'Lifecycle' },
    location:  { glyph: '📍', accessibleName: 'Location' },
    freeform:  { glyph: '🔖', accessibleName: 'Tag' },
  },
}

// Neutral fallback dot — matches the prior PlantStatusBadge default ('•'). Never throws.
const NEUTRAL_DOT = '•'

export function statusGlyph(status) {
  return ICONS.status[status]?.glyph ?? NEUTRAL_DOT
}
