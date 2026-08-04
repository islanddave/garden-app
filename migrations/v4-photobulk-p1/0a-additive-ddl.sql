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
-- IDEMPOTENCY (added 2026-08-04): PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS, so this was a
-- hard error on replay against an already-migrated DB. That error was, until this edit, the ONLY
-- thing stopping a replay from reaching §2 below and stripping the space_id arm. Guarding it here
-- is safe ONLY because §2 is now replay-safe in its own right — do not add this guard without it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.photos'::regclass
       AND conname  = 'photos_intake_status_valid'
  ) THEN
    ALTER TABLE public.photos
      ADD CONSTRAINT photos_intake_status_valid
      CHECK (intake_status IS NULL OR intake_status IN ('pending_tag','upload_failed'));
  END IF;
END $$;

-- ── 2. Widen the parent invariant to admit the intake state ─────────────────────────────────
-- !! NULL-SAFETY (do not "simplify" this back) !!
-- The new term MUST be COALESCE(... , false), not a bare `intake_status = 'pending_tag'`.
-- A CHECK rejects only on FALSE; it PASSES on NULL. Every pre-existing term is `IS NOT NULL`,
-- which yields TRUE/FALSE and never NULL — so the original OR-chain correctly evaluated to
-- FALSE for a parentless row. A bare equality on a NULL intake_status yields NULL, making the
-- whole chain `FALSE OR ... OR NULL` => NULL => ACCEPTED. That silently re-admits exactly the
-- accidental-orphan class this constraint exists to stop (the BUG-ORPHANNAV-001 disease).
-- Caught on the staging branch 2026-07-16 by the invariant test before this reached prod.
--
-- !! REPLAY SAFETY (rewritten 2026-08-04 — read this before touching the block below) !!
-- This block ORIGINALLY read:
--     ALTER TABLE photos DROP CONSTRAINT photos_must_have_parent;
--     ALTER TABLE photos ADD  CONSTRAINT photos_must_have_parent CHECK ( <SIX hardcoded arms> );
-- That was correct on 2026-07-16 and is a LANDMINE now. V4-SPACEPHOTO-001 (applied 2026-08-01)
-- widened the live constraint to SEVEN arms by adding `space_id IS NOT NULL`. A hardcoded
-- six-arm re-ADD therefore SILENTLY NARROWS prod: every space-only photo violates the new
-- predicate and every space-only INSERT starts failing 23514. The replay path was masked only
-- by the accidental duplicate-constraint error in §1 above — which has now been made idempotent,
-- so this block must defend itself.
--
-- The fix is to never hardcode an arm list again. The widening is DERIVED from the live
-- predicate (pg_get_constraintdef), so whatever arms exist are carried forward verbatim and a
-- future eighth arm needs no edit here. Three outcomes, no fourth:
--   (a) the live constraint already carries the intake arm  -> NO-OP (the prod case today);
--   (b) it does not                                         -> widen, preserving every live arm;
--   (c) it is absent, or it narrowed behind our back         -> RAISE EXCEPTION, loudly.
-- Silent narrowing is not reachable from any of the three.
--
-- Widening uses spacephoto's ADD NOT VALID -> VALIDATE -> DROP -> RENAME order, never
-- drop-then-add: dropping first opens a window with NO parent invariant on a hot table.
-- (Branch (b) is not expected to fire against prod ever again; it exists for a rebuilt staging
-- branch replaying the migration set in order, where photos is small. If a genuine hot-table
-- widening is ever needed, split it across 0a/0c like v4-spacephoto-001 does so VALIDATE gets
-- its own transaction rather than holding ACCESS EXCLUSIVE for the whole block.)
DO $$
DECLARE
  def        text;
  pred       text;
  has_intake boolean;
  has_space  boolean;
  space_col  boolean;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint
   WHERE conrelid = 'public.photos'::regclass
     AND conname  = 'photos_must_have_parent';

  IF def IS NULL THEN
    RAISE EXCEPTION
      'photos_must_have_parent is ABSENT from public.photos. This migration WIDENS an existing '
      'invariant; it refuses to synthesize one from a hardcoded arm list, because that is exactly '
      'how the space_id arm gets silently dropped. Inspect pg_constraint and restore the '
      'constraint before re-running.';
  END IF;

  space_col  := EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema = 'public' AND table_name = 'photos'
                           AND column_name  = 'space_id');
  has_intake := def LIKE '%intake_status%';
  has_space  := def LIKE '%space_id%';

  -- (c) narrowing tripwire: space_id exists as a column but has fallen out of the predicate.
  IF space_col AND NOT has_space THEN
    RAISE EXCEPTION
      'photos.space_id EXISTS but photos_must_have_parent does not reference it -- the constraint '
      'has been narrowed and space-only photos are already unwritable. Refusing to proceed. '
      'Live definition: %', def;
  END IF;

  -- (a) already applied.
  IF has_intake THEN
    RAISE NOTICE 'photos_must_have_parent already carries the intake arm; leaving it untouched. Live definition: %', def;
    RETURN;
  END IF;

  -- (b) widen, carrying every existing arm forward verbatim.
  pred := regexp_replace(def, '\s+NOT VALID\s*$', '');   -- a NOT VALID def would break the CHECK
  pred := substring(pred from 7);                        -- strip the leading 'CHECK '
  IF left(btrim(pred), 1) <> '(' THEN
    RAISE EXCEPTION 'Could not parse the live photos_must_have_parent predicate; refusing to guess. Raw: %', def;
  END IF;

  EXECUTE format(
    'ALTER TABLE public.photos ADD CONSTRAINT photos_must_have_parent_intake '
    'CHECK (%s OR COALESCE(intake_status = %L, false)) NOT VALID', pred, 'pending_tag');
  ALTER TABLE public.photos VALIDATE CONSTRAINT photos_must_have_parent_intake;
  ALTER TABLE public.photos DROP CONSTRAINT photos_must_have_parent;
  ALTER TABLE public.photos
    RENAME CONSTRAINT photos_must_have_parent_intake TO photos_must_have_parent;

  RAISE NOTICE 'photos_must_have_parent widened with the intake arm, derived from the live predicate.';
