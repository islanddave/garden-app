-- V4-RAPINIDTM-001 — ROLLBACK. Restores Rapini's days_to_maturity to 60.
--
-- SAFE, and destroys nothing: this migration writes one reference-data field, and both the old and
-- new values are recorded here and in 0a's header. No DDL, no view, no deploy coupling — unlike
-- v4-dtmbasisvar-001's rollback, nothing needs reverting in a Lambda first.
--
-- READ THIS BEFORE RUNNING IT. Rolling back restores a value that is KNOWN WRONG. 60 was unsourced
-- and broccoli-shaped; 45 is what Dave's actual seed packet says. The only legitimate reason to run
-- this is that the 45 itself turns out to be mis-transcribed — in which case prefer a forward fix
-- with the corrected number over a rollback to a value nobody can source.
--
-- Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

UPDATE public.plant_varieties
   SET days_to_maturity_min = 60,
       days_to_maturity_max = 60
 WHERE id = '0e33b90d-0dd0-4864-bd37-e9fedd1d3088'
   AND deleted_at IS NULL;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.19.0-rapinidtm-001-rollback',
        'ROLLBACK of 4.19.0-rapinidtm-001: Rapini days_to_maturity restored to 60. NOTE 60 is the '
        'unsourced broccoli-shaped value; 45 is packet-sourced. Prefer a forward fix.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
