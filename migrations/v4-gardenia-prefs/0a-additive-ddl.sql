-- V4-GARDENIA-PREFS — cross-device Garden group-by preference
-- Date: 2026-06-26
-- Scope: ADD COLUMN IF NOT EXISTS garden_group_by + garden_sort_order + garden_expanded (text, nullable) on user_notification_prefs.
--        Backs the faceted Garden group-by control with a per-user, cross-device server pref
--        (localStorage stays as the instant-paint cache + offline fallback). NULL = "not set"
--        (frontend falls back to localStorage / 'none').
--
-- Valid values are enforced at the API layer (lambda/critter/validators.js GARDEN_GROUP_BY_VALUES:
-- none|type|lifecycle|location|group|freeform; garden_sort_order alpha|recency). No DB CHECK on purpose — the facet set
-- is dynamic and may grow; an enum CHECK here would be brittle (cf. L-091 check-constraint-enum).
--
-- Safe additive: idempotent via IF NOT EXISTS; nullable; no existing-row scan; no backfill.
-- Applied to prod + staging 2026-06-26 (runtime-proven first on a prod COW branch).
-- Reaches every DB the critter Lambda touches (expand-contract: schema before code).

BEGIN;

ALTER TABLE public.user_notification_prefs
  ADD COLUMN IF NOT EXISTS garden_group_by TEXT NULL,
  ADD COLUMN IF NOT EXISTS garden_sort_order TEXT NULL,
  ADD COLUMN IF NOT EXISTS garden_expanded TEXT NULL,   -- JSON array of expanded project-id strings
  ADD COLUMN IF NOT EXISTS garden_bloom_seen TEXT NULL,   -- JSON array of witnessed critter-id strings (V4-BLOOM-001)
  ADD COLUMN IF NOT EXISTS garden_helper_rung1_seen BOOLEAN NULL;  -- GardenHelper rung-1 explainer dismissed (one-shot)

COMMIT;
