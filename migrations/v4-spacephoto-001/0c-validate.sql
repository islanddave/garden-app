-- 0c-validate.sql
-- V4-SPACEPHOTO-001 — validate the widened parent constraint, then retire the old one.
--
-- VALIDATE takes only a SHARE UPDATE EXCLUSIVE lock (not ACCESS EXCLUSIVE), so concurrent
-- reads and writes continue during the 977-row scan.
--
-- The rename is what makes this idempotent-safe to re-run against an already-migrated DB:
-- after the rename there is exactly one constraint named photos_must_have_parent, carrying
-- the widened predicate. Re-running 0a would then fail on the duplicate _v2 name rather than
-- silently producing two overlapping constraints.

-- SCHEMA_VERSION (added 2026-08-01, after the fact). This migration set originally wrote NO
-- schema_version row — the house convention every other 2026 migration follows (see
-- v4-putupprov-001/0a: INSERT ... ON CONFLICT (version) DO NOTHING inside the transaction). The
-- omission meant prod carried the columns with no recorded fact that the migration had run:
-- applied-state was recoverable only by hand-inspecting pg_constraint. The ledger row for the
-- 2026-07-31 prod and staging applies was backfilled separately; this tail is what makes any
-- future replay record itself. ON CONFLICT DO NOTHING keeps 0c idempotent, which it already was.

BEGIN;

ALTER TABLE public.photos VALIDATE CONSTRAINT photos_must_have_parent_v2;

ALTER TABLE public.photos DROP CONSTRAINT photos_must_have_parent;

ALTER TABLE public.photos
  RENAME CONSTRAINT photos_must_have_parent_v2 TO photos_must_have_parent;

INSERT INTO public.schema_version (version, description)
VALUES ('4.18.0-spacephoto-001','SPACEPHOTO: photos.space_id uuid NULL -> spaces(id) ON DELETE RESTRICT (RESTRICT not CASCADE — a space photo may also be a planting photo; not SET NULL — that would strand a space-only photo in violation of must-have-parent). spaces.featured_photo_id uuid NULL -> photos(id) ON DELETE SET NULL (photos are SOFT-deleted so this fires only on a hard delete; the hero read must still filter deleted_at and fall back). Partial index idx_photos_space_id WHERE space_id IS NOT NULL. photos_must_have_parent widened 6 -> 7 clauses via ADD NOT VALID (0a) -> VALIDATE -> DROP old -> RENAME (0c), never drop-then-add. Additive only; no existing column, view or row touched. The feature stays dark behind the garden-photos Lambda env var SPACE_PHOTOS_ENABLED and the client const in src/lib/featureFlags.js — schema first, server gate second, client third.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
