-- Rollback for v5-indoorcadence-001. Deletes no care_profile row (Soft-Delete-Only Rule).
--   Royal Ruby: restores the prior interval, source and notes kept in _prior_*.
--   Tumeric: removes the watering key from its leaf row, so cadence_scopes is empty again and the
--   planting falls back to the bundled default exactly as before. The row stays, marked rolled back.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

UPDATE public.care_profile
   SET profile = (profile - '_prior_water_interval_days_container' - '_prior_source' - '_prior_notes')
                 || jsonb_build_object(
                      'water_interval_days_container', profile->'_prior_water_interval_days_container',
                      '_source', profile->'_prior_source',
                      'notes', profile->'_prior_notes'),
       updated_at = now()
 WHERE id = '75b26870-5d72-4a4d-999a-1cb9fb7ea7ae'
   AND profile->>'_source' = 'indoorcadence-20261014'
   AND profile ? '_prior_water_interval_days_container';

UPDATE public.care_profile
   SET profile = (profile - 'water_interval_days_container')
                 || '{"_rolled_back": "indoorcadence-20261014"}'::jsonb,
       updated_at = now()
 WHERE scope = 'leaf'
   AND scope_id = 'c83adf60-523b-41cb-be90-38d930412e99'
   AND profile->>'_source' = 'indoorcadence-20261014';

DELETE FROM public.schema_version WHERE version = '4.189.1-indoorcadence-20261014';

COMMIT;
