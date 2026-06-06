// V3-DELIGHT-001 D1 — deterministic "Critter of the Day" pick. Pure, no side effects.
// Household-coherent: every device computes the SAME pick for a given UTC date (no server
// coordination), so the shared-state PUT race is harmless (all members write the identical
// payload). Seeded permutation indexed by epoch-day -> full N-day no-repeat cycle, no
// consecutive repeats (review-mandated anti-repetition; verified node-side over the 168 roster).

// mulberry32 deterministic PRNG (constant seed -> identical sequence on every client/build).
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PERM_SEED = 0x9e3779b9 // fixed -> the permutation is identical for all users/devices

function seededPermutation(n) {
  const arr = Array.from({ length: n }, (_, i) => i)
  const rnd = mulberry32(PERM_SEED)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t
  }
  return arr
}

// epoch-day (UTC) for a 'YYYY-MM-DD' string; null if malformed.
export function epochDayUTC(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null
  const ms = Date.parse(dateStr + 'T00:00:00Z')
  if (Number.isNaN(ms)) return null
  return Math.floor(ms / 86400000)
}

// pickCritterOfDay(roster, dateStr) -> roster entry | null. Stable per date; cycles all N with
// no repeat inside any N-day window.
export function pickCritterOfDay(roster, dateStr) {
  if (!Array.isArray(roster) || roster.length === 0) return null
  const n = roster.length
  const day = epochDayUTC(dateStr)
  if (day === null) return null
  const perm = seededPermutation(n)
  const idx = perm[((day % n) + n) % n]
  return roster[idx] ?? null
}

export function todayUTCDate() {
  return new Date().toISOString().slice(0, 10)
}
