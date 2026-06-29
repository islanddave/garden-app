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

// ─────────────────────────────────────────────────────────────────────────────
// V4-ICON-001 (DESIGNSYS Pass B V101) — additive go-forward registry.
// The legacy ICONS/statusGlyph above are UNTOUCHED (PlantStatusBadge + contract
// test still read them). GLYPHS is the V101-schema registry the custom-SVG era
// migrates into; consumers are NOT yet routed here (inert until per-glyph swaps).
// Entry shape (§13 additive superset): { key, glyph (legacy/null), svg24, svg18,
// class:'mono'|'color-candidate', register:'functional'|'illustrated', variant,
// accessibleName (string | per-state map), schemaVersion, variants? }. isSvg is
// DERIVED (Boolean(svg24 && svg18)) — never hand-stored (removes a drift vector).
import ANCHORS from './iconAnchors.js'
import { STATUS_GLYPHS } from './iconStatus.js'
import { EVENT_GLYPHS } from './iconEvents.js'

const ANCHOR_META = {
  'nav.today':      { accessibleName: 'Today' },
  'nav.garden':     { accessibleName: 'Garden' },
  'care.drop':      { accessibleName: 'Water' },
  'facet.type':     { accessibleName: 'Type' },
  'facet.location': { accessibleName: 'Location' },
  'severity.high':  { accessibleName: 'High severity' },
  'action.heart':   { accessibleName: { outline: 'Add to favorites', filled: 'Remove from favorites' } },
  'care.pause':     { accessibleName: 'Pause' },
  'care.sun':       { accessibleName: 'Sun' },
  'lifecycle.sprout': { accessibleName: 'Sprout' },
  'lifecycle.bud':    { accessibleName: 'Bud' },
  'lifecycle.bloom':  { accessibleName: 'Bloom' },
  'lifecycle.fruit':  { accessibleName: 'Fruit' },
}

export const GLYPHS = Object.fromEntries(
  Object.entries(ANCHORS).map(([key, a]) => [key, {
    key,
    glyph: null,                 // anchors are SVG-native (no legacy emoji backing)
    svg24: a.svg24, svg18: a.svg18,
    class: a.class, register: a.register, variant: a.variant,
    variants: a.variants ?? null,
    regionIntent: a.regionIntent ?? null,
    colorFills: a.colorFills ?? null,
    accessibleName: ANCHOR_META[key]?.accessibleName ?? key,
    schemaVersion: 101,
  }])
)
Object.assign(GLYPHS, Object.fromEntries(Object.entries(STATUS_GLYPHS).map(([k,e])=>[`status.${k}`, e])))
Object.assign(GLYPHS, EVENT_GLYPHS)

// Neutral fallback — V101 successor to the statusGlyph '•' dot. Never throws.
export const NEUTRAL_ICON = {
  key: '__neutral__', glyph: '•', class: 'mono', register: 'functional', variant: 'line',
  svg24: '<circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/>',
  svg18: '<circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/>',
  accessibleName: 'Icon', schemaVersion: 101,
}

export function isSvg(entry) { return Boolean(entry && entry.svg24 && entry.svg18) }
export function getIcon(key) { return GLYPHS[key] ?? NEUTRAL_ICON }
