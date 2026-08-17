-- 0r-rollback.sql — V4-WINTERGREENSTYPES-001
-- An INSERT's undo is a DELETE. Nothing is force-deleted: each row is removed ONLY if nothing has
-- adopted it since apply. A cultivar pointing at one of these slugs means someone used it
-- deliberately, and silently destroying that is worse than leaving a reference row behind.
--
-- Hard-delete is correct here and does NOT violate the Soft-Delete-Only Rule: crop_types is
-- reference vocabulary, not user-authored content, and the guards below ensure a row is only
-- removed while it carries no user data of any kind.
BEGIN;

DELETE FROM public.crop_types ct
WHERE ct.created_by = 'v4-wintergreenstypes-001'
  AND ct.slug IN ('mache', 'claytonia', 'tatsoi', 'mizuna')
  -- The two FKs referencing crop_types(slug), enumerated from pg_constraint rather than assumed:
  --   plant_varieties.crop_type_slug  ON DELETE SET NULL  <- would SILENTLY orphan a cultivar
  --   preservation_log.crop_type_slug (no action)         <- would block the delete, loudly
  -- The plant_varieties one is the dangerous half: ON DELETE SET NULL means a bare DELETE would
  -- succeed and quietly strip the crop type off someone's cultivar. Guard it explicitly.
  -- NOTE: inventory_items does NOT reference crop_types (its only matching column is `type`, an
  -- item-kind enum). Checked against information_schema, not assumed.
  AND NOT EXISTS (
    SELECT 1 FROM public.plant_varieties v
     WHERE v.crop_type_slug = ct.slug AND v.deleted_at IS NULL)
  AND NOT EXISTS (
    SELECT 1 FROM public.preservation_log pl
     WHERE pl.crop_type_slug = ct.slug);

DELETE FROM public.schema_version WHERE version = '4.32.1-wintergreenstypes-001';

-- Report what survived, so a partial rollback is visible rather than silent.
SELECT slug,
       (SELECT count(*) FROM public.plant_varieties v WHERE v.crop_type_slug = ct.slug) AS cultivars_blocking
  FROM public.crop_types ct
 WHERE ct.slug IN ('mache', 'claytonia', 'tatsoi', 'mizuna');

COMMIT;
