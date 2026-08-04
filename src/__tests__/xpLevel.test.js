// xpLevel.test.js — BUG-XPPROGRESSION-001.
//
// Two jobs, and the second is the one that matters most:
//   1. the display mirror's arithmetic is right at every boundary, and degrades instead of throwing
//   2. THE DRIFT GUARD — the mirror's coefficient is parsed out of the migration SQL and compared,
//      so src/lib/xpLevel.js cannot silently disagree with public.xp_level(). A JS copy of a SQL
//      curve is exactly the "two hand-copied expressions plus a comment asking them to stay
//      identical" shape that this ticket exists to eliminate; if the duplication has to exist for
//      offline rendering, it has to be mechanically pinned.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  XP_LEVEL_COEFF, XP_PLATEAU_LEVEL, XP_PLATEAU_BAND,
  xpForLevel, levelForXp, levelProgress,
} from '../lib/xpLevel.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATION = readFileSync(
  resolve(__dirname, '../../migrations/v4-xpprogression-001/0a-level-curve.sql'),
  'utf8',
)

describe('drift guard — the JS mirror must match the canonical SQL curve', () => {
  it('xp_level_floor() in SQL uses the same coefficient as XP_LEVEL_COEFF', () => {
    // Matches: THEN (100 * (GREATEST(p_level, 1) - 1) * (GREATEST(p_level, 1) - 1))
    const m = MIGRATION.match(/THEN \((\d+) \* \(GREATEST\(p_level, 1\) - 1\)/)
    expect(m, 'xp_level_floor body not found — did the migration change shape?').toBeTruthy()
    expect(Number(m[1])).toBe(XP_LEVEL_COEFF)
  })

  it('xp_level() in SQL divides by the same coefficient', () => {
    const m = MIGRATION.match(/floor\(sqrt\(GREATEST\(COALESCE\(p_xp, 0\), 0\)::numeric \/ (\d+)\)\)/)
    expect(m, 'xp_level body not found — did the migration change shape?').toBeTruthy()
    expect(Number(m[1])).toBe(XP_LEVEL_COEFF)
  })

  it('the SQL plateau boundary and band match XP_PLATEAU_LEVEL / XP_PLATEAU_BAND', () => {
    // The plateau is the half of the curve a JS mirror is most likely to forget, because everything
    // the two live users touch sits below it. Pin both halves.
    const floorM = MIGRATION.match(/ELSE (\d+) \+ (\d+) \* \(GREATEST\(p_level, 1\) - (\d+)\)/)
    expect(floorM, 'xp_level_floor plateau branch not found').toBeTruthy()
    expect(Number(floorM[1])).toBe(XP_LEVEL_COEFF * (XP_PLATEAU_LEVEL - 1) ** 2)   // 8100
    expect(Number(floorM[2])).toBe(XP_PLATEAU_BAND)                                 // 1900
    expect(Number(floorM[3])).toBe(XP_PLATEAU_LEVEL)                                // 10

    const invM = MIGRATION.match(/THEN (\d+) \+ \(\(GREATEST\(COALESCE\(p_xp, 0\), 0\) - (\d+)\) \/ (\d+)\)/)
    expect(invM, 'xp_level plateau branch not found').toBeTruthy()
    expect(Number(invM[1])).toBe(XP_PLATEAU_LEVEL)
    expect(Number(invM[2])).toBe(XP_LEVEL_COEFF * (XP_PLATEAU_LEVEL - 1) ** 2)
    expect(Number(invM[3])).toBe(XP_PLATEAU_BAND)
  })

  it('the plateau JOINS SMOOTHLY — no jump in band width at the handover', () => {
    // The quadratic's own L10→L11 step is 100*(2*10-1) = 1900, which is exactly the plateau band.
    // If these ever diverge the ladder gets a visible discontinuity right where it hands over.
    const quadraticStepAtJoin = XP_LEVEL_COEFF * (2 * XP_PLATEAU_LEVEL - 1)
    expect(quadraticStepAtJoin).toBe(XP_PLATEAU_BAND)
    const bands = []
    for (let l = 2; l <= 30; l++) bands.push(xpForLevel(l) - xpForLevel(l - 1))
    // monotone non-decreasing, and flat from the join onward
    for (let i = 1; i < bands.length; i++) expect(bands[i]).toBeGreaterThanOrEqual(bands[i - 1])
    expect(bands.slice(XP_PLATEAU_LEVEL - 1)).toEqual(
      new Array(bands.length - (XP_PLATEAU_LEVEL - 1)).fill(XP_PLATEAU_BAND),
    )
  })

  it('the SQL still installs the trigger that makes user_stats.level derived, not written', () => {
    // If this ever stops being true, the mirror is no longer a mirror — some caller is computing
    // levels again and the whole design has regressed.
    expect(MIGRATION).toMatch(/CREATE TRIGGER trg_user_stats_level/)
    expect(MIGRATION).toMatch(/BEFORE INSERT OR UPDATE ON public\.user_stats/)
    expect(MIGRATION).toMatch(/NEW\.level := public\.xp_level\(NEW\.xp\)/)
  })
})

describe('xpForLevel — total XP required to reach a level', () => {
  it('matches the published ladder through the quadratic half', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(xpForLevel))
      .toEqual([0, 100, 400, 900, 1600, 2500, 3600, 4900, 6400, 8100])
  })

  it('continues on a constant 1,900 band above level 10', () => {
    expect([11, 12, 15, 20, 25].map(xpForLevel))
      .toEqual([10000, 11900, 17600, 27100, 36600])
  })

  it('the two achievement thresholds land where the reachability analysis says', () => {
    // level_5 "True Gardener" (100 XP) and level_9 "Master" (500 XP) are live, is_active, and had
    // ZERO earners. These two numbers are what make them reachable; gates.yml asserts the same
    // pair server-side so the curve cannot move under shipped content.
    expect(xpForLevel(5)).toBe(1600)
    expect(xpForLevel(9)).toBe(6400)
  })

  it('clamps level 0, negatives, and junk to the level-1 floor of 0', () => {
    expect(xpForLevel(1)).toBe(0)
    expect(xpForLevel(0)).toBe(0)
    expect(xpForLevel(-4)).toBe(0)
    expect(xpForLevel(null)).toBe(0)
    expect(xpForLevel(undefined)).toBe(0)
    expect(xpForLevel(NaN)).toBe(0)
  })

  it('truncates fractional levels rather than producing a fractional floor', () => {
    expect(xpForLevel(5.9)).toBe(xpForLevel(5))
  })
})

