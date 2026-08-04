// xpLevel.js — BUG-XPPROGRESSION-001. DISPLAY-ONLY mirror of the XP level curve.
//
// ⚠ THIS IS NOT THE DEFINITION. public.xp_level() / public.xp_level_floor()
// (migrations/v4-xpprogression-001/0a-level-curve.sql) are canonical, and user_stats.level is
// maintained from them by trg_user_stats_level. Nothing here is ever written back to the database,
// and no server decision — least of all whether level_5 / level_9 have been earned — is made from
// this file. It exists so the dashboard can render a progress bar from an `xp` it already holds
// without a round trip, and so a level renders sensibly if an older API response omits the derived
// fields the Lambda now sends (level, xp_into_level, xp_to_next_level, next_level_at).
//
// The duplication is the same drift class this whole ticket is about, so it is DEFENDED rather than
// merely apologised for: src/__tests__/xpLevel.test.js parses the coefficient straight out of the
// migration SQL and fails if these two ever disagree. If you change the curve, change the SQL — the
// test will then tell you to change this file too.
//
// THE CURVE — quadratic to level 10, then a constant 1,900 XP band:
//   xp_floor(L) = 100·(L−1)²           for L ≤ 10     L2 100 · L3 400 · L4 900 · L5 1600
//   xp_floor(L) = 8100 + 1900·(L−10)   for L > 10     L6 2500 · L7 3600 · L9 6400 · L10 8100
// The join is smooth: the quadratic's own L10→L11 step is already 1,900, so the plateau just holds
// the band at the width it had reached. The plateau exists because income here does NOT scale with
// level (10 XP per action forever, hard-capped at 300/day), and quadratic cost against flat capped
// income means time-per-level grows without bound. Full rationale, the seasonal caveat, the
// rejected alternatives and the reachability arithmetic live in the migration header — not here,
// because the migration is where someone changing the curve will actually be looking.

export const XP_LEVEL_COEFF = 100
/** Level at which the quadratic hands over to a constant band. Mirrors the SQL CASE boundary. */
export const XP_PLATEAU_LEVEL = 10
/** Constant XP per level above XP_PLATEAU_LEVEL. Equals the quadratic's own step at that level. */
export const XP_PLATEAU_BAND = 1900

const PLATEAU_FLOOR = XP_LEVEL_COEFF * (XP_PLATEAU_LEVEL - 1) * (XP_PLATEAU_LEVEL - 1)  // 8100

/** Total XP required to reach `level`. Inverse of levelForXp. Levels below 1 clamp to 1 (floor 0). */
export function xpForLevel(level) {
  const l = Math.max(1, Math.floor(Number(level) || 1))
  if (l <= XP_PLATEAU_LEVEL) return XP_LEVEL_COEFF * (l - 1) * (l - 1)
  return PLATEAU_FLOOR + XP_PLATEAU_BAND * (l - XP_PLATEAU_LEVEL)
}

/**
 * Level for a given lifetime XP. Mirrors public.xp_level().
 * Null/NaN/negative clamp to level 1 — this renders a header, so it degrades rather than throws.
 */
export function levelForXp(xp) {
  const x = Math.max(0, Math.floor(Number(xp) || 0))
  if (x >= PLATEAU_FLOOR) {
    return XP_PLATEAU_LEVEL + Math.floor((x - PLATEAU_FLOOR) / XP_PLATEAU_BAND)
  }
  return Math.max(1, Math.floor(Math.sqrt(x / XP_LEVEL_COEFF)) + 1)
}

/**
 * Progress within the current level band, for a bar.
 * Prefers the server-derived fields when the caller passes a user_stats row that has them (the
 * Lambda computes those from the canonical SQL functions); falls back to local arithmetic only for
 * responses predating BUG-XPPROGRESSION-001.
 * `fraction` is 0..1 and is 0 for a fresh level rather than NaN on a zero-width band.
 */
export function levelProgress(stats) {
  const s = stats ?? {}
  const xp = Math.max(0, Math.floor(Number(s.xp) || 0))
  const level = Number.isFinite(Number(s.level)) && Number(s.level) >= 1
    ? Math.floor(Number(s.level))
    : levelForXp(xp)

  const floorXp = xpForLevel(level)
  const nextAt = Number.isFinite(Number(s.next_level_at))
    ? Math.floor(Number(s.next_level_at))
    : xpForLevel(level + 1)

  const into = Number.isFinite(Number(s.xp_into_level))
    ? Math.max(0, Math.floor(Number(s.xp_into_level)))
    : Math.max(0, xp - floorXp)
  const toNext = Number.isFinite(Number(s.xp_to_next_level))
    ? Math.max(0, Math.floor(Number(s.xp_to_next_level)))
    : Math.max(0, nextAt - xp)

  const band = into + toNext
  return {
    level,
    xp,
    xpIntoLevel: into,
    xpToNextLevel: toNext,
    nextLevelAt: nextAt,
    fraction: band > 0 ? Math.min(1, into / band) : 0,
  }
}
