-- V4-PHOTOBULK-001 P1 — bulk photo upload + quick-tag carousel: additive intake columns.
--
-- DESIGN NOTE (deviates from bulk-photo-upload-architecture-V100-20260709.md — deliberately):
-- V100 proposed a NEW `photo_inbox` table. That spec was written without reference to the
-- existing `photos` table, which already carries storage_path / plant_id / taken_at /
-- created_by / caption / sort_order / deleted_at plus FOUR other parent targets. A second
-- table holding photos would be a second source of truth for one entity. Dave's call
-- (2026-07-16): extend `photos`. V100's UX findings (tag-at-capture primary, visible buttons
-- over swipe gestures, client-side resize, undo, per-tag persistence) are all retained; only
-- its data-model half is superseded.
--
-- V100's DDL additionally referenced `plantings(id)` and `users(id)` — NEITHER TABLE EXISTS.
-- The real planting table is `plants` (garden_node is a VIEW over it) and there is no users
-- table at all: identity is a Clerk sub stored as TEXT (e.g. 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI'),
-- so `user_id UUID REFERENCES users(id)` was unbuildable. We reuse photos.created_by (text).
--
-- ── THE CONSTRAINT INTERACTION (the load-bearing bit) ──────────────────────────────────────
-- `photos_must_have_parent` currently REQUIRES at least one parent FK. That is why 0 of 698
-- live photos are parentless — it is enforced, not incidental. An "inbox" of untagged photos
-- is therefore IMPOSSIBLE without touching this constraint.
--
-- We do NOT simply drop it. That constraint guards the exact failure class as
-- BUG-ORPHANNAV-001 (a record attached to nothing is invisible everywhere and unreachable).
-- Instead we widen it to admit ONE new legal parentless state: an explicit intake photo
-- (intake_status='pending_tag'). The invariant becomes:
--
--     a photo is attached to something, OR it is deliberately sitting in the tagging inbox.
--
-- A photo can still never become parentless BY ACCIDENT — only by declaring itself intake,
-- and the inbox UI is what makes that state visible and drainable. Tagging a photo sets a
-- parent and clears intake_status to NULL, returning it to the strict invariant.
--
-- SAFETY: widening a CHECK is a loosening — every existing row satisfies the stricter
-- predicate and therefore satisfies the looser one (verified: 0 rows parentless on prod
-- 2026-07-16). All new columns are nullable with no default => metadata-only ALTER, no table
-- rewrite, no long lock (PG11+). The photos INSERT in lambda/photos/index.js uses an EXPLICIT
-- column list, so new columns are simply omitted (default NULL) and the existing write path is
-- byte-unaffected — same reasoning as v4-photocdn-p1/0a.
--
-- L-238 ORDERING: apply to BOTH prod AND the staging Neon branch BEFORE the promote. The
-- carousel/batch code reads intake_status, so this DDL MUST land before that code deploys
-- (the "code referencing new columns that don't yet exist" exception in the Migration
-- Authoring Rule: additive DDL first, then code).

-- ── 1. Intake metadata (all nullable; legacy rows stay NULL) ────────────────────────────────
ALTER TABLE photos
  ADD COLUMN IF NOT EXISTS content_hash      text,
  ADD COLUMN IF NOT EXISTS file_size_bytes   integer,
  ADD COLUMN IF NOT EXISTS mime_type         text,
  ADD COLUMN IF NOT EXISTS original_filename text,
  ADD COLUMN IF NOT EXISTS gps_lat           numeric,
  ADD COLUMN IF NOT EXISTS gps_lon           numeric,
  ADD COLUMN IF NOT EXISTS intake_status     text;

-- NULL = a normal attached photo (every legacy row, and every photo once tagged).
-- 'pending_tag'   = uploaded, sitting in the inbox, not yet attached to anything.
-- 'upload_failed' = confirm step recorded a failure; retained for the cleanup sweep.
-- V100's 'tagged' / 'skipped' / 'auto_tagged_session' are DERIVED, not stored:
--   tagged  = intake_status IS NULL AND a parent FK is set
--   skipped = still pending_tag (the carousel just moves on; skip is not a persisted state)
-- Session auto-tagging (V100 Phase 2) sets a real parent, so it needs no separate status.
ALTER TABLE photos
  ADD CONSTRAINT photos_intake_status_valid
  CHECK (intake_status IS NULL OR intake_status IN ('pending_tag','upload_failed'));

-- ── 2. Widen the parent invariant to admit the intake state ─────────────────────────────────
-- !! NULL-SAFETY (do not "simplify" this back) !!
-- The new term MUST be COALESCE(... , false), not a bare `intake_status = 'pending_tag'`.
-- A CHECK rejects only on FALSE; it PASSES on NULL. Every pre-existing term is `IS NOT NULL`,
-- which yields TRUE/FALSE and never NULL — so the original OR-chain correctly evaluated to
-- FALSE for a parentless row. A bare equality on a NULL intake_status yields NULL, making the
-- whole chain `FALSE OR ... OR NULL` => NULL => ACCEPTED. That silently re-admits exactly the
-- accidental-orphan class this constraint exists to stop (the BUG-ORPHANNAV-001 disease).
-- Caught on the staging branch 2026-07-16 by the invariant test before this reached prod.
ALTER TABLE photos DROP CONSTRAINT photos_must_have_parent;
ALTER TABLE photos ADD CONSTRAINT photos_must_have_parent CHECK (
  event_id IS NOT NULL
  OR project_id IS NOT NULL
  OR location_id IS NOT NULL
  OR plant_id IS NOT NULL
  OR inventory_item_id IS NOT NULL
  -- NEW: a deliberately-parentless photo awaiting tagging. Drainable via the inbox UI.
  OR COALESCE(intake_status = 'pending_tag', false)
);

-- ── 3. Indexes ──────────────────────────────────────────────────────────────────────────────
-- The inbox query: this user's untagged photos in CAPTURE order (taken_at), which is what the
-- carousel exploits (spatial memory from a garden walk). taken_at is in the index so the sort
-- is covered. Partial => tiny (only ever holds the undrained inbox, normally 0 rows).
CREATE INDEX IF NOT EXISTS idx_photos_intake_pending
  ON photos (created_by, taken_at)
  WHERE deleted_at IS NULL AND intake_status = 'pending_tag';

-- Dedup guard: re-selecting the same photo from the camera roll must not create a second row.
-- Scoped per-user and to live rows so a soft-deleted photo can be legitimately re-uploaded.
CREATE UNIQUE INDEX IF NOT EXISTS idx_photos_content_hash_uniq
  ON photos (created_by, content_hash)
  WHERE content_hash IS NOT NULL AND deleted_at IS NULL;

-- Orphan sweep support: find intake rows old enough to be presumed abandoned (V100's 48h
-- S3-object cleanup). Partial + tiny for the same reason as above.
CREATE INDEX IF NOT EXISTS idx_photos_intake_stale
  ON photos (created_at)
  WHERE deleted_at IS NULL AND intake_status IS NOT NULL;

-- ── 4. taken_at is the canonical capture time (project rule: capture time, NEVER file-add) ──
-- taken_at already exists but is NULL on ALL 698 live rows — the app has never extracted EXIF.
-- P1 populates it client-side from EXIF DateTimeOriginal at upload. The historical backfill of
-- the existing 698 is a SEPARATE one-off script (V4-PHOTOEXIF-001), not this migration.
COMMENT ON COLUMN photos.taken_at IS
  'Canonical CAPTURE timestamp from EXIF DateTimeOriginal, never upload/file-add time. NULL on pre-V4-PHOTOBULK-001 rows (readers fall back to created_at). Care notes/KB facts derived from a photo MUST be dated by this, per the gardening Photo-observation-timestamp rule.';

COMMENT ON COLUMN photos.intake_status IS
  'NULL = attached photo (normal). pending_tag = in the bulk-upload inbox, deliberately parentless, drainable via the quick-tag carousel. upload_failed = confirm recorded a failure. photos_must_have_parent admits parentless ONLY for pending_tag.';
