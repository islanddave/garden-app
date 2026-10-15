-- Rollback for v5-indoorcadence-002. Deletes no row (Soft-Delete-Only Rule).
--   The five variety profiles: strips the three keys 0a merged in, and only on a row 0a wrote. jsonb
--   minus the keys is byte-for-byte the profile 0a read, so its md5 matches 0a's guard again and a
--   later re-apply works.
--   The receipt row stays, marked rolled back, so the post gates disarm. A re-apply of 0a restores
--   its description (ON CONFLICT DO UPDATE).
-- With the keys gone the engine reads the summer interval indoors again, exactly as before 0a.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

UPDATE public.care_profile
   SET profile = profile - 'water_interval_days_indoor' - '_indoor_source' - '_indoor_note',
       updated_at = now()
 WHERE id IN ('a29447b8-387f-4390-ac73-7e152efcbe8d', 'e74d95b7-df0a-4948-9bf2-d5bfd1bbeeea',
              '6b8e2195-5534-4bb6-aceb-c91a9daebc88', '573c512c-f98a-4b1f-9fc6-c18afced8306',
              '6834e8f5-2342-4605-9e82-e03f94f3143d')
   AND scope = 'cultivar'
   AND profile->>'_indoor_source' = 'v5-indoorcadence-002';

UPDATE public.schema_version
   SET description = 'ROLLED BACK ' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') || ': ' || description
 WHERE version = '5.0.0-indoorcadence-002'
   AND description NOT LIKE 'ROLLED BACK %';

COMMIT;
