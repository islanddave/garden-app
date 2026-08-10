-- V4-DBHYGIENE-001 — additive index hygiene (garden-app prod Neon PG17)
-- Authored 2026-07-01 (session db-keys-index-audit). NOT YET APPLIED.
-- Apply to prod + staging Neon branch on Dave's explicit ship approval.
--
-- CONTEXT: A two-expert audit confirmed the DB is NOT the perf bottleneck
-- (whole DB is a few MB, 99%+ cache hits, plants-list join EXPLAIN = 0.79ms).
-- These changes are cheap forward-looking hygiene, NOT the fix for "bogging down"
-- (that is photo delivery — see V4-PHOTOCDN-001). Value here is LOW but correct.
--
-- IMPORTANT: CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
-- Run each statement individually (Neon SQL editor / psql \i without BEGIN),
-- NOT wrapped by a migration-runner transaction.

-- ── ADD: FK leading-column indexes on real growth columns ────────────────────
-- plants.location_id — actively used (222 rows, grows); speeds "plants at location"
-- and protects locations-delete FK fan-out. Matches soft-delete partial convention.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_plants_location
  ON public.plants (location_id)
  WHERE (location_id IS NOT NULL) AND (deleted_at IS NULL);

-- plant_varieties.photo_id — protects photo-delete FK checks; low/med value.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_plant_varieties_photo
  ON public.plant_varieties (photo_id)
  WHERE (photo_id IS NOT NULL) AND (deleted_at IS NULL);

-- ── SKIPPED (deliberately) ───────────────────────────────────────────────────
-- featured_image_id on plants/inventory_items/locations/plant_projects:
--   VERIFIED 2026-07-01 = 0 populated rows in EVERY table. Dead legacy column
--   (live column is featured_photo_id, already indexed). Do NOT index; candidate
--   for column removal in a later cleanup, not here.
-- All FK indexes on 0/20/30-row tables (proj_rescope_events, slug_alias,
--   user_achievements, inactive_project_dismissals, evidence.source_tier[5-row
--   lookup], plant_projects.project_type_id[20-row lookup]): the FK check scans a
--   handful of rows and is free forever. Adding indexes only worsens write cost.

-- ── OPTIONAL DROPS (commented — apply only if trimming write amplification) ───
-- photos carries 10 indexes (idx size 224kB > heap 184kB); every photo insert
-- maintains all 10. These two are safe (redundant / unused). LOW priority.
-- DO NOT drop idx_photos_live / idx_photos_project / photos_pkey (in use), and
-- DO NOT drop any findings/evidence index (zero-scan only because the care engine
-- has not launched — they are forward-correct).
--
-- DROP INDEX CONCURRENTLY IF EXISTS public.idx_photos_event_public;  -- redundant w/ idx_photos_event (leading col covered)
--   -- recreate: CREATE INDEX CONCURRENTLY idx_photos_event_public ON public.photos (event_id, project_id);
-- DROP INDEX CONCURRENTLY IF EXISTS public.idx_photos_created_by;    -- scans=0, no query filters photos by creator alone
--   -- recreate: CREATE INDEX CONCURRENTLY idx_photos_created_by ON public.photos (created_by);

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- DROP INDEX CONCURRENTLY IF EXISTS public.idx_plants_location;
-- DROP INDEX CONCURRENTLY IF EXISTS public.idx_plant_varieties_photo;
