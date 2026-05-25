-- 0a-additive-ddl.sql
-- UX-METRICS (Post-V2 UX Overhaul — Increment 0 Foundations) — success-metric instrumentation sink.
-- Spec: success-metric-instrumentation-spec-V001-20260522.1620.md — §2 (M1 tap-count), §6 Q1 (dedicated
--   append-only ux_events table, NOT event_log, which is user-facing garden data).
-- Decision: append-only UX telemetry. Admin-gated read only (Reward UX V100 §8 "Garden Activity").
--   Jen-invisible. This is NOT user garden data — it is Dave's diagnostic instrument (M1 tap-count).
--   M2 (capture-events/week) is derived from existing event_log/plants/plant_projects.created_at — no rows here.
--   M3 (agent-proposal accept-rate) reserves no schema here; its fields live on the Inc-3 `tasks` table.
-- Safety: ADDITIVE ONLY — CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS. No backfill,
--   no NOT NULL added to an existing table, no VALIDATE → L-058 pre-VALIDATE sweep N/A.
--   Idempotent; re-run is a no-op. Migration Authoring Rule §2 (additive — safe any time).
-- Order note: this table must exist BEFORE the garden-ux-events Lambda's writes go live, or POSTs 500
--   (additive-before-consuming-code). Lambda + frontend hooks ship after this is verified on each env.
-- Retention: diagnostic, ~90 days (spec §6 Q3). Cleanup is a separate scheduled concern (not this DDL).
-- Rollback: DROP TABLE IF EXISTS public.ux_events;

CREATE TABLE IF NOT EXISTS public.ux_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clerk_sub   text        NOT NULL,                 -- who (Clerk sub from verified JWT; never trusted from body)
  session_id  text        NOT NULL,                 -- client session id → taps-to-completion is per (session_id, flow_id)
  flow_id     text        NOT NULL,                 -- 'log_watering' | 'reach_planting' | 'create_project' (server-allowlisted)
  step_index  integer     NOT NULL DEFAULT 0,       -- monotonic step within a flow instance
  step_name   text,                                 -- optional human label for the step
  tap_count   integer,                              -- taps so far in this flow instance (set on the completion event)
  client_ts   timestamptz,                          -- client-reported event time (advisory; created_at is authoritative)
  meta        jsonb,                                -- optional structured extras (entry route, etc.) — no free text PII
  created_at  timestamptz NOT NULL DEFAULT now()    -- server receive time (authoritative ordering)
);

-- Aggregation by flow over a recent window (admin M1 panel).
CREATE INDEX IF NOT EXISTS idx_ux_events_flow_recent
  ON public.ux_events (flow_id, created_at DESC);

-- Per-user-per-flow (future per-person breakdown; cheap, low cardinality at N=2 users).
CREATE INDEX IF NOT EXISTS idx_ux_events_sub_flow
  ON public.ux_events (clerk_sub, flow_id, created_at DESC);

-- Collapse a flow instance's step rows into one taps-to-completion figure.
CREATE INDEX IF NOT EXISTS idx_ux_events_session_flow
  ON public.ux_events (session_id, flow_id);

INSERT INTO public.schema_version (version, description)
VALUES ('2.2.8a', 'UX-METRICS Inc0: ux_events append-only telemetry sink (M1 tap-count). Admin-gated read, Jen-invisible. Additive.')
ON CONFLICT (version) DO NOTHING;
