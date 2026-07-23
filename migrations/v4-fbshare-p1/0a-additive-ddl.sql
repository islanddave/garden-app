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
