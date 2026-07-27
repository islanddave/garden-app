-- 0a-additive-ddl.sql
-- BUG-SOWFIRSTYEAR-001 — crop_types.first_year_harvest, retiring the hardcoded guess in sowEngine.
-- Canon: putup-provenance-plan-V101-20260726.md; follows BUG-SOWNONANNUAL-001 (v3.65.0).
--
-- WHY. v3.65.0 taught the sow engine to ask "is the payoff a harvest this season, or an
-- overwintering crown", because a Brussels sprout is biennial and you eat it in year 1 while a
-- hollyhock is biennial and the payoff is next June. It answered that question with a HARDCODED SET
-- of crop slugs in src/lib/sowEngine.js. That set is right for the 12 non-annuals Dave owns today
-- and wrong the moment he buys a biennial vegetable that isn't in it: the default is `establishment`,
-- which is the safe direction for an ornamental and the WRONG direction for a crop — it would tell
-- him to wait a year for a carrot. This moves the fact into data, where it can be corrected without
-- a deploy.
--
-- WHY NOT REUSE grown_as. It cannot carry this, and the reason is worth writing down because it
-- looks like it should. grown_as answers "does this persist?"; first_year_harvest answers "do I get
-- a crop this season?" — and they are ORTHOGONAL. Tokyo Long White is a bunching onion: live data
-- has it grown_as='perennial', which is correct (it clumps and overwinters), AND you cut scallions
-- from it the first season. Asparagus is also perennial and takes three years. Same grown_as,
-- opposite answers. A second column is not redundancy here, it is a second question.
--
-- WHY crop_types AND NOT plant_varieties. This sits with the harvest-behaviour columns already on
-- crop_types (harvest_habit, repeat_interval_days, loss_horizon_hours, set_to_first_pick_days) —
-- same kind of fact, same table. It is crop-level in practice: every carrot is a first-year harvest.
-- The known exception is variety-level (alpine strawberry fruits from seed in year 1 where most
-- strawberries do not), which is why `strawberry` is set FALSE at crop level and a variety-level
-- override is left as future work rather than guessed at here.
--
-- NULL MEANS UNKNOWN AND IS THE DEFAULT FOR MOST ROWS. Only slugs where the answer is unambiguous
-- are set. Everything else stays NULL and the engine falls back to its existing heuristics — the
-- V4-HARVATTR-001 convention. Deliberately left NULL: garlic and shallot (fall-planted, harvested
-- the FOLLOWING summer — neither "first year" nor "establishment" as this flag means them),
-- artichoke (annual cultivars exist alongside the year-2 norm), and every houseplant and ornamental
-- whose year-1 bloom I am not certain of. Guessing here would put inference in a column the engine
-- reads as fact, which is the norm this project holds.
--
-- SAFETY: additive. One nullable column, no default; a seeded UPDATE touching only the listed slugs;
-- and a CREATE OR REPLACE of v_sow_candidates that ADDS one column (29 -> 30) and changes nothing
-- else. The read path is `SELECT *` so a new column is transparent to it. Re-running is a clean
-- no-op.

BEGIN;

ALTER TABLE public.crop_types
  ADD COLUMN IF NOT EXISTS first_year_harvest boolean;

COMMENT ON COLUMN public.crop_types.first_year_harvest IS
  'Does sowing this yield its payoff in the SAME season? NULL = unknown (engine falls back to heuristics). Orthogonal to lifecycle/grown_as: a bunching onion is perennial AND first-year, asparagus is perennial and is not.';

-- TRUE: unambiguous same-season harvest. Vegetables whose default_lifecycle is biennial/perennial
-- are the whole point of the flag — without it the engine treats them as year-2 ornamentals.
UPDATE public.crop_types SET first_year_harvest = true
 WHERE slug IN (
   'brussels_sprouts','carrot','beet','chard','parsley','parsnip','celery','kale','leek','onion',
   'cabbage','chives','broccoli','collard','kohlrabi','radicchio','sweet_potato',
   'mint','oregano','sage','thyme','tarragon','lemongrass','culantro','vietnamese_coriander',
   'eggplant','pepper','tomato'
 ) AND first_year_harvest IS DISTINCT FROM true;

