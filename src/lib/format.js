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
