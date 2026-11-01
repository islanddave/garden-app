// /api/dashboard Lambda entry point. Wires neon + Clerk + SecretsManager to the SQL builders in
// ./handlers.js, which unit tests import alone (no neon/clerk/aws deps at load time).
//   - GET  /api/dashboard                                 aggregated dashboard state (one round trip)
//   - GET  /api/projects/inactive                         inactive project list
//   - POST /api/projects/inactive/:projectId/dismiss      dismiss an inactive project
// Per-path method dispatch: no blanket non-GET 405. The dismiss UUID is regex-checked BEFORE
// handler dispatch (404 on parse failure).

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
