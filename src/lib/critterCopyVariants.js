// Stage 1 inline-announcement copy variants — MVP-Critter.
// Canonical source: critter-stage1-copy-variants-V001-20260528.1530.md §2-§4.
// Spec gate: revision §3.18 (emoji aria-label override), §3.19 (drop task 5),
//            §3.20 (rewordings), §3.21 (fold opt-in copy into walkthrough).
//
// Variant pool size & order are walkthrough-stable: changing them affects what
// Jen has reacted to. Drops/adds go through the walkthrough log (jen-walkthrough-log.md).
//
// Verb discipline: ZERO references to "task", "job", "chore", "earned", "unlocked",
// "achievement", "XP", or any internal app terminology. See packet §2 verb audit.
//
// Species name interpolation: `{species}` placeholder is replaced by the species'
// `aria_announce_name` (e.g., "a blue jay", "an American robin") from critterSpecies.BY_ID.

// 10 single-action variants. The ✨ emoji is part of the VISIBLE string; the aria-label
// override strips it for screen-reader output (per revision §3.18).
export const SINGLE_VARIANTS = Object.freeze([
  '✨ {species_capitalized} heard about that — heading to your garden.',
  "✨ {species_capitalized}'s on the way to check in.",
  "✨ Word's out — a visitor wants to see what you just did.",
  '✨ {species_capitalized} picked up the scent. On its way.',
  '✨ Someone in the neighborhood heard. Heading over.',
  '✨ {species_capitalized} is curious. Coming by.',
  "✨ Word travels fast — a critter's making its way over.",
  '✨ {species_capitalized} caught wind of that. On its way.',
  "✨ Something stirred in the brush — a visitor's coming.",
  '✨ {species_capitalized} heard. Heading your way.',
])

// Burst variant — fires once on the first of a 3+ in <60s burst.
export const BURST_VARIANT =
  '✨ A few visitors heard about that — heading to your garden.'

// Present-tense variants — used when already on garden view at reveal time.
export const PRESENT_TENSE_VARIANTS = Object.freeze([
  '✨ {species_capitalized} just landed near your {plant}.',
  "✨ {species_capitalized}'s settling in by your {plant}.",
])

// resolveCopy — picks the rendered text for a given critter + species.
// mode = 'arrival' (default), 'burst', or 'present_tense'.
// variantIndex = deterministic index from critterSpecies.pickCopyVariant(seed, poolSize).
// plantName = optional plant noun for present-tense variants (e.g., "tomatoes").
//
// Returns { visible, aria }:
//   visible — string with the ✨ emoji prefix (rendered in the UI)
//   aria    — same string with emoji stripped and species capitalized for screen readers
//             (per revision §3.18 — VoiceOver should announce "A blue jay heard about that"
//              not "Sparkles A blue jay heard about that")
export function resolveCopy({ mode = 'arrival', variantIndex = 0, speciesAnnounceName = 'a critter', plantName = 'plants' } = {}) {
  // Capitalize first letter of species name (e.g. "a blue jay" → "A blue jay").
  // aria_announce_name is lower-case-leading by convention in critterSpecies.js.
  const speciesCapitalized = capitalizeFirst(speciesAnnounceName)
  let template
  if (mode === 'burst') {
    template = BURST_VARIANT
  } else if (mode === 'present_tense') {
    const idx = Math.abs(Number.isInteger(variantIndex) ? variantIndex : 0) % PRESENT_TENSE_VARIANTS.length
    template = PRESENT_TENSE_VARIANTS[idx]
  } else {
    const idx = Math.abs(Number.isInteger(variantIndex) ? variantIndex : 0) % SINGLE_VARIANTS.length
    template = SINGLE_VARIANTS[idx]
  }
  const visible = template
    .replace(/\{species_capitalized\}/g, speciesCapitalized)
    .replace(/\{plant\}/g, plantName || 'plants')
  // ARIA strip: remove the ✨ prefix + any surrounding whitespace so screen readers
  // announce just the sentence (revision §3.18).
  const aria = visible.replace(/^✨\s*/, '').trim()
  return { visible, aria }
}

function capitalizeFirst(s) {
  if (typeof s !== 'string' || s.length === 0) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}
