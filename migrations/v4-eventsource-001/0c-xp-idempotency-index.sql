-- V4-EVENTSOURCE-001 / 0c — make the XP ledger idempotent by CONSTRAINT, not by convention.
-- Prerequisite for BUG-BATCHSIDEEFFECTS-001: the batch path is about to start granting flat XP,
-- and a retried batch must not double-grant. Today nothing in the schema prevents that — xp_events
-- has NO uniqueness on source_id, so every INSERT is a blind append.
--
-- WHY (user_id, reason, source_id) IS THE RIGHT KEY, verified against live prod 2026-08-04:
--   • 'event_logged'       source_id = event_log.id  (single path) / event_batches.id (batch path,
--                          new). Both are per-grant-unique UUIDs.
--   • 'achievement_earned' source_id = achievements.id, which REPEATS across users — hence
--                          user_id must be in the key. Per (user, achievement) it is already
--                          once-only via user_achievements ON CONFLICT (user_id, achievement_id).
--   • 'photo_bonus'        10 rows, all 2026-04, NO live writer anywhere in lambda/ (grep). Dead.
--   • duplicate (user_id, reason, source_id) groups in the live table: 0
--   • rows with source_id IS NULL: 0 of 266  (index is partial anyway, so future NULLs are exempt)
--
-- BACKWARD COMPATIBILITY: no currently-deployed writer can violate this. The single-event
-- 'event_logged' grant always carries a brand-new event id; the 'achievement_earned' grant only
-- fires for rows the same statement just INSERTed into user_achievements. So applying this ahead of
-- the code deploy cannot 23505 the running Lambda. It is nonetheless a NARROWING change, which is
-- why it is its own file and its own gate.
--
-- INTERACTION WITH lambda/xp-reconcile: that function heals user_stats.xp from SUM(xp_events.amount)
-- and is the reason integrity-weekly's `user_stats_drift` reads 1 (its baseline) rather than
-- climbing. With this index the ledger becomes the idempotent source of truth and the cache
-- self-heals — so an ON CONFLICT DO NOTHING that skips the in-line user_stats.xp bump is safe by
-- construction rather than by hope.

CREATE UNIQUE INDEX IF NOT EXISTS uq_xp_events_user_reason_source
  ON public.xp_events (user_id, reason, source_id)
  WHERE source_id IS NOT NULL;

INSERT INTO public.schema_version (version, description)
VALUES ('4.21.1-eventsource-001-xpidem',
        'UNIQUE (user_id, reason, source_id) WHERE source_id IS NOT NULL on xp_events — retry-safe XP grants for the batch path')
ON CONFLICT (version) DO NOTHING;
