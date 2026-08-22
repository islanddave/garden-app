// garden-ux-events — Post-V2 UX Overhaul Increment 0 success-metric sink.
// Spec: success-metric-instrumentation-spec-V001-20260522.1620.md.
//
// Surfaces:
//   POST /api/ux-events            — authed (any signed-in user). Append one telemetry row
//                                     (M1 tap-count steps + completion). flow_id is server-allowlisted.
//                                     Fire-and-forget from the client; failures must never affect UX.
//   GET  /api/ux-events?admin=1    — ADMIN_CLERK_SUBS-gated (fail-closed). Returns the three
//                                     "Garden Activity" measures: M1 tap-count (from ux_events),
//                                     M2 capture-events/week (derived from existing tables — no new
//                                     write path), M3 agent accept-rate (placeholder until Inc-3 tasks).
//   GET  /api/ux-events            — non-admin GET is 403: this is an admin-only diagnostic surface
//                                     (Jen-invisible per Reward UX V100 §8).
//
// clerk_sub is taken from the verified JWT, NEVER from the request body.
// CORS is owned by the Lambda Function URL config (handler keeps CORS={}), per L-097.

import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

let _secrets = null;
async function getSecrets() {
  if (_secrets) return _secrets;
  const cmd = new GetSecretValueCommand({ SecretId: process.env.SECRET_NAME ?? 'garden-app/secrets' });
  const res = await sm.send(cmd);
  _secrets = JSON.parse(res.SecretString);
  return _secrets;
}

const CORS = {}; // Lambda URL config is sole CORS source — handler must not duplicate.

// Server-side allowlist of the M1 flows. A client cannot invent flow_ids.
//
// THIS SET SILENTLY DROPS ANYTHING NOT IN IT, and that has already cost 2.5 months of data.
// `open_planting` shipped in the CLIENT on 2026-06-03 (V3-NAV-001, PlantingDetail.jsx:115) and was
// never added here, so every one of its events was rejected with a 200-shaped no-op. Measured on
// live prod 2026-08-22: ux_events holds reach_planting 244, log_watering 215, create_project 53,
// and open_planting ZERO. uxEvents.js predicted this exact outcome in a comment — "if the Lambda
// allowlist hasn't added 'open_planting' yet, sendUxEvent is a silent no-op" — and called the
// resulting gap a deliberate temporary double-signal during the nav cutover. It was never double:
// PlantingDetail REPLACED ProjectDetail as the way in, so as the old surface fell out of use the
// funnel fell to zero rather than handing over. reach_planting's last row is 2026-08-10.
//
// The drop is now pinned by ux-events.flowLockstep.test.js, which fails if any client FLOWS value
// is missing here. That guard is the actual fix; adding two strings is just today's instance.
export const ALLOWED_FLOWS = new Set([
  'log_watering',
  'reach_planting',
  'create_project',
  // Dropped for 2.5 months — see above.
  'open_planting',
  // V4-PHOTOUPLOADINSTR-001: one event per photo upload carrying which downscale branch ran and how
  // long each phase took. BUG-PHOTOUPLOADSLOW-001 could be measured but not DIAGNOSED, because the
  // branch that decides a 680 kB upload from an 8.8 MB one is a console.warn nobody collects.
  'photo_upload',
]);

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

