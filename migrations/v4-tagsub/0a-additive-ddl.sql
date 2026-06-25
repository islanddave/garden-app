-- 0a-additive-ddl.sql
-- V4 TAGSUB — faceted tag + entity_tag M2M (supersedes the flat entity_tags table)
--
-- PURPOSE: replace the flat single-row entity_tags model with a normalized, faceted tag system:
--   * public.tag        — distinct tag entities, faceted (type/group/lifecycle/location/freeform),
--                         owner-scoped, with visibility (shared|private), source (user|derived),
--                         and soft-delete (deleted_at).
--   * public.entity_tag — M2M join from a tag to a tagged entity (plant|cultivar|location|project),
--                         soft-delete, ON DELETE RESTRICT FK to tag (a referenced tag cannot be
--                         hard-deleted).
--   Partial-unique indexes (WHERE deleted_at IS NULL) enforce dedup only among LIVE rows, so a
--   soft-deleted tag/link can be re-created. Mirrors the owner/created_by + soft-delete RLS shape
--   of the existing entity_tags + plant_projects tables.
--
-- SAFETY: fully additive + idempotent. CREATE TABLE/INDEX IF NOT EXISTS; RLS enable is idempotent;
--   policies guarded with DROP POLICY IF EXISTS then CREATE POLICY; schema_version INSERT is
--   ON CONFLICT DO NOTHING. Re-running the whole file is a clean no-op. The legacy entity_tags
--   table is left untouched (additive supersession; cutover/backfill is a later, separate step).
--
-- DRY-RUN: dry-run-validated on COW branch dryrun-v4-tagsub-20260625-193243
--   (br-snowy-field-amxeo8j7, copy-on-write off production br-delicate-sea-amum92c2).
--   NOT yet applied to prod. NOT yet applied to staging.
--
-- ROLLBACK:
--   DROP POLICY IF EXISTS entity_tag_delete ON public.entity_tag;
--   DROP POLICY IF EXISTS entity_tag_update ON public.entity_tag;
--   DROP POLICY IF EXISTS entity_tag_insert ON public.entity_tag;
--   DROP POLICY IF EXISTS entity_tag_select ON public.entity_tag;
--   DROP POLICY IF EXISTS tag_delete ON public.tag;
--   DROP POLICY IF EXISTS tag_update ON public.tag;
--   DROP POLICY IF EXISTS tag_insert ON public.tag;
--   DROP POLICY IF EXISTS tag_select ON public.tag;
--   DROP TABLE IF EXISTS public.entity_tag;
--   DROP TABLE IF EXISTS public.tag;
--   DELETE FROM public.schema_version WHERE version='4.2.0-tagsub-001';

CREATE TABLE IF NOT EXISTS public.tag (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facet text NOT NULL CHECK (facet IN ('type','group','lifecycle','location','freeform')),
  label text NOT NULL,
  slug text NOT NULL,
  source text NOT NULL DEFAULT 'user' CHECK (source IN ('user','derived')),
  owner_id text NOT NULL,
  visibility text NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared','private')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tag_facet_slug_owner ON public.tag(facet, slug, owner_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tag_facet ON public.tag(facet) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.entity_tag (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag_id uuid NOT NULL REFERENCES public.tag(id) ON DELETE RESTRICT,
  entity_type text NOT NULL CHECK (entity_type IN ('plant','cultivar','location','project')),
  entity_id uuid NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_tag ON public.entity_tag(tag_id, entity_type, entity_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_entity_tag_entity ON public.entity_tag(entity_type, entity_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_entity_tag_tag ON public.entity_tag(tag_id) WHERE deleted_at IS NULL;

ALTER TABLE public.tag ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entity_tag ENABLE ROW LEVEL SECURITY;

-- ── RLS POLICIES ───────────────────────────────────────────────────────────────────────────────
-- Mirrors the existing entity_tags policy shape (SELECT gated on current_user_id() IS NOT NULL;
-- INSERT with_check created_by=current_user_id(); DELETE qual created_by=current_user_id()),
-- extended with the plant_projects soft-delete idiom: SELECT filters deleted_at IS NULL, and an
-- UPDATE policy (created_by both qual + with_check) is added so soft-delete (UPDATE deleted_at)
-- works under RLS. owner_id mirrors created_by as the ownership key on tag. All policies use the
-- existing public.current_user_id() session-scoped helper (reads app.user_id; STABLE).

-- tag
DROP POLICY IF EXISTS tag_select ON public.tag;
CREATE POLICY tag_select ON public.tag
  FOR SELECT
  USING (current_user_id() IS NOT NULL AND deleted_at IS NULL);

DROP POLICY IF EXISTS tag_insert ON public.tag;
CREATE POLICY tag_insert ON public.tag
  FOR INSERT
  WITH CHECK (created_by = current_user_id());

DROP POLICY IF EXISTS tag_update ON public.tag;
CREATE POLICY tag_update ON public.tag
  FOR UPDATE
  USING (created_by = current_user_id())
  WITH CHECK (created_by = current_user_id());

DROP POLICY IF EXISTS tag_delete ON public.tag;
CREATE POLICY tag_delete ON public.tag
  FOR DELETE
  USING (created_by = current_user_id());

-- entity_tag
DROP POLICY IF EXISTS entity_tag_select ON public.entity_tag;
CREATE POLICY entity_tag_select ON public.entity_tag
  FOR SELECT
  USING (current_user_id() IS NOT NULL AND deleted_at IS NULL);

DROP POLICY IF EXISTS entity_tag_insert ON public.entity_tag;
CREATE POLICY entity_tag_insert ON public.entity_tag
  FOR INSERT
  WITH CHECK (created_by = current_user_id());

DROP POLICY IF EXISTS entity_tag_update ON public.entity_tag;
CREATE POLICY entity_tag_update ON public.entity_tag
  FOR UPDATE
  USING (created_by = current_user_id())
  WITH CHECK (created_by = current_user_id());

DROP POLICY IF EXISTS entity_tag_delete ON public.entity_tag;
CREATE POLICY entity_tag_delete ON public.entity_tag
  FOR DELETE
  USING (created_by = current_user_id());

INSERT INTO public.schema_version (version, description)
VALUES ('4.2.0-tagsub-001','TAGSUB: faceted tag + entity_tag M2M (5 facets, source user/derived, visibility, soft-delete, partial-unique dedup, RLS). Supersedes flat entity_tags.')
ON CONFLICT (version) DO NOTHING;
