-- DRG-CADENCEFLOOR-001 — fill the EVIDENCE-BACKED half of the regrown cadence gap.
--
-- The 2026-08-23 backfill drove unmatched live plantings to ZERO. Measured 2026-09-01 it has regrown
-- to 8 (one strawberry from May, the rest created Aug 2026), so those plantings are watered on the
-- house 3-day system default with nothing in the DB expressing an opinion about them.
--
-- METHOD IS THE HOUSE METHOD, not horticultural opinion. cadence-backfill-20260823's own rows read
-- "Cadence derived from Dave's own watering log: median gap N over K intervals". This follows the
-- same evidence ladder and records which rung each row stands on:
--   OWN LOG   strawberry Early June — 44 intervals, median 1.0d.
--   SIBLINGS  pepper (58 cultivar profiles, median 2.0, range 1-3), tomato (41, all 1.0),
--             tradescantia (2, both 7.0), pothos (1, 10.0) — every one from Dave's OWN garden.
--
-- DELIBERATELY NOT FILLED — hoya, goldenrod (Canada), yarrow (Summer Pastels) have NEITHER a
-- watering log NOR a sibling cultivar profile, so any number is my judgement about Dave's living
-- plants rather than evidence. Hoya especially: semi-succulent, and the 3-day default is actively
-- harmful to it — which is a reason to ASK him, not a licence to guess. Held for his call, and it is
-- why this does NOT drive the gap count to zero.
--
-- COLLARDS IS NOT A GAP. Its cultivar profile exists and deliberately omits every watering key —
-- "container-sizing only; watering/thresholds intentionally omitted so resolution still falls to
-- system default (no behavior change)" — and engine.js:63-68 records that adopting it would move
-- Collards 2d -> 3d against its author's written intent. The guard rule is therefore
-- "a cultivar profile ROW EXISTS", never "the row carries a watering key".
--
-- Idempotent: guarded on the absence of a row for that scope_id, so a second run writes 0.
-- Reversible: 0r-rollback.sql deletes exactly these five by _source.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f cadence-fill.sql

BEGIN;

INSERT INTO public.care_profile (scope, scope_id, profile, model_version, workspace_id)
SELECT 'cultivar', v.scope_id::uuid, v.profile::jsonb, 1,
       '00000000-0000-0000-0000-000000000001'::uuid
FROM (VALUES
  ('70a2173b-611e-4bcf-8440-5144de5d2ea8', '{
     "crop": "strawberry", "_tier": "T2", "confidence": "high",
     "water_method": "drench_to_drainage", "drought_tolerance": "low",
     "water_interval_days_container": 1,
     "_source": "cadence-refill-20260901",
     "notes": "Cadence derived from Dave''s own watering log: median gap 1.0d over 44 intervals."
   }'),
  ('cddbdc68-470a-4b22-88e4-63eb5334f11f', '{
     "crop": "pepper", "_tier": "T2", "confidence": "medium",
     "water_method": "drench_to_drainage", "drought_tolerance": "low",
     "water_interval_days_container": 2,
     "_source": "cadence-refill-20260901",
     "notes": "No own-log history. Cadence from 58 sibling pepper cultivar profiles: median 2.0d (range 1-3)."
   }'),
  ('b5ec43ed-dbd0-4282-9adb-52f8666925ef', '{
     "crop": "tomato", "_tier": "T2", "confidence": "medium",
     "water_method": "drench_to_drainage", "drought_tolerance": "low",
     "water_interval_days_container": 1,
     "_source": "cadence-refill-20260901",
     "notes": "No own-log history. Cadence from 41 sibling tomato cultivar profiles: all 1.0d. Planting is a solo_cup, which the engine caps at 1d independently."
   }'),
  ('7f8f60b2-5ad5-4dfe-a6d9-5f254dd6d445', '{
     "crop": "tradescantia", "_tier": "T2", "confidence": "medium",
     "water_method": "drench_to_drainage", "drought_tolerance": "medium",
     "water_interval_days_container": 7,
     "_source": "cadence-refill-20260901",
     "notes": "No own-log history. Cadence from 2 sibling tradescantia cultivar profiles: both 7.0d."
   }'),
  ('ba561955-b006-4ee4-bdeb-1e813e90c7f2', '{
     "crop": "pothos", "_tier": "T2", "confidence": "medium",
     "water_method": "drench_to_drainage", "drought_tolerance": "medium",
     "water_interval_days_container": 10,
     "_source": "cadence-refill-20260901",
     "notes": "No own-log history. Cadence from 1 sibling pothos cultivar profile: 10.0d. Single-sibling basis, so confidence is medium not high."
   }')
) AS v(scope_id, profile)
WHERE NOT EXISTS (
  SELECT 1 FROM public.care_profile cp
   WHERE cp.scope = 'cultivar' AND cp.scope_id = v.scope_id::uuid
);

-- ── Part 2: the three Dave-ratified judgement rows ──────────────────────────────────────────
INSERT INTO public.care_profile (scope, scope_id, profile, model_version, workspace_id)
SELECT 'cultivar', v.scope_id::uuid, v.profile::jsonb, 1,
       '00000000-0000-0000-0000-000000000001'::uuid
FROM (VALUES
  ('c29da78e-b6c0-43ae-907d-bbd41be857f0', '{
     "crop": "hoya", "_tier": "T3", "confidence": "low",
     "water_method": "drench_to_drainage", "drought_tolerance": "high",
     "water_interval_days_container": 14,
     "_source": "cadence-refill-20260901", "_basis": "dave_decision",
     "notes": "NO own-log history and NO sibling cultivar. Dave-ratified judgement 2026-09-01, not a measurement. Semi-succulent; set one step drier than the pothos sibling (10d). The 3-day default it replaces was the root-rot case."
   }'),
  ('c22aa1ee-c57b-450d-b81a-a0154ca8d339', '{
     "crop": "goldenrod", "_tier": "T3", "confidence": "low",
     "water_method": "drench_to_drainage", "drought_tolerance": "high",
     "water_interval_days_container": 7,
     "_source": "cadence-refill-20260901", "_basis": "dave_decision",
     "notes": "NO own-log history and NO sibling cultivar. Dave-ratified judgement 2026-09-01, not a measurement. Drought-tolerant native, but potted so soil volume is limited."
   }'),
  ('4f30f434-f8df-473a-aee8-7902af9f0da5', '{
     "crop": "yarrow", "_tier": "T3", "confidence": "low",
     "water_method": "drench_to_drainage", "drought_tolerance": "high",
     "water_interval_days_container": 7,
     "_source": "cadence-refill-20260901", "_basis": "dave_decision",
     "notes": "NO sibling cultivar. Dave-ratified judgement 2026-09-01, not a measurement. One logged watering interval existed at 6.0d (n=1, too thin to derive from) and is consistent with 7."
   }')
) AS v(scope_id, profile)
WHERE NOT EXISTS (
  SELECT 1 FROM public.care_profile cp
   WHERE cp.scope = 'cultivar' AND cp.scope_id = v.scope_id::uuid
);

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.89.0-cadencerefill-20260901',
        'CADENCEREFILL: DRG-CADENCEFLOOR-001 partial. Five cultivar care_profile rows for live '
        'plantings that had none, so they stop resolving to the house 3-day default. One from '
        'Dave''s own watering log (strawberry, 44 intervals), four from sibling cultivar profiles '
        'in his own garden. Hoya, goldenrod and yarrow deliberately NOT filled - no log and no '
        'sibling, so a number there would be guesswork on living plants. Collards deliberately '
        'excluded: its profile exists and omits watering keys on purpose.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
