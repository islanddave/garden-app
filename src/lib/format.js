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

// Money rendering. Always 2 decimals. Dave directive 2026-06-15: money stays decimal
// at exactly 2 places (numeric columns serialize as "12.990"; this trims to "$12.99").
// Display-only; DB column unchanged. Returns '' for null/empty, String(n) when not finite.
export function formatMoney(n) {
  if (n == null || n === '') return ''
  const num = Number(n)
  if (!Number.isFinite(num)) return String(n)
  return '$' + num.toFixed(2)
}
