// /api/app-events — POST-only telemetry sink for ADHD daily-loop signals.
// V1.2a-1 Session 2 (V002 §A5).
//
// Append-only telemetry from SPA to app_events table. Fire-and-forget on the client side —
// failure is non-fatal and never blocks the reward moment (per adhd-ux constraint).
//
// Auth: Clerk JWT verified per request → user_clerk_sub = JWT.sub.
// Rate limit: 1000/hour per actor via rate_limit_buckets bucket key 'app_events.write'.
// Body: { event_name (required), event_source?, session_id?, metadata? }
//   - event_name: 1-64 chars (DB CHECK enforces; the reply names the kind of refusal, never the constraint)
//   - metadata: JSONB, Lambda-side rejects >8KB (no DB constraint to avoid retrofit pain — V002 §A5)
// CORS: Lambda URL config owns CORS (empty handler CORS, mirrors prod Lambda pattern).

import { neon } from '@neondatabase/serverless';
import { checkRateLimit, withRetryAfter } from './rate-limit.js';
import { requestContext } from './request-context.js';
import { dbErrorReply, logCaughtError } from './db-error.js';

const CORS = {}; // Lambda URL config is sole CORS source — handler must not duplicate

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

const METADATA_BYTE_LIMIT = 8 * 1024; // 8KB cap per V002 §A5

export function validateBody(body) {
  if (!body || typeof body !== 'object') return 'body required';
  if (!body.event_name || typeof body.event_name !== 'string') return 'event_name is required';
  const nameLen = body.event_name.length;
  if (nameLen < 1 || nameLen > 64) return 'event_name must be 1-64 characters';
  if (body.event_source != null && typeof body.event_source !== 'string') return 'event_source must be a string';
  if (body.session_id != null && typeof body.session_id !== 'string') return 'session_id must be a string';
  if (body.metadata != null) {
    if (typeof body.metadata !== 'object' || Array.isArray(body.metadata)) return 'metadata must be a JSON object';
    const size = Buffer.byteLength(JSON.stringify(body.metadata), 'utf8');
    if (size > METADATA_BYTE_LIMIT) return `metadata exceeds 8KB limit (${size} bytes)`;
  }
  return null;
}

export const handler = async (event) => {
  // The kit answers OPTIONS and every sign-in refusal (401, the household gate's 403) before any statement, so a
  // refused caller never reaches checkRateLimit below and spends no bucket.
  const ctx = await requestContext(event, { resp, neon });
  if (ctx.response) return ctx.response;
  const { userId, sql } = ctx;
  const method = event.requestContext?.http?.method ?? 'GET';

  if (method !== 'POST') return resp(405, { error: 'Method not allowed — POST only' });

  try {
    const body = JSON.parse(event.body ?? '{}');
    const verr = validateBody(body);
    if (verr) return resp(400, { error: verr });

    const allowed = await checkRateLimit(sql, userId, 'app_events.write', 1000);
    if (!allowed) return withRetryAfter(resp(429, { error: 'Rate limit exceeded — 1000/hour for app_events.write' }));

    const rows = await sql`
      INSERT INTO public.app_events (user_clerk_sub, event_name, event_source, session_id, metadata)
      VALUES (
        ${userId},
        ${body.event_name},
        ${body.event_source ?? null},
        ${body.session_id ?? null},
        ${body.metadata ?? null}
      )
      RETURNING id, created_at
    `;
    return resp(201, rows[0]);

  } catch (err) {
    logCaughtError('app-events lambda error', err);
    const db = dbErrorReply(err, ['23514', '23502']);
    if (db) return resp(db.status, db.body);
    return resp(500, { error: 'Internal server error' });
  }
};
