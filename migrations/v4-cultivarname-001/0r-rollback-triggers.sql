-- 0r-rollback-triggers.sql
-- V4-CULTIVARNAME-001 — remove the entity-mirror name-sync triggers added by 0a.
--
-- READ THIS BEFORE RUNNING. This is NOT part of rolling back the rename; 0r-rollback.sql handles
-- that and deliberately leaves these triggers in place. Dropping them re-opens the defect that
-- caused BUG-FLORADADESYNC-001: entity.display_name is written once at INSERT and never again, so
-- every subsequent rename through the app (which writes plant_varieties.name / plants.name via the
-- auto-updatable cultivar / garden_node views) silently drifts the mirror, with no error and no
-- detector. That is how 28 rows drifted before anyone noticed.
--
-- Run this ONLY if the triggers themselves are implicated in an incident. If you do run it, the
-- drift is silent again — add the check from 0c-verify.sql's final SELECT to a scheduled job, or
-- you will not find out.
--
-- Dropping is safe in the mechanical sense: AFTER triggers with no dependents, and no deployed
-- writer references them.

BEGIN;

DROP TRIGGER IF EXISTS plant_varieties_entity_rename ON public.plant_varieties;
DROP TRIGGER IF EXISTS plants_entity_rename ON public.plants;
DROP FUNCTION IF EXISTS gv.entity_cultivar_rename();
DROP FUNCTION IF EXISTS gv.entity_planting_rename();

DELETE FROM public.schema_version WHERE version = '4.21.3-cultivarname-001-namesync';

COMMIT;
