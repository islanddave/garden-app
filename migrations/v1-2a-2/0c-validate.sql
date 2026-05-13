-- V1.2a-2 Session 1 — 0c validate
-- Date: 2026-05-13
-- Scope: VALIDATE the chk_event_log_severity_requires_flag constraint added NOT VALID in 0a.
-- Pre-condition: pre-VALIDATE sweep (runner-enforced, between 0a→0b and 0b→0c) confirmed
--                all rows satisfy the predicate (no deleted_at filter — L-058).

BEGIN;

ALTER TABLE event_log
  VALIDATE CONSTRAINT chk_event_log_severity_requires_flag;

COMMIT;
