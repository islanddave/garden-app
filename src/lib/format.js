// Quantity rendering helpers.
// numeric(N,3) columns serialize through the pg driver as strings like "3.000".
// Dave directive 2026-06-15: show INTEGERS everywhere for now (he'll re-add decimal precision
// per-surface where he wants it). formatQty rounds to nearest integer: "3.000"→"3", "3.500"→"4",
// "3.125"→"3". Returns '' for null/undefined/empty. Returns String(n) when not finite (defensive).
// The DB column stays numeric(N,3); this is display-only rounding, no data is altered.
export function formatQty(n) {
  if (n == null || n === '') return ''
  const num = Number(n)
  if (!Number.isFinite(num)) return String(n)
  return String(Math.round(num))
}

// V5-SEEDQTY-001 — seed WEIGHT, and the one thing it must never be is formatQty. That function is
// String(Math.round(n)) with no unit, so a 0.5 g pinch of lettuce seed renders as a bare "1": a
// number that is both wrong and unlabelled. inventory_items.seed_weight_g is numeric(10,3) and the
// column is GRAMS, always — mg is a display unit here and never a stored one.
//
// TWO BRANCHES AND A BOUNDARY. Above a decigram the gram is the readable unit (0.5 g, 28.35 g, the
// 1 oz bean packet at 28.3495 -> "28.35 g"); below it the leading zeros are noise the scale itself
// would not show, so 0.05 g reads "50 mg". The boundary is CLOSED ON THE GRAM SIDE — 0.1 is
// "0.1 g", 0.099 is "99 mg" — and that pair is pinned in format.test.js because it is the only
// place a >= / > slip is visible.
//
// ZERO IS A MEASURED FACT and goes to the gram branch deliberately: "0 g" is a weight somebody put
// on a scale, '' is a weight nobody ever recorded, and the two must not collapse. That is also why
// 0 cannot fall into the mg branch and read "0 mg", which asserts a precision the reading has not
// got. Below 0.0005 g rounds to "0 mg" — unreachable from the DB, whose 3dp resolution is 1 mg.
// Returns '' for null/undefined/empty and String(n) when not finite, same contract as its siblings.
export function formatSeedWeight(g) {
  if (g == null || g === '') return ''
  const num = Number(g)
  if (!Number.isFinite(num)) return String(g)
  if (num >= 0.1 || num <= 0) return `${num.toFixed(2).replace(/\.?0+$/, '')} g`
  return `${Math.round(num * 1000)} mg`
}

// Money rendering. Always 2 decimals. Dave directive 2026-06-15: money stays decimal
// at exactly 2 places (numeric columns serialize as "12.990"; this trims to "$12.99").
// Display-only; DB column unchanged. Returns '' for null/empty, String(n) when not finite.
export function formatMoney(n) {
  if (n == null || n === '') return ''
  const num = Number(n)
  if (!Number.isFinite(num)) return String(n)
  return '$' + num.toFixed(2)
}

// Date rendering. numeric/timestamp date columns can serialize as a full ISO
// string ("2026-06-01T00:00:00.000Z") OR a date-only "2026-06-01". Render a clean
// friendly date from the leading YYYY-MM-DD WITHOUT a Date object (avoids the
// midnight-UTC off-by-one TZ bug, L-107). Returns '' for null/empty, and the input
// untouched if it doesn't start with an ISO date (defensive — free-text passes through).
const _MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
export function formatDate(s) {
  if (s == null || s === '') return ''
  const str = String(s)
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return str
  const [, y, mo, d] = m
  const mi = Number(mo) - 1
  if (mi < 0 || mi > 11) return str
  return `${_MONTHS[mi]} ${Number(d)}, ${y}`
}
