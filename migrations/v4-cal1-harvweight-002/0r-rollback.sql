-- 0r-rollback.sql — V4-CAL1-HARVWEIGHT-002.
--
-- ORDER MATTERS: revert the LAMBDA FIRST, then run this. Both harvest write paths call this function
-- by name; dropping it under a live Lambda makes every harvest save raise 42883.
--
-- No data is touched — this migration only ever added a function. Rows already written through it
-- keep their weights (correctly: those weights are real, whatever derives them next).

DROP FUNCTION IF EXISTS public.resolve_harvest_weight(uuid, text, numeric, numeric);
DELETE FROM public.schema_version WHERE version = '4.19.0-cal1-harvweight-002';
