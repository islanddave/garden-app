-- 0a-additive-ddl.sql
-- V4-PUTUPFOODCATEGORY-001 (BD-056) — seed the NON-PLANT food classes into crop_types.
--
-- WHY THIS EXISTS. Dave's test case is "where's my bread?". Today he cannot ask it: every grouping
-- key on the browse surface is a plant-taxonomy key (VERIFIED, lambda/preservation/index.js:363 —
-- group is storage | crop | planting and nothing else), and the food he freezes that never grew in
-- a garden — bread, cheese, milk — has no crop_type to be grouped BY. Worse, it cannot be logged at
-- all: chk_preservation_log_attribution is CHECK (crop_type_slug IS NOT NULL OR variety_id IS NOT
-- NULL) (VERIFIED against live prod), so a loaf of bread fails the insert.
--
-- WHY THIS IS A SEED AND NOT A NEW COLUMN. The 873-line design (design-putup-datamodel-20260824.md
-- §4.5) proposed a new food_category column plus a relaxed attribution CHECK. That is not needed.
-- whats-put-up?group=crop already LEFT JOINs crop_types and groups on crop_type_slug with
-- crop_display_name as the label (VERIFIED, lambda/preservation/index.js:370/376/388-391). Give
-- bread a crop_type row and the SHIPPED endpoint answers the question — no column, no table, no
-- CHECK relaxation, and none of the provenance-CHECK reversal the design's §5.1 required.
--
-- THE PRECEDENT THE DESIGN MISSED, AND WHY IT SETTLES THE "IT WILL POLLUTE THE PICKERS" OBJECTION.
-- §2.2 rules this technique out on exactly that ground. v4-putupprov-002-fruitseed already did it,
-- 24 days earlier, and its own header raised and REJECTED the same objection with a live-code audit:
-- v_sow_candidates is built FROM inventory_items JOIN plant_varieties and never reads crop_types, so
-- a row here cannot generate a sow suggestion; parseSowProfile.js uses the table as a validation
-- whitelist, not a recommender. That audit still holds and was re-confirmed this session.
--
-- WHERE THIS SEED IS DIFFERENT, AND WHY IT SHIPS WITH A GATE THE FRUIT SEED DID NOT NEED. Apple and
-- plum are plants. Bread is not, so "more options in a picker" is NOT the whole blast radius here: a
-- garden picker offering `Bread` as a crop to plant is a defect, not a wider vocabulary. So these
-- rows carry category = 'non_plant_food' and the app filters on it. useCropTypes() takes a scope
-- that DEFAULTS to 'garden' (excluding this category) and only the Put-Up crop field opts into
-- 'all' — fail-closed, so a future garden surface that forgets to think about this gets the safe
-- list by default. Proven by src/__tests__/putUpFoodClassGating.test.js, not assumed.
--
-- WHY THESE SEVEN AND NOTHING ELSE. bread / cheese / milk are Dave's own words in BD-056. butter and
-- yogurt complete the dairy class he named — seeding two of the four and stopping would be an
-- arbitrary line a later reader could not reconstruct. meat and fish are the class behind the
-- storage location he already created and named "Meat deep freezer". That location holds ZERO
-- put-up rows (VERIFIED, live prod) — it is evidence of how he THINKS, not of what he logs, and this
-- seed is a bet on future logging rather than a fix for existing data. Say so plainly rather than
-- overclaiming it, per the crucible's field-use seat.
--
-- DELIBERATELY NOT SEEDED: pantry staples (flour, tins, nuts). A bag of flour was never preserved by
-- anyone, so method, preserved_at and use_by_target are all meaningless for it, and inventory_items
-- (352 live rows; type / category / name / quantity_on_hand numeric(10,3) / unit / location_id /
-- source) is the existing generic-inventory shape that already fits them. Putting them here would
-- fork "what is in my house" across two tables with no rule for which one wins.
--
-- HARVEST-BEHAVIOUR AND LIFECYCLE COLUMNS ARE LEFT NULL, per the V4-HARVATTR-001 convention: NULL
-- means UNKNOWN and never fires. default_lifecycle is nullable by the original DDL and there is no
-- honest value for bread. sort_order 900 puts these last in the crop-types GET ordering
-- (sort_order ASC, display_name ASC; live rows span 0-2) so that even if the category filter were
-- somehow bypassed they sink to the bottom rather than interleaving with the garden.
--
-- SAFETY: pure INSERT ... ON CONFLICT DO NOTHING against an existing table. No DDL, no constraint
-- change, no update to any existing row, nothing dropped. Re-running is a clean no-op. VERIFIED
-- against live prod this session: none of these seven slugs exists, and 'non_plant_food' is not
-- among the 8 categories in use (flower, fruit, herb, houseplant, ornamental, succulent, tree,
-- vegetable). Rollback deletes ONLY the rows still unreferenced by any table (see 0r).

BEGIN;

INSERT INTO public.crop_types (slug, display_name, default_lifecycle, category, sort_order, created_by) VALUES
  ('bread',  'Bread',  NULL, 'non_plant_food', 900, 'system'),
  ('cheese', 'Cheese', NULL, 'non_plant_food', 900, 'system'),
  ('milk',   'Milk',   NULL, 'non_plant_food', 900, 'system'),
  ('butter', 'Butter', NULL, 'non_plant_food', 900, 'system'),
  ('yogurt', 'Yogurt', NULL, 'non_plant_food', 900, 'system'),
  ('meat',   'Meat',   NULL, 'non_plant_food', 900, 'system'),
  ('fish',   'Fish',   NULL, 'non_plant_food', 900, 'system')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.schema_version (version, description)
VALUES ('4.39.0-putupfood-001','PUTUPFOOD-001 (BD-056): seed 7 NON-PLANT food crop_types (bread, cheese, milk, butter, yogurt, meat, fish) with category=non_plant_food so Put-Up can record and BROWSE food that never grew in a garden — "where''s my bread?". Zero DDL: the shipped whats-put-up?group=crop already groups on crop_type_slug and joins crop_types for the label, and chk_preservation_log_attribution already requires crop_type_slug OR variety_id, so a crop_types row is the whole feature. No new column, no new table, no relaxation of the attribution or provenance CHECKs the design (§4.5/§5.1) proposed. Identity columns only; default_lifecycle and every harvest-behaviour column left NULL (=UNKNOWN, never fires) — there is no honest lifecycle for bread. sort_order 900 sinks them below the garden vocabulary (live rows span 0-2). Non-plant classes are gated OUT of the garden pickers by category: useCropTypes(scope) defaults to garden and only the Put-Up crop field opts into all; proven by src/__tests__/putUpFoodClassGating.test.js. Precedent: v4-putupprov-002-fruitseed seeded 13 bought/foraged fruit the same way and audited the same pollution objection.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
