// V4-APPBANNER-001 — deterministic daily banner pick.
// Local-calendar math (DST-immune: UTC-anchored Y/M/D — a 23h/25h DST day cannot shift the index),
// seasonal pools with fallback-to-all, and a per-block seeded Fisher-Yates permutation
// (block = pool.length consecutive days): the photo changes every day within a block and the
// order reshuffles each block, so there is no learnable fixed cycle and no modulo year-wrap artifact.
// Same result for every user/device on the same local date (shared household referent).

export function localDayNumber(d) {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000)
}

export function seasonOf(d) {
  const m = d.getMonth()
  if (m === 11 || m <= 1) return 'winter'
  if (m <= 4) return 'spring'
  if (m <= 7) return 'summer'
  return 'fall'
}

function mulberry32(seed) {
  let a = seed | 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function pickBanner(date, banners) {
  if (!banners || banners.length === 0) return null
  const season = seasonOf(date)
  let pool = banners.filter((b) => b.season === season)
  if (pool.length === 0) pool = banners
  if (pool.length === 1) return pool[0]
  const day = localDayNumber(date)
  const block = Math.floor(day / pool.length)
  const rng = mulberry32(Math.imul(block, 2654435761) ^ pool.length)
  const perm = pool.map((_, i) => i)
  for (let i = perm.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t
  }
  return pool[perm[day % pool.length]]
}
