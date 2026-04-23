-- Technical Sprint Migration
-- Session: Technical Sprint
-- Applied: 2026-04-23
-- Items: soft-delete (plant_projects/event_log/photos/tasks) + RLS updates
--        app_config table, featured_image_id FKs
-- NOTE: quantity NUMERIC(10,3) deferred pending table clarification

-- ============================================================
-- 1. SOFT DELETE — add deleted_at to remaining core tables
-- plants + inventory_items already have deleted_at (skipped here)
-- ============================================================

ALTER TABLE public.plant_projects  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.event_log        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.photos           ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.tasks            ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Partial indexes for soft-delete queries
CREATE INDEX IF NOT EXISTS idx_plant_projects_live ON public.plant_projects(id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_event_log_live       ON public.event_log(id)        WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_photos_live          ON public.photos(id)           WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_live           ON public.tasks(id)            WHERE deleted_at IS NULL;

-- ============================================================
-- 2. RLS SELECT POLICIES — add deleted_at IS NULL filter
-- ============================================================

-- plant_projects
DROP POLICY IF EXISTS projects_public_read ON public.plant_projects;
CREATE POLICY projects_public_read ON public.plant_projects FOR SELECT
  USING ((is_public = true OR auth.role() = 'authenticated') AND deleted_at IS NULL);

-- event_log
DROP POLICY IF EXISTS events_public_read ON public.event_log;
CREATE POLICY events_public_read ON public.event_log FOR SELECT
  USING (
    deleted_at IS NULL
    AND (
      auth.role() = 'authenticated'
      OR (
        is_public = true
        AND EXISTS (
          SELECT 1 FROM public.plant_projects p
          WHERE p.id = event_log.project_id
            AND p.is_public = true
            AND p.deleted_at IS NULL
        )
      )
    )
  );

-- photos
DROP POLICY IF EXISTS photos_public_read ON public.photos;
CREATE POLICY photos_public_read ON public.photos FOR SELECT
  USING (
    deleted_at IS NULL
    AND (
      auth.role() = 'authenticated'
      OR (
        is_public = true
        AND (
          (
            event_id IS NULL AND project_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public.plant_projects p
              WHERE p.id = photos.project_id
                AND p.is_public = true
                AND p.deleted_at IS NULL
            )
          )
          OR (
            event_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public.event_log e
              JOIN public.plant_projects p ON p.id = e.project_id
              WHERE e.id = photos.event_id
                AND e.is_public = true AND e.deleted_at IS NULL
                AND p.is_public = true AND p.deleted_at IS NULL
            )
          )
        )
      )
    )
  );

-- tasks — split ALL policy into SELECT (with deleted filter) + write ops
DROP POLICY IF EXISTS tasks_auth_only ON public.tasks;

DO $$ BEGIN
  CREATE POLICY tasks_select_auth ON public.tasks FOR SELECT
    USING (auth.role() = 'authenticated' AND deleted_at IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY tasks_insert_auth ON public.tasks FOR INSERT
    WITH CHECK (auth.role() = 'authenticated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY tasks_update_auth ON public.tasks FOR UPDATE
    USING (auth.role() = 'authenticated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY tasks_delete_auth ON public.tasks FOR DELETE
    USING (auth.role() = 'authenticated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ============================================================
-- 3. APP_CONFIG TABLE
-- k/v store for runtime config (e.g. app_name, feature flags)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.app_config (
  key        TEXT        PRIMARY KEY,
  value      JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY app_config_auth_read ON public.app_config FOR SELECT
    USING (auth.role() = 'authenticated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY app_config_auth_write ON public.app_config
    FOR ALL USING (auth.role() = 'authenticated')
    WITH CHECK (auth.role() = 'authenticated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TRIGGER app_config_updated_at BEFORE UPDATE ON public.app_config
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================
-- 4. FEATURED_IMAGE_ID — nullable FK to photos on 4 tables
-- ON DELETE SET NULL: deleting a photo doesn't cascade to entity
-- ============================================================

ALTER TABLE public.plant_projects
  ADD COLUMN IF NOT EXISTS featured_image_id UUID
  REFERENCES public.photos(id) ON DELETE SET NULL;

ALTER TABLE public.plants
  ADD COLUMN IF NOT EXISTS featured_image_id UUID
  REFERENCES public.photos(id) ON DELETE SET NULL;

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS featured_image_id UUID
  REFERENCES public.photos(id) ON DELETE SET NULL;

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS featured_image_id UUID
  REFERENCES public.photos(id) ON DELETE SET NULL;


-- ============================================================
-- 5. QUANTITY NUMERIC(10,3) — DEFERRED
-- Target table unclear (event_log.quantity is TEXT; plants.quantity is INT)
-- Run separately after confirmation
-- ============================================================
