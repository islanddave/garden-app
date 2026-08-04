-- V4-XPPROGRESSION-001 / 0b — correct the levels that four months of a dead column left behind.
--
-- 0a installs the trigger, but a trigger only fires on a WRITE. Existing rows keep whatever level
-- they were stuck at until something happens to touch them, which for a low-traffic table could be
-- days. This file is the one-shot that makes the invariant true for rows that already exist.
--
-- IDEMPOTENT AND SELF-LIMITING. The WHERE clause means a second run touches zero rows, and the
-- statement is an ABSOLUTE assignment (level = f(xp)) with no increment anywhere — re-running it is
-- a no-op by construction, not by luck. It is also belt-and-braces with 0a: the trigger would set
-- the same value on the same UPDATE even if the SET list were omitted.
--
-- updated_at is deliberately NOT bumped. This is a derived-column repair, not user activity, and
-- the dashboard's "last active" surface reads last_active_date rather than updated_at — but
-- xp-reconcile's drift log and the integrity job both read updated_at as a write signal, and a
-- backfill that looks like 2 users doing something at 02:00 is noise in exactly the place the
-- reward accounting is audited from.
--
-- EXPECTED EFFECT ON LIVE PROD (measured 2026-08-04, both rows have drift 0 vs the ledger):
--   user_3D2gM0hIl03gjW3JM2DjtPzm0jI  xp 3790  level 1 -> 7
--   user_3E2xA85kQhr1vSZhiv4W1GLudJV  xp  445  level 1 -> 3
-- On staging the single row (user_3CxBEbOgG…, xp 2875) moves level 3 -> 6. Note staging's row
-- carries a −50 ledger drift that prod does not; that is xp-reconcile's business, not this file's,
-- and the level follows whatever xp the reconciler settles on because the trigger reruns on its
-- UPDATE. A migration verified only against prod would not have seen that row at all.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO: create a user_stats row for
-- user_3CxBEbOgG0fmeGmB6D0ohTju0wv, the third user_id present in prod xp_events (26 rows, 275 XP,
-- all April 2026) with no user_stats row. That absence is the known baseline of the
-- `user_stats_drift` integrity metric (scripts/integrity-baselines.json). Manufacturing a row for
-- an abandoned account to give it a level would move that baseline for a cosmetic reason and
-- would be a data change smuggled inside a derived-column repair.

UPDATE public.user_stats
   SET level = public.xp_level(xp)
 WHERE level IS DISTINCT FROM public.xp_level(xp);

INSERT INTO public.schema_version (version, description)
VALUES ('4.22.1-xpprogression-001-backfill',
        'backfill user_stats.level = xp_level(xp) for rows predating the trigger')
ON CONFLICT (version) DO NOTHING;
