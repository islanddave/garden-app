-- 20260424_brand_spaces_spacetheme.sql
-- BRAND migration — V1.1.1
-- Creates spaces stub + spacetheme table for per-space UX/UI theming.
-- App name is now "Gardens at Home" (placeholder; will change).
-- Space identity (e.g. "Gardens at Mathews Ridge") lives in spaces/spacetheme — separate from app brand.

-- spaces: L0 physical location stub
-- V2 will expand with multi-user ownership, invites, workspace FK.
CREATE TABLE IF NOT EXISTS public.spaces (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  created_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- spacetheme: per-space UX/UI branding properties
-- One row per space (UNIQUE on space_id).
-- All fields nullable — partial themes are valid while a space is being set up.
CREATE TABLE IF NOT EXISTS public.spacetheme (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id          UUID        NOT NULL REFERENCES public.spaces(id) ON DELETE CASCADE,
  display_name      TEXT,                  -- Branded name shown to users (may differ from spaces.name)
  tagline           TEXT,                  -- Short subtitle / description
  profile_image_url TEXT,                  -- Square avatar / profile image for the space
  banner_image_url  TEXT,                  -- Wide hero/header image
  logo_url          TEXT,                  -- Logo asset (transparent PNG preferred)
  primary_color     TEXT,                  -- Hex e.g. #2d6a4f
  secondary_color   TEXT,                  -- Hex e.g. #f8f5f0
  accent_color      TEXT,                  -- Hex e.g. #8a6e2a
  font_family       TEXT,                  -- CSS font-family override (null = app default)
  created_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(space_id)
);

-- RLS
ALTER TABLE public.spaces     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spacetheme ENABLE ROW LEVEL SECURITY;

-- spaces policies
CREATE POLICY spaces_select ON public.spaces FOR SELECT TO authenticated USING (true);
CREATE POLICY spaces_insert ON public.spaces FOR INSERT TO authenticated WITH CHECK (auth.uid() = created_by);
CREATE POLICY spaces_update ON public.spaces FOR UPDATE TO authenticated USING (auth.uid() = created_by);
CREATE POLICY spaces_delete ON public.spaces FOR DELETE TO authenticated USING (auth.uid() = created_by);

-- spacetheme policies
CREATE POLICY spacetheme_select ON public.spacetheme FOR SELECT TO authenticated USING (true);
CREATE POLICY spacetheme_insert ON public.spacetheme FOR INSERT TO authenticated WITH CHECK (auth.uid() = created_by);
CREATE POLICY spacetheme_update ON public.spacetheme FOR UPDATE TO authenticated USING (auth.uid() = created_by);
CREATE POLICY spacetheme_delete ON public.spacetheme FOR DELETE TO authenticated USING (auth.uid() = created_by);

-- Seed: initial space
INSERT INTO public.spaces (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'Gardens at Mathews Ridge')
ON CONFLICT (id) DO NOTHING;

-- Seed: initial spacetheme — matches current app palette
INSERT INTO public.spacetheme (space_id, display_name, primary_color, secondary_color, accent_color)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Gardens at Mathews Ridge',
  '#2d6a4f',
  '#f8f5f0',
  '#8a6e2a'   -- gold token (confirmed canonical)
)
ON CONFLICT (space_id) DO NOTHING;

-- schema_version bump
INSERT INTO public.schema_version (version, description)
VALUES ('1.1.1', 'BRAND: spaces stub + spacetheme table, app renamed to Gardens at Home')
ON CONFLICT (version) DO NOTHING;
