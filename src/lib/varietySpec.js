// V4-VARSLUG-001 — pure formatters for first-class cultivar spec chips (SHU for peppers,
// determinacy for tomatoes). Sourced from variety_ref (scoville_min/max, growth_habit),
// plumbed by the plants Lambda. No fabrication: absent data => null (chip hidden).

function fmtShu(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M'
  if (n >= 10_000) return Math.round(n / 1000) + 'K'
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  return String(n)
}

// Returns a display label like "50K–100K SHU", "800K–1.04M SHU", "Sweet · 0 SHU", or null.
export function shuLabel(v) {
  const mn = v?.scoville_min, mx = v?.scoville_max
  if (mn == null && mx == null) return null
  const lo = mn ?? mx, hi = mx ?? mn
  if (lo === 0 && hi === 0) return 'Sweet · 0 SHU'
  return lo === hi ? `${fmtShu(lo)} SHU` : `${fmtShu(lo)}–${fmtShu(hi)} SHU`
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
