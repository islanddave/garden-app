-- 0b-data.sql
-- V4-CAL1-PERVARIETY-001 — DATA seed: crop_types.variety_grams_required.
--
-- variety_grams_required DEFAULTs true (0a) — the SAFE default: an uncharacterized crop requires a
-- per-variety sample and NEVER falls back to a crop-type guess. 0b sets false ONLY for crops where a
-- crop-TYPE grams value is a defensible approximation (low BETWEEN-variety variance), so the on-read
-- resolver may fall back to crop_types.grams_per_unit (basis=crop_type, flagged) when a cultivar has no
-- usable samples. Values from the crop-class analysis in the V100 spec + src/data/harvest-weights-v2.json:
--   REQUIRED (stay true — high between-variety variance; per-variety or NULL, never a guess):
--     tomato, pepper, squash, tomatillo, cucumber, shallot (count-of-discrete-fruit; cherry vs beefsteak,
--     Ristra Cayenne vs Chili Red diverge 10-20x).
--   FALLBACK-OK (set false — low between-variety variance):
--     blueberry, red_raspberry, wineberry (volume-rigid, a cup normalizes berry size);
--     basil, lettuce (pack-variable — crop-type is ~as good as variety; PREFER DIRECT WEIGHING regardless);
--     broccoli (head, condition-variable — PREFER DIRECT WEIGHING; crop-type head weight is a rough fallback).
--
-- SAFETY: apply-once seed (staging then prod; not re-run). Deterministic UPDATE of the named low-variance
-- crops to false; all other crops keep the DEFAULT true. If Dave later hand-tunes a value, do not re-run 0b.
-- Only touches the new column; no weight/other data written.

UPDATE public.crop_types
   SET variety_grams_required = false
 WHERE slug IN ('blueberry','red_raspberry','wineberry','basil','lettuce','broccoli')
   AND deleted_at IS NULL;

INSERT INTO public.schema_version (version, description)
VALUES ('4.18.1-cal1-pervariety-seed-001','CAL-1 per-variety seed: crop_types.variety_grams_required=false for low between-variety-variance crops (blueberry, red_raspberry, wineberry, basil, lettuce, broccoli); all others keep DEFAULT true (per-variety required, no crop-type guess). Apply-once.')
ON CONFLICT (version) DO NOTHING;
