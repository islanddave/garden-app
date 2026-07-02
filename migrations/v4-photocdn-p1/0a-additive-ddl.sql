-- V4-PHOTOCDN-001 P1 — additive derivative/blurhash columns on photos.
-- INERT in P1: no deployed code reads or writes these columns yet. They are the persistence
-- target for the later derivative-generation phase (eager backfill persists derivative keys +
-- blurhash on the row so issuance never HEADs/hashes at request time — spec V101 §4/§6).
--
-- SAFE additive change: all columns nullable, no default => metadata-only ALTER (no table
-- rewrite/long lock, PG11+), and the photos INSERT uses an EXPLICIT 10-column list so the new
-- columns are simply omitted (default NULL) — the write path is unaffected. Verified against
-- lambda/photos/index.js INSERT (explicit column list).
--
-- L-238 ordering: apply to BOTH prod AND the staging Neon branch BEFORE the promote. Because no
-- consuming code references these columns in P1, there is no schema/code coupling to violate —
-- shipping the schema AHEAD of its future consumer is the safe side of L-238.
--
-- Column meanings:
--   original_etag        S3 ETag (hex, no quotes) of the original object at derivative-gen time;
--                        the derivative key embeds it so a replaced original yields a new key.
--   derivative_thumb_key S3 key of the 96px thumb WebP derivative (priv/d/...); NULL until backfilled.
--   derivative_card_key  S3 key of the 480w card WebP derivative;               NULL until backfilled.
--   blurhash             compact blurhash string for an instant placeholder;    NULL until backfilled.
ALTER TABLE public.photos
  ADD COLUMN IF NOT EXISTS original_etag        text,
  ADD COLUMN IF NOT EXISTS derivative_thumb_key text,
  ADD COLUMN IF NOT EXISTS derivative_card_key  text,
  ADD COLUMN IF NOT EXISTS blurhash             text;
