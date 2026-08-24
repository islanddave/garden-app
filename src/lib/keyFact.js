// src/lib/keyFact.js — V200 Slice 5b. Pure, dependency-free helpers for the planting
// photo-hero overlay. Two exports:
//   selectKeyFact(planting)  -> a single short "key fact" string for the gold hero pill,
//                               or null (the pill is then NOT rendered — graceful reflow).
//   formatBotanical(varietyRef) -> { text, italic } | null for the Basics-tab botanical row.
// Both read JSON fields defensively (optional-chaining + type guards): the cultivar substrate
// is sparse and heterogeneous, so any missing/garbage field must degrade to "skip", never throw.
//
// "dependency-free" above is now one import short of literal: V4-CONSUMABLECLASS-001 (BD-042) added
// lib/harvestTracked.js, which is itself pure, constant-only and imports nothing. The property that
// mattered — no React, no network, no clock, unit-testable in isolation — is intact.
import { plantingIsHarvestTracked } from './harvestTracked.js'

// Lower-cased crop-family signal used by both the key-fact cascade and the no-photo fallback
// glyph picker. Pulls from variety type/group + the planting's own name as a last resort.
function cropSignal(planting) {
  const v = planting?.variety_ref || {}
  const parts = [
    v.type, v.group, v.category, v.crop, v.crop_family,
    v.name, planting?.name,
  ].filter(s => typeof s === 'string')
  return parts.join(' ').toLowerCase()
}

export function isPepper(planting) {
  const v = planting?.variety_ref || {}
  if (typeof v.type === 'string' && v.type.toLowerCase().includes('pepper')) return true
  if (typeof v.group === 'string' && v.group.toLowerCase().includes('pepper')) return true
  return /\bpepper|chil[ei]|jalape|habanero|serrano|cayenne\b/.test(cropSignal(planting))
}

export function isTomato(planting) {
  const v = planting?.variety_ref || {}
  if (typeof v.type === 'string' && v.type.toLowerCase().includes('tomato')) return true
  if (typeof v.group === 'string' && v.group.toLowerCase().includes('tomato')) return true
  return /\btomato|tomatillo\b/.test(cropSignal(planting))
}

// Crop-family bucket for the no-photo placeholder glyph (§2): 'fruit' for fruiting crops,
// 'bloom' for flowers, else 'sprout'. Lower-cased substring match, defensive.
export function cropFamilyGlyph(planting) {
  const sig = cropSignal(planting)
  if (/\bpepper|chil[ei]|jalape|tomato|strawberr|fruit|berry|squash|cucumber|melon|eggplant|tomatillo\b/.test(sig)) {
    return 'lifecycle.fruit'
  }
  if (/\bflower|bloom|marigold|zinnia|sunflower|dahlia|cosmos|petunia|nasturtium|pansy|aster\b/.test(sig)) {
    return 'lifecycle.bloom'
  }
  return 'lifecycle.sprout'
}

// V4-ABOVEFOLD-001 — a short crop-TYPE label for the hero (surfaced above the fold, distinct
// from the key-fact pill which carries a per-crop attribute like SHU/DTM). Pure + fetch-free:
// prefers an explicit structured crop field on the cultivar, then falls back to the pepper/tomato
// family detectors, then null (the chip is simply omitted). Title-cased for display; long values
// are clamped so the pill stays compact.
export function selectCropType(planting) {
  const v = planting?.variety_ref || {}
  const explicit = [v.type, v.group, v.category, v.crop, v.crop_family]
    .find(s => typeof s === 'string' && s.trim())
  if (explicit) {
    const t = explicit.trim().replace(/[_-]+/g, ' ')
    const titled = t.charAt(0).toUpperCase() + t.slice(1)
    return titled.length > 22 ? titled.slice(0, 21).trimEnd() + '…' : titled
  }
  if (isPepper(planting)) return 'Pepper'
  if (isTomato(planting)) return 'Tomato'
  return null
}

