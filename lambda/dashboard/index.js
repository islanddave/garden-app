// /api/dashboard — V1.2a-2 Session 2 (extends V1.2a-1 Session 3)
// Per-path method dispatch (F11):
//   - GET  /api/dashboard                                 → aggregated dashboard state
//   - GET  /api/projects/inactive                         → inactive project list (§7)
//   - POST /api/projects/inactive/:projectId/dismiss      → dismiss inactive project (§8)
//
// GET /api/dashboard returns aggregated dashboard state in a single round trip:
//   - recent_events: last 5 logged events
//   - active_projects: all non-deleted projects + entity_memory state
//   - counts: projects, plants, locations, favorites
//   - user_stats: current_streak, longest_streak, last_active_date, total_events, xp
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
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  classifyRoute,
  resp,
  optionsResp,
  handleDashboard,
  handleGetInactive,
  handleDismissInactive,
  UUID_RE,
} from './handlers.js';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

let _secrets = null;
async function getSecrets() {
  if (_secrets) return _secrets;
  const cmd = new GetSecretValueCommand({ SecretId: process.env.SECRET_NAME ?? 'garden-app/secrets' });
  const res = await sm.send(cmd);
  _secrets = JSON.parse(res.SecretString);
  return _secrets;
}

// Re-export for backward compat with any caller importing UUID_RE from index.js.
export { UUID_RE };

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return optionsResp();
  }

  const secrets = await getSecrets();

  const authHeader = event.headers?.authorization ?? event.headers?.Authorization ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  let userId;
  try {
    const payload = await verifyToken(token, {
      secretKey: secrets.CLERK_SECRET_KEY,
      authorizedParties: [
        'https://garden.futureishere.net',
        'https://dg6mmjhepoyt9.cloudfront.net',
      ],
    });
    userId = payload.sub;
  } catch (err) {
    console.error('verifyToken failed:', err?.message ?? String(err));
    return resp(401, { error: 'Unauthorized' });
  }

  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/dashboard';

  const route = classifyRoute(method, rawPath);
  if (route.kind === 'options') return optionsResp();
  if (route.kind === 'method-not-allowed') return resp(405, { error: 'Method not allowed' });
  if (route.kind === 'not-found') return resp(404, { error: 'Not found' });
  if (route.kind === 'uuid-not-found') return resp(404, { error: 'Not found' });

  const sql = neon(secrets.NEON_DATABASE_URL);

  try {
    if (route.kind === 'inactive-list') return await handleGetInactive(sql, userId);
    if (route.kind === 'inactive-dismiss') return await handleDismissInactive(sql, userId, route.projectId);
    // route.kind === 'dashboard'
    return await handleDashboard(sql, userId);
  } catch (err) {
    console.error('dashboard lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};