describe('levelForXp — level for a given lifetime XP', () => {
  it('is exact at EVERY boundary over 200 levels, from both sides', () => {
    // The float-rounding trap: the boundaries are the perfect squares, so a sqrt landing at
    // 3.9999999999 would hold a user one level short at the precise moment they levelled up.
    // Same assertion the migration's post_curve_inverse_exact_at_every_boundary_1_to_200 gate
    // makes against real Postgres.
    for (let l = 1; l <= 200; l++) {
      expect(levelForXp(xpForLevel(l)), `at floor of level ${l}`).toBe(l)
      if (l > 1) {
        expect(levelForXp(xpForLevel(l) - 1), `one XP below level ${l}`).toBe(l - 1)
      }
    }
  })

  it('holds the level across the whole band, not just at its edges', () => {
    expect(levelForXp(1600)).toBe(5)
    expect(levelForXp(2000)).toBe(5)
    expect(levelForXp(2499)).toBe(5)
    expect(levelForXp(2500)).toBe(6)
  })

  it('crosses the plateau handover without a gap or an overlap', () => {
    expect(levelForXp(8099)).toBe(9)
    expect(levelForXp(8100)).toBe(10)
    expect(levelForXp(9999)).toBe(10)
    expect(levelForXp(10000)).toBe(11)
    expect(levelForXp(11899)).toBe(11)
    expect(levelForXp(11900)).toBe(12)
  })

  it('reaches the four new named rungs at the XP 0c seeds them for', () => {
    // 0c seeds level_12 / level_15 / level_20 / level_25. If the curve moves under them they become
    // the same unreachable content level_5 and level_9 were.
    expect(levelForXp(11900)).toBe(12)
    expect(levelForXp(17600)).toBe(15)
    expect(levelForXp(27100)).toBe(20)
    expect(levelForXp(36600)).toBe(25)
  })

  it('places the two live prod users where the backfill predicted', () => {
    // Measured live prod 2026-08-04, both rows at level 1 with zero ledger drift. These are the
    // numbers 0b's header commits to; if the curve moves, this test says so.
    expect(levelForXp(3790)).toBe(7)
    expect(levelForXp(445)).toBe(3)
    // …and staging's single row, which a prod-only check would have missed entirely.
    expect(levelForXp(2875)).toBe(6)
  })

  it('clamps zero, negatives, nulls and junk to level 1 — never 0, never NaN', () => {
    expect(levelForXp(0)).toBe(1)
    expect(levelForXp(99)).toBe(1)
    expect(levelForXp(-500)).toBe(1)
    expect(levelForXp(null)).toBe(1)
    expect(levelForXp(undefined)).toBe(1)
    expect(levelForXp(NaN)).toBe(1)
    expect(levelForXp('nonsense')).toBe(1)
  })

  it('accepts a numeric string, as an API payload may deliver', () => {
    expect(levelForXp('3790')).toBe(7)
  })
})

