-- Rollback for v5-heatrespcabbage-001. Restores the pre-correction heat_response on the same rows
-- and removes the receipt, which also DISARMS the post gates (all are guarded on it).
--
-- SAME SINGLE-KEY SHAPE AS 0a, for the same reason: jsonb_set on heat_response only. A rollback that
-- restored a whole stored object would undo more than the thing it is reversing.
--
-- Matched on the NEW value, so it is the exact inverse of 0a's predicate and is likewise idempotent.
--
-- WHAT ROLLING BACK COSTS: three live cabbage plantings go back to being told that heat causes their
-- bolting. That is a false horticultural claim on a surface Dave reads, so this exists to unwind a
-- bad apply, not for tidiness.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

UPDATE public.care_profile
   SET profile = jsonb_set(
         profile,
         '{heat_response}',
         to_jsonb('>85F daily; heat causes bolting; afternoon shade'::text),
         false),
       updated_at = now()
 WHERE scope = 'cultivar'
   AND profile->>'heat_response' = '>85F daily; heat loosens heads and worsens splitting; harvest promptly; afternoon shade; bolting here is cold-triggered (vernalization), not heat';

DELETE FROM public.schema_version WHERE version = '5.0.0-heatrespcabbage-20260902';

COMMIT;
