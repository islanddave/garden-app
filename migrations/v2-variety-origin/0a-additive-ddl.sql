-- 0a-additive-ddl.sql
-- VARIETY-ORIGIN — plant_varieties country/region of origin (optional descriptive fields)
-- Decision (Dave, 2026-05-24): add optional country + region of origin to variety records,
--   as part of tomato variety enrichment. Nullable, no CHECK — purely descriptive metadata.
-- Safety: IF NOT EXISTS — idempotent; re-run is a no-op. No backfill, no NOT NULL, no VALIDATE → L-058 sweep N/A.
-- Already applied to prod + staging Neon 2026-05-24 (dry-run-validated in a rolled-back txn, then verify-or-rollback apply).
--   This file makes the change durable in the repo so fresh provisions / staging resets carry it.
-- Rollback: ALTER TABLE public.plant_varieties DROP COLUMN IF EXISTS origin_region, DROP COLUMN IF EXISTS origin_country;

ALTER TABLE public.plant_varieties
  ADD COLUMN IF NOT EXISTS origin_country text;

ALTER TABLE public.plant_varieties
  ADD COLUMN IF NOT EXISTS origin_region text;

INSERT INTO public.schema_version (version, description)
VALUES ('2.1.2a', 'VARIETY-ORIGIN: plant_varieties.origin_country + origin_region (nullable, optional). Tomato variety enrichment 2026-05-24.')
ON CONFLICT (version) DO NOTHING;
