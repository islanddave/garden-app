-- 0a-capeliente-reference.sql
-- V4-PEPPERREFFIX-001 — retract one falsified catalogue weight estimate.
--
-- WHAT IS WRONG. plant_varieties 'Capeliente' (7e14c699-9ed1-4566-ac46-c7677cb91da3) carries
-- unit_weights->>'count' = 5 g. Its own record says jalapeno-type: scoville 2500-8000 and
-- expected_yield_notes 'Reliable heavy jalapeno-type yields over a long season.' A jalapeno-type
-- fruit is tens of grams, not 5. Dave has since weighed it twice, independently, five days apart:
-- 43 g on 1 fruit (2026-08-07) and 225 g on 4 fruit = 56.25 g (2026-08-12).
--
-- WHY THIS IS NOT THE USUAL 'the catalogue disagrees with my scale' CASE. Small values in this
-- column are mostly CORRECT and deliberately curated: Tepin 0.4 g, Chiltepin 0.5, Piquin 0.5,
-- Tabasco 1, Thai Hot 1.5, Biquinho 3 — all of them weight_source='catalog', weight_confidence='high'.
-- Those are real bird/chile peppers and must not be touched. Capeliente is one of only a handful of
-- rows marked weight_source='estimate', weight_confidence='low', and it is the smallest of them.
-- The catalogue itself already flagged this number as a guess; two weighings falsified the guess.
--
-- WHY RETRACT RATHER THAN RE-ESTIMATE. Writing 53.6 (the sample-derived factor) into the catalogue
-- would make the reference a copy of the measurement it is supposed to be an independent check on —
-- the outlier gate in scripts/harvest-weight-ratchet.sh would then be comparing the samples to
-- themselves and could never fire for this cultivar again. Deleting the key lets the row fall
-- through to crop_types.pepper.count = 45 g, which is an independent generic-pepper figure and a
-- reasonable fallback for a jalapeno-type. The measured 53.6 g still WINS at resolve time; the
-- reference is only the fallback and the yardstick.
--
-- CONSEQUENCE FOR THE RATCHET. 53.6 / 45 = 1.19x, comfortably inside the 5x divergence gate, so
-- Capeliente stops blocking harvest-weight-ratchet.sh WITHOUT being added to the ack allowlist. That
-- matters: an ack is permanent and would have suppressed a genuine future outlier on this cultivar.
--
-- SCOPE. Exactly one row, one key. jsonb - 'count' is a no-op if the key is already absent, so this
-- is idempotent and safe to re-run. weight_source/weight_confidence are left as
-- estimate/low: nothing here established a new catalogue figure, it only withdrew a false one.

BEGIN;

UPDATE public.plant_varieties
   SET unit_weights = unit_weights - 'count',
       updated_at   = now()
 WHERE id = '7e14c699-9ed1-4566-ac46-c7677cb91da3'
   AND unit_weights ? 'count'
   AND (unit_weights->>'count')::numeric = 5
   AND weight_source = 'estimate'
   AND weight_confidence = 'low';

-- Guard: refuse to land if the row above did not match exactly what this migration was written
-- against (someone re-curated it, or the id moved). Better a failed apply than a silent no-op that
-- leaves the ratchet blocked and this file marked applied.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.plant_varieties
     WHERE id = '7e14c699-9ed1-4566-ac46-c7677cb91da3'
       AND unit_weights ? 'count'
  ) THEN
    RAISE EXCEPTION 'V4-PEPPERREFFIX-001: Capeliente still carries a count weight — row did not match the expected 5g/estimate/low shape, refusing to proceed';
  END IF;
END $$;

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.16-pepperreffix-001',
  'V4-PEPPERREFFIX-001 catalogue correction: retract Capeliente unit_weights count=5g, a '
  'weight_source=estimate / weight_confidence=low guess falsified by two independent weighings '
  '(43g and 56.25g) on a variety its own record calls jalapeno-type (SHU 2500-8000). The key is '
  'REMOVED rather than re-estimated so the row falls through to crop_types.pepper count=45g, an '
  'independent reference — writing the sample-derived 53.6g would make the reference a copy of the '
  'measurement it exists to check. Clears Capeliente from the harvest-weight-ratchet outlier block '
  'without an ack allowlist entry. No-op on any environment lacking the row.')
ON CONFLICT DO NOTHING;

COMMIT;
