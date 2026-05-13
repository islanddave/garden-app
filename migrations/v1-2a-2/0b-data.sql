-- V1.2a-2 Session 1 — 0b data backfill
-- Date: 2026-05-13
-- Scope: entity_memory.last_issue_at backfill (no-op at apply time: no flagged events
--        exist pre-migration since flagged_as_issue was just added with DEFAULT false).
--        Statement is idempotent; protects re-runs after manual data edits.
--        Notification subscription rows are initialized lazily by Session 2 Lambda.

BEGIN;

-- Backfill last_issue_at for any pre-existing flagged events.
UPDATE entity_memory em
SET last_issue_at = sub.max_flagged_at,
    updated_at = now()
FROM (
  SELECT project_id, MAX(created_at) AS max_flagged_at
  FROM event_log
  WHERE flagged_as_issue = true
    AND resolved_at IS NULL
    AND deleted_at IS NULL
  GROUP BY project_id
) sub
WHERE em.project_id = sub.project_id;

COMMIT;
