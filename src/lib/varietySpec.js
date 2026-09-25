// V4-VARSLUG-001 — pure formatters for first-class cultivar spec chips (SHU for peppers,
// determinacy for tomatoes). Sourced from variety_ref (scoville_min/max, growth_habit),
// plumbed by the plants Lambda. No fabrication: absent data => null (chip hidden).
// The Sun words (SUN_OPTIONS / sunLabel, at the bottom) live here too: the editor and every display
// of sun_requirements share them.
// V5-SEEDCARDS-001 — and a GUESS is never shown as a supplier figure: scoville_source
// (v5-scovillesource-001) says where the numbers came from, and 'inference' (a best guess) is
// labelled "est." on the chip. Every other source, and null/absent, renders exactly as before.

// Exported for the seed facts' narrow-column heat (components/seed/seedFacts.js).
export function fmtShu(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M'
  if (n >= 10_000) return Math.round(n / 1000) + 'K'
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  return String(n)
}

// Returns a display label like "50K–100K SHU", "800K–1.04M SHU", "Sweet · 0 SHU", or null.
// An estimate (scoville_source === 'inference') gains the WORD "est. " in front: "est. 100K–350K SHU".
// A word, not ≈: the chip is 0.75rem, and at that size a leading glyph reads as a smudge (house rule
// from commit 4382da4). Strict equality on purpose — only the one value the DB CHECK defines as a
// guess is marked; a source never makes a chip appear on its own (no numbers => null, as before).
export function shuLabel(v) {
  const mn = v?.scoville_min, mx = v?.scoville_max
  if (mn == null && mx == null) return null
  const lo = mn ?? mx, hi = mx ?? mn
  const label = lo === 0 && hi === 0 ? 'Sweet · 0 SHU'
    : lo === hi ? `${fmtShu(lo)} SHU` : `${fmtShu(lo)}–${fmtShu(hi)} SHU`
  return v?.scoville_source === 'inference' ? `est. ${label}` : label
}

// Returns "Indeterminate" / "Determinate" / "Semi-determinate", or null. Nothing else, ever: the pill
// names a determinacy class and never echoes the prose. Until 2026-09-25 prose with no determinacy
// word came back whole (146 live non-tomato cards wore a sentence of up to 209 chars as a green pill)
// and a bare `semi` test read "semi-woody", "semi-upright", "semi-vining"... as Semi-determinate (7 more).
//
// A whole term, leftmost wins: the same primary-term rule as the derived determinacy facet
// (parseDeterminacy, lambda/tags/crop-derive.js), so on every live prose string the pill and the facet
// chip under it agree (varietySpec.test.js pins that). "indeterminate vine (semi-determinate per some
// sources)" is Indeterminate: the Rosso Sicilian card said Semi-determinate over an Indeterminate chip.
// The semi family is one term in each real spelling: hyphen, U+2010/U+2011, en dash, space, underscore
// (the slug) or none. A term inside a hyphen compound ("non-determinate", "semi-indeterminate") or a
// longer word ("indeterminates", "determinant", an ordinary noun) is not that term, so it labels nothing
// rather than something the prose did not say. The facet matches substrings, so it is looser on exactly
// those words; no live prose contains one.
//
// No crop gate, on evidence: across all 515 live cultivars (prod, 2026-09-25) the only non-tomato prose
// with one of these terms describes plant habit (3 tomatillos, 3 potatoes, 1 bush bean), so the label is
// true where it appears. Dwarf stays the facet's refinement; the pill keeps its three words.
const DETERMINACY_TERM = /(?:^|[^\w\-\u2010\u2011])(semi[-\u2010\u2011\u2013_\s]?determinate|indeterminate|determinate)(?!\w)/i

export function determinacyLabel(v) {
  const m = DETERMINACY_TERM.exec(v?.growth_habit || '')
  if (!m) return null
  const term = m[1].toLowerCase()
  if (term.startsWith('semi')) return 'Semi-determinate'
  return term === 'indeterminate' ? 'Indeterminate' : 'Determinate'
}

// The Sun words, one list for the whole app. The four codes are the only values the plant_varieties
// CHECK allows (plant_varieties_sun_requirements_check, and VALID_SUN in lambda/varieties/validate.js,
// which varietySpec.test.js diffs against this list), in the editor's order. VarietyEditor's Sun
// pick-list offers these words and every screen that shows a cultivar's sun needs prints them through
// sunLabel, so the word you pick is the word you read. Until 2026-09-25 three of those screens printed
// the code itself: the CropCard Sun row and the Care tab's Light row on 205 of 244 live plantings, and
// the hero's gold key-fact pill on 45.
export const SUN_OPTIONS = [
  ['full_sun', 'Full sun'], ['part_sun', 'Part sun'],
  ['part_shade', 'Part shade'], ['full_shade', 'Full shade'],
]
const SUN_WORDS = new Map(SUN_OPTIONS)

// 'part_shade' -> 'Part shade'. A value outside the list still reads as words rather than vanishing
// (underscores to spaces, first letter raised: 'dappled_shade' -> 'Dappled shade'), and prose passes
// through with only its first letter raised. Absent, blank or not a string -> null, so every caller
// hides its row exactly as it did when it printed the raw column.
export function sunLabel(value) {
  if (typeof value !== 'string') return null
  const t = value.trim()
  if (!t) return null
  const known = SUN_WORDS.get(t.toLowerCase())
  if (known) return known
  const words = t.replace(/_/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : null
}
