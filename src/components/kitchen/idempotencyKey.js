// src/components/kitchen/idempotencyKey.js
// Put-Up release 1b (V4 §5.2, §6.5) — the one client key minter for every keyed Put-Up write (the Start
// sheet's create, a Put it up sitting, each line it adds). A v4 uuid: the server refuses a malformed
// key with a 400, so a timestamp fallback would be worse than none. getRandomValues exists wherever
// randomUUID does not (older Android WebViews).
export function mintKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
