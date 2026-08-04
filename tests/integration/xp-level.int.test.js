// xp-level.int.test.js — BUG-XPPROGRESSION-001 against REAL Postgres.
//
// The unit suites prove the WIRING (the Lambda reads a level rather than computing one, in the
// right order, and reports it honestly). Only this file can prove the two things that actually
// decide whether the reward loop works:
//   1. the curve's numeric behaviour in Postgres — specifically that numeric sqrt is exact at the
//      perfect-square boundaries, which are precisely the moments a user levels up. A float
//      implementation returning 3.9999999999 instead of 4.0 would hold someone one level short on
//      the one XP value where it is most visible, and no JS test can catch that.
//   2. that the TRIGGER, not a caller, is what maintains user_stats.level — proved by writing
//      through statement shapes that never mention `level` at all, including the exact shapes used
//      by the currently-deployed Lambda and by lambda/xp-reconcile.
//
// REQUIRES migrations/v4-xpprogression-001/0a to have been applied to the target branch.
// integration-test.yml branches off STAGING and does NOT apply migrations, so 0a must reach staging
// before the dev push or every test here fails 42883 undefined_function. That ordering is spelled
// out in the migration's gates.yml header.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql } from './_harness.js'

const U = 'int-xplevel-' + Math.random().toString(36).slice(2, 10)

beforeAll(async () => {
  await directSql`DELETE FROM user_stats WHERE user_id = ${U}`
})

afterAll(async () => {
  await directSql`DELETE FROM user_stats WHERE user_id = ${U}`
})

describe('the curve functions exist and are exact in Postgres', () => {
  it('xp_level_floor() reproduces the published ladder', async () => {
    const rows = await directSql`
      SELECT l, public.xp_level_floor(l)::int AS floor_xp
      FROM generate_series(1, 10) AS l ORDER BY l`
    expect(rows.map((r) => r.floor_xp))
      .toEqual([0, 100, 400, 900, 1600, 2500, 3600, 4900, 6400, 8100])
  })

  it('the plateau holds a CONSTANT band above level 10, with no jump at the handover', async () => {
    // The plateau exists because income does not scale with level (10 XP/action, hard-capped at
    // 300/day), so an uncapped quadratic band grows without bound — +1.8 days per level forever.
    // The join is smooth: the quadratic's own L10->L11 step is already 1,900.
    const rows = await directSql`
      SELECT l::int AS l,
             (public.xp_level_floor(l) - public.xp_level_floor(l - 1))::int AS band
        FROM generate_series(2, 40) AS l ORDER BY l`
    const bands = rows.map((r) => r.band)
    // monotone non-decreasing everywhere — a discontinuity here is a visible kink in the ladder
    for (let i = 1; i < bands.length; i++) expect(bands[i]).toBeGreaterThanOrEqual(bands[i - 1])
    // flat from the handover on (l = 11 is index 9 in a series starting at 2)
    expect(new Set(bands.slice(9))).toEqual(new Set([1900]))
  })

  it('xp_level() is the EXACT inverse at every boundary over 200 levels, from both sides', async () => {
    // The keystone. Mirrors gates.yml post_curve_inverse_exact_at_every_boundary_1_to_200 — asserted
    // in the test suite as well as at apply time, because a curve that is only checked when someone
    // remembers to run the gates is a curve that can rot between applies.
    const rows = await directSql`
      SELECT l::int AS l,
             public.xp_level(public.xp_level_floor(l))::int     AS at_floor,
             public.xp_level(public.xp_level_floor(l) - 1)::int AS below_floor
        FROM generate_series(1, 200) AS l`
    const bad = rows.filter((r) => r.at_floor !== r.l || (r.l > 1 && r.below_floor !== r.l - 1))
    expect(bad).toEqual([])
  })

  it('clamps zero, negative and NULL XP to level 1 rather than raising', async () => {
    // It is called inside the achievement evaluator's non-fatal try/catch: a raise here would take
    // ALL achievement evaluation down, not just level achievements.
    const [r] = await directSql`
      SELECT public.xp_level(0)::int      AS z,
             public.xp_level(-500)::int   AS neg,
             public.xp_level(NULL)::int   AS nul,
             public.xp_level(99)::int     AS below,
             public.xp_level(100)::int    AS at`
    expect([r.z, r.neg, r.nul, r.below, r.at]).toEqual([1, 1, 1, 1, 2])
  })

  it('is IMMUTABLE, so it is safe in an index or a generated column later', async () => {
    const rows = await directSql`
      SELECT p.proname, p.provolatile FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('xp_level', 'xp_level_floor')`
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(r.provolatile).toBe('i')
  })

  it('puts level_5 and level_9 exactly where the reachability analysis placed them', async () => {
    const [r] = await directSql`
      SELECT public.xp_level_floor(5)::int AS l5, public.xp_level_floor(9)::int AS l9`
    expect(r.l5).toBe(1600)
    expect(r.l9).toBe(6400)
  })
})

