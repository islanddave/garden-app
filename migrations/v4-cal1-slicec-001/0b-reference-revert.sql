-- 0b-reference-revert.sql
-- V4-HARVDUAL-001 Slice C — return the nine hand-weighed tomato varieties to the REFERENCE tier.
--
-- On 2026-08-03 Dave's kitchen-scale numbers were written straight into
-- plant_varieties.unit_weights with weight_source='measured', because at that moment there was
-- nowhere else to put them: cultivar_weight_sample did not exist yet.
--
-- It exists now, and 0d-seed-samples has loaded the RAW samples into it. Leaving the derived value
-- ALSO in plant_varieties would mean one fact with two homes that can silently disagree — edit a
-- sample, and the stale copy in unit_weights keeps answering for it. The resolver reads
-- cultivar_weight_derived FIRST, so these rows are already superseded; this makes the data say so.
--
-- Each row goes back to its catalog/USDA reference value from
-- src/data/harvest-weights-v3-reference.json — exactly what 0b-seed of v4-cal1-refweight-001 would
-- have written, and what that seed still refuses to touch while weight_source='measured'.
--
-- NOT a data loss: the measurements live in cultivar_weight_sample (append-only, immutable) and in
-- src/data/harvest-weights-v2.json. Verify with 0e-coverage before and after — the resolved grams
-- per variety must not change.

BEGIN;

UPDATE public.plant_varieties SET unit_weights='{"count":17,"cup":180}'::jsonb, weight_source='catalog', weight_confidence='high', updated_at=now()
 WHERE crop_type_slug='tomato' AND name='Black Cherry' AND deleted_at IS NULL AND weight_source='measured';
UPDATE public.plant_varieties SET unit_weights='{"count":210,"cup":180}'::jsonb, weight_source='catalog', weight_confidence='high', updated_at=now()
 WHERE crop_type_slug='tomato' AND name='Celebrity' AND deleted_at IS NULL AND weight_source='measured';
UPDATE public.plant_varieties SET unit_weights='{"count":25,"cup":180}'::jsonb, weight_source='catalog', weight_confidence='high', updated_at=now()
 WHERE crop_type_slug='tomato' AND name='Cherry Falls' AND deleted_at IS NULL AND weight_source='measured';
UPDATE public.plant_varieties SET unit_weights='{"count":110,"cup":180}'::jsonb, weight_source='catalog', weight_confidence='high', updated_at=now()
 WHERE crop_type_slug='tomato' AND name='Granadero' AND deleted_at IS NULL AND weight_source='measured';
UPDATE public.plant_varieties SET unit_weights='{"count":140,"cup":180}'::jsonb, weight_source='catalog', weight_confidence='high', updated_at=now()
 WHERE crop_type_slug='tomato' AND name='Moskvich Heirloom' AND deleted_at IS NULL AND weight_source='measured';
UPDATE public.plant_varieties SET unit_weights='{"count":110,"cup":180}'::jsonb, weight_source='catalog', weight_confidence='high', updated_at=now()
 WHERE crop_type_slug='tomato' AND name='San Marzano' AND deleted_at IS NULL AND weight_source='measured';
UPDATE public.plant_varieties SET unit_weights='{"count":110,"cup":180}'::jsonb, weight_source='catalog', weight_confidence='high', updated_at=now()
 WHERE crop_type_slug='tomato' AND name='San Marzano Roma' AND deleted_at IS NULL AND weight_source='measured';
UPDATE public.plant_varieties SET unit_weights='{"count":225,"cup":180}'::jsonb, weight_source='catalog', weight_confidence='medium', updated_at=now()
 WHERE crop_type_slug='tomato' AND name='Sunray' AND deleted_at IS NULL AND weight_source='measured';
UPDATE public.plant_varieties SET unit_weights='{"count":15,"cup":180}'::jsonb, weight_source='catalog', weight_confidence='high', updated_at=now()
 WHERE crop_type_slug='tomato' AND name='Super Sweet 100' AND deleted_at IS NULL AND weight_source='measured';

INSERT INTO public.schema_version (version, description)
VALUES ('4.20.1-cal1-slicec-revert-001','V4-HARVDUAL-001 Slice C: return the 9 hand-weighed tomato varieties in plant_varieties.unit_weights to their catalog/USDA REFERENCE values. The measured truth now lives once, in cultivar_weight_sample, which the resolver reads first. Removes the duplicate home, not the data.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
