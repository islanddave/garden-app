-- V4-SHARETARGETS-001 — make share_log honest about WHICH surface a post went to.
--
-- Prerequisite of any destination beyond Facebook, and of the 20260828 crucible's condition 4.
-- share_log currently holds 0 rows and garden-facebook-share has never posted (VITE_API_FACEBOOK_SHARE
-- does not exist as a repo variable, so the shipped SPA has no address to post to), which is why
-- every change below is free of a backfill: there is no history to migrate, only a shape to fix
-- before the first row is ever written.
--
-- ORDERING. This DDL must land BEFORE any handler that writes an Instagram row or one of the new
-- status values. Adding an accepted value to a CHECK is the safe direction — it cannot break the
-- currently deployed writer, which emits only 'facebook' and only the five original statuses
-- (verified: lambda/facebook-share/index.js is the ONLY writer to this table, at :339/:343/:351/
-- :473/:476, and it passes target explicitly on every INSERT). Doing it the other way round — code
-- first — is the 23514-after-publish hazard: the post goes out to a public Page and the audit
-- INSERT then fails, leaving a live post with no record.
--
-- WHAT IS DELIBERATELY NOT HERE: client_request_id is still NULLABLE. Making it NOT NULL would
-- break the DEPLOYED handler, which passes null whenever the client omits the field, so it needs
-- expand/contract across three promotes rather than a line in an additive migration. Until then
-- idempotency is opt-in by the client and a double-post remains possible for any caller that omits
-- the key — see the note on the unique index below, which is also deliberately absent.

BEGIN;

-- 1. DROP THE DEFAULT. `target text NOT NULL DEFAULT 'facebook'` is the live hazard the crucible
--    ranked above the missing CHECK: a writer that omits target does not fail, it silently records
--    an Instagram or Threads post AS A FACEBOOK POST — and it would pass the new CHECK below while
--    doing it, because 'facebook' is a legal value. With no default, the same omission raises a
--    NOT NULL violation at the INSERT, which is the loud, correct failure.
ALTER TABLE share_log ALTER COLUMN target DROP DEFAULT;

-- 2. CONSTRAIN target TO THE REAL DESTINATION SET. Enumerating only 'facebook' would reproduce the
--    same 23514-after-publish hazard the moment the Instagram lane ships, so the set is written to
--    cover the destinations that are built or specified, not just the one that exists today.
--    'instagram' is not speculative: lane-igtrack-20260821 already writes target='instagram'.
ALTER TABLE share_log DROP CONSTRAINT IF EXISTS share_log_target_valid;
ALTER TABLE share_log ADD CONSTRAINT share_log_target_valid
  CHECK (target IN ('facebook', 'instagram', 'threads', 'pinterest'));

-- 3. WIDEN THE STATUS SET.
--    orphan_cleanup_failed — the state that had no representation: a Graph delete that did not
--      confirm means a real unpublished media object is still on a public Page. It was previously
--      recorded as 'orphan_cleaned', i.e. as a success. lambda/facebook-share/orphans.js writes
--      'failed' + a specific error today precisely BECAUSE this value did not exist yet; once this
--      migration is applied it can move to the honest status.
--    partial — a multi-target post where one destination succeeded and another did not. Unrepresentable
--      today, and it is the normal outcome of a combined Facebook+Instagram post.
--    queued  — media accepted but not yet published (the Instagram container flow is asynchronous by
--      construction: create container, poll, publish).
--    retracted — the post was deleted from the destination afterwards. Without it, deleting a post
--      leaves share_log asserting it is still live.
ALTER TABLE share_log DROP CONSTRAINT IF EXISTS share_log_status_valid;
ALTER TABLE share_log ADD CONSTRAINT share_log_status_valid
  CHECK (status IN ('pending', 'uploading', 'queued', 'posted', 'partial',
                    'failed', 'orphan_cleaned', 'orphan_cleanup_failed', 'retracted'));

-- 4. permalink — the handler already returns `permalink` to the client from the Graph response and
--    the success sheet links to it, but nothing persists it. Without the column the audit trail can
--    say a post exists and cannot say where it is, which is the one fact a human needs in order to
--    go and delete it.
ALTER TABLE share_log ADD COLUMN IF NOT EXISTS permalink text;

-- 5. on_behalf_of — Jen. Every post is made with Dave's admin identity and requested_by records the
--    Clerk sub that pressed the button, so a post of Jen's photo is indistinguishable from a post of
--    Dave's. This column is added now because the schema window for it is open exactly once: adding
--    it later means backfilling a provenance fact that was never recorded and cannot be recovered.
--    Nullable and unwritten until the household-publish decision is made — its presence costs
--    nothing and its absence is irreversible.
ALTER TABLE share_log ADD COLUMN IF NOT EXISTS on_behalf_of text;

-- NO UNIQUE INDEX ON (client_request_id, target, photo_id). The grain is right, and the constraint
-- would still be wrong to add here: this table's INSERT writes 'pending' rows BEFORE the post is
-- attempted, so a retry after a FAILED attempt — the exact case the key exists to serve — would hit
-- the unique violation on its own prior pending rows and be unable to retry at all. Enforcing
-- idempotency in the database requires the writer to become an upsert first. The replay SELECT plus
-- a client key that now survives reload (src/lib/shareIdempotency.js) is the working guard.

COMMIT;
