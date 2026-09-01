-- OPS-ROSCHEMAVERSIONBLIND-001 — make public.schema_version readable by non-owner roles.
--
-- THE LEDGER ROW'S PROPOSED FIX WAS WRONG, AND IT IS WORTH RECORDING WHY. The row said
-- "GRANT SELECT on public.schema_version to garden_ro". Measured live on prod 2026-09-01:
--   has_table_privilege('garden_ro','public.schema_version','SELECT')  ->  TRUE
-- garden_ro ALREADY holds SELECT. That GRANT is a no-op and would have "fixed" nothing while
-- looking like a fix. The tell was in the symptom: garden_ro got ZERO ROWS, not
-- "permission denied for table schema_version". A missing GRANT raises; RLS filters silently.
--
-- ACTUAL CAUSE: row-level security is ENABLED on the table with ZERO policies —
--   pg_class.relrowsecurity = true, relforcerowsecurity = false, pg_policies -> 0 rows.
-- RLS enabled + no matching policy = deny-all for every role that is neither the table owner nor
-- BYPASSRLS. relforcerowsecurity=false is why the owner DSN still sees all 116 rows and every
-- read-only session sees none.
--
-- This is near-certainly an accidental blanket "enable RLS everywhere" sweep rather than a
-- decision: schema_version is a migration-receipt ledger holding no user data, no household
-- scoping and nothing tenant-specific, and every genuinely tenant-scoped table in this database
-- carries policies. This one has none at all, which is the signature of a table that was armed and
-- then never given a policy.
--
-- WHY A POLICY AND NOT `DISABLE ROW LEVEL SECURITY`: disabling would work, but it removes the
-- control outright and would silently open the table to any future write path too. A SELECT-only
-- policy is the narrower change — reads work, and because no INSERT/UPDATE/DELETE policy is
-- created, WRITES REMAIN DENY-ALL for every non-owner role. That is exactly the posture a receipt
-- table should have, and post_no_write_policy_exists below holds it as a standing invariant.
--
-- USING (true) is the honest predicate: there is no row-level distinction to draw on this table.
-- The table GRANT stays the real access control, which is where it belongs.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-ddl.sql

BEGIN;

-- Guarded for idempotency: CREATE POLICY has no IF NOT EXISTS, and a second run must change 0 rows
-- rather than abort the transaction.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'schema_version'
       AND policyname = 'schema_version_select_all'
  ) THEN
    CREATE POLICY schema_version_select_all
        ON public.schema_version
       FOR SELECT
     USING (true);
  END IF;
END
$$;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.89.0-roschemaversion-001',
        'ROSCHEMAVERSION: OPS-ROSCHEMAVERSIONBLIND-001 adds a SELECT-only RLS policy to '
        'public.schema_version so read-only roles (garden_ro) can read migration receipts. '
        'CORRECTS THE FILED DIAGNOSIS: garden_ro already held SELECT; the blindness was RLS '
        'enabled with zero policies, which denies silently rather than raising. RLS stays ENABLED '
        'and no write policy is created, so writes remain deny-all for non-owner roles. '
        'Reversible via 0r-rollback.sql.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;

-- Verify (must be run through the garden_ro DSN, not the owner DSN — the owner bypasses RLS
-- because relforcerowsecurity is false, so an owner-side read proves nothing about this fix):
--   psql "$GARDEN_RO_DATABASE_URL" -c "SELECT count(*) FROM schema_version;"
