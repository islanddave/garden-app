// V4-RIPENESSCUES-001 — harvest COLOUR WINDOWS, resolved for a planting's variety_ref.
//
// WHY THIS EXISTS SEPARATELY FROM ripenessCues.js. That module answers "what colour is ripe" with a
// single corrective sentence, and it is SPARSE ON PURPOSE — a cultivar cue has to correct a wrong
// intuition to earn its pixels, which is asserted by name for 24 ordinary-red tomatoes in
// `ripenessCues.test.js` §"sparse by design". This module answers a different question: "when CAN I
// pick this, and what do I get at each colour point?" (more heat, less sweet, ...).
//
// That question wants the OPPOSITE density: every live cultivar, because the early end of the window
// is what varies by cultivar and what the gardener does not know. Two questions, two densities, two
// structures — so Celebrity has a full breaker→red window while still carrying no corrective
// one-liner. Merging the two would force a choice between them.
//
// THE WINDOW IS HARVESTABILITY, NOT PREFERENCE. It is not built around the range at which Dave
// happens to pick; his habits are not what he wants the app to tell him. Tomato windows open at
// BREAKER, pepper windows at correct MATURE GREEN, and he chooses inside them.
//
// CONTENT RULE WITH TEETH — `gives` is a consequence, never a permission. A `gives` that grants
// permission or reassures ("you never have to wait for red") is filler and is rejected by the test
// suite.
//
// THE GREEN-WHEN-RIPE FIELD: Cherokee Green ripens green. Any cultivar whose ripe state is
// confusable with unripe carries `ripe_vs_unripe`: the shade/tone shift, where it shows first,
// gloss, ground spot or shoulder, and the give under thumb pressure. Same class: Black Krim's green
// shoulders, Gold Rush wax bean (yellow is cultivar identity, not ripeness), Zephyr squash's green
// tip.
//
// SOURCING. Every window traces to a fetched page. Where only the market class could be sourced
// (cayenne-type, beefsteak, grape tomato) the record is `confidence: 'low'` and carries a `caveat`
// that RENDERS ON SCREEN. That is what makes complete coverage safe: a confidently wrong cue is
// worse than none, because Dave will trust it against his own eyes, while a labelled derivation is
// not a confident claim. Never fill a gap from general knowledge.
//
// SHAPE — mirrors the eventual DB rows (`crop_types.harvest_window` jsonb + a cultivar override) so
// the lift is mechanical, per the crucible's Slice 1 sketch:
//   { window_label, window: [{ at, look, gives }], ripe_vs_unripe, source, source_url,
//     confidence, asserted_on, caveat? }

import DATA from '../data/harvestWindows.json'

/** Same normalizer as ripenessCues.cueKey — the two datasets MUST key identically or a cultivar
 *  resolves a cue and no window, which renders as a half-answered card. */
export function windowKey(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}
function windowKeyNoParen(name) {
  return windowKey(String(name ?? '').replace(/\([^)]*\)/g, ' '))
}

export const WINDOWS_BY_CULTIVAR = DATA.by_cultivar ?? {}
export const WINDOWS_BY_CROP_TYPE = DATA.by_crop_type ?? {}

/**
 * Resolve the harvest colour window for a planting's variety_ref.
 *
 * Returns { cultivar, crop } — either may be null. BOTH null is the correct outcome for anything
 * never harvested (every ornamental and houseplant) and for a crop nobody has sourced yet; the
 * caller renders nothing rather than an empty labelled section.
 *
 * The two are returned separately, not merged, for the same reason ripenessCues splits its grains:
 * the crop record is the colour-AGNOSTIC mechanic (size, firmness, gloss, how it detaches) and the
 * cultivar record is the colour sequence. A cultivar window does not make its crop mechanic
 * redundant — "full size, firm, snaps off cleanly" still applies to a Cherokee Green.
 */
export function resolveHarvestWindow(varietyRef) {
  const v = varietyRef || {}
  const crop = WINDOWS_BY_CROP_TYPE[v.crop_type_slug] ?? null
  const cultivar =
    WINDOWS_BY_CULTIVAR[windowKey(v.name)] ??
    WINDOWS_BY_CULTIVAR[windowKeyNoParen(v.name)] ??
    null
  return { cultivar, crop }
}
