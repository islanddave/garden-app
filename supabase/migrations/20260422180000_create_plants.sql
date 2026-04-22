-- Session C: plants table + event_log plant_id FK
-- 2026-04-22
-- Supports two plant types in one table:
--   Individual: name="Megatron Jalapeno", quantity=1
--   Group:      name="Serrano seedlings", quantity=5

-- ── 1. plants table ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.plants (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID        REFERENCES public.plant_projects(id) ON DELETE SET NULL,
  name        TEXT        NOT NULL,
  variety     TEXT,
  quantity    INTEGER     NOT NULL DEFAULT 1,
  notes       TEXT,
  status      TEXT,
  planted_at  TIMESTAMPTZ,
  created_by  UUID        NOT NULL REFERENCES public.profiles(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ,
  deleted_at  TIMESTAMPTZ,
  CONSTRAINT chk_plants_quantity CHECK (quantity >= 1)
);

ALTER TABLE public.plants ENABLE ROW LEVEL SECURITY;

-- Auth users can read non-deleted plants
CREATE POLICY "plants_select_auth" ON public.plants
  FOR SELECT USING (auth.uid() IS NOT NULL AND deleted_at IS NULL);

-- Auth users can insert plants they own
CREATE POLICY "plants_insert_auth" ON public.plants
  FOR INSERT WITH CHECK (auth.uid() = created_by);

-- Owner can update non-deleted plants
CREATE POLICY "plants_update_own" ON public.plants
  FOR UPDATE USING (auth.uid() = created_by AND deleted_at IS NULL);

-- Owner can soft-delete (set deleted_at) — hard DELETE blocked implicitly
CREATE POLICY "plants_delete_own" ON public.plants
  FOR DELETE USING (auth.uid() = created_by AND deleted_at IS NULL);

CREATE INDEX idx_plants_project    ON public.plants(project_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_plants_created_by ON public.plants(created_by) WHERE deleted_at IS NULL;

-- ── 2. Add plant_id to event_log ─────────────────────────────────────────────

ALTER TABLE public.event_log
  ADD COLUMN IF NOT EXISTS plant_id UUID REFERENCES public.plants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_event_log_plant
  ON public.event_log(plant_id) WHERE plant_id IS NOT NULL;
