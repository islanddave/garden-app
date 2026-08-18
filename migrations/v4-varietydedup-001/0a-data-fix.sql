-- V4-VARIETYDUP-001 + V4-CWARCHIVE-001 — plant_varieties consolidation.
-- Non-destructive (soft-delete only, per this project's Soft-Delete-Only Rule), idempotent,
-- re-runnable. Every statement is guarded so a second run changes 0 rows.
--
-- Findings (live prod Neon, read via owner DSN, measured 2026-08-18):
--
-- === V4-VARIETYDUP-001 — "Alaska Mix" duplicate ===
-- Two rows, both crop_type_slug='nasturtium', name='Alaska Mix' exactly:
--   a11dd600-84b4-4bd6-8611-f85336bc3c2e  created_by='data-audit-20260706'  2026-07-06
--     species='majus' genus='Tropaeolum' (correct botanical ID for the real Alaska Mix nasturtium
--     seed mix) — otherwise empty (no source_url/notes/DTM).
--   f2c6edd8-7b8f-4bd2-a443-a7e1070fa6d7  created_by=user_3D2gM0hIl03gjW3JM2DjtPzm0jI  2026-07-07
--     species/genus NULL, every other descriptive field NULL too.
-- TRUE duplicate, not near-duplicate: identical name+crop, no vendor/source_url on either side,
-- no conflicting characteristics anywhere — the second row is a bare stub with zero data the
-- first doesn't already have. uq_plant_varieties_name_species didn't catch it at insert time only
-- because COALESCE(species,'') differs ('majus' vs '') between the two rows.
-- a11dd600 is kept as survivor: richer data, 1 live planting (8f84f21c, status=vegetative, not
-- archived/deleted) + 1 already-deleted planting, + the sole inventory_items row. f2c6edd8's only
-- planting (7ea304c4) was already deleted_at-set before this migration — repointed anyway per the
-- "any FK references to EITHER row must be preserved" instruction. created_by='data-audit-20260706'
-- matches MANAGED_PRINCIPAL_PATTERNS ('data-audit-%') in lambda/varieties/authz.js, so the survivor
-- stays editable/deletable by Dave through the app's normal household-scoped write path.
-- inventory_items / cultivar_weight_sample / preservation_log / proj_rescope_events: verified 0 rows
-- reference f2c6edd8 — nothing else to repoint.

UPDATE plants
   SET variety_id = 'a11dd600-84b4-4bd6-8611-f85336bc3c2e', updated_at = now()
 WHERE id = '7ea304c4-5ae5-4408-94e5-546d706e3392'
   AND variety_id = 'f2c6edd8-7b8f-4bd2-a443-a7e1070fa6d7';

UPDATE plant_varieties
   SET deleted_at = now()
 WHERE id = 'f2c6edd8-7b8f-4bd2-a443-a7e1070fa6d7'
   AND deleted_at IS NULL;

-- === V4-CWARCHIVE-001 — California Wonder pepper family ===
-- Ledger text: "archive Golden CW + Orange Sun, rename keeper to Emerald Green" (3 rows expected,
-- keeper = the row named 'California Wonder', rename target 'Emerald Green'). Live data has a 4th
-- row the ledger doesn't mention:
--   960c10f5-80e9-4a92-8e8c-da70f54c89f0  "Golden California Wonder"  created_by=system  2026-05-11
--   750c8334-1aaa-493b-bcef-02d7a9378a39  "Orange Sun"                created_by=system  2026-05-11
--   1eff5046-f6a1-4f5d-82df-85a35e890849  "California Wonder"         created_by=user     2026-05-21
--   7a6ab71f-4449-4740-8e4c-1947fa9da361  "Emerald Green"             created_by=user     2026-06-07  <- not in ledger
-- A literal rename of 1eff5046 -> 'Emerald Green' is blocked outright: uq_plant_varieties_name_species
-- is UNIQUE(lower(name), COALESCE(species,'')) WHERE deleted_at IS NULL, and 7a6ab71f already holds
-- that exact key (name='Emerald Green', species='annuum').
-- Planting-level evidence resolves it without a rename: 1eff5046's only planting (2d362fc7,
-- status=failed) is already archived_at-set; 7a6ab71f's planting (6cb08d0d, status=failed) is the
-- ONLY one of the four rows' plantings that is neither archived nor deleted — it is Dave's current
-- active pepper planting. 7a6ab71f also carries cultivar-specific detail (DTM 72-80, no generic
-- source_url) vs 1eff5046's generic gardeningchannel.com growing-guide content (DTM 60-90). Reading:
-- 'Emerald Green' was already created as the real keeper on 2026-06-07 (by hand, not by literally
-- renaming the old row); 1eff5046 is the superseded pre-rename row and belongs in the archive set
-- alongside Golden CW / Orange Sun, not as the rename target. No UPDATE ... SET name is needed:
-- 7a6ab71f already carries the correct final name and is left untouched by this migration.
--
-- Archive-impact check (per gardening-deploy.md Archive-Hiding Rule scope, and the deleted_at-aware
-- LEFT JOIN in lambda/plants/index.js:455 that blanks variety_ref when plant_varieties.deleted_at is
-- set): every planting referencing the 3 rows below is ALREADY archived_at-set or deleted_at-set
-- (960c10f5: one archived + one deleted; 750c8334: one archived + one deleted; 1eff5046: one
-- archived). None is in a currently-visible view today, so archiving these three varieties changes
-- zero currently-rendered screens. Confirmed by post_no_orphaned_active_planting in gates.yml, not
-- just asserted here.

UPDATE plant_varieties
   SET deleted_at = now()
 WHERE id IN (
   '960c10f5-80e9-4a92-8e8c-da70f54c89f0',  -- Golden California Wonder
   '750c8334-1aaa-493b-bcef-02d7a9378a39',  -- Orange Sun
   '1eff5046-f6a1-4f5d-82df-85a35e890849'   -- California Wonder (superseded by Emerald Green)
 )
   AND deleted_at IS NULL;

-- Verify (both items):
-- SELECT id, name, species, crop_type_slug, deleted_at FROM plant_varieties
--  WHERE id IN ('a11dd600-84b4-4bd6-8611-f85336bc3c2e','f2c6edd8-7b8f-4bd2-a443-a7e1070fa6d7',
--               '960c10f5-80e9-4a92-8e8c-da70f54c89f0','750c8334-1aaa-493b-bcef-02d7a9378a39',
--               '1eff5046-f6a1-4f5d-82df-85a35e890849','7a6ab71f-4449-4740-8e4c-1947fa9da361')
--  ORDER BY name;
-- SELECT id, variety_id FROM plants WHERE id = '7ea304c4-5ae5-4408-94e5-546d706e3392';
