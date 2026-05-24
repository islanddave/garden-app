-- V2-quicklog Session 1 — 0a additive DDL (bulk "Quick Log" / Unit A)
-- Date: 2026-05-24 | Spec: bulk-quick-log-unitA-build-spec-V001-20260524.md
-- Scope: NEW event_batches table (batch audit + idempotency + recent-batches source)
--        + expression index on event_log(metadata->>'batch_id') for undo/lookup.
-- Additive only. No destructive DDL. Idempotent guards per house convention.

BEGIN;

CREATE TABLE IF NOT EXISTS event_batches (
  id              UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  idempotency_key TEXT NOT NULL UNIQUE,                 -- client-generated per Confirm intent
  created_by      TEXT NOT NULL,                        -- Clerk sub
  event_type      TEXT NOT NULL,
  scope_json      JSONB NOT NULL,                       -- {type:'all'|'project'|'space', project_id?, location_id?}
  item_count      INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','complete')),
  event_date      DATE NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  undone_at       TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_event_batches_owner_recent
  ON event_batches (created_by, created_at DESC) WHERE undone_at IS NULL;

-- Undo + batch lookup on event_log without seq-scan (soft-delete-aware).
CREATE INDEX IF NOT EXISTS idx_event_log_batch_id
  ON event_log ((metadata->>'batch_id')) WHERE deleted_at IS NULL;

COMMIT;
