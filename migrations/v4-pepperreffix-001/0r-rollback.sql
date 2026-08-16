-- 0r-rollback.sql
-- V4-PEPPERREFFIX-001 rollback — restore Capeliente's 5 g count estimate.
--
-- Restores the exact prior state: unit_weights regains "count": 5. Only fires if the key is
-- currently absent, so re-running is a no-op rather than a clobber of a newer curated figure.
--
-- Rolling this back re-blocks scripts/harvest-weight-ratchet.sh on Capeliente (53.6 / 5 = 10.72x,
-- over the 5x gate) unless the cultivar is also added to harvest-weight-ratchet-ack.json. That is
-- the intended coupling, not an oversight: the block and the bad reference are the same fact.

BEGIN;

UPDATE public.plant_varieties
   SET unit_weights = unit_weights || '{"count": 5}'::jsonb,
       updated_at   = now()
 WHERE id = '7e14c699-9ed1-4566-ac46-c7677cb91da3'
   AND NOT (unit_weights ? 'count');

DELETE FROM public.schema_version WHERE version = '4.23.16-pepperreffix-001';

COMMIT;
