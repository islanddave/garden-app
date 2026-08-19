-- 0a-additive-ddl.sql
-- OPS-HARVESTAUDIT-001 — audit_events coverage for harvest_log + event_log.
--
--   psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v4-harvestaudit-001/0a-additive-ddl.sql
--
-- PHASE 0a IS INERT. It creates three functions and attaches NOTHING. No trigger exists after this
-- file, so no write path changes behaviour and the deployed Lambdas cannot notice it ran. Arming is
-- 0b, deliberately separate — see README.md §Deploy order.
--
-- WHY THIS MIGRATION EXISTS. public.audit_events has been live since 2026-05-11 and holds 1,872
-- rows, every one of them plant_varieties, written by trg_audit_plant_varieties. harvest_log carries
-- NO triggers at all and event_log carries only set_updated_at + prevent_ownership_transfer. So a
-- row that leaves either table leaves no trace, which is what made a disputed crop total
-- unreconstructable (the tomato-total probe).
--
-- ── THREE DESIGN DECISIONS, each measured on live prod rather than assumed ────────────────────────
--
-- (1) STATEMENT-LEVEL, NOT ROW-LEVEL. event_log is batch-shaped: grouping real prod rows into
--     one-second buckets gives a max of 157 rows in a single second and 87 separate bursts of 50+.
--     runBulk fan-out writes ~150 rows for ONE human action. A FOR EACH ROW trigger would run 157
--     times — and, because each carries an exception block (decision 3), open 157 subtransactions —
--     where a FOR EACH STATEMENT trigger with transition tables does the same work in one
--     INSERT ... SELECT. The hard-delete path is statement-shaped too: archive_plant_events issues a
--     single `DELETE FROM public.event_log e WHERE e.id = ANY(v_ids)`.
--
-- (2) UPDATE IS COLUMN-SCOPED. An unfiltered UPDATE audit is not merely expensive, it is
--     self-defeating. 12,275 of 15,019 event_log rows show updated_at > created_at, but 11,775 of
--     those updates (96%) landed in bulk bursts, and 11,201 of them landed in ONE second —
--     2026-08-04 18:53:13, which is exactly the applied_at of 4.21.3-eventsource-001-backfill, a
--     migration whose only write is `UPDATE public.event_log SET source = ...`. Auditing every
--     UPDATE would have written 11,201 rows (~20 MB of before+after jsonb) for one schema backfill
--     into a table that is 5.5 MB in total, burying the handful of real user edits. So each trigger
--     carries an explicit WATCHED column list and fires only when one of those columns actually
--     moved. Under this design that backfill writes ZERO audit rows.
--
--     The watched list is an ALLOWLIST, which has a real failure mode: a quantity-bearing column
--     added later would be silently unaudited. That is closed by gates.yml, which fails when any
--     column of either table is neither watched nor explicitly ignored — so schema growth forces a
--     human decision instead of opening a quiet gap.
--
-- (3) THE AUDIT CAN NEVER ABORT THE WRITE IT IS AUDITING. audit_events.actor_clerk_sub is NOT NULL
--     with no default, so a trigger that cannot produce an actor raises 23502 and kills the user's
--     write. That matters more now than it used to: V4-LOSSEVENT-001 adds the schema's first
--     accumulating writer (plant-reduction events whose metadata drives counters on plants, reversed
--     on delete), and an audit row is not worth failing a counter transaction for. Every audit INSERT
--     is therefore wrapped in an exception block that degrades to a WARNING. Cancellation is
--     deliberately NOT swallowed — see the handler.
--
-- INSERT IS NOT AUDITED, and that is a decision rather than an omission. For the question this
-- migration exists to answer — "which rows existed, with which values, at time T" — an INSERT audit
-- row is redundant twice over: a row that still exists carries its own created_at, and a row that
-- was hard-deleted has its complete pre-image in the DELETE audit's before_jsonb (created_at
-- included, and created_at is itself watched, so a later edit to it is captured). INSERT is also
-- where 100% of the batch amplification lives — it is the 157-row bursts. Auditing it would roughly
-- double the write volume of the hottest table in the schema to record facts already on the row.
-- Adding an INSERT arm later is one CREATE TRIGGER; see README.md §What was deliberately not built.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- audit_watched_slice — project a row's jsonb down to the watched keys, so two versions of a row can
-- be compared on the columns that matter and nothing else.
--
-- A key absent from the row yields SQL NULL from `->`, which jsonb_object_agg stores as JSON null.
-- Both sides then agree and the column silently stops being watched. That is the allowlist's vacuity
-- mode, and it is why gates.yml asserts every watched name is a real column of the table rather than
-- trusting this function to notice.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.audit_watched_slice(p_row jsonb, p_keys text[])
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(jsonb_object_agg(k, p_row -> k), '{}'::jsonb) FROM unnest(p_keys) AS k
$$;

