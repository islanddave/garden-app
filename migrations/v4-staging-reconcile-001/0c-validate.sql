-- 0c-validate.sql
-- Validate the two reconcile constraints whose predicates every existing row already satisfies.
--
-- crop_types_dtm_basis_chk: dtm_basis is NULL on all 82 staging rows, and a CHECK passes on NULL
--   (three-valued logic — NULL = ANY(...) is unknown, not false), so this validates cleanly.
-- chk_plants_rain_exposed_source: carries an explicit `IS NULL OR` guard, and the column was just
--   added, so every row is NULL.
--
-- plant_projects_kind_not_null_unless_deleted is DELIBERATELY ABSENT here — staging holds 4
-- grandfathered violating rows. It stays NOT VALID and still enforces on new writes. Validating it
-- would require deleting or mutating staging data, which this migration has no business doing.

ALTER TABLE public.crop_types VALIDATE CONSTRAINT crop_types_dtm_basis_chk;

ALTER TABLE public.plants VALIDATE CONSTRAINT chk_plants_rain_exposed_source;