describe('levelProgress — what the dashboard bar renders', () => {
  it('PREFERS the server-derived fields over recomputing locally', () => {
    // The server numbers come from public.xp_level_floor(); the local ones are a fallback. If the
    // two ever disagree the server must win, because the server's is the level the achievement
    // evaluator judged against.
    const p = levelProgress({
      xp: 2875, level: 6, xp_into_level: 375, xp_to_next_level: 725, next_level_at: 3600,
    })
    expect(p.level).toBe(6)
    expect(p.xpIntoLevel).toBe(375)
    expect(p.xpToNextLevel).toBe(725)
    expect(p.nextLevelAt).toBe(3600)
    expect(p.fraction).toBeCloseTo(375 / 1100, 6)
  })

  it('falls back to the local mirror for a response predating the change', () => {
    // An older /api/dashboard reply carries xp only. The bar must still be right.
    const p = levelProgress({ xp: 3790 })
    expect(p.level).toBe(7)
    expect(p.xpIntoLevel).toBe(190)      // 3790 - 3600
    expect(p.xpToNextLevel).toBe(1110)   // 4900 - 3790
    expect(p.nextLevelAt).toBe(4900)
    expect(p.fraction).toBeCloseTo(190 / 1300, 6)
  })

  it('a freshly reached level reads 0/full-band, not NaN', () => {
    const p = levelProgress({ xp: 1600 })
    expect(p.level).toBe(5)
    expect(p.xpIntoLevel).toBe(0)
    expect(p.xpToNextLevel).toBe(900)
    expect(p.fraction).toBe(0)
  })

  it('survives null / empty / garbage stats without throwing', () => {
    for (const s of [null, undefined, {}, { xp: null, level: null }, { xp: 'x' }]) {
      const p = levelProgress(s)
      expect(p.level).toBe(1)
      expect(p.fraction).toBeGreaterThanOrEqual(0)
      expect(p.fraction).toBeLessThanOrEqual(1)
      expect(Number.isNaN(p.fraction)).toBe(false)
    }
  })

  it('clamps a drifted level rather than rendering a negative or >100% bar', () => {
    // Cannot happen while the trigger is installed; this pins the degradation if it ever did.
    const low  = levelProgress({ xp: 100, level: 9, xp_into_level: -50, xp_to_next_level: 6300 })
    expect(low.xpIntoLevel).toBe(0)
    expect(low.fraction).toBeGreaterThanOrEqual(0)

    const high = levelProgress({ xp: 99999, level: 2, xp_into_level: 99899, xp_to_next_level: 0 })
    expect(high.fraction).toBeLessThanOrEqual(1)
  })

  it('ignores a level below 1 in the payload and derives from xp instead', () => {
    expect(levelProgress({ xp: 3790, level: 0 }).level).toBe(7)
  })

  it('a zero-width band yields fraction 0, not a division by zero', () => {
    // Degenerate only if a server response ever sent both derived fields as 0. Pinned because the
    // alternative is NaN, and NaN reaches the DOM as width:"NaN%" — a silently invisible bar.
    const p = levelProgress({ xp: 100, level: 2, xp_into_level: 0, xp_to_next_level: 0 })
    expect(p.fraction).toBe(0)
    expect(Number.isNaN(p.fraction)).toBe(false)
  })
})
