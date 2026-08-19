-- 0r-rollback.sql
-- V4-WATCHEXCLUDEDLOG-001 rollback.
--
-- The 0a is a single greenfield CREATE TABLE with one secondary index and no writes to any existing
-- relation, so the inverse is a DROP and there is nothing else to undo. No column was added to an
-- existing table, no constraint was armed over existing data, no row was rewritten.
--
-- THE DATA LOSS IS TOTAL AND UNRECONSTRUCTIBLE — the same warning watch_impression's rollback
-- carries, for the same reason. The watch list is computed fresh per request from mutable state
-- (plantings, dismissals, anchors and reference data all move), so a resolver verdict that was not
-- written down at serve time is gone: re-running today's resolver over today's rows does NOT
-- reproduce what it decided last Tuesday. Dropping this table discards every exclusion day it
-- accumulated and no backfill can return them.
--
-- Rehearse this on STAGING as part of the apply sequence (apply 0a -> run 0r -> re-apply 0a), which
-- is safe there precisely because staging has no history worth keeping. On PROD, treat it as a
-- last-resort break-glass step and prefer leaving an unused table in place over destroying the
-- denominator the refit is waiting on.

BEGIN;
DROP TABLE IF EXISTS public.watch_exclusion;
COMMIT;
