-- Rollback for v4-cadencerefill-001. Deletes exactly the eight care_profile rows 0a wrote and
-- removes the receipt, which also DISARMS the post gates (all four are guarded on it).
--
-- Scoped by _source, never by scope_id list: a hand-maintained id list here would silently miss a
-- row if 0a is ever extended, and would silently delete a row someone else wrote under the same id
-- if it is not. The _source tag is what 0a stamps and is the only thing that identifies its work.
--
-- HARD DELETE IS CORRECT HERE, and it is worth saying why given the Soft-Delete-Only Rule. A
-- care_profile row is DERIVED care configuration, not user-authored content: nothing is lost by
-- removing it because resolution simply falls back to the system default, which is exactly the state
-- these rows replaced. It carries no measurement, no timestamped observation and no text Dave wrote.
-- That places it under the rule's ephemeral/derived carve-out, not under its protected-entity list.
--
-- WHAT ROLLING BACK ACTUALLY COSTS: eight live plantings return to the house 3-day default,
-- including the hoya that the 3-day cadence was over-watering. Rolling back is therefore a real
-- horticultural regression, not a neutral undo — do it only to unwind a bad apply, not for tidiness.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

DELETE FROM public.care_profile
 WHERE scope = 'cultivar'
   AND profile->>'_source' = 'cadence-refill-20260901';

DELETE FROM public.schema_version WHERE version = '4.89.0-cadencerefill-20260901';

COMMIT;
