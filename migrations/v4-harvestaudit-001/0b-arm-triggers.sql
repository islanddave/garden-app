-- 0b-arm-triggers.sql
-- OPS-HARVESTAUDIT-001 — attach the audit triggers. THIS is the phase that changes behaviour.
--
--   psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v4-harvestaudit-001/0b-arm-triggers.sql
--
-- Requires 0a. Attaching a trigger to a function that does not exist fails at CREATE TRIGGER, so the
-- ordering is enforced by Postgres and not only by the runbook.
--
-- ── WHY THIS NEEDS NO LAMBDA DEPLOY BEFORE OR AFTER IT ────────────────────────────────────────────
-- Adding a trigger normally has deploy-ordering consequences, because a trigger that references a
-- column the deployed writer does not set, or that writes a shape the writer does not expect, breaks
-- the live writer the moment it lands. Three measured facts say this one does not:
--
--   * It writes ONLY to public.audit_events, which no Lambda and no SPA surface reads. Nothing
--     downstream can be surprised by its output.
--   * It cannot raise. Every INSERT is inside 0a's exception handler, so the worst case is a WARNING
--     in the Postgres log and a missing audit row — never a failed user write.
--   * The actor GUC it reads is ALREADY SET by the deployed code on the paths that matter.
--     lambda/events/index.js sets `set_config('app.actor_clerk_sub', userId, true)` inside the same
--     transaction as the soft-delete UPDATE (the DELETE handler at the `stmts` array), and
--     lambda/plants, lambda/varieties and lambda/photos do the same on their write paths. Where it
--     is not set — a psql session, a migration, a Lambda path that never needed it — the actor
--     degrades to the literal 'system' rather than failing, exactly as trg_audit_plant_varieties has
--     behaved since 2026-05-11.
--
-- So 0a/0b are safe to apply against the currently deployed artifact with no promote on either side.
-- The one thing a later deploy could improve is attribution, not correctness: see README.md
-- §What was deliberately not built.
--
-- ── THE WATCHED LISTS ─────────────────────────────────────────────────────────────────────────────
-- Passed as trigger arguments, so the classification is visible in pg_get_triggerdef() on a live
-- database and does not require reading this file to recover. Every column of each table is either
-- watched here or named in the ignored list in gates.yml; the completeness gate fails if a column is
-- in neither, so a future ALTER TABLE ... ADD COLUMN cannot open a silent hole.
--
-- Watched = the column can change a total, change which planting/container a row counts toward,
-- change whether the row is visible, or change who is credited with it. Ignored = annotation,
-- workflow state, or machine-maintained bookkeeping.
--
-- Two ignored columns are worth naming explicitly because ignoring them is what makes this design
-- work at all:
--   * updated_at — set by set_updated_at on EVERY update. Watching it would audit every update and
--     collapse this design back into the unfiltered one.
--   * source     — the target of 4.21.3-eventsource-001-backfill, the single statement that touched
--     11,201 rows. It is a classification of how an event was created, not part of any total.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- harvest_log — 735 rows, no triggers of any kind before this migration. The table crop totals are
-- actually summed from, so its watched list is deliberately the widest relative to the table.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_audit_harvest_log_del ON public.harvest_log;
CREATE TRIGGER trg_audit_harvest_log_del
  AFTER DELETE ON public.harvest_log
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.audit_stmt_delete();

DROP TRIGGER IF EXISTS trg_audit_harvest_log_upd ON public.harvest_log;
CREATE TRIGGER trg_audit_harvest_log_upd
  AFTER UPDATE ON public.harvest_log
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.audit_stmt_update(
    'project_id', 'event_id', 'quantity', 'unit',
    'weight_grams', 'weight_estimated', 'weight_basis',
    'deleted_at', 'created_by', 'created_at',
    -- disposition arrives in the SAME fleet, from v4-losscapture-001/0a. This bundle's watched list
    -- was authored against a schema that did not yet have the column, so it was neither watched nor
    -- in gates.yml's `ignored` set — post_column_classification_is_complete caught it on the staging
    -- apply (1 row: harvest_log|disposition). Watched, not ignored: it is classificatory data a user
    -- sets and can change (dropped|culled|aborted|damaged), not an annotation like notes or
    -- quality_rating, and a silent edit to it changes what a pick MEANS without changing its total.
    'disposition'
  );

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- event_log — 15,019 rows and the batch-shaped one. metadata is watched because it is where the
-- V4-LOSSEVENT-001 reduction ledger stores qty_reduced and loss_reason: that lane's counters on
-- plants are driven by, and reversed from, this jsonb, so a lost or edited metadata value is
-- precisely the shape that turns into an unexplainable number.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_audit_event_log_del ON public.event_log;
CREATE TRIGGER trg_audit_event_log_del
  AFTER DELETE ON public.event_log
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.audit_stmt_delete();

DROP TRIGGER IF EXISTS trg_audit_event_log_upd ON public.event_log;
CREATE TRIGGER trg_audit_event_log_upd
  AFTER UPDATE ON public.event_log
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.audit_stmt_update(
    'project_id', 'plant_id', 'location_id',
    'event_type', 'event_date',
    'quantity', 'quantity_numeric', 'metadata',
    'is_public', 'logged_by',
    'deleted_at', 'created_by', 'created_at'
  );

INSERT INTO public.schema_version (version, description)
VALUES ('4.36.0-harvestaudit-001',
        'OPS-HARVESTAUDIT-001 0b: audit_events triggers ARMED on harvest_log + event_log (statement-level, column-scoped UPDATE, no INSERT arm).')
ON CONFLICT (version) DO NOTHING;

COMMIT;
