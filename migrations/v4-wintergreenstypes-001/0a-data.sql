-- V4-WINTERGREENSTYPES-001 — reference-data only. Additive, idempotent, re-runnable, non-destructive.
--
-- WHY: the 2026-08-17 whole-system check-in found the app cannot REPRESENT the four cold-hardy
-- winter salad greens. Verified live prod, same day: zero crop_types rows, zero plant_varieties
-- rows, zero inventory_items, and zero occurrences in seeds/seed-inventory-master-20260720.csv.
-- The horticulture seat's ruling is why this is not a nice-to-have:
--
--   "mache and claytonia are the two hardiest salad crops in existence (reliable unprotected to
--    ~-10F, harvestable in a Conway low tunnel in January when spinach has stalled). They are
--    precisely the crops that make winter harvest work, and their sow window closes ~Aug 28."
--
-- Conway MA, zone 5b. This is the app-side enabler ONLY — Dave owns no seed for any of these as of
-- 2026-08-17, so a planting cannot exist until seed is bought and sown. Filed knowingly.
--
-- SCOPE NOTE: Dave approved "mache/claytonia". tatsoi and mizuna are included because they were in
-- the approved ledger row's scope and cost one line each; both are standard 5b fall brassica greens.
-- If they are unwanted they can be soft-deleted with no dependents (nothing references them yet).
--
-- ATTRIBUTE CONVENTION: mirrors the live greens catalog read this session --
--   arugula  cut_and_come_again / rpt 7  / loss 48 / from-sow / cup 20g
--   spinach  cut_and_come_again / rpt 10 / from-sow / cup 30g
--   chard    cut_and_come_again / rpt 8  / loss 96 / from-sow / cup 36g
-- and the v4-radicchio-croptype precedent for asserting harvest_habit (definitional) while leaving
-- harvest_season_start_doy/end_doy NULL (only 2 of 137 rows carry them; not this migration's job).
--
-- harvest_habit is asserted deliberately and per-crop, NOT defaulted -- the check-in found 75 of 137
-- crop_types carry NULL habit, which the harvest-surface split excludes outright. These four must
-- not join that pile on the day they are created.

-- Mache / corn salad (Valerianella locusta). SINGLE, not cut-and-come-again: harvested as a whole
-- rosette cut at the base, which does not reliably regrow. That distinction is the point -- getting
-- it wrong is exactly the radicchio defect (a heading crop mislabelled cut_and_come_again, which
-- made the harvest model wrong as well as the label). Loss horizon 72h: mache keeps notably better
-- than arugula or lettuce.
INSERT INTO crop_types (slug, display_name, category, default_lifecycle, harvest_habit,
                        loss_horizon_hours, dtm_basis, default_unit, grams_per_unit,
                        weight_source, weight_confidence, first_year_harvest, sort_order, created_by)
VALUES ('mache', 'Mache (Corn Salad)', 'vegetable', 'annual', 'single',
        72, 'from-sow', 'cup', 20,
        'estimate', 'low', true, 0, 'v4-wintergreenstypes-001')
ON CONFLICT (slug) DO NOTHING;

-- Claytonia / miner's lettuce (Claytonia perfoliata). Genuinely cut-and-come-again -- regrows
-- repeatedly after cutting above the crown. Repeat 14d rather than arugula's 7: regrowth under
-- declining autumn daylength and cold is materially slower, and a 7d cadence would nag for a cut
-- the plant cannot yet supply.
INSERT INTO crop_types (slug, display_name, category, default_lifecycle, harvest_habit,
                        repeat_interval_days, loss_horizon_hours, dtm_basis, default_unit,
                        grams_per_unit, weight_source, weight_confidence, first_year_harvest,
                        sort_order, created_by)
VALUES ('claytonia', 'Claytonia (Miner''s Lettuce)', 'vegetable', 'annual', 'cut_and_come_again',
        14, 48, 'from-sow', 'cup',
        20, 'estimate', 'low', true,
        0, 'v4-wintergreenstypes-001')
ON CONFLICT (slug) DO NOTHING;

-- Tatsoi (Brassica rapa subsp. narinosa). Cut-and-come-again at baby-leaf stage.
INSERT INTO crop_types (slug, display_name, category, default_lifecycle, harvest_habit,
                        repeat_interval_days, loss_horizon_hours, dtm_basis, default_unit,
                        grams_per_unit, weight_source, weight_confidence, first_year_harvest,
                        sort_order, created_by)
VALUES ('tatsoi', 'Tatsoi', 'vegetable', 'annual', 'cut_and_come_again',
        10, 48, 'from-sow', 'cup',
        30, 'estimate', 'low', true,
        0, 'v4-wintergreenstypes-001')
ON CONFLICT (slug) DO NOTHING;

-- Mizuna (Brassica rapa var. nipposinica). Vigorous regrowth after cutting; the most forgiving of
-- the four.
INSERT INTO crop_types (slug, display_name, category, default_lifecycle, harvest_habit,
                        repeat_interval_days, loss_horizon_hours, dtm_basis, default_unit,
                        grams_per_unit, weight_source, weight_confidence, first_year_harvest,
                        sort_order, created_by)
VALUES ('mizuna', 'Mizuna', 'vegetable', 'annual', 'cut_and_come_again',
        10, 48, 'from-sow', 'cup',
        25, 'estimate', 'low', true,
        0, 'v4-wintergreenstypes-001')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.schema_version (version, description)
VALUES ('4.32.1-wintergreenstypes-001',
        'WINTERGREENSTYPES-001: create 4 cold-hardy winter salad crop_types (mache, claytonia, tatsoi, mizuna) with full attributes -- harvest_habit asserted per-crop (mache single, the other three cut_and_come_again), dtm_basis from-sow, cup unit with grams. Reference data only, no DDL, no backfill of existing rows. Dave owned no seed for any of these at authoring time; this is the app-side enabler only.')
ON CONFLICT (version) DO NOTHING;

-- Verify (expects 4 rows, every attribute populated, no NULL harvest_habit):
-- SELECT slug, harvest_habit, repeat_interval_days, dtm_basis, default_unit, grams_per_unit
--   FROM crop_types WHERE created_by = 'v4-wintergreenstypes-001' ORDER BY slug;
