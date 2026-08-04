-- V4-EVENTSOURCE-001 / 0c-pre — collapse duplicate XP ledger grants so 0c's unique index can build.
--
-- WHY THIS FILE EXISTS: 0c was authored and verified against PROD, where duplicate
-- (user_id, reason, source_id) groups number ZERO. Applying it to STAGING failed:
--
--   ERROR: could not create unique index "uq_xp_events_user_reason_source"
--   DETAIL: Key (user_id, reason, source_id)=(user_3CxBE…, achievement_earned, 6ebd7ed9-…)
--           is duplicated.
--
-- Staging holds 6 duplicated groups (14 rows collapsing to 6), every one `achievement_earned`
-- for a single account, dated 2026-05-12 → 2026-05-31. A migration that only applies cleanly in
-- one environment is not a migration, hence this step rather than a hand-fix on staging.
--
-- WHY DELETING THESE IS A REPAIR, NOT DATA LOSS: `achievement_earned` is once-per-(user,
-- achievement) by design — `user_achievements` enforces it with ON CONFLICT (user_id,
-- achievement_id). A second XP grant for an achievement already earned is the exact defect 0c's
-- index exists to make impossible; leaving the rows would mean the ledger permanently over-counts
-- that user's XP. `lambda/xp-reconcile` heals `user_stats.xp` from SUM(xp_events.amount), so the
-- cache follows the ledger automatically once the duplicates are gone.
--
-- ON PROD THIS IS A NO-OP — 0 rows match. Verified 2026-08-04.
--
-- CONSERVATIVE BY CONSTRUCTION: keeps the EARLIEST row per group (the legitimate first grant,
-- ordered by created_at then id so the choice is deterministic, never arbitrary) and removes only
-- the later repeats. It touches no group of size 1 and no row with a NULL source_id (which 0c's
-- partial index exempts anyway).

BEGIN;

CREATE TEMP TABLE _xp_dupes_removed AS
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id, reason, source_id
           ORDER BY created_at, id
         ) AS rn
  FROM public.xp_events
  WHERE source_id IS NOT NULL
)
SELECT id FROM ranked WHERE rn > 1;

DELETE FROM public.xp_events e
USING _xp_dupes_removed d
WHERE e.id = d.id;

-- Fail loudly rather than silently leaving 0c to error: if any duplicate survives, stop here.
DO $$
DECLARE remaining int;
BEGIN
  SELECT count(*) INTO remaining FROM (
    SELECT 1 FROM public.xp_events
    WHERE source_id IS NOT NULL
    GROUP BY user_id, reason, source_id HAVING count(*) > 1
  ) s;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'xp_events still has % duplicate (user_id, reason, source_id) group(s) after dedupe', remaining;
  END IF;
END $$;

INSERT INTO public.schema_version (version, description)
VALUES ('4.21.2-eventsource-001-xpdedupe',
        'Collapse duplicate xp_events (user_id, reason, source_id) grants — prerequisite for the 0c unique index; no-op on prod')
ON CONFLICT (version) DO NOTHING;

COMMIT;
