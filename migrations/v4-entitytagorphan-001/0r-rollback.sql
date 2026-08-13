-- 0r-rollback.sql
-- BUG-ENTITYTAGORPHAN-001 — drops the four guard triggers and the guard function.
--
-- WHAT ROLLING BACK RE-ARMS — stated plainly, because this file reintroduces the defect: after
-- running it, hard-deleting a plant, container, location or cultivar once again silently orphans
-- every entity_tag association pointing at it. There is no declared foreign key to catch it,
-- because entity_tag.entity_id cannot carry one; these triggers ARE the constraint. The only thing
-- standing behind them is entity.cultivar_ref_id RESTRICT, which covers one of the four types, by
-- accident, and which the staging smoke purge already routes around in two statements.
--
-- Roll back only to unblock a caller that MUST hard-delete a tagged parent, and prefer the escape
-- hatch first — it is one explicit statement and it is what the guard's own HINT prints:
--   DELETE FROM public.entity_tag WHERE entity_type = '<type>' AND entity_id = '<id>';
--
-- SAFE AT ANY TIME. Dropping a trigger never fails on existing data and never touches a row. The
-- function is dropped after its triggers; DROP FUNCTION would otherwise be refused as depended-on.
--
-- REHEARSAL CONTRACT: run on STAGING before 0c is applied anywhere — apply 0c, run this, confirm
-- zero guard triggers remain, then re-apply 0c. A rollback path that has never been executed is a
-- rollback path that does not exist.
--
-- The schema_version row is left in place on purpose: it is an applied-history log, not a state
-- flag. gates.yml keys on pg_trigger, not on that row, so a rolled-back database reports honestly.

BEGIN;

SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS trg_guard_entity_tag_plant    ON public.plants;
DROP TRIGGER IF EXISTS trg_guard_entity_tag_project  ON public.plant_projects;
DROP TRIGGER IF EXISTS trg_guard_entity_tag_location ON public.locations;
DROP TRIGGER IF EXISTS trg_guard_entity_tag_cultivar ON public.plant_varieties;

DROP FUNCTION IF EXISTS public.guard_entity_tag_parent_delete();

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.8-entitytagorphan-001-rollback',
  'ROLLBACK of 4.23.8-entitytagorphan-001: drops the four entity_tag parent guards and their '
  'function. Re-arms silent orphaning of tag associations on any parent hard delete. '
  'No row data touched.')
ON CONFLICT DO NOTHING;

COMMIT;
