-- 0r-rollback.sql
-- V5-VOICEALIAS-001 — reverse of 0a-additive-ddl.sql.
--
-- WHAT IS LOST, stated plainly because it is not nothing. Dropping this table destroys every
-- mishearing the user has taught the app, and that data is NOT RECONSTRUCTIBLE from anywhere else:
-- the heard phrase exists only here. event_log records that a harvest came from voice
-- (metadata.harvest_input_source) but never records what was heard, so no backfill can recover an
-- alias set. The cost of a rollback is therefore "Dave reteaches every correction he has made",
-- which is small early and grows through the season.
--
-- That is survivable by design and is why this feature was built additive-only: the chooser treats
-- an empty or absent alias set as "no aliases", falling straight through to voiceFuzzyMatch.js, so
-- dropping the table degrades voice harvest to exactly its v4.78.0 behaviour rather than breaking
-- it. Nothing else in the schema references voice_alias, so the DROP has no dependents.
--
-- REHEARSE THIS ON STAGING BEFORE THE PROD APPLY (gates.yml sequencing: staging -> rehearse 0r ->
-- re-apply -> prod). A rollback script that has never been executed is a hope, not a rollback.
--
-- ORDER OF OPERATIONS. The deployed READER must be gone, or degraded to tolerate a missing relation,
-- BEFORE this runs against an environment serving traffic — a live resolver querying a dropped table
-- raises rather than returning empty. The client-side resolver is written to fail soft (a failed
-- alias fetch logs and returns []), so the ordering matters less here than it would for a writer on
-- the critical path, but do not rely on that: take the reader out first.

BEGIN;

-- The index goes with the table; named explicitly so a partial rollback of a partially-applied 0a
-- still lands somewhere sane.
DROP INDEX IF EXISTS public.idx_voice_alias_variety;

DROP TABLE IF EXISTS public.voice_alias;

COMMIT;
