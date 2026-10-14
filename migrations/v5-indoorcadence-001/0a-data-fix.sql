-- BUG-INDOORCADENCE-001 part 1 — two indoor watering intervals that are wrong in every season.
--
-- Dave 2026-10-14 (AskUserQuestion, first-hand, "Split it"): fix these two by data today; the five
-- whose summer numbers are right for summer get an indoor interval key in code instead.
--
--   Royal Ruby Hens & Chicks (sempervivum, Stable, 4 in pot): cultivar profile said 2 days, from
--     cadence-backfill-20260823 ("median gap 2.0d over 17 intervals" of a summer log partly written
--     by "Water all", so it copied the app's own asks back in). Every other succulent profile sits at
--     12-18 days and the bundled Sempervivum genus entry is 14. -> 14.
--   Tumeric (House, 6 in pot): no variety, so no cultivar profile can reach it, and it watered on the
--     house 3-day default. No turmeric variety exists on prod (checked 2026-10-14). -> a LEAF profile
--     at 7 days (heated House, foliage dying back into winter rest; Dave's own gap was 9 days).
--
-- The leaf row carries no "crop" and no drought_tolerance on purpose: "crop" feeds the crop-keyed
-- cold lookups and drought_tolerance 'low' arms the hot-day minus-one; neither is the ask here.
--
-- Idempotent: the update is guarded on the old value 2, the insert on the absence of a leaf row.
-- Reversible without deleting a row: 0r restores the prior value kept in _prior_*.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-data-fix.sql

BEGIN;

UPDATE public.care_profile
   SET profile = profile || jsonb_build_object(
         'water_interval_days_container', 14,
         '_prior_water_interval_days_container', profile->'water_interval_days_container',
         '_prior_source', profile->'_source',
         '_prior_notes', profile->'notes',
         '_source', 'indoorcadence-20261014',
         'notes', 'Sempervivum: 14d, the bundled genus value and in line with every other succulent profile (12-18d). The 2d it replaced came from a summer log partly written by Water all.'),
       updated_at = now()
 WHERE id = '75b26870-5d72-4a4d-999a-1cb9fb7ea7ae'
   AND scope = 'cultivar'
   AND scope_id = 'dbe541b7-64d9-44f7-8806-f582f6ccd850'
   AND profile->>'water_interval_days_container' = '2';

INSERT INTO public.care_profile (scope, scope_id, profile, model_version, workspace_id)
SELECT 'leaf', 'c83adf60-523b-41cb-be90-38d930412e99'::uuid, '{
         "water_interval_days_container": 7,
         "water_method": "soak_then_dry",
         "confidence": "medium",
         "_tier": "T3",
         "_basis": "dave_decision",
         "_source": "indoorcadence-20261014",
         "notes": "Turmeric indoors (heated House): 7d while the foliage dies back into winter rest; Dave went 9d between waterings in Sep-Oct 2026. Planting has no variety, so this is a leaf profile."
       }'::jsonb, 1, '00000000-0000-0000-0000-000000000001'::uuid
WHERE NOT EXISTS (
  SELECT 1 FROM public.care_profile cp
   WHERE cp.scope = 'leaf' AND cp.scope_id = 'c83adf60-523b-41cb-be90-38d930412e99'::uuid
);

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.189.1-indoorcadence-20261014',
        'INDOORCADENCE: BUG-INDOORCADENCE-001 part 1. Royal Ruby hens & chicks cultivar profile 2d -> 14d '
        '(sempervivum; the 2d came from a Water-all-shaped summer log). Tumeric gets a leaf profile at 7d '
        '(no variety; was on the 3-day default). The five summer intervals that are right outdoors wait for '
        'an indoor interval key in code.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