function adminSubs() {
  return (process.env.ADMIN_CLERK_SUBS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
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

  const sql = neon(secrets.NEON_DATABASE_URL);
  const method = event.requestContext?.http?.method ?? 'GET';

  try {
    // ── POST /api/ux-events ── append one telemetry row ──────────────────
    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      const flowId = String(body.flow_id ?? '');
      if (!ALLOWED_FLOWS.has(flowId)) {
        return resp(400, { error: 'unknown flow_id' });
      }
      const sessionId = String(body.session_id ?? '').slice(0, 128);
      if (!sessionId) return resp(400, { error: 'session_id is required' });

      const stepIndex = Number.isInteger(body.step_index) ? body.step_index : 0;
      const stepName = body.step_name != null ? String(body.step_name).slice(0, 64) : null;
      const tapCount = Number.isInteger(body.tap_count) ? body.tap_count : null;
      const clientTs = body.client_ts != null ? String(body.client_ts) : null;
      const metaJson = body.meta != null ? JSON.stringify(body.meta) : null;

      const rows = await sql`
        INSERT INTO ux_events (clerk_sub, session_id, flow_id, step_index, step_name, tap_count, client_ts, meta)
        VALUES (
          ${userId}, ${sessionId}, ${flowId}, ${stepIndex}, ${stepName},
          ${tapCount}, ${clientTs}::timestamptz, ${metaJson}::jsonb
        )
        RETURNING id
      `;
      return resp(201, { ok: true, id: rows[0]?.id ?? null });
    }

    // ── GET /api/ux-events?admin=1 ── admin-only aggregates ──────────────
    if (method === 'GET') {
      const adminMode = event.queryStringParameters?.admin === '1';
      const allow = adminSubs();
      // Fail-closed: this surface is admin-only (Jen-invisible). A bare GET, or any
      // non-admin caller, gets 403 — there is no user-facing read of ux telemetry.
      if (allow.length === 0) return resp(403, { error: 'Admin route not configured' });
      if (!adminMode || !allow.includes(userId)) return resp(403, { error: 'Not authorized' });

      // M1 — tap-count to completion, per flow, last 30 days.
      // Completion events carry tap_count; aggregate those.
      const m1 = await sql`
        SELECT flow_id,
               COUNT(*)::int                                   AS samples,
               ROUND(AVG(tap_count)::numeric, 2)               AS avg_taps,
               MIN(tap_count)::int                             AS min_taps,
               MAX(tap_count)::int                             AS max_taps,
               PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY tap_count) AS median_taps
        FROM ux_events
        WHERE tap_count IS NOT NULL
          AND created_at >= now() - interval '30 days'
        GROUP BY flow_id
        ORDER BY flow_id
      `;

      // M2 — capture-events/week, derived from EXISTING tables (no new write path).
      // Union created_at across the three garden-data tables, bucket by ISO week, last 8 weeks.
      //
      // V4-ARCHIVEHIDE-001 (L7): the two garden_node/container arms counted ARCHIVED rows. AXIS is
      // archived_at, not deleted_at. Prod 2026-08-13: 3 archived plantings + 1 archived project fall
      // inside the 8-week window, so this lowers recent weekly capture counts by up to 4.
      //
      // THIS IS THE WEAKEST OF THE SIX AND THE FIRST TO REVERT IF DAVE DISAGREES. Two honest
      // arguments against it: (1) the route is admin-only (403 above), so it is not a "default view"
      // in the user-facing sense the ticket is written about; (2) M2 measures CAPTURE ACTIVITY, and
      // archiving in week 9 does not un-capture what was captured in week 1 — filtering makes a past
      // week's number change retroactively. Note also that these arms do not filter deleted_at
      // either, so the two lifecycle axes are now asymmetric here on purpose rather than by
      // oversight: closing archived alone was the scoped ask, and widening it to deleted_at would be
      // an unbriefed behaviour change to a shipped metric.
      const m2 = await sql`
        SELECT to_char(date_trunc('week', created_at), 'IYYY-"W"IW') AS iso_week,
               COUNT(*)::int AS captures
        FROM (
          SELECT created_at FROM event_log
          UNION ALL SELECT created_at FROM public.garden_node WHERE archived_at IS NULL
          UNION ALL SELECT created_at FROM public.container WHERE archived_at IS NULL
        ) c
        WHERE created_at >= now() - interval '8 weeks'
        GROUP BY 1
        ORDER BY 1
      `;

      // M3 — agent-proposal accept-rate. Lives on the Inc-3 `tasks` table. The table may
      // not exist yet, OR a differently-shaped `tasks` table may already exist (pre-Inc-3)
      // WITHOUT the agent_proposed/accepted_at columns. Either case must degrade to
      // "not available" — never 500 the whole admin panel. Wrapped in try/catch so column
      // shape drift on `tasks` is tolerated. (Caught on staging: a pre-Inc-3 tasks table
      // exists, so to_regclass is non-null but the column query errored.)
      let m3 = { available: false, reason: 'tasks table not yet created (Increment 3)', accept_rate: null, canary_threshold: 0.40 };
      try {
        const taskTbl = await sql`SELECT to_regclass('public.tasks') AS t`;
        if (taskTbl[0]?.t) {
          const r = await sql`
            SELECT COUNT(*) FILTER (WHERE agent_proposed)                            AS proposed,
                   COUNT(*) FILTER (WHERE agent_proposed AND accepted_at IS NOT NULL) AS accepted
            FROM tasks
            WHERE created_at >= now() - interval '30 days'
          `;
          const proposed = Number(r[0]?.proposed ?? 0);
          const accepted = Number(r[0]?.accepted ?? 0);
          m3 = {
            available: proposed > 0,
            reason: proposed > 0 ? null : 'no agent-proposed tasks in window',
            accept_rate: proposed > 0 ? Number((accepted / proposed).toFixed(4)) : null,
            proposed, accepted,
            canary_threshold: 0.40,
          };
        }
      } catch {
        // tasks table present but missing the Inc-3 agent-proposal columns (shape drift) — degrade.
        m3 = { available: false, reason: 'tasks table present but missing agent-proposal columns (pre-Inc-3 shape)', accept_rate: null, canary_threshold: 0.40 };
      }

      return resp(200, {
        generated_at: new Date().toISOString(),
        m1: { window_days: 30, by_flow: m1 },
        m2: { window_weeks: 8, by_week: m2 },
        m3,
      });
    }

    return resp(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('ux-events lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};
