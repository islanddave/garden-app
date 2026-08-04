-- V4-EVENTSOURCE-001 / 0a — first-class provenance column on event_log (ADDITIVE, nullable).
-- Batch-B decision packet item 10, Option B ("add event_log.source, backfill, THEN drop app_events").
--
-- WHY A COLUMN AND NOT A metadata KEY: it survives schema tooling, can be indexed, and can be
-- constrained. An earlier draft proposed metadata.app_path; the packet supersedes it.
--
-- WHY THIS REPLACES THE TIMESTAMP-COLLISION HEURISTIC: that heuristic is 98.5% false-positive —
-- 231 of 236 collision groups are POST /api/events/batch, which shares created_at by construction
-- (one INSERT ... SELECT for up to 500 rows). See the packet §10.
--
-- BACKWARD COMPATIBILITY — READ BEFORE APPLYING (memory: "arming a CHECK is a deploy, not a
-- migration"). This file is safe to apply against a DB still served by the CURRENTLY DEPLOYED
-- Lambda, which knows nothing about `source`:
--   • column is NULLABLE with no DEFAULT  -> old INSERTs that omit it succeed, landing NULL.
--   • the CHECK admits NULL explicitly    -> those NULL rows satisfy it.
--   • the CHECK is created NOT VALID      -> no full-table scan, and no failure on pre-existing rows.
-- There is therefore NO ordering constraint between this file and the code deploy in the
-- "apply first" direction. The reverse IS constrained: the Lambda change that WRITES `source`
-- must not reach an environment where this column is absent, or every event INSERT 42703s.
-- Sequencing consequence (integration-test.yml branches off staging and does NOT apply
-- migrations): APPLY 0a TO STAGING BEFORE THE DEV PUSH.
--
-- VALUE SET — deliberately small, and every value must be PROVABLE from a surface that exists:
--   'app'        POST /api/events          (single-event write path, lambda/events)
--   'app_batch'  POST /api/events/batch    (bulk "Log all" write path, lambda/events)
--   'app_status' server-emitted status_change audit rows (lambda/plants, lambda/projects;
--                frozen metadata contract schema='status_change.v1')
--   'import'     bulk/one-off import scripts (0 rows today; reserved so an importer has a value
--                to declare rather than inventing one)
--   'direct'     written straight to the database, bypassing every API path. RESERVED. 0b does
--                NOT backfill it and MUST NOT: the app_events telemetry INSERT is wrapped in a
--                non-fatal try/catch (lambda/events/index.js Step 5), so "no telemetry row" is
--                indistinguishable from "telemetry failed". Only a writer that knows it is
--                bypassing the API may set this.
--   NULL         UNKNOWN. Honest default; 0b leaves 166 historical rows here on purpose.

ALTER TABLE public.event_log
  ADD COLUMN IF NOT EXISTS source text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'event_log_source_check') THEN
    ALTER TABLE public.event_log ADD CONSTRAINT event_log_source_check
      CHECK (source IS NULL OR source = ANY (ARRAY['app','app_batch','app_status','import','direct']))
      NOT VALID;
  END IF;
END $$;

-- Provenance questions are "how many rows came from X" / "show me the non-app rows", i.e. low
-- cardinality over the live set. Partial on deleted_at IS NULL to match every other event_log
-- read predicate in the codebase.
CREATE INDEX IF NOT EXISTS idx_event_log_source
  ON public.event_log (source) WHERE deleted_at IS NULL;

INSERT INTO public.schema_version (version, description)
VALUES ('4.21.0-eventsource-001',
        'event_log.source provenance column (nullable, NOT VALID CHECK, partial index) — Batch-B item 10 Option B')
ON CONFLICT (version) DO NOTHING;
