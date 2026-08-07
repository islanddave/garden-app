-- 0b-data.sql
-- V4-LASTISSUEPLANT-001 — backfill entity_memory.last_issue_at on the PLANT-KEYED arm
-- (BUG-LASTISSUEPLANT-001).
--
-- WHY: the plant-keyed forward upsert in lambda/events/index.js was introduced by care-rekey-001
-- Step B as an ADDITIVE dual-write whose column set was copied from care-rekey-001/0b-backfill.sql.
-- That backfill has no last_issue_at mapping — the column is driven by event_log.flagged_as_issue,
-- not by event_type, so it had no natural home in an event_type-keyed column list. The omission was
-- then inherited by every plant-keyed maintenance arm. Net result on prod at authoring time: ALL 262
-- plant-keyed rows read NULL, and 72 of them are BEHIND the event log — exactly the 72 live flagged
-- events, one per planting. The project-keyed arm has always written the column and measures clean.
--
-- This is the follow-up v4-carecacheundo-001/0b-data.sql explicitly deferred. Its header reads:
--   "last_issue_at — driven by event_log.flagged_as_issue, not by event_type, so it has no mapping
--    in 0b-backfill.sql. Same bug class ... but a separate mapping and a separate decision;
--    measured at authoring time and reported in README.md rather than repaired blind."
-- This file is that separate decision, made.
--
-- DATA-ONLY. No DDL on any app table; no column, constraint, index or view is touched. The one
-- snap_* table is rollback scaffolding (see 0r) and is the only object created.
--
-- ═══ DIRECTION IS THE WHOLE DESIGN — READ BEFORE EDITING ═══
-- This file walks the cache FORWARDS ONLY, and it is the exact mirror of its sibling. A cell is
-- rewritten if and only if it is STRICTLY BEHIND the surviving-event truth (including the dominant
-- case here, "cached NULL, truth non-NULL"). A cell AHEAD of the truth is left exactly as found.
--
-- Forwards is correct HERE because the defect is a writer that never fired: there is no value to
-- lower, only a value that was never recorded. Measured before writing: 0 plant-keyed rows are ahead
-- (see gate P3). If that count is ever non-zero, those rows are NOT this ticket — an AHEAD
-- last_issue_at means an undone flagged event left a stale value, which is the CARECACHEUNDO class,
-- and its repair is the recompute arms in lambda/events/index.js that now carry last_issue_at.
-- Widening this file to "set every cell to truth" would merge the two tickets and destroy the
-- before/after measurement each one owns. Do not.
--
-- ═══ THE FLAG IS THE KEY, NOT THE EVENT TYPE ═══
-- last_issue_at is MAX(event_date) over events with flagged_as_issue = true. It deliberately does
-- NOT filter on event_type: any event type can be flagged, and the project-keyed forward writer
-- keys on the flag alone. A recompute must be the exact inverse of its arm's writer, and after the
-- accompanying Lambda change both arms' writers key on the flag. An event_type-scoped truth here
-- would compute a value no forward write has ever produced.
--
-- ═══ NOT IN SCOPE ═══
--   * project-keyed rows — their writer has always set this column and they measure clean (7 rows
--     populated, 0 ahead, 0 behind). Touching them would blur the arm boundary this ticket is
--     scoped by. The accompanying Lambda change adds last_issue_at to their recompute arms, which
--     is what keeps them clean going forward.
--   * next_water_at on the plant arm — still deliberately absent. The nightly daily-plan engine
--     owns "due"; this writer does not.
--   * location-keyed entity_memory rows — no event path writes them.
--
-- SCOPE: every plant-keyed entity_memory row, INCLUDING rows whose planting is archived or
-- soft-deleted and rows whose container is soft-deleted. A stale cache on a hidden row is still a
-- lie, it costs nothing to correct, and leaving it would make the post gates assert "zero except the
-- ones we chose not to look at" — the same reasoning the sibling file states.
--
-- SAFETY: idempotent (a second run finds nothing behind and matches zero rows). Fully reversible via
-- 0r using the snapshot. Never lowers a cell — the only possible movement is toward the event log.
--
-- ORDERING: this file and the Lambda change are order-INDEPENDENT and may ship in either order.
-- Nothing reads last_issue_at on the plant arm today (reads are still project-keyed until
-- care-rekey Step D cuts over), and the column is nullable with no CHECK. Applying the backfill
-- before the code leaves the 72 rows correct until the next flagged event on an unfixed writer;
-- applying it after leaves them NULL for longer. Neither can 500 and neither can lose data.

