-- V4-PLANTMERGE-001 — 0a additive DDL.
--
-- merge_event: the durable record + restorable snapshot for a planting merge.
--
-- WHY THIS IS NOT MODELLED ON reparent_event. reparent_event snapshots five scalars of ONE row
-- because a reparent changes one pointer on one row; its atomicity comes from being a single CTE
-- on a single table. A merge repoints ~1000 rows across 14 surfaces, soft-deletes N planting rows
-- and soft-deletes ~560 event rows. `snapshot` here is therefore a FULL pre-state payload, not a
-- field list, and the restore path replays it rather than writing one id back.
--
-- Snapshot contract (jsonb, schema_version pinned so a future shape change is detectable):
--   { schema_version: 1,
--     winner:   { id, <every reconciled scalar column, pre-merge> },
--     losers:  [ { id, <every column>, ... } ],
--     repoints:[ { table, column, row_id, old_value } ],          -- every row moved
--     dropped: [ <event_log.id> ],                                -- soft-deleted duplicates
--     water_collapsed: [ <event_log.id> ],                        -- B2 same-day water collapse
--     anchors_superseded: [ <plant_anchor_derivation.id> ],
--     entity_memory_deleted: [ { <full row> } ],
--     fingerprint: { <table>: { rows: n, max_updated_at: ts } }    -- set-level concurrency guard
--   }
--
-- Row ids are captured for dropped events deliberately: other surfaces may reference an event id,
-- so a restore that minted new ids would not be a restore.

BEGIN;

CREATE TABLE IF NOT EXISTS public.merge_event (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  op_id             text        NOT NULL,
  winner_plant_id   uuid        NOT NULL REFERENCES public.plants(id),
  loser_plant_ids   uuid[]      NOT NULL,
  group_label       text,
  snapshot          jsonb       NOT NULL,
  snapshot_version  integer     NOT NULL DEFAULT 1,
  events_dropped    integer     NOT NULL DEFAULT 0,
  rows_repointed    integer     NOT NULL DEFAULT 0,
  merged_at         timestamptz NOT NULL DEFAULT now(),
  merged_by         text        NOT NULL,
  restored_at       timestamptz,
  restored_by       text,
  workspace_id      uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  CONSTRAINT merge_event_losers_nonempty CHECK (cardinality(loser_plant_ids) > 0),
  -- A winner may never appear in its own loser set (would soft-delete the survivor).
  CONSTRAINT merge_event_winner_not_loser CHECK (NOT (winner_plant_id = ANY(loser_plant_ids)))
);

-- Idempotency key. A replayed op_id returns the prior outcome instead of merging twice.
CREATE UNIQUE INDEX IF NOT EXISTS merge_event_op_uniq ON public.merge_event (op_id);

CREATE INDEX IF NOT EXISTS idx_merge_event_winner ON public.merge_event (winner_plant_id);
-- Restore lookup: find the live (un-restored) merge for a given loser.
CREATE INDEX IF NOT EXISTS idx_merge_event_losers ON public.merge_event USING gin (loser_plant_ids);
CREATE INDEX IF NOT EXISTS idx_merge_event_unrestored ON public.merge_event (merged_at)
  WHERE restored_at IS NULL;

COMMIT;
