-- V4-XPPROGRESSION-001 — rollback.
--
-- FULLY REVERSIBLE, with one honest asymmetry stated up front: dropping the trigger restores the
-- old behaviour (level stops tracking xp) but does NOT restore the old VALUES. Levels 7 and 3 stay
-- on the two prod rows unless you also run the optional reset at the bottom. That is the right
-- default — reverting the mechanism should not silently re-break two users back to level 1, and a
-- correct level is harmless to the old code, which never reads the column.
--
-- Reversal order is the inverse of application: trigger, then trigger function, then the curve
-- functions the trigger depends on. Dropping xp_level() while the trigger still referenced it
-- would leave every user_stats write failing 42883 — the reason this order is not negotiable.
--
-- SEQUENCING VS THE CODE: revert the Lambda FIRST if the new code is deployed. With the trigger
-- gone, the `WHEN 'level'` evaluator branch reads a frozen level and simply stops granting — it
-- does not error — so a code-still-deployed rollback is degraded, not broken. But the dashboard's
-- `SELECT … level FROM user_stats` and the responses' `level` field keep working either way,
-- because the column itself is untouched by this file.

DROP TRIGGER IF EXISTS trg_user_stats_level ON public.user_stats;
DROP FUNCTION IF EXISTS public.user_stats_set_level();

DROP FUNCTION IF EXISTS public.xp_level(integer);
DROP FUNCTION IF EXISTS public.xp_level_floor(integer);

-- 0c content. Removing the four rows is safe ONLY if nobody has earned one: user_achievements
-- carries an FK to achievements.id, so a DELETE would either fail or cascade away a badge someone
-- actually holds. The guard makes the rollback a no-op for any level already reached rather than
-- a silent revocation.
DELETE FROM public.achievements a
 WHERE a.slug IN ('level_12', 'level_15', 'level_20', 'level_25')
   AND NOT EXISTS (SELECT 1 FROM public.user_achievements ua WHERE ua.achievement_id = a.id);

DELETE FROM public.schema_version
 WHERE version IN ('4.22.0-xpprogression-001', '4.22.1-xpprogression-001-backfill',
                   '4.22.2-xpprogression-001-content');

-- OPTIONAL — only if you specifically want the pre-migration values back. Uncomment deliberately.
-- The literal 1 is the column DEFAULT and was the only value the old code ever wrote.
-- UPDATE public.user_stats SET level = 1 WHERE level <> 1;