describe('the TRIGGER maintains level — not any caller', () => {
  it('an INSERT that never mentions level still gets the right one', async () => {
    await directSql`INSERT INTO user_stats (user_id, xp) VALUES (${U}, 3790)`
    const [r] = await directSql`SELECT xp, level FROM user_stats WHERE user_id = ${U}`
    expect(r.xp).toBe(3790)
    expect(r.level).toBe(7)   // the main prod user's exact balance
  })

  it('overrides a WRONG level supplied by the caller — the deployed Lambda literal 1', async () => {
    // THE BACKWARD-COMPATIBILITY CLAIM, executed rather than asserted. This is byte-for-byte the
    // shape the currently-deployed resolve path sends (index.js stats_xp): it carries `level` in
    // the column list with a literal 1. If the trigger did not overwrite it, deploying this
    // migration ahead of the code would silently demote a user to level 1 on every issue resolve.
    await directSql`
      INSERT INTO user_stats (user_id, xp, level, current_streak, longest_streak, total_events, updated_at)
      VALUES (${U}, 100, 1, 0, 0, 0, NOW())
      ON CONFLICT (user_id) DO UPDATE SET xp = user_stats.xp + EXCLUDED.xp, updated_at = NOW()`
    const [r] = await directSql`SELECT xp, level FROM user_stats WHERE user_id = ${U}`
    expect(r.xp).toBe(3890)
    expect(r.level).toBe(7)   // NOT 1
  })

  it('follows an increment write (the five in-line xp = xp + n grants)', async () => {
    await directSql`UPDATE user_stats SET xp = xp + 1010 WHERE user_id = ${U}`  // 3890 -> 4900
    const [r] = await directSql`SELECT xp, level FROM user_stats WHERE user_id = ${U}`
    expect(r.xp).toBe(4900)
    expect(r.level).toBe(8)
  })

  it('follows the xp-reconcile shape: an ABSOLUTE heal with no level in the SET list', async () => {
    // This is the write that happens at 04:00 daily, outside the request path. If level were
    // computed by the six Lambda XP writers instead of by the trigger, this heal would leave it
    // stale until the user happened to log again.
    await directSql`UPDATE user_stats SET xp = 6400, updated_at = NOW() WHERE user_id = ${U}`
    const [r] = await directSql`SELECT xp, level FROM user_stats WHERE user_id = ${U}`
    expect(r.level).toBe(9)   // level_9 "Master" now satisfiable
  })

  it('IDEMPOTENT: writing the same xp twice leaves the same level (no increment anywhere)', async () => {
    await directSql`UPDATE user_stats SET xp = 6400 WHERE user_id = ${U}`
    await directSql`UPDATE user_stats SET xp = 6400 WHERE user_id = ${U}`
    const [r] = await directSql`SELECT xp, level FROM user_stats WHERE user_id = ${U}`
    expect(r.xp).toBe(6400)
    expect(r.level).toBe(9)
  })

  it('SELF-REPAIRS: a hand-corrupted level is corrected by the next write of any column', async () => {
    // The trigger is deliberately NOT gated on `WHEN (NEW.xp IS DISTINCT FROM OLD.xp)`. Gating it
    // would make it correct only for rows that were already correct — and the two rows this
    // migration inherits were not.
    await directSql`UPDATE user_stats SET level = 1 WHERE user_id = ${U}`
    const [mid] = await directSql`SELECT level FROM user_stats WHERE user_id = ${U}`
    expect(mid.level).toBe(9)  // even the corrupting write itself is corrected

    await directSql`UPDATE user_stats SET current_streak = 3 WHERE user_id = ${U}`
    const [r] = await directSql`SELECT level FROM user_stats WHERE user_id = ${U}`
    expect(r.level).toBe(9)
  })

  it('a level can go DOWN if the ledger is healed downward — level tracks xp, it is not a ratchet', () => {
    // Stated as an explicit expectation rather than discovered later: xp-reconcile can lower xp
    // (it heals toward SUM(xp_events.amount), which a soft-deleted grant could reduce). Earned
    // ACHIEVEMENTS are permanent — user_achievements rows are never removed — so a level dip
    // cannot revoke level_5. Only the displayed level moves.
    return directSql`UPDATE user_stats SET xp = 400 WHERE user_id = ${U}`
      .then(() => directSql`SELECT level FROM user_stats WHERE user_id = ${U}`)
      .then(([r]) => expect(r.level).toBe(3))
  })
})

