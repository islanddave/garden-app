-- BUG-INDOORCADENCE-001 part 2 — an indoor watering interval for the five plants that summer outside
-- and winter in the Stable.
--
-- Dave 2026-10-14 (AskUserQuestion, first-hand, "Split it"): their summer intervals are right for summer,
-- so they stay; each variety profile gains water_interval_days_indoor, which the daily-plan engine reads
-- in place of the container/in-ground interval only while the planting sits in a covered location
-- (engine.js baseWaterInterval, ledger.exposureClass === 'indoor'). Spring needs no reset.
-- Values: gardening-docs project-state/_waterdemand-20260928/recheck-20261014/indoor-intervals-20261014.md.
--
--   Ginger                          2 (summer) -> 5 indoors
--   Lemon Verbena                   1          -> 7
--   Lemon Thyme                     2          -> 7
--   Fairway Orange (coleus)         1          -> 5   two plantings: Clone 1 in the Stable takes 5,
--                                                    the Trough planting outside keeps 1 while it is out
--   Italian Parsley                 2          -> 4
--
-- ORDER: apply only once the engine change that reads the key is live on prod. Applied earlier, the key
-- is inert (no reader), so the order is about meaning, not safety.
--
-- Additive only: three keys merged into each row (the interval, _indoor_source, _indoor_note). The summer
-- interval, notes and _source are untouched. v_resolved_care.cadence_scopes does not count the new key,
-- and every row already carries a container interval, so all five keep resolving from the database.
--
-- Guarded per row on md5(profile::text) as read on prod 2026-10-14, so a row someone edited since is left
-- alone; the DO block then aborts the whole transaction unless all five carry the indoor value. Idempotent:
-- a second run matches no md5, writes nothing, and the assert still passes.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-data.sql

BEGIN;

UPDATE public.care_profile cp
   SET profile = cp.profile || jsonb_build_object(
         'water_interval_days_indoor', v.indoor,
         '_indoor_source', 'v5-indoorcadence-002',
         '_indoor_note', v.note),
       updated_at = now()
  FROM (VALUES
    ('a29447b8-387f-4390-ac73-7e152efcbe8d'::uuid, 'be1211e0-0e4f-41c2-a37d-f48c313aac0b'::uuid,
     '5421338c837dae75308c5df32312e817', 5,
     'Indoors 5d: cool unheated Stable, growth slowing toward winter rest; Dave went 6-7d between waterings in Oct 2026.'),
    ('e74d95b7-df0a-4948-9bf2-d5bfd1bbeeea'::uuid, '72ebf73c-bf46-429a-bb2d-3243e3d0826d'::uuid,
     '81f8ce0784e2747cf5a2ee469ec558b7', 7,
     'Indoors 7d: deciduous in the cold Stable and kept on the dry side over winter; Dave went 6d.'),
    ('6b8e2195-5534-4bb6-aceb-c91a9daebc88'::uuid, 'db83be63-5344-4615-9399-4eb0644dce14'::uuid,
     'fff6d33d22b85c1bd849b7d2c22a3e48', 7,
     'Indoors 7d: thyme wants to dry out between waterings; the bundled thyme value is 6; Dave went 6d.'),
    ('573c512c-f98a-4b1f-9fc6-c18afced8306'::uuid, 'ba9e69e5-b8e5-40ea-a4a4-aeee7411ddd2'::uuid,
     'f1da83d4f74e9ebd64f003074786bc8c', 5,
     'Indoors 5d: a 15 gal pot in the cool Stable holds water far longer than a summer bag; Dave went 6d.'),
    ('6834e8f5-2342-4605-9e82-e03f94f3143d'::uuid, '6f1ebb8f-9e65-4a95-bd7e-4ba9b1a659ef'::uuid,
     'ca6ecefc181fbc46514d1976ab831ffa', 4,
     'Indoors 4d: a 4 in pot still dries faster than the rest; Dave went 6-9d in Oct 2026, so 4 is the cautious end.')
  ) AS v(id, cultivar, md5_before, indoor, note)
 WHERE cp.id = v.id
   AND cp.scope = 'cultivar'
   AND cp.scope_id = v.cultivar
   AND md5(cp.profile::text) = v.md5_before;

DO $assert$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM public.care_profile cp
    JOIN (VALUES
      ('a29447b8-387f-4390-ac73-7e152efcbe8d'::uuid, 5, 2),
      ('e74d95b7-df0a-4948-9bf2-d5bfd1bbeeea'::uuid, 7, 1),
      ('6b8e2195-5534-4bb6-aceb-c91a9daebc88'::uuid, 7, 2),
      ('573c512c-f98a-4b1f-9fc6-c18afced8306'::uuid, 5, 1),
      ('6834e8f5-2342-4605-9e82-e03f94f3143d'::uuid, 4, 2)
    ) AS v(id, indoor, summer) ON v.id = cp.id
   WHERE cp.profile->>'_indoor_source' = 'v5-indoorcadence-002'
     AND cp.profile->'water_interval_days_indoor' = to_jsonb(v.indoor)
     AND cp.profile->'water_interval_days_container' = to_jsonb(v.summer);
  IF n <> 5 THEN
    RAISE EXCEPTION 'v5-indoorcadence-002: % of 5 rows carry the indoor value over an untouched summer value; nothing written', n;
  END IF;
END
$assert$;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-indoorcadence-002',
        'INDOORCADENCE: BUG-INDOORCADENCE-001 part 2. water_interval_days_indoor on five variety profiles '
        '(ginger 5, lemon verbena 7, lemon thyme 7, Fairway Orange coleus 5, Italian parsley 4), read by the '
        'engine only while the planting is indoors. Summer intervals untouched.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
