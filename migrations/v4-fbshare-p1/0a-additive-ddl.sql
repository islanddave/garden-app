-- V4-FBSHARE-001 P1 — Facebook Page sharing: share_log audit / idempotency table.
--
-- Additive-only. Records each attempt to post a garden photo to the "Gardens at Mathews"
-- Facebook Page via the Graph API (POST /api/share/facebook). ONE ROW PER PHOTO PER POST; the
-- N photos of one multi-photo post share a post_group_id.
--
-- WHY a table (not fire-and-forget): the Graph API has NO idempotency key, so a lost HTTP
-- response on a client retry would double-post. The pending -> posted status here is the
-- idempotency guard: a completed row for a given client_request_id is replayed instead of
-- re-posted. The row also holds the published=false media id so an orphaned media object can be
-- deleted if the subsequent /feed call fails (attached_media flow leaves invisible media on
-- failure otherwise).
--
-- DECOUPLED FROM photos.is_public BY DESIGN: FB posting reads the photo BYTES from S3
-- server-side (byte-upload, not url=), so it never makes an S3 object public and never reads or
-- writes is_public. is_public is true for all 869 live rows and means only "visible on the public
-- project page" — a narrower consent than "post to public Facebook". The explicit compose+post
-- action is the consent gate, not is_public.
--
-- IDENTITY: requested_by is a Clerk sub stored as TEXT (mirrors photos.created_by); there is no
-- users table. photo_id FKs photos(id) ON DELETE CASCADE so a purged photo takes its share log
-- with it (the FB post is external and unaffected — this is a local audit trail, not a mirror).

CREATE TABLE IF NOT EXISTS share_log (
  id                uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  post_group_id     uuid NOT NULL,                                 -- groups the N photos of one FB post
  photo_id          uuid NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  target            text NOT NULL DEFAULT 'facebook',              -- forward-compat: other targets later
  client_request_id text,                                          -- client idempotency key (replay guard)
  fb_page_id        text,
  fb_media_id       text,                                          -- published=false media id (orphan cleanup)
  fb_post_id        text,                                          -- the /feed (or /photos) story id
  status            text NOT NULL DEFAULT 'pending',
  caption           text,
  requested_by      text NOT NULL,                                 -- Clerk sub of the admin who posted
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT share_log_status_valid
    CHECK (status IN ('pending', 'uploading', 'posted', 'failed', 'orphan_cleaned'))
);

CREATE INDEX IF NOT EXISTS share_log_photo_idx ON share_log (photo_id);
CREATE INDEX IF NOT EXISTS share_log_group_idx ON share_log (post_group_id);
-- Idempotency replay lookup: a completed post for a given client_request_id.
CREATE INDEX IF NOT EXISTS share_log_reqid_idx ON share_log (client_request_id) WHERE client_request_id IS NOT NULL;

-- ── Added 2026-07-26 while closing the L-081 audit ───────────────────────────────────────────────
-- This migration was authored for V4-FBSHARE-001 and NEVER APPLIED TO ANY ENVIRONMENT, while the
-- ledger recorded the feature as "Shipped prod v3.35.0" and deploy-lambda.yml kept shipping
-- garden-facebook-share on every promote. So POST /api/share/facebook has been live in prod against
-- a table that does not exist: the first real use would raise 42703 and 500. The L-081 schema audit
-- has been failing on exactly these 8 columns and was correct every time — it was reported as
-- "chronically red / pre-existing", which is how a true positive gets read as noise.
--
-- It also lacked the schema_version INSERT that every other migration in this tree records, which is
-- why nothing downstream could tell applied from unapplied. Added below; the file stays idempotent
-- (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, ON CONFLICT DO NOTHING).
INSERT INTO public.schema_version (version, description)
VALUES ('4.9.0-fbshare-p1','FBSHARE P1: share_log audit/idempotency table for Facebook Page posting (post_group_id groups the N photos of one post; client_request_id is the replay guard since the Graph API has no idempotency key; status CHECK pending|uploading|posted|failed|orphan_cleaned; photo_id FK photos ON DELETE CASCADE) + 3 indexes. Authored for V4-FBSHARE-001 but never applied — backfilled 2026-07-26 after the L-081 audit showed the lambda referencing 8 columns of a table absent from prod.')
ON CONFLICT (version) DO NOTHING;