describe('the dashboard progress fields are self-consistent', () => {
  it('xp_into_level + xp_to_next_level spans the band, and both are non-negative', async () => {
    await directSql`UPDATE user_stats SET xp = 2875 WHERE user_id = ${U}`
    const [r] = await directSql`
      SELECT xp, level,
             GREATEST(0, xp - public.xp_level_floor(level))::int     AS xp_into_level,
             GREATEST(0, public.xp_level_floor(level + 1) - xp)::int AS xp_to_next_level,
             public.xp_level_floor(level + 1)::int                   AS next_level_at
        FROM user_stats WHERE user_id = ${U}`
    expect(r.level).toBe(6)
    expect(r.xp_into_level).toBe(375)
    expect(r.xp_to_next_level).toBe(725)
    expect(r.next_level_at).toBe(3600)
    expect(r.xp_into_level + r.xp_to_next_level).toBe(1100)
    expect(r.xp + r.xp_to_next_level).toBe(r.next_level_at)
  })
})

describe('the level achievements are reachable content again', () => {
  it('level_5 and level_9 are live, active, and use the trigger_value key the evaluator reads', async () => {
    const rows = await directSql`
      SELECT slug, trigger_type, (trigger_value->>'level')::int AS lvl, xp_reward, is_active
        FROM achievements WHERE slug IN ('level_5', 'level_9') ORDER BY slug`
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ slug: 'level_5', trigger_type: 'level', lvl: 5, is_active: true })
    expect(rows[1]).toMatchObject({ slug: 'level_9', trigger_type: 'level', lvl: 9, is_active: true })
  })

  it('a user at the level_5 threshold now satisfies the evaluator predicate', async () => {
    // The evaluator's CASE, reduced to the branch under test and run against real rows: before this
    // change `level` fell to ELSE false and this returned nothing no matter how much XP the user had.
    await directSql`UPDATE user_stats SET xp = ${1600} WHERE user_id = ${U}`
    const rows = await directSql`
      SELECT a.slug
        FROM achievements a, user_stats us
       WHERE us.user_id = ${U}
         AND a.is_active = true
         AND CASE a.trigger_type
               WHEN 'level' THEN us.level >= (a.trigger_value->>'level')::int
               ELSE false
             END`
    expect(rows.map((r) => r.slug)).toEqual(['level_5'])
  })

  it('0c gives the ladder somewhere to go ABOVE its own capstone', async () => {
    // level_9 "Master" was the last named thing in the system. A formula that runs forever does not
    // fix that on its own — replacing a threshold table with a formula solved the arithmetic
    // problem, not the content problem.
    const rows = await directSql`
      SELECT slug, (trigger_value->>'level')::int AS lvl, xp_reward
        FROM achievements WHERE trigger_type = 'level' AND is_active = true
       ORDER BY (trigger_value->>'level')::int`
    expect(rows.map((r) => r.lvl)).toEqual([5, 9, 12, 15, 20, 25])
    // every named rung sits on an XP value the curve actually produces
    for (const r of rows) {
      const [{ floor_xp, lvl_at_floor }] = await directSql`
        SELECT public.xp_level_floor(${r.lvl})::int AS floor_xp,
               public.xp_level(public.xp_level_floor(${r.lvl}))::int AS lvl_at_floor`
      expect(lvl_at_floor, `level ${r.lvl} unreachable at ${floor_xp} XP`).toBe(r.lvl)
    }
  })

  it('and at 6,400 XP satisfies both — the 600 XP that was stranded since 2026-04-21', async () => {
    await directSql`UPDATE user_stats SET xp = 6400 WHERE user_id = ${U}`
    const rows = await directSql`
      SELECT a.slug, a.xp_reward
        FROM achievements a, user_stats us
       WHERE us.user_id = ${U}
         AND a.is_active = true
         AND CASE a.trigger_type
               WHEN 'level' THEN us.level >= (a.trigger_value->>'level')::int
               ELSE false
             END
       ORDER BY a.sort_order`
    expect(rows.map((r) => r.slug)).toEqual(['level_5', 'level_9'])
    expect(rows.reduce((s, r) => s + r.xp_reward, 0)).toBe(600)
  })
})
