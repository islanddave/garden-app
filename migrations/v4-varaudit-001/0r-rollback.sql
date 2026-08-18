-- 0r-rollback.sql
-- OPS-VARAUDIT-001 — restore the original row-level audit trigger.
--
--   psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v4-varaudit-001/0r-rollback.sql
--
-- Reverses 0b and 0a in one transaction. It CANNOT fail on data: it removes writers and re-attaches
-- one, and touches no constraint and no row of plant_varieties.
--
-- ── WHAT IS RESTORED, AND WHY IT IS EXACT ────────────────────────────────────────────────────────
-- 0b deliberately did not drop public.audit_plant_varieties_trigger(). The original function is
-- still on the database, byte-for-byte as it has been since 2026-05-11, so this file re-attaches THE
-- ORIGINAL OBJECT rather than re-creating it from a transcription that could have drifted. The
-- CREATE TRIGGER below reproduces pg_get_triggerdef's output for the live trigger verbatim:
--
--   CREATE TRIGGER trg_audit_plant_varieties AFTER INSERT OR DELETE OR UPDATE
--     ON public.plant_varieties FOR EACH ROW EXECUTE FUNCTION audit_plant_varieties_trigger()
--
-- If 0a ran but 0b did not, this file is still correct: DROP TRIGGER IF EXISTS is a no-op on the
-- three that were never attached, and re-creating trg_audit_plant_varieties over an identical live
-- one is idempotent.
--
-- ── WHAT IS DELIBERATELY *NOT* UNDONE ────────────────────────────────────────────────────────────
-- The audit_events rows written while the hardened triggers were armed are KEPT. They are the same
-- shape the row-level trigger writes — same actions, same payloads, same table_name — so they are
-- indistinguishable from the rest of the trail and deleting them would be the one destructive act in
-- a rollback that otherwise destroys nothing.
--
-- ── ORDERING ─────────────────────────────────────────────────────────────────────────────────────
-- Triggers before functions. A DROP FUNCTION with a trigger still attached fails on the dependency,
-- so the order is enforced by Postgres, not only by this comment. Same lock reasoning as 0b: the
-- swap back is atomic and there is no window in which the table is unaudited.

BEGIN;

SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS trg_audit_plant_varieties_ins ON public.plant_varieties;
DROP TRIGGER IF EXISTS trg_audit_plant_varieties_upd ON public.plant_varieties;
DROP TRIGGER IF EXISTS trg_audit_plant_varieties_del ON public.plant_varieties;

DROP TRIGGER IF EXISTS trg_audit_plant_varieties ON public.plant_varieties;
CREATE TRIGGER trg_audit_plant_varieties
  AFTER INSERT OR DELETE OR UPDATE ON public.plant_varieties
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_plant_varieties_trigger();

DROP FUNCTION IF EXISTS public.audit_pv_stmt_insert();
DROP FUNCTION IF EXISTS public.audit_pv_stmt_update();
DROP FUNCTION IF EXISTS public.audit_pv_stmt_delete();

DELETE FROM public.schema_version
 WHERE version IN ('4.38.0-varaudit-001', '4.38.0-varaudit-001-fn');

COMMIT;