// Read a field that may live on the variety, on planting.metadata, or on an attr_override.
function attr(planting, key) {
  const v = planting?.variety_ref || {}
  const md = planting?.metadata || {}
  const ov = planting?.attr_override || {}
  // attr_override wins (explicit per-planting), then metadata, then the cultivar default.
  return ov[key] ?? md[key] ?? v[key] ?? null
}

// selectKeyFact — priority cascade, FIRST non-null wins. Returns a short display string or null.
//   (1) pepper -> "{N} SHU"   (when an SHU value is available)
//   (2) tomato -> "Determinate" / "Indeterminate"   (growth_habit)
//   (3) DTM    -> "{min}–{max} days"
//   (4) sun    -> short sun requirement
//   (5) null
export function selectKeyFact(planting) {
  if (!planting) return null

  // (1) Pepper heat.
  if (isPepper(planting)) {
    const shuRaw = attr(planting, 'shu') ?? attr(planting, 'scoville')
    const shu = Number(shuRaw)
    if (Number.isFinite(shu) && shu > 0) {
      return `${shu.toLocaleString('en-US')} SHU`
    }
  }

  // (2) Tomato determinacy.
  if (isTomato(planting)) {
    const gh = attr(planting, 'growth_habit')
    if (typeof gh === 'string' && gh.trim()) {
      const g = gh.trim().toLowerCase()
      if (g.startsWith('indeterm')) return 'Indeterminate'
      if (g.startsWith('determ')) return 'Determinate'
      // Unknown habit string: surface a capitalized form rather than dropping it.
      return gh.trim().charAt(0).toUpperCase() + gh.trim().slice(1)
    }
  }

  // (3) Days to maturity window.
  //
  // V4-CONSUMABLECLASS-001 (BD-042) — skipped for a not-harvest-tracked crop. "75–95 days" next to
  // a violet is the same claim as the "Est. harvest" window plantingMaturity.js now suppresses,
  // just in a shorter sentence: days-to-MATURITY is a harvest figure, and the pill sits on a hero
  // photo where it reads as one. This is a SKIP, not a blank — the chain falls through to sun
  // requirement, which is the genuinely useful key fact for an ornamental. That fall-through is why
  // the gate is here rather than at the render site.
  const v = planting?.variety_ref || {}
  const dmin = Number.isFinite(v.days_to_maturity_min) ? v.days_to_maturity_min : null
  const dmax = Number.isFinite(v.days_to_maturity_max) ? v.days_to_maturity_max : null
  if (plantingIsHarvestTracked(planting) && (dmin != null || dmax != null)) {
    if (dmin != null && dmax != null && dmin !== dmax) return `${dmin}–${dmax} days`
    return `${dmin ?? dmax} days`
  }

  // (4) Sun requirement (short).
  const sun = v.sun_requirements
  if (typeof sun === 'string' && sun.trim()) {
    // Keep it pill-short: take the first clause / few words.
    const short = sun.trim().split(/[,;(]/)[0].trim()
    return short.length > 18 ? short.slice(0, 17).trimEnd() + '…' : short
  }

  // (5) Nothing worth a pill.
  return null
}

// formatBotanical — render the cultivar's Latin name. Returns null (omit the row) when neither
// genus nor species is present. { text, italic } — when only a bare species is known we italicize
// the whole thing; with a genus we render "Genus species" (genus capitalized, species lower-cased).
export function formatBotanical(varietyRef) {
  const v = varietyRef || {}
  const rawGenus = typeof v.genus === 'string' ? v.genus.trim() : ''
  let rawSpecies = typeof v.species === 'string' ? v.species.trim() : ''
  // Some records pack "Genus species" into the single `species` field with no `genus`.
  let genus = rawGenus
  let species = rawSpecies
  if (!genus && species.includes(' ')) {
    const [g, ...rest] = species.split(/\s+/)
    genus = g
    species = rest.join(' ')
  }
  const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '')
  if (genus && species) return { text: `${cap(genus)} ${species.toLowerCase()}`, italic: true }
  if (genus) return { text: cap(genus), italic: true }
  if (species) return { text: species, italic: true }
  return null
}
