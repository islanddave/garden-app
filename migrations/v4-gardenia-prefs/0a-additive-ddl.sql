-- V4-GARDENIA-PREFS — cross-device Garden group-by preference
-- Date: 2026-06-26
-- Scope: ADD COLUMN IF NOT EXISTS garden_group_by (text, nullable) on user_notification_prefs.
--        Backs the faceted Garden group-by control with a per-user, cross-device server pref
--        (localStorage stays as the instant-paint cache + offline fallback). NULL = "not set"
--        (frontend falls back to localStorage / 'none').
--
-- Valid values are enforced at the API layer (lambda/critter/validators.js GARDEN_GROUP_BY_VALUES:
-- none|type|lifecycle|location|group|freeform). No DB CHECK constraint on purpose — the facet set
-- is dynamic and may grow; an enum CHECK here would be brittle (cf. L-091 check-constraint-enum).
--
-- Safe additive: idempotent via IF NOT EXISTS; nullable; no existing-row scan; no backfill.
-- Applied to prod + staging 2026-06-26 (runtime-proven first on a prod COW branch).
-- Reaches every DB the critter Lambda touches (expand-contract: schema before code).

BEGIN;

ALTER TABLE public.user_notification_prefs
  ADD COLUMN IF NOT EXISTS garden_group_by TEXT NULL;

COMMIT;