-- FALSE: the payoff is year 2 or later. Year-2 bloomers, tree/cane fruit, and the two crowns that
-- famously punish impatience (asparagus ~3 years, rhubarb 2-3).
UPDATE public.crop_types SET first_year_harvest = false
 WHERE slug IN (
   'hollyhock','money_plant','columbine','delphinium','foxglove','blackberry_lily','althaea',
   'milkweed','edelweiss','asparagus','rhubarb',
   'apple','pear','plum','cherry','sour_cherry','apricot','nectarine','peach',
   'cranberry','grape','raspberry','black_raspberry','red_raspberry','blackberry','wineberry',
   'elderberry','blueberry','strawberry'
 ) AND first_year_harvest IS DISTINCT FROM false;

-- Expose it to the engine. LEFT JOIN so a variety with no crop type (crop_type_slug IS NULL) still
-- appears as a candidate with first_year_harvest NULL — dropping those rows would silently shrink
-- Sow Now, which is a worse failure than an unknown flag.
--
-- THE WHERE CLAUSE IS LOAD-BEARING AND IS REPRODUCED VERBATIM FROM THE LIVE DEFINITION. It is what
-- makes this view "active seed packets" rather than "every inventory row that happens to have a
-- variety". Omitting it floods Sow Now with non-seed inventory and soft-deleted rows. Note that
-- CREATE OR REPLACE VIEW would NOT have caught the omission: it validates column names, types and
-- order, and is entirely indifferent to the WHERE. The only defence is diffing against
-- pg_get_viewdef before writing this statement, which is how the omission was caught here.
-- Post-gates below assert the filter survived, on both the definition text and the row count.
CREATE OR REPLACE VIEW public.v_sow_candidates AS
SELECT i.id AS inventory_item_id,
       i.name AS item_name,
       i.quantity_on_hand,
       i.unit,
       i.created_by,
       i.purchase_date,
       i.source,
       i.metadata,
       v.id AS variety_id,
       v.name AS variety_name,
       v.crop_type_slug,
       v.lifecycle,
       v.grown_as,
       v.sun_requirements,
       v.days_to_maturity_min,
       v.days_to_maturity_max,
       v.start_method,
       v.start_indoor_weeks_min,
       v.start_indoor_weeks_max,
       v.direct_sow_timing,
       v.sow_depth_in,
       v.seed_spacing_in,
       v.row_spacing_in,
       v.days_to_germ_min,
       v.days_to_germ_max,
       v.sow_season,
       v.sow_notes,
       v.growth_habit,
       v.day_length_response,
       ct.first_year_harvest
  FROM inventory_items i
  JOIN plant_varieties v ON v.id = i.variety_id
  LEFT JOIN crop_types ct ON ct.slug = v.crop_type_slug
 WHERE i.category = 'seeds'::text
   AND i.deleted_at IS NULL
   AND i.status = 'active'::text
   AND v.deleted_at IS NULL;

INSERT INTO public.schema_version (version, description)
VALUES ('4.16.0-sowfirstyear-001','SOWFIRSTYEAR: crop_types.first_year_harvest boolean (nullable, NULL=unknown) + seeded for 28 true / 29 false slugs + v_sow_candidates gains the column via LEFT JOIN crop_types (29->30 cols). Retires the hardcoded FIRST_YEAR_HARVEST_CROPS set in sowEngine, whose establishment default is safe for ornamentals and wrong for vegetables. Orthogonal to grown_as: a bunching onion is perennial AND first-year, asparagus is perennial and is not. garlic/shallot/artichoke deliberately left NULL.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
