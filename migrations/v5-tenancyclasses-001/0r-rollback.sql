-- 0r-rollback.sql: v5-tenancyclasses-001 rollback. Deletes stamp 5.3.6-tenancyclasses-001; the gate in gates.yml
--   goes vacuous (it is armed on it). Touches nothing else.
--
-- A re-run finds no stamp and is a no-op. A re-apply of 0a re-checks the predicate before it re-arms.
--
-- Usage: psql "$URL" -X -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

DELETE FROM public.schema_version WHERE version = '5.3.6-tenancyclasses-001';

COMMIT;
