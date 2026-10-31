// /api/dashboard — V1.2a-2 Session 2 (extends V1.2a-1 Session 3)
// Per-path method dispatch (F11):
//   - GET  /api/dashboard                                 → aggregated dashboard state
//   - GET  /api/projects/inactive                         → inactive project list (§7)
//   - POST /api/projects/inactive/:projectId/dismiss      → dismiss inactive project (§8)
//
// GET /api/dashboard returns aggregated dashboard state in a single round trip:
//   - recent_events: last 20 collapsed feed entries (V3-FEED-001: Log Many batches fold to one)
//   - active_projects: all non-deleted projects + entity_memory state
//   - counts: projects, plants, locations, favorites
//   - user_stats: current_streak, longest_streak, last_active_date, total_events, xp,
//                 level, xp_into_level, xp_to_next_level, next_level_at  (BUG-XPPROGRESSION-001)
//   - water_due: projects with entity_memory.next_water_at < NOW() (Tile 2)
//   - harvest_ready: projects with status='harvesting' ordered by oldest last_observed_at (Tile 3, §4)
//   - heads_up: Hybrid A+C union — flagged-unresolved + active-growth stale (Tile 4, §5)
//   - inactive_projects_count: scalar count of harvested/ended NOT dismissed (§6)
//
// F1: days computed via calendar-day arithmetic (NOW()::date - col::date)::int — NOT EXTRACT(DAY FROM interval).
// F7: Tile 4 stale predicate handles NULL last_observed_at with COALESCE(last_event_at, created_at) fallback.
// F9: POST dismiss validates UUID via regex BEFORE handler dispatch (404 on parse failure).
// F11: per-path method dispatch — no blanket non-GET 405.
// B6: Tile 4 'stale' = OBSERVATION staleness by design.
//
// This file is the Lambda entry point — it wires neon + Clerk + SecretsManager
// to the pure SQL builders in ./handlers.js. Unit tests import ONLY handlers.js
// (no @neondatabase/serverless / @clerk/backend / @aws-sdk/* deps required at
// test load time). Mirrors the lambda/events/{index,validators}.js split.

import { neon } from '@neondatabase/serverless';
import {
  classifyRoute,
  resp,
  optionsResp,
  handleDashboard,
  handleGetInactive,
  handleDismissInactive,
  handleSearch,
  UUID_RE,
} from './handlers.js';
import { requestContext } from './request-context.js';

// Re-export for backward compat with any caller importing UUID_RE from index.js.
export { UUID_RE };

export const handler = async (event) => {
  // The kit answers OPTIONS (the same 204 as optionsResp()) and every sign-in refusal (401, the household gate's 403)
  // before any statement. It gets no scope: this wrapper only forwards userId to ./handlers.js, which scopes and
  // interpolates ${userId}, so lambda/authz-write-fk.test.js derives the scoped set from the whole dir. Never name the
  // scope helper in this file, not even in a comment: lambda/household-isolation.test.js asserts its token is absent.
  const ctx = await requestContext(event, { resp, neon });
  if (ctx.response) return ctx.response;
  const { userId, sql } = ctx;

  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/dashboard';

  const route = classifyRoute(method, rawPath);
  if (route.kind === 'options') return optionsResp();
  if (route.kind === 'method-not-allowed') return resp(405, { error: 'Method not allowed' });
  if (route.kind === 'not-found') return resp(404, { error: 'Not found' });
  if (route.kind === 'uuid-not-found') return resp(404, { error: 'Not found' });

  try {
    if (route.kind === 'search') return await handleSearch(sql, userId, event.queryStringParameters?.q ?? '');
    if (route.kind === 'inactive-list') return await handleGetInactive(sql, userId);
    if (route.kind === 'inactive-dismiss') return await handleDismissInactive(sql, userId, route.projectId);
    // route.kind === 'dashboard'
    return await handleDashboard(sql, userId);
  } catch (err) {
    console.error('dashboard lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};
