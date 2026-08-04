-- V4-XPPROGRESSION-001 / 0a — give user_stats.level a definition, and ONE place that holds it.
--
-- THE DEFECT
-- `user_stats.level` has existed since the schema was created (integer NOT NULL DEFAULT 1). It is
-- written exactly once in the entire codebase — as the literal `1`, in the resolve path's
-- row-creating upsert (lambda/events/index.js). No UPDATE anywhere has ever touched it. Both live
-- prod users therefore sit at level 1 on 3,790 and 445 XP.
-- Downstream, the achievement evaluator's `CASE a.trigger_type` has no `level` branch, so
-- `level_5` (True Gardener, 100 XP) and `level_9` (Master, 500 XP) fall to `ELSE false` and can
-- never fire — 600 XP of designed reward stranded, while src/pages/Achievements.jsx cheerfully
-- prints "Reach level 5" as a locked hint for a goal the code cannot grant. That is a live UX lie,
-- not just a gap.
--
-- ── WHY A TRIGGER AND NOT SIX CAREFUL CALLERS ────────────────────────────────────────────────
-- `user_stats.xp` is mutated at SIX sites: three in lambda/events/index.js (resolve upsert,
-- Step-3b achievement grant, Step-4 flat grant), two in lambda/events/batchSideEffects.js
-- (Steps 3 and 4), and one in lambda/xp-reconcile (the nightly absolute heal from the ledger).
-- Deriving `level` at each of those six sites is precisely the shape of the bug being fixed here:
-- a derived value that some paths maintain and others silently do not. It is also the shape of
-- BUG-BATCHSIDEEFFECTS-001 (six effects on one path, one effect on the other) and of
-- V4-CAL1-HARVWEIGHT-002, whose header says it plainly: two hand-copied SQL expressions plus a
-- comment asking them to stay identical is not a mechanism. That migration's answer — extract the
-- derivation to ONE SQL function — is the house pattern, and this file follows it.
--
-- A BEFORE trigger goes one step further than a function the callers must remember to call: it
-- makes the invariant `level = xp_level(xp)` hold for EVERY writer, including the reconciler that
-- rewrites xp behind the Lambda's back at 04:00, including the resolve path that has no Step-4
-- equivalent, and including any future writer or manual UPDATE. The rot class is closed
-- structurally rather than by discipline.
--
-- IDEMPOTENT BY CONSTRUCTION. `level` becomes an ABSOLUTE function of `xp`, never an increment.
-- This is the `total_events` precedent (recomputed live count, not `+ 1`) rather than the `xp`
-- precedent (five in-line `xp = xp + …` increments whose retry-safety comes from the grant's
-- ON CONFLICT, not from the `+`). Writing the same level twice is a no-op by definition, which is
-- what the batch path's retry contract requires.
--
-- ── BACKWARD COMPATIBILITY: THIS IS A MIGRATION, NOT A DEPLOY ────────────────────────────────
-- Deliberately verified against the 2026-08-03 harvest incident, where a CHECK was validated ahead
-- of its writer and 23514'd every prod harvest save. Nothing here can do that:
--   • No column is added, dropped, retyped, or made generated. `level` keeps its type, its
--     NOT NULL, and its DEFAULT 1.
--   • No CHECK is created and none is validated. There is nothing to arm.
--   • The currently-deployed Lambda's only `level` write is
--     `INSERT INTO user_stats (user_id, xp, level, …) SELECT …, 1, …` — a BEFORE trigger simply
--     overwrites that literal with the correct value. It cannot error; there is no
--     "cannot insert into generated column" (428C9) failure mode, which IS why this is a trigger
--     and not a GENERATED ALWAYS column. A generated column would have required dropping and
--     re-adding `level`, breaking that still-deployed INSERT, and forcing a writer-first/
--     constraint-second two-deploy dance for a purely derived integer.
-- CONSEQUENCE: 0a/0b may be applied to any environment BEFORE or AFTER the code deploy. The only
-- ordering that matters is soft and one-directional — until 0a lands, the new `WHEN 'level'`
-- evaluator branch reads a stale level and simply does not grant, which is exactly today's
-- behaviour. It never errors. Prefer migration-first anyway so the branch is live on arrival.
--
-- ── THE CURVE: quadratic to level 10, then a constant 1,900 XP band ─────────────────────────
--     xp_floor(L) = 100·(L−1)²            for L ≤ 10   (L10 = 8,100)
--     xp_floor(L) = 8,100 + 1,900·(L−10)  for L > 10
-- The join is SMOOTH, not a kink: the quadratic's own L10→L11 step is 100·(2·10−1) = 1,900, so the
-- plateau simply holds the band at the width the curve had already reached. The gap sequence
-- 100, 300, 500 … 1,700, 1,900, 1,900, 1,900 … is monotone non-decreasing with no jump anywhere.
--
-- WHY THE PLATEAU (this was a pure quadratic until an adversarial review of the economy):
-- Games survive quadratic COST curves because income scales with level. This one has no income
-- scaling at all — a logging action is 10 XP forever — and a hard 300/day ceiling on top. Quadratic
-- cost against flat capped income means time-per-level = 100·(2L−1)/rate, which grows linearly and
-- WITHOUT BOUND: +1.8 days per level, every level, forever. A pure quadratic reached 33 days/level
-- by L19 and kept going. The first draft of this header called that "an unbounded ladder with no
-- wall"; it was a wall that receded at constant speed, and the "never more than a month before
-- level 19" claim was engineered to within one rung of its own boundary, at peak rate, for the
-- fastest user in the system. The plateau caps the band at ~17 peak-season days per level
-- permanently, which is what the binding constraint — "a level curve that takes months to move is
-- worse than no curve" — actually requires.
-- NOTHING BELOW LEVEL 10 CHANGES. Both live users, both achievement thresholds, and every
-- reachability number in this header sit under L10 and are identical either way.
-- Calibrated on measured prod behaviour, NOT on the 3,790 lifetime total. That total was earned
-- under the broken regime (30 XP/day cap, batch path paying nothing — 0 of 9,724 batch rows ever
-- produced an xp_event). The FORWARD rate is 20x higher and is the only number a curve may be
-- calibrated against. Measured on live prod 2026-08-04, main user, last 120 days, live rows,
-- America/New_York, batch collapsed to one logging action:
--     73 active days · 2,632 logging actions · p50 20 actions/day · p75 52 · p90 81 · max 258
--     under the shipped 300-cap / 10-XP-per-action rules: 13,500 XP per 120 days
--       = 112.5 XP per calendar day = 185 XP per active day; 32/73 days (43.8%) bind the cap.
-- Second user, same window: 8 active days, 27 actions, 270 XP per 120 days.
--
-- Ladder and, at that measured rate, what each rung costs the main user:
--     L2    100    L3    400    L4    900    L5   1600    L6   2500
--     L7   3600    L8   4900    L9   6400    L10  8100    L11 10000    L12 11900    L20 27100
--   L7→8 1,300 (≈9 d)   L8→9 1,500 (≈13 d)   L9→10 1,700 (≈15 d)   L10→11 and every rung
--   thereafter 1,900 (≈17 d).
-- So: ≈9–15 days per level through level 10, then a flat ≈17 days per level indefinitely. Stated
-- that way rather than as "1.5–2 weeks" — the pure-quadratic draft claimed that band and left it
-- behind at level 10.
--
-- ⚠ THE SEASONAL CAVEAT, which the rate above does NOT contain. The 120-day measurement window is
-- 2026-04-06 → 2026-08-04 — peak growing season, and the only season for which any data exists.
-- December logging is not 112.5 XP/day. At a generous 30% of peak (≈34 XP/day) a 1,900 XP band is
-- ≈56 days, not 17. The plateau is what keeps that number at 56 rather than the 110+ a continuing
-- quadratic would have produced by level 20 — but no curve shape fixes an off-season income
-- collapse, and this one does not pretend to. Winter progression is expected to come from the
-- streak and milestone channels, which are volume-independent, not from this ladder. If the
-- off-season shows the level bar frozen for months, the fix is a dormant-season band or a seasonal
-- channel — a product decision, deliberately not smuggled into a curve.
--
-- REJECTED: the historical ladder recoverable from git at 90ab22c:src/lib/garden-ops.js
-- (100/250/500/1000/2000/4000/7500/15000). It is the original designer's intent and it was
-- tempting to simply revive it, but measured against the forward rate it fails twice: level_9 at
-- 15,000 XP is 100 calendar days away — past the end of the season, and a 67-day wall from
-- level 8 — and the table stops at 9, so the bar dies the moment it is reached. Its early rungs
-- ARE better tuned than a pure quadratic (100/250/500 vs 100/400/900); that is the one thing given
-- up here, and it is given up knowingly for an unbounded ladder with no wall.
-- REJECTED: triangular 75·(L−1)·L, which puts level_9 only 14 days out — "Master" earned two weeks
-- after a bug fix devalues a 500-XP capstone.
--
-- WHERE THE TWO LIVE USERS LAND (this is the backfill's whole visible effect, see 0b):
--   3,790 XP → level 7. He is 190 XP INTO a 1,300 XP band (14.6%), with 1,110 to go to level 8.
--              `level_5` becomes satisfied and fires on the next logging action, +100 XP.
--              `level_9` (6,400) is 2,510 XP ≈ 22 days out — within this season, which is the point.
--     445 XP → level 3 (45 XP into a 500 XP band, 455 to level 4).
-- The existing level_5 / level_9 trigger_values are RIGHT under this curve and are NOT amended.
-- Stating the honest version of that, because "the thresholds happen to fit" is one letter away
-- from "the curve was fitted to two legacy magic numbers": the curve was chosen on CADENCE grounds
-- (≈9–17 days per rung at the measured rate) before the thresholds were checked, and 1,600 / 6,400
-- then landed at "committed" and "season-scale capstone" respectively. Had they not, the correct
-- move was to UPDATE the two trigger_values, not to bend the curve — and that remains available.
--
-- ⚠ WHAT THIS CURVE DOES NOT SOLVE — the second user, stated plainly rather than glossed.
-- At her measured rate (2.25 XP/calendar day, 8 active days in 120) level 4 is ~200 calendar days
-- away and level_5 is well over a year. That is NOT a curve defect and no curve fixes it: the two
-- users are 50x apart in logging volume (2,632 actions vs 27 in the same window), and any ladder
-- where level 5 means something to the first is out of reach for the second. Her progression is
-- already carried by the OTHER channel and the data says so: 335 of her 445 XP (75%) came from
-- achievements, not from logging volume. Milestones are volume-independent and are the right
-- surface for a light user; this ladder is not, and the UI should not imply otherwise. A stalled
-- bar shown to a lapsed user is a shame surface, not a motivator.

-- ── LEVEL CAN GO DOWN. This is new, and it is not a bug. ─────────────────────────────────────
-- Before this migration `level` was frozen at 1 and could not regress. Now it tracks `xp`, and
-- lambda/xp-reconcile heals `xp` ABSOLUTELY from SUM(xp_events.amount) — which can move DOWNWARD
-- (staging already carries a row with −50 drift). A user sitting just above a threshold who is
-- healed downward drops a level at 04:00, silently. The trigger is unconditional, and the same
-- property that makes it REPAIR a wrong row is the one that lets it demote a corrected one.
-- ACCEPTED, not mitigated, for two reasons: (a) `level` is defined as a pure function of `xp`, and
-- a GREATEST(old_level, …) ratchet would break that — it would make the column depend on write
-- history rather than on state, and the reconciler could then never correct an inflated level;
-- (b) nothing is actually lost — user_achievements rows are NEVER deleted, so a demotion cannot
-- revoke `level_5` or `level_9` once earned.
-- BINDING ON THE UI: never surface a level DECREASE. Show the current level; do not animate,
-- announce, or explain a drop. `leveled_up` is deliberately a one-directional flag — there is no
-- `leveled_down`, and there must not be one. If a persistent high-water mark is ever wanted for
-- display, add a separate `max_level_reached` column; do not make `level` a ratchet.

-- ── xp_level_floor(L): the curve's FORWARD form, and its definition of record ────────────────
-- Exact integer arithmetic. xp_level() below is its inverse; gates.yml proves they agree over
-- levels 2..200 at both the floor and floor−1, so the inverse can never drift from the definition.
-- Levels below 1 clamp to 1 (floor 0) — there is no level 0 and no negative XP band.
CREATE OR REPLACE FUNCTION public.xp_level_floor(p_level integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
  SELECT CASE
           WHEN GREATEST(p_level, 1) <= 10
             THEN (100 * (GREATEST(p_level, 1) - 1) * (GREATEST(p_level, 1) - 1))
           ELSE 8100 + 1900 * (GREATEST(p_level, 1) - 10)
         END::int
$$;

COMMENT ON FUNCTION public.xp_level_floor(integer) IS
  'V4-XPPROGRESSION-001. Total XP required to reach level L: 100*(L-1)^2. Inverse of xp_level().';

-- ── xp_level(xp): the inverse, and the single definition every writer resolves through ───────
-- NUMERIC, not double precision, on purpose. The boundary cases are exactly the perfect squares,
-- and a float sqrt landing at 3.9999999999 instead of 4.0 would silently hold a user one level
-- short at the precise moment they crossed — a rounding bug that only ever fires on the rung it
-- matters most. numeric sqrt is exact-decimal and deterministic; verified against live Neon over
-- levels 1..200 at both xp_level_floor(L) and xp_level_floor(L)-1, zero mismatches, and re-proved
-- on every apply by the gates.
-- NULL/negative XP clamps to level 1 rather than erroring: this function is read inside the
-- achievement evaluator, which runs in a non-fatal try/catch, and a raise there would take the
-- whole evaluation down rather than degrade.
CREATE OR REPLACE FUNCTION public.xp_level(p_xp integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
           WHEN GREATEST(COALESCE(p_xp, 0), 0) >= 8100
             -- Plateau: constant 1,900 XP bands from level 10 up. Pure integer division, so no
             -- rounding question arises above the join at all.
             THEN 10 + ((GREATEST(COALESCE(p_xp, 0), 0) - 8100) / 1900)
           ELSE GREATEST(1, (floor(sqrt(GREATEST(COALESCE(p_xp, 0), 0)::numeric / 100)) + 1)::int)
         END::int
$$;

COMMENT ON FUNCTION public.xp_level(integer) IS
  'V4-XPPROGRESSION-001. Level for a given lifetime XP: floor(sqrt(xp/100))+1, min 1. Canonical — '
  'user_stats.level is maintained from this by trg_user_stats_level; no application code may '
  'compute a level for storage.';

-- ── The trigger: makes level = xp_level(xp) an invariant of the table, not a caller obligation ──
-- BEFORE INSERT OR UPDATE, unconditional. Not gated on `WHEN (NEW.xp IS DISTINCT FROM OLD.xp)`,
-- deliberately: an unconditional assignment also REPAIRS a row whose level was wrong for any other
-- reason (the two rows this migration inherits, a hand-edit, a restore from an old dump) on the
-- next write of any column. Gating it would make the trigger correct only for rows that were
-- already correct.
-- Cost is a few integer operations on a table written a handful of times per logging action.
CREATE OR REPLACE FUNCTION public.user_stats_set_level()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.level := public.xp_level(NEW.xp);
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.user_stats_set_level() IS
  'V4-XPPROGRESSION-001. BEFORE INSERT OR UPDATE on user_stats: derives level from xp so every '
  'xp writer (events single, events batch, resolve path, xp-reconcile) maintains it for free.';

DROP TRIGGER IF EXISTS trg_user_stats_level ON public.user_stats;
CREATE TRIGGER trg_user_stats_level
  BEFORE INSERT OR UPDATE ON public.user_stats
  FOR EACH ROW
  EXECUTE FUNCTION public.user_stats_set_level();

-- ── RETIREMENT: xp_events.reason = 'photo_bonus' ─────────────────────────────────────────────
-- Recorded here because this is the migration that audits the XP economy, and leaving a third dead
-- reason undocumented is how it stayed dead for four months.
-- MEASURED (live prod 2026-08-04): 10 rows, 5 XP each, 50 XP total, ALL between 2026-04-23 and
-- 2026-04-26, ALL belonging to user_3CxBEbOgG0fmeGmB6D0ohTju0wv — a third user_id that appears in
-- xp_events but has NO user_stats row at all. Zero rows in the last 90 days. The only writer ever
-- to emit it was the Supabase-era client-side garden-ops.js (const PHOTO_BONUS_XP = 5), removed by
-- DB-MIGRATE-2; nothing in lambda/ or src/ references it today.
-- DECISION: RETIRE the concept, KEEP the rows.
--   • Not wired, because wiring contradicts the binding reward grain. Photos arrive on a SEPARATE
--     request after the event exists (POST /api/events then POST /api/photos), so the grant would
--     have to live in lambda/photos — a Lambda with no XP machinery — and a bulk photo upload is
--     ONE logging action producing many photos. Per-photo XP is the per-EVENT grain that
--     critterAward.js's "one logging action = one shot at the reward" already forbids. Photo
--     volume belongs in the MILESTONE channel, where it already has a home: the `photo_habit`
--     achievement ({"count": 10}) — itself unfireable today for the same missing-branch reason as
--     level_5, and tracked separately.
--   • Rows are NOT deleted. lambda/xp-reconcile treats SUM(xp_events.amount) as canonical and
--     heals user_stats.xp from it; deleting 50 XP of real ledger history would make the reconciler
--     "correct" a balance that was never wrong. Destructive, and buys nothing.
--   • No CHECK constraint is added to pin the live reason set. Arming one would be a deploy, not a
--     migration (2026-08-03), and it would reject the historical rows it is meant to describe.
--     Enforcement is instead a static-source test (lambda/events/xp-level.test.js) asserting no
--     Lambda emits a reason outside {event_logged, achievement_earned}.

INSERT INTO public.schema_version (version, description)
VALUES ('4.22.0-xpprogression-001',
        'xp_level()/xp_level_floor() curve + trg_user_stats_level — user_stats.level derived from xp on every write')
ON CONFLICT (version) DO NOTHING;
