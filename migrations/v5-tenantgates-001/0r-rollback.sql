-- 0r-rollback.sql: v5-tenantgates-001 rollback. Deletes stamp 5.1.5-tenantgates-001; every gate in gates.yml goes
--   vacuous (each is armed on it). Touches nothing else.
--
-- ORDER ACROSS PHASE 1: M3 -> M2 -> M1. This file and v5-platformoperators-001's 0r first, then v5-spacefk-001,
--   then v5-spaceguard-001. post_photo_tenancy_no_conflict is also armed on v5-spacefk-001's fold stamp, which that
--   directory's 0r deletes in the same transaction that restores the ten containers to the nil workspace, so the gate
--   is vacuous either way; running this file first keeps it so without relying on that.
--
-- A re-run finds no stamp and is a no-op. A re-apply of 0a re-checks every predicate before it re-arms.
--
-- Usage: psql "$URL" -X -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

DELETE FROM public.schema_version WHERE version = '5.1.5-tenantgates-001';

COMMIT;