END $$;

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

-- ── 5. SCHEMA_VERSION (added 2026-08-04, after the fact) ────────────────────────────────────
-- This migration originally wrote NO schema_version row, breaking the house convention every
-- other 2026 migration follows (INSERT ... ON CONFLICT (version) DO NOTHING at the tail — see
-- v4-putupprov-001/0a and v4-spacephoto-001/0c, which backfilled itself for the same reason).
-- The omission meant prod carried the columns, the indexes and the widened constraint with NO
-- recorded fact that the migration had run: applied-state was recoverable only by hand-reading
-- pg_constraint. That is what made §2's landmine reachable — an unmarked migration reads as an
-- unapplied one, and the obvious next move is to replay it. The prod row was inserted directly
-- on 2026-08-04 alongside this edit; this tail is what makes any FUTURE replay record itself.
-- applied_at intentionally defaults to now(): it is the row's write time, and for prod that is
-- the backfill date, not the DDL date. The real DDL window is stated in the description below
-- and in README.md, rather than fabricating a timestamp we cannot recover.
INSERT INTO public.schema_version (version, description)
VALUES ('4.17.0-photobulk-p1','PHOTOBULK P1 (V4-PHOTOBULK-001): photos += content_hash/file_size_bytes/mime_type/original_filename/gps_lat/gps_lon/intake_status (all nullable, no defaults); CHECK photos_intake_status_valid (NULL|pending_tag|upload_failed); photos_must_have_parent widened 5 -> 6 arms with COALESCE(intake_status=''pending_tag'', false) — the COALESCE is load-bearing, a bare equality yields NULL on a NULL row and a NULL CHECK PASSES, re-admitting the accidental-orphan class; indexes idx_photos_intake_pending, idx_photos_content_hash_uniq (dedupe), idx_photos_intake_stale; COMMENTs on taken_at/intake_status. MARKER BACKFILLED 2026-08-04 — the DDL itself was applied to prod EARLIER, on or before 2026-07-31, and this row is not evidence of its apply date. Evidence for the earlier apply: v4-spacephoto-001/0a records the live constraint on 2026-07-31 already carrying the intake arm, and 4.18.0-spacephoto-001 describes itself as widening 6 -> 7 clauses, the 6 being this migration''s post-widen shape. Live shape re-verified 2026-08-04: 7 arms, convalidated. Superseded the photo_inbox table proposed by bulk-photo-upload-architecture-V100 (Dave 2026-07-16: extend photos, one source of truth); no photo_inbox table exists or should. Backend shipped in v3.55.0; client never wired, so 0/989 rows carry content_hash or taken_at.')
ON CONFLICT (version) DO NOTHING;
