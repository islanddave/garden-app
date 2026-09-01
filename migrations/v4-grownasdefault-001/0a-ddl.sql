-- BUG-GROWNASDEFAULT-001 — drop the manufactured default on plant_varieties.grown_as.
--
-- WHAT THIS DOES NOT DO: it does not touch a single existing row. The 195 May+June rows that were
-- written 'annual' BY the default stay exactly as they are. That is deliberate and is the ledger
-- row's own instruction — sowGoal reads coalesce(grown_as, lifecycle)='annual' FIRST, and 7 of 259
-- seed candidates are currently held off the NULL fall-through ONLY by that manufactured value.
-- Mass-correcting them here would move 6 of those 7 candidates' close dates 51-112 days LATER, so
-- the correction belongs with the sow-window Phase 0 work, not with this bleeding-stopper.
--
-- CONSUMER CENSUS (the precondition the ledger row demanded), run against origin/dev dea90f5:
--   * lambda/varieties/index.js:707 — the INSERT passes `${body.grown_as ?? null}` EXPLICITLY, so
--     the app's own write path has never relied on this default. That is why July-onward rows
--     began arriving NULL while May/June are 100% 'annual'.
--   * lambda/varieties/validate.js:12 — VALID_GROWN_AS is a nullable enum
--     ('annual','tender_perennial','perennial','biennial'); NULL is already a legal state.
--   * src/lib/sowEngine.js:375 — `candidate.grown_as ?? candidate.lifecycle`. A coalesce, not a
--     NOT NULL assumption; NULL falls through to lifecycle by design.
--   * src/lib/parseSowProfile.js:171 — already returns {lifecycle:null, grown_as:null} for unknown.
--   * ZERO NOT NULL constraints on the column anywhere in migrations/ (git grep, whole tree).
-- Conclusion: nothing downstream assumes NOT NULL, and no app write path is changed by this. The
-- default fires ONLY for inserts that omit the column entirely — hand-written SQL, seed/load
-- scripts, and future migrations. Those are exactly the writers that should be stating their
-- intent rather than inheriting someone else's.
--
-- RE-ARMING: the default was introduced twice, at migrations/v4-classify/0a-additive-ddl.sql:53 and
-- migrations/v4-seedinv-001/0a-additive-ddl.sql:39, both as
-- `ADD COLUMN IF NOT EXISTS grown_as text DEFAULT 'annual'`. Because the column now exists, a
-- re-run of either is a no-op and CANNOT silently re-arm this default. Stated rather than assumed.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-ddl.sql

BEGIN;

ALTER TABLE public.plant_varieties ALTER COLUMN grown_as DROP DEFAULT;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.89.0-grownasdefault-001',
        'GROWNASDEFAULT: BUG-GROWNASDEFAULT-001 drops the DEFAULT ''annual''::text from '
        'plant_varieties.grown_as so the column stops manufacturing a value nobody chose. '
        'DDL only — zero rows read or written; the 195 already-defaulted rows are deliberately '
        'left intact pending sow-window Phase 0. Consumer census found no NOT NULL dependency and '
        'no app write path affected (lambda/varieties/index.js already passes an explicit value). '
        'Reversible via 0r-rollback.sql.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;

-- Verify:
-- SELECT column_default, is_nullable FROM information_schema.columns
--  WHERE table_name='plant_varieties' AND column_name='grown_as';
