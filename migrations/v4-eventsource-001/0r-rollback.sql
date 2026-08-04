-- V4-EVENTSOURCE-001 — rollback.
--
-- REVERSIBILITY IS ASYMMETRIC AND THAT IS THE POINT OF THE MIGRATION ORDER (packet item 10):
--   • 0a (column) + 0b (backfill) + 0c (index) are ALL fully reversible — this file.
--   • dropping app_events is NOT reversible, and is deliberately NOT part of this migration.
--     Do not add it here. It is gated on this landing AND on the drift repair completing.
--
-- Reversal order is the inverse of application. Dropping the column takes the backfill with it,
-- so there is no separate "un-backfill" step; if you want to keep the column but redo the
-- classification, run `UPDATE public.event_log SET source = NULL` and re-run 0b instead.

DROP INDEX IF EXISTS public.uq_xp_events_user_reason_source;

DROP INDEX IF EXISTS public.idx_event_log_source;
ALTER TABLE public.event_log DROP CONSTRAINT IF EXISTS event_log_source_check;
ALTER TABLE public.event_log DROP COLUMN IF EXISTS source;

DELETE FROM public.schema_version
 WHERE version IN ('4.21.0-eventsource-001', '4.21.1-eventsource-001-xpidem');
