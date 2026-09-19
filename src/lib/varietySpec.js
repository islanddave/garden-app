// V4-VARSLUG-001 — pure formatters for first-class cultivar spec chips (SHU for peppers,
// determinacy for tomatoes). Sourced from variety_ref (scoville_min/max, growth_habit),
// plumbed by the plants Lambda. No fabrication: absent data => null (chip hidden).
// V5-SEEDCARDS-001 — and a GUESS is never shown as a supplier figure: scoville_source
// (v5-scovillesource-001) says where the numbers came from, and 'inference' (a best guess) is
// labelled "est." on the chip. Every other source, and null/absent, renders exactly as before.

function fmtShu(n) {
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

// Returns "Indeterminate" / "Determinate" / "Semi-determinate" / title-cased habit, or null.
export function determinacyLabel(v) {
  const g = (v?.growth_habit || '').trim().toLowerCase()
  if (!g) return null
  if (g.includes('semi')) return 'Semi-determinate'
  if (g.includes('indetermin')) return 'Indeterminate'
  if (g.includes('determin')) return 'Determinate'
  return g.charAt(0).toUpperCase() + g.slice(1)
}
