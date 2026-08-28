-- 0r-rollback.sql
-- V4-RAINAUTOLOG-001 — reverse 0b-data.sql.
--
-- Restores weather_daily from the snapshot, withdraws the backfilled rain events, and walks the care
-- cache back — in that order, so the cache step can reason about a log that no longer contains the
-- withdrawn rows.
--
-- ═══ THE EVENTS ARE SOFT-DELETED, NOT REMOVED ═══
-- The Soft-Delete-Only Rule lists events explicitly, and none of its carve-outs clearly covers these:
-- they are regenerable (re-running 0b reproduces them exactly), but "regenerable" in that rule means
-- caches and derived rollups, not rows sitting in the user's own history. A hard delete would also
-- need Dave's explicit approval, which this file must not assume it has. So deleted_at is set and the
-- rows stay.
--
-- CONSEQUENCE, stated rather than discovered later: 0b's re-run guard tests
-- `NOT EXISTS (... AND e.deleted_at IS NULL)`, so after this rollback a re-run of 0b WILL insert a
-- fresh set alongside the withdrawn ones. That is deliberate — it keeps 0b's guard about "is there a
-- LIVE rain row for this plant/day", which is the question that matters for correctness — but it
-- means rollback-then-reapply leaves 1,696 soft-deleted rows behind. If that is not wanted, hard-
-- delete them as a separate, explicitly approved act.
--
-- ═══ THE CACHE STEP IS PRECISE, NOT A BLANKET RESTORE ═══
-- A blanket "put entity_memory back to the snapshot" would be WRONG: the snapshot covers every
-- plant/project row, and ordinary garden use moves last_watered_at forward constantly. Restoring all
-- of them would silently undo real waterings logged since 0b ran.
-- Instead this restores only rows whose CURRENT last_watered_at is exactly one of the eight
-- backfilled rain instants — i.e. rows still sitting where 0b left them, untouched since. Any row a
-- real watering has moved past is left alone, which is the correct outcome for it.

BEGIN;

SELECT set_config('app.actor_clerk_sub', 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI', true);

-- ── 1. weather_daily, straight from the snapshot ────────────────────────────────────────────────
UPDATE public.weather_daily wd
   SET precip_in     = s.precip_in,
       precip_source = s.precip_source,
       updated_at    = now()
  FROM public.snap_rainbackfill001_weather_daily s
 WHERE s.date = wd.date
   AND s.space_id IS NOT DISTINCT FROM wd.space_id
   AND (wd.precip_in IS DISTINCT FROM s.precip_in OR wd.precip_source IS DISTINCT FROM s.precip_source);

-- ── 2. care cache, before the events go away ────────────────────────────────────────────────────
-- Ordered BEFORE the soft-delete on purpose: it identifies its targets by the backfilled event
-- instants, which is cheapest to express while those rows are still live and tagged.
UPDATE public.entity_memory em
   SET last_watered_at = s.last_watered_at,
       last_event_at   = s.last_event_at,
       next_water_at   = s.next_water_at,
       updated_at      = now()
  FROM public.snap_rainbackfill001_entity_memory s
 WHERE s.id = em.id
   AND em.last_watered_at IN (
         SELECT DISTINCT e.event_date
           FROM public.event_log e
          WHERE e.metadata->>'rain_backfill' = 'v4-rainbackfill-001'
            AND e.deleted_at IS NULL
       );

-- ── 3. withdraw the events ──────────────────────────────────────────────────────────────────────
UPDATE public.event_log
   SET deleted_at = now()
 WHERE metadata->>'rain_backfill' = 'v4-rainbackfill-001'
   AND deleted_at IS NULL;

DELETE FROM public.schema_version WHERE version = '4.62.0-rainbackfill-001';

-- The snapshots are deliberately LEFT IN PLACE. Dropping them here would make a second rollback
-- impossible and would destroy the only record of what the pre-migration values were. Drop them by
-- hand once the outcome is settled:
--   DROP TABLE public.snap_rainbackfill001_weather_daily;
--   DROP TABLE public.snap_rainbackfill001_entity_memory;

COMMIT;
