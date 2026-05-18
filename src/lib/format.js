// Quantity rendering helpers.
// numeric(N,3) columns serialize through the pg driver as strings like "3.000".
// formatQty drops trailing zeros: "3.000" → "3", "3.500" → "3.5", "3.125" → "3.125".
// Returns '' for null/undefined/empty. Returns String(n) when not finite (defensive).
export function formatQty(n) {
  if (n == null || n === '') return ''
  const num = Number(n)
  if (!Number.isFinite(num)) return String(n)
  return num.toString()
}
