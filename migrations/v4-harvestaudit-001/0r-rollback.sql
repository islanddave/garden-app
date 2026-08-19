-- 0r-rollback.sql
-- OPS-HARVESTAUDIT-001 — undo 0b then 0a.
--
--   psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v4-harvestaudit-001/0r-rollback.sql
--
-- Triggers first, then the functions they point at: DROP FUNCTION would otherwise fail on the
-- dependency, which is a safety property rather than an inconvenience — it makes a half-rollback
-- that leaves live triggers pointing at a dropped function impossible.
--
-- THIS ROLLBACK CANNOT FAIL ON DATA. It removes writers, not constraints, so there is no stored row
-- that can refuse it — the asymmetry with a constraint rollback, which legitimately aborts when data
-- has moved on.
--
-- WHAT IT DELIBERATELY DOES NOT DO: it does not delete the audit_events rows the triggers wrote.
-- Those rows are the evidence this migration exists to collect, and a rollback of the MECHANISM is
-- not a decision to destroy the RECORD. They remain queryable by table_name, and they are the only
-- copy — the rows they describe are already gone. To discard them as well, deliberately and
-- separately:
--
--   DELETE FROM public.audit_events WHERE table_name IN ('event_log','harvest_log');
--
-- Re-applying is 0a then 0b; both are idempotent (CREATE OR REPLACE, DROP TRIGGER IF EXISTS).

BEGIN;

DROP TRIGGER IF EXISTS trg_audit_event_log_upd   ON public.event_log;
DROP TRIGGER IF EXISTS trg_audit_event_log_del   ON public.event_log;
DROP TRIGGER IF EXISTS trg_audit_harvest_log_upd ON public.harvest_log;
DROP TRIGGER IF EXISTS trg_audit_harvest_log_del ON public.harvest_log;

DROP FUNCTION IF EXISTS public.audit_stmt_update();
DROP FUNCTION IF EXISTS public.audit_stmt_delete();
DROP FUNCTION IF EXISTS public.audit_watched_slice(jsonb, text[]);

DELETE FROM public.schema_version
 WHERE version IN ('4.36.0-harvestaudit-001', '4.36.0-harvestaudit-001-fn');

COMMIT;
