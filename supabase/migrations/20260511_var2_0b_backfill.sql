-- 20260511_var2_0b_backfill.sql
-- VARIETY-REF Session 2 — Step 0b: Idempotent backfill of plant_varieties + plants.variety_id
-- Spec: varieties-schema-design-V001-20260508.md
-- Sequence: 0a (DDL, must be applied first) → 0b (this) → 0c (VALIDATE, gated)
-- Safe to re-run: ON CONFLICT NO-OP for varieties; UPDATE only fires where variety_id IS NULL.
--
-- Step 1: Insert plant_varieties from distinct (genus, species, variety) tuples in plants.
-- Step 2: Backfill plants.variety_id from matching plant_varieties row.
-- Step 3: Verification SELECT — must return 0 before migration 0c (VALIDATE) runs.

-- ============================================================
-- Step 1: Seed plant_varieties from distinct plants tuples.
-- created_by = 'system' for backfilled rows. ON CONFLICT NO-OP for re-runnability.
-- COALESCE chain: variety > genus+species > literal 'Unknown'.
-- ============================================================

INSERT INTO public.plant_varieties (name, genus, species, created_by)
SELECT DISTINCT
  COALESCE(
    NULLIF(TRIM(p.variety), ''),
    NULLIF(TRIM(CONCAT_WS(' ', NULLIF(TRIM(p.genus), ''), NULLIF(TRIM(p.species), ''))), ''),
    'Unknown'
  ) AS name,
  NULLIF(TRIM(p.genus), '') AS genus,
  NULLIF(TRIM(p.species), '') AS species,
  'system' AS created_by
FROM public.plants p
WHERE p.deleted_at IS NULL
  AND (p.genus IS NOT NULL OR p.species IS NOT NULL OR p.variety IS NOT NULL)
ON CONFLICT (LOWER(name), COALESCE(species, '')) WHERE deleted_at IS NULL
DO NOTHING;

-- ============================================================
-- Step 2: Backfill plants.variety_id from matching plant_varieties row.
-- Match on (lower(name), species) — same key as the unique index.
-- Only fires where variety_id IS NULL (idempotent on re-run).
-- ============================================================

UPDATE public.plants p
SET variety_id = pv.id
FROM public.plant_varieties pv
WHERE p.variety_id IS NULL
  AND p.deleted_at IS NULL
  AND pv.deleted_at IS NULL
  AND LOWER(pv.name) = LOWER(
        COALESCE(
          NULLIF(TRIM(p.variety), ''),
          NULLIF(TRIM(CONCAT_WS(' ', NULLIF(TRIM(p.genus), ''), NULLIF(TRIM(p.species), ''))), ''),
          ''
        )
      )
  AND COALESCE(pv.species, '') = COALESCE(NULLIF(TRIM(p.species), ''), '');

-- ============================================================
-- Step 3: Verification (SELECT — not a mutation). MUST return 0 before 0c VALIDATE runs.
--
-- Acceptance semantics:
--   * Plants with all three (genus/species/variety) NULL keep variety_id NULL —
--     this is "unknown-origin," allowed.
--   * Plants with ANY of the three populated MUST have variety_id populated post-backfill.
--   * Inventory items with category != 'seeds' may have variety_id NULL.
--   * Inventory items with category = 'seeds' MUST have variety_id populated before 0c.
--
-- Manual run after applying 0b (do not run as part of this file):
--   SELECT 'plants_unbackfilled' AS check_name, COUNT(*)::text AS n
--     FROM public.plants
--     WHERE variety_id IS NULL
--       AND deleted_at IS NULL
--       AND (genus IS NOT NULL OR species IS NOT NULL OR variety IS NOT NULL)
--   UNION ALL
--   SELECT 'seeds_without_variety' AS check_name, COUNT(*)::text AS n
--     FROM public.inventory_items
--     WHERE category = 'seeds'
--       AND variety_id IS NULL
--       AND deleted_at IS NULL;
--
-- BOTH counts must be 0 before 0c can be applied.
-- If 'seeds_without_variety' > 0: backfill seed rows manually (data quality issue —
-- existing seed inventory was created without a variety reference).
-- ============================================================

INSERT INTO public.schema_version (version, description)
VALUES ('2.0.3b', 'VAR2-0b: backfill plant_varieties from distinct plants tuples + populate plants.variety_id (idempotent)')
ON CONFLICT (version) DO NOTHING;