COMMENT ON FUNCTION public.audit_watched_slice(jsonb, text[]) IS
  'OPS-HARVESTAUDIT-001. Projects a row-as-jsonb onto the audit trigger''s watched column list so an '
  'UPDATE is audited only when a forensically material column moved.';

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- audit_stmt_delete — one audit row per hard-deleted row, written by a single INSERT ... SELECT over
-- the OLD transition table.
--
-- SECURITY DEFINER, which trg_audit_plant_varieties is not. The deviation is deliberate: this
-- function's INSERT is inside an exception handler, so a permission failure would be swallowed into
-- a WARNING and the gap would be invisible. Running as the owner means the capture cannot fail for
-- want of a grant. search_path is pinned, which is what makes SECURITY DEFINER safe here.
--
-- TG_TABLE_NAME rather than a TG_ARGV string: it cannot drift from the table the trigger is on.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.audit_stmt_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  BEGIN
    INSERT INTO public.audit_events
           (table_name, row_id, action, actor_clerk_sub, before_jsonb, after_jsonb)
    SELECT TG_TABLE_NAME,
           o.id,
           'DELETE',
           -- NULLIF before COALESCE: current_setting(..., true) yields NULL when the GUC was never
           -- set but '' when it was set to the empty string, and only the first is caught by a bare
           -- COALESCE. An empty actor satisfies NOT NULL and is useless forensically.
           COALESCE(NULLIF(current_setting('app.actor_clerk_sub', true), ''), 'system'),
           to_jsonb(o),
           NULL
      FROM old_rows o;
  EXCEPTION
    -- Never swallow cancellation or shutdown: those are the operator asking the statement to stop,
    -- and converting them to a WARNING would make this trigger un-cancellable.
    WHEN query_canceled OR admin_shutdown THEN
      RAISE;
    WHEN OTHERS THEN
      RAISE WARNING 'audit_stmt_delete(%): audit write FAILED, SQLSTATE=% (%). The originating DELETE is unaffected.',
        TG_TABLE_NAME, SQLSTATE, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.audit_stmt_delete() IS
  'OPS-HARVESTAUDIT-001. AFTER DELETE FOR EACH STATEMENT audit writer. Requires '
  'REFERENCING OLD TABLE AS old_rows. Cannot abort the originating statement.';

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- audit_stmt_update — SOFT_DELETE / RESTORE / UPDATE, from the OLD+NEW transition tables.
--
-- The deleted_at delta is tested on its own and NOT via the watched slice. That is redundant, since
-- deleted_at is in both watched lists, and the redundancy is the point: a row leaving or re-entering
-- view is the single most forensically important UPDATE there is, and it stays audited even if a
-- future edit drops deleted_at from the trigger's argument list.
--
-- Rows are joined on id. event_log and harvest_log both have a uuid primary key named id, and
-- prevent_ownership_transfer plus the absence of any id-rewriting path make it stable across an
-- UPDATE. gates.yml asserts the id column exists on both tables.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.audit_stmt_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_watched text[] := TG_ARGV;
BEGIN
  BEGIN
    INSERT INTO public.audit_events
           (table_name, row_id, action, actor_clerk_sub, before_jsonb, after_jsonb)
    SELECT TG_TABLE_NAME,
           n.id,
           CASE
             WHEN o.deleted_at IS NULL     AND n.deleted_at IS NOT NULL THEN 'SOFT_DELETE'
             WHEN o.deleted_at IS NOT NULL AND n.deleted_at IS NULL     THEN 'RESTORE'
             ELSE 'UPDATE'
           END,
           COALESCE(NULLIF(current_setting('app.actor_clerk_sub', true), ''), 'system'),
           to_jsonb(o),
           to_jsonb(n)
      FROM new_rows n
      JOIN old_rows o ON o.id = n.id
     WHERE o.deleted_at IS DISTINCT FROM n.deleted_at
        OR public.audit_watched_slice(to_jsonb(o), v_watched)
           IS DISTINCT FROM
           public.audit_watched_slice(to_jsonb(n), v_watched);
  EXCEPTION
    WHEN query_canceled OR admin_shutdown THEN
      RAISE;
    WHEN OTHERS THEN
      RAISE WARNING 'audit_stmt_update(%): audit write FAILED, SQLSTATE=% (%). The originating UPDATE is unaffected.',
        TG_TABLE_NAME, SQLSTATE, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.audit_stmt_update() IS
  'OPS-HARVESTAUDIT-001. AFTER UPDATE FOR EACH STATEMENT audit writer. Requires REFERENCING OLD '
  'TABLE AS old_rows NEW TABLE AS new_rows, and the watched column list as trigger arguments. '
  'Cannot abort the originating statement.';

INSERT INTO public.schema_version (version, description)
VALUES ('4.36.0-harvestaudit-001-fn',
        'OPS-HARVESTAUDIT-001 0a: audit trigger FUNCTIONS for harvest_log + event_log. Inert — no trigger attached yet.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