BEGIN;

-- ═══ PRE-GATES (advisory; recorded so the post-gates below are interpretable) ═══
--   P1  plant-keyed rows total                        expected 262
--   P2  plant-keyed rows BEHIND on last_issue_at      expected  72
--   P3  plant-keyed rows AHEAD on last_issue_at       expected   0   <-- if non-zero, STOP, see header
--   P4  project-keyed rows AHEAD or BEHIND            expected   0   (untouched by this file)
-- The queries are in README.md so they can be run outside the transaction, before and after.

-- Rollback snapshot, captured BEFORE any write. CREATE ... IF NOT EXISTS ... AS SELECT is a no-op on
-- re-run, which preserves the ORIGINAL pre-repair capture rather than overwriting it with the
-- post-repair state.
CREATE TABLE IF NOT EXISTS public.snap_lastissueplant001_entity_memory AS
SELECT em.id, em.plant_id, em.last_issue_at
  FROM public.entity_memory em
 WHERE em.plant_id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM public.event_log e
      WHERE e.plant_id = em.plant_id AND e.flagged_as_issue = true AND e.deleted_at IS NULL
        AND (em.last_issue_at IS NULL OR em.last_issue_at < e.event_date));

-- The repair. Forwards-only: raise to truth if BEHIND, otherwise keep exactly what is there.
--
-- Written as an explicit CASE and NOT as GREATEST(em.last_issue_at, t.t_issue): GREATEST ignores
-- NULL inputs in Postgres, so GREATEST(NULL, ts) returns ts and would appear to work — but the
-- explicit form states the direction in the source, which is the property the sibling file's
-- LEAST/NULL footgun proved is worth spelling out. Same reasoning, opposite direction.
UPDATE public.entity_memory em
   SET last_issue_at = CASE
         WHEN t.t_issue IS NOT NULL
          AND (em.last_issue_at IS NULL OR em.last_issue_at < t.t_issue) THEN t.t_issue
         ELSE em.last_issue_at
       END,
       updated_at = NOW()
  FROM (
    SELECT em2.id,
           (SELECT MAX(e.event_date) FROM public.event_log e
             WHERE e.deleted_at IS NULL
               AND e.flagged_as_issue = true
               AND e.plant_id = em2.plant_id) AS t_issue
      FROM public.entity_memory em2
     WHERE em2.plant_id IS NOT NULL
  ) t
 WHERE t.id = em.id
   AND t.t_issue IS NOT NULL
   AND (em.last_issue_at IS NULL OR em.last_issue_at < t.t_issue);

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.3-lastissueplant-001',
  'LASTISSUEPLANT backfill (data-only): populate entity_memory.last_issue_at on the plant-keyed arm '
  'from surviving flagged events. Forwards-only by construction — a cell AHEAD of the log is '
  'untouched, because that is the CARECACHEUNDO class and its repair is the recompute arms in '
  'lambda/events/index.js, which now carry last_issue_at on all six arms. The plant-keyed forward '
  'writer never set this column (care-rekey Step B copied its column list from 0b-backfill.sql, '
  'which is event_type-keyed and has no mapping for a flag-driven column), leaving all 262 '
  'plant-keyed rows NULL and 72 of them behind the event log. Explicitly deferred by '
  'v4-carecacheundo-001/0b-data.sql; this is that decision made. Rollback snapshot in '
  'snap_lastissueplant001_entity_memory.')
ON CONFLICT DO NOTHING;

COMMIT;
