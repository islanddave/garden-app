// /api/events — Lambda 2.2.x (V1.2a-2 Session 2)
// V002 spec: garden/v12a2-session2-lambda-design-V002-20260513.md
// Brief overrides (Dave 2026-05-13): F16=path-b (achievement XP UNCAPPED — daily 30-XP cap
// is event_logged-only); F17=scope reduction (ship harvest infra + validators + F18 caps,
// DEFER harvest_quantity/harvest_quality CASE branches to V4; harvest_century works via
// existing event_type_count evaluator; issue_resolve_count SHIPS in PATCH path);
// F19=moot since quality_grower not evaluated this session.
//
// Endpoints:
//   GET    /api/events                       (unchanged from 2.1.x)
//   GET    /api/events/:id                   (unchanged from 2.1.x; UUID pre-validated per F9)
//   POST   /api/events                       (extended: flagged_as_issue, severity, harvest{})
//   PATCH  /api/events/:id                   (NEW: issue resolve; UUID pre-validated per F9)
//   POST   /api/notifications/subscribe      (NEW)
//
// Routing precedence (F10):
//   1. POST /api/notifications/subscribe       — exact path
//   2. PATCH /api/events/:id                   — regex, UUID-pre-validated
//   3. GET   /api/events/:id                   — regex, UUID-pre-validated
//   4. GET / POST /api/events                  — base path

import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { validatePostBody, HARVEST_UNITS, MAX_PLAUSIBLE, UUID_RE } from './validators.js';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

let _secrets = null;
async function getSecrets() {
  if (_secrets) return _secrets;
  const cmd = new GetSecretValueCommand({ SecretId: process.env.SECRET_NAME ?? 'garden-app/secrets' });
  const res = await sm.send(cmd);
  _secrets = JSON.parse(res.SecretString);
  return _secrets;
}

const CORS = {}; // Lambda URL config is sole CORS source — handler must not duplicate

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

// Daily flat-XP cap (V002 §11; F16 brief override): cap event_logged grants at 30 XP/user/day.
// Achievement XP is encouragement-class — milestones celebrate progress, not bounded by daily limits.
const DAILY_FLAT_XP_CAP = 30;
const FLAT_XP_PER_EVENT = 10;

// Harvest constants, validator, UUID regex live in validators.js (DB-free, unit-testable).
// Re-exported here for backward compat with any caller importing from index.js directly.
export { HARVEST_UNITS, MAX_PLAUSIBLE, validatePostBody, UUID_RE };

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
  const rawPath = event.rawPath ?? '/api/events';

  try {
    // ── Route 1 (F10 precedence): POST /api/notifications/subscribe ────────────────────────────
    if (rawPath === '/api/notifications/subscribe' && method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      if (!['default', 'granted', 'denied'].includes(body.permission_state)) {
        return resp(400, { error: 'permission_state must be default, granted, or denied' });
      }
      const state = body.permission_state;

      // F29 — defensive profiles INSERT so notification_subscriptions FK never fails on first call.
      // Brief override: profiles PK is `id`, not `user_id` (V002 §3.3 draft used wrong column name).
      await sql`INSERT INTO profiles (id) VALUES (${userId}) ON CONFLICT (id) DO NOTHING`;

      const rows = await sql`
        INSERT INTO notification_subscriptions
          (user_id, permission_state, granted_at, last_prompted_at)
        VALUES (
          ${userId},
          ${state},
          CASE WHEN ${state} = 'granted' THEN NOW() ELSE NULL END,
          CASE WHEN ${state} <> 'default' THEN NOW() ELSE NULL END
        )
        ON CONFLICT (user_id) DO UPDATE SET
          permission_state = EXCLUDED.permission_state,
          granted_at = CASE
            WHEN EXCLUDED.permission_state = 'granted'
              AND notification_subscriptions.granted_at IS NULL
              THEN NOW()
            ELSE notification_subscriptions.granted_at
          END,
          last_prompted_at = CASE
            WHEN EXCLUDED.permission_state <> 'default' THEN NOW()
            ELSE notification_subscriptions.last_prompted_at
          END,
          updated_at = NOW()
        RETURNING permission_state, granted_at, last_prompted_at, updated_at
      `;

      // F28 — canonical event name: notification_permission_<state>
      try {
        await sql`
          INSERT INTO app_events (user_clerk_sub, event_name, event_source, metadata)
          VALUES (${userId}, ${'notification_permission_' + state}, 'lambda', ${{ source: 'banner' }})
        `;
      } catch (telErr) {
        console.warn('notification telemetry failed (non-fatal)', telErr.message);
      }

      return resp(200, rows[0]);
    }

    // ── Route 2/3 (F10 precedence): /api/events/:id (PATCH then GET) ──────────────────────────
    const idMatch = rawPath.match(/^\/api\/events\/([^/]+)$/);
    if (idMatch) {
      const eventId = idMatch[1];
      // F9 — UUID pre-validation returns 404 (existence-oblivious, no parse oracle)
      if (!UUID_RE.test(eventId)) return resp(404, { error: 'Not found' });

      if (method === 'PATCH') {
        const body = JSON.parse(event.body ?? '{}');
        if (body.resolved !== true) return resp(400, { error: 'resolved must be true' });

        // §2.3 — single-statement UPDATE with auth via plant_projects join.
        // F8 NOW()-relative achievement gate in RETURNING (not preserved resolved_at).
        // F26 resolved_by COALESCE preserves first-resolver on idempotent re-PATCH.
        const updated = await sql`
          UPDATE event_log el
          SET resolved_at = COALESCE(el.resolved_at, NOW()),
              resolved_by = COALESCE(el.resolved_by, ${userId}),
              updated_at  = NOW()
          FROM plant_projects pp
          WHERE el.id = ${eventId}
            AND el.flagged_as_issue = true
            AND el.deleted_at IS NULL
            AND pp.id = el.project_id
            AND pp.created_by = ${userId}
            AND pp.deleted_at IS NULL
          RETURNING
            el.id, el.project_id, el.event_type, el.flagged_as_issue,
            el.severity, el.resolved_at, el.resolved_by, el.created_at,
            (NOW() >= el.created_at + INTERVAL '24 hours') AS qualifies_for_achievement
        `;
        if (!updated.length) return resp(404, { error: 'Not found' });
        const row = updated[0];

        // Pre-fetch timezone for distinct-days computation. COALESCE to America/New_York.
        const tzRows = await sql`
          SELECT COALESCE(
            (SELECT user_timezone FROM profiles WHERE id = ${userId}),
            'America/New_York'
          ) AS tz
        `;
        const userTz = tzRows[0].tz;

        // §2.5 issue_resolve_count achievement evaluator.
        // F20 caretaker (count>=10) requires >=3 distinct calendar days.
        // RETURNING-gate chain is the race mitigation for parallel PATCH-resolves crossing same threshold.
        let newlyEarned = [];
        let xpGained = 0;
        if (row.qualifies_for_achievement) {
          try {
            const earnedRows = await sql`
              WITH resolved_set AS (
                SELECT
                  el.id,
                  el.resolved_at,
                  DATE(el.resolved_at AT TIME ZONE ${userTz}) AS resolve_day
                FROM event_log el
                JOIN plant_projects pp ON pp.id = el.project_id
                WHERE pp.created_by = ${userId}
                  AND pp.deleted_at IS NULL
                  AND el.deleted_at IS NULL
                  AND el.flagged_as_issue = true
                  AND el.resolved_at IS NOT NULL
                  AND el.resolved_at >= el.created_at + INTERVAL '24 hours'
              ),
              resolved_stats AS (
                SELECT
                  COUNT(*)::int AS cnt,
                  COUNT(DISTINCT resolve_day)::int AS distinct_days
                FROM resolved_set
              ),
              candidates AS (
                SELECT a.id, a.xp_reward, a.slug
                FROM achievements a, resolved_stats rs
                WHERE a.is_active = true
                  AND a.trigger_type = 'issue_resolve_count'
                  AND NOT EXISTS (
                    SELECT 1 FROM user_achievements ua
                    WHERE ua.user_id = ${userId} AND ua.achievement_id = a.id
                  )
                  AND rs.cnt >= (a.trigger_value->>'count')::int
                  AND (
                    (a.trigger_value->>'count')::int < 10
                    OR rs.distinct_days >= COALESCE((a.trigger_value->>'min_distinct_days')::int, 3)
                  )
              ),
              inserted AS (
                INSERT INTO user_achievements (user_id, achievement_id, trigger_event_id)
                SELECT ${userId}, c.id, ${eventId}::uuid FROM candidates c
                ON CONFLICT (user_id, achievement_id) DO NOTHING
                RETURNING achievement_id
              ),
              xp_grants AS (
                INSERT INTO xp_events (user_id, amount, reason, source_id)
                SELECT ${userId}, a.xp_reward, 'achievement_earned', i.achievement_id
                FROM inserted i JOIN achievements a ON a.id = i.achievement_id
                RETURNING amount, source_id
              ),
              stats_xp AS (
                UPDATE user_stats
                  SET xp = user_stats.xp + COALESCE((SELECT SUM(amount) FROM xp_grants), 0),
                      updated_at = NOW()
                WHERE user_id = ${userId}
                  AND EXISTS (SELECT 1 FROM xp_grants)
                RETURNING xp
              )
              SELECT
                COALESCE(
                  (SELECT json_agg(
                     json_build_object('slug', a.slug, 'name', a.name, 'emoji', a.emoji, 'xp_reward', a.xp_reward)
                     ORDER BY a.sort_order
                   )
                   FROM xp_grants xg JOIN achievements a ON a.id = xg.source_id),
                  '[]'::json
                ) AS newly_earned,
                COALESCE((SELECT SUM(amount) FROM xp_grants), 0)::int AS xp_total
            `;
            if (earnedRows.length) {
              newlyEarned = earnedRows[0].newly_earned ?? [];
              xpGained = earnedRows[0].xp_total ?? 0;
            }
          } catch (achErr) {
            console.warn('resolve achievement eval failed (non-fatal)', achErr.message);
          }
        }

        // §2.6 telemetry — only on UPDATE-success path (skip on 404)
        try {
          await sql`
            INSERT INTO app_events (user_clerk_sub, event_name, event_source, metadata)
            VALUES (${userId}, 'event_resolved', 'lambda',
              ${{ event_id: eventId, project_id: row.project_id, severity: row.severity, qualified: row.qualifies_for_achievement }})
          `;
        } catch (telErr) {
          console.warn('resolve telemetry failed (non-fatal)', telErr.message);
        }

        return resp(200, {
          id: row.id,
          project_id: row.project_id,
          event_type: row.event_type,
          flagged_as_issue: row.flagged_as_issue,
          severity: row.severity,
          resolved_at: row.resolved_at,
          resolved_by: row.resolved_by,
          newly_earned_achievements: newlyEarned,
          xp_gained: xpGained,
        });
      }

      if (method === 'GET') {
        const rows = await sql`
          SELECT
            e.id, e.project_id, e.location_id, e.plant_id,
            e.event_type, e.event_date, e.notes, e.private_notes,
            e.quantity, e.is_public, e.logged_by, e.created_at,
            e.metadata,
            e.flagged_as_issue, e.severity, e.resolved_at,
            pp.name AS project_name
          FROM event_log e
          JOIN plant_projects pp ON pp.id = e.project_id
          WHERE e.id = ${eventId}
            AND e.deleted_at IS NULL
            AND pp.created_by = ${userId}
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, rows[0]);
      }

      return resp(405, { error: 'Method not allowed' });
    }

    // ── Route 4: /api/events (collection) ──────────────────────────────────────────────────────
    if (method === 'GET') {
      const projectId = event.queryStringParameters?.project_id ?? null;
      const limit = Math.min(parseInt(event.queryStringParameters?.limit ?? '50', 10), 200);

      const rows = projectId
        ? await sql`
            SELECT
              e.id, e.project_id, e.location_id, e.plant_id,
              e.event_type, e.event_date, e.notes,
              e.quantity, e.is_public, e.logged_by, e.created_at,
              e.metadata,
              pp.name AS project_name
            FROM event_log e
            JOIN plant_projects pp ON pp.id = e.project_id
            WHERE pp.created_by = ${userId}
              AND e.project_id = ${projectId}
              AND e.deleted_at IS NULL
            ORDER BY e.event_date DESC, e.created_at DESC
            LIMIT ${limit}
          `
        : await sql`
            SELECT
              e.id, e.project_id, e.location_id, e.plant_id,
              e.event_type, e.event_date, e.notes,
              e.quantity, e.is_public, e.logged_by, e.created_at,
              e.metadata,
              pp.name AS project_name
            FROM event_log e
            JOIN plant_projects pp ON pp.id = e.project_id
            WHERE pp.created_by = ${userId}
              AND e.deleted_at IS NULL
            ORDER BY e.event_date DESC, e.created_at DESC
            LIMIT ${limit}
          `;
      return resp(200, rows);
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      const vErr = validatePostBody(body);
      if (vErr) return resp(vErr.status, { error: vErr.error });

      const eventDate = body.event_date
        ? new Date(body.event_date).toISOString()
        : new Date().toISOString();
      const eventType = body.event_type;
      const projectId = body.project_id;
      const metadata = body.metadata ?? null;
      // B8 — normalize flagged_as_issue ONCE; use throughout SQL bindings.
      const flagged = body.flagged_as_issue === true;
      const severity = flagged ? body.severity : null;
      const isHarvest = eventType === 'harvest';
      const harvestQty = isHarvest ? body.harvest.quantity : null;
      const harvestUnit = isHarvest ? body.harvest.unit : null;
      const harvestQuality = isHarvest ? (body.harvest.quality_rating ?? null) : null;
      const harvestNotes = isHarvest ? (body.harvest.notes ?? null) : null;

      // ── Step 1: pre-fetch user_timezone (COALESCE to America/New_York) ───────────────────────
      const tzRows = await sql`
        SELECT COALESCE(
          (SELECT user_timezone FROM profiles WHERE id = ${userId}),
          'America/New_York'
        ) AS tz
      `;
      const userTz = tzRows[0].tz;

      // ── Step 2: atomic transaction — set_config + dual-write CTE + entity_memory UPSERT ──────
      // Statement 2 (CTE): event_log + harvest_log (conditional) via WITH new_event AS / new_harvest AS.
      // F3 quantity_numeric synced for harvest events. F15 explicit RETURNING allow-list (no *).
      // F12 JS extraction: harvest_row stripped from row, exposed as `harvest` key.
      // Statement 3: entity_memory UPSERT with last_issue_at (F2 — present in INSERT col list, VALUES,
      // and ON CONFLICT branch). B1 prod vocabulary: 'watering' / 'fertilization' / 'pruning' /
      // 'observation' / 'harvest' verbatim.
      const txResult = await sql.transaction([
        sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
        sql`
          WITH new_event AS (
            INSERT INTO event_log
              (project_id, location_id, plant_id, event_type, event_date,
               notes, private_notes, quantity, quantity_numeric, is_public,
               logged_by, created_by, metadata,
               flagged_as_issue, severity)
            VALUES (
              ${projectId},
              ${body.location_id ?? null},
              ${body.plant_id ?? null},
              ${eventType},
              ${eventDate}::timestamptz,
              ${body.notes ?? null},
              ${body.private_notes ?? null},
              ${body.quantity ?? null},
              ${harvestQty}::numeric,
              ${body.is_public ?? true},
              ${userId},
              ${userId},
              ${metadata},
              ${flagged},
              ${severity}
            )
            RETURNING
              id, project_id, location_id, plant_id, event_type, event_date,
              notes, private_notes, quantity, quantity_numeric, is_public,
              logged_by, created_by, metadata,
              flagged_as_issue, severity, resolved_at, resolved_by,
              created_at, updated_at
          ),
          new_harvest AS (
            INSERT INTO harvest_log
              (event_id, project_id, quantity, unit, quality_rating, notes, created_by)
            SELECT
              ne.id, ne.project_id,
              ${harvestQty}::numeric,
              ${harvestUnit},
              ${harvestQuality}::smallint,
              ${harvestNotes},
              ${userId}
            FROM new_event ne
            WHERE ${isHarvest}::boolean = true
            RETURNING id, quantity, unit, quality_rating, notes
          )
          SELECT
            ne.*,
            (SELECT row_to_json(nh) FROM new_harvest nh) AS harvest_row
          FROM new_event ne
        `,
        sql`
          INSERT INTO entity_memory
            (project_id, last_event_at,
             last_watered_at, last_fertilized_at, last_pruned_at, last_observed_at, last_harvested_at,
             next_water_at, last_issue_at)
          VALUES (
            ${projectId},
            ${eventDate}::timestamptz,
            CASE WHEN ${eventType} = 'watering'      THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'fertilization' THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'pruning'       THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'observation'   THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'harvest'       THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'watering'      THEN ${eventDate}::timestamptz + INTERVAL '4 days' ELSE NULL END,
            CASE WHEN ${flagged}::boolean = true     THEN ${eventDate}::timestamptz ELSE NULL END
          )
          ON CONFLICT (project_id) DO UPDATE SET
            last_event_at      = GREATEST(COALESCE(entity_memory.last_event_at,      ${eventDate}::timestamptz), ${eventDate}::timestamptz),
            last_watered_at    = CASE WHEN ${eventType} = 'watering'      THEN GREATEST(COALESCE(entity_memory.last_watered_at,    ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_watered_at    END,
            last_fertilized_at = CASE WHEN ${eventType} = 'fertilization' THEN GREATEST(COALESCE(entity_memory.last_fertilized_at, ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_fertilized_at END,
            last_pruned_at     = CASE WHEN ${eventType} = 'pruning'       THEN GREATEST(COALESCE(entity_memory.last_pruned_at,     ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_pruned_at     END,
            last_observed_at   = CASE WHEN ${eventType} = 'observation'   THEN GREATEST(COALESCE(entity_memory.last_observed_at,   ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_observed_at   END,
            last_harvested_at  = CASE WHEN ${eventType} = 'harvest'       THEN GREATEST(COALESCE(entity_memory.last_harvested_at,  ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_harvested_at  END,
            next_water_at      = CASE WHEN ${eventType} = 'watering'
              THEN GREATEST(COALESCE(entity_memory.last_watered_at, ${eventDate}::timestamptz), ${eventDate}::timestamptz)
                   + (COALESCE(
                       entity_memory.watering_interval_days,
                       CASE entity_memory.location_type
                         WHEN 'indoor_seedling'   THEN 1
                         WHEN 'outdoor_container' THEN 2
                         WHEN 'outdoor_bed'       THEN 4
                         WHEN 'outdoor_inground'  THEN 5
                         WHEN 'indoor_mature'     THEN 5
                         ELSE 4
                       END
                     )::int * INTERVAL '1 day')
              ELSE entity_memory.next_water_at
            END,
            last_issue_at      = CASE WHEN ${flagged}::boolean = true
              THEN GREATEST(COALESCE(entity_memory.last_issue_at, ${eventDate}::timestamptz), ${eventDate}::timestamptz)
              ELSE entity_memory.last_issue_at
            END,
            updated_at = NOW()
        `,
      ]);

      // F12 — JS-side extraction of harvest sub-row from the joined CTE row.
      const newEvent = txResult[1][0];
      const harvest = newEvent.harvest_row;
      delete newEvent.harvest_row;
      newEvent.harvest = harvest;
      const eventId = newEvent.id;

      // ── Step 3a: user_stats UPSERT with timezone-aware streak math ──────────────────────────
      let achievementResult = { newly_earned: [], current_streak: null, total_events: null };
      try {
        const statsRows = await sql`
          WITH today_in_tz AS (
            SELECT (NOW() AT TIME ZONE ${userTz})::date AS today_date
          ),
          new_streak_calc AS (
            SELECT
              CASE
                WHEN s.last_active_date = (SELECT today_date FROM today_in_tz)
                  THEN s.current_streak
                WHEN s.last_active_date = (SELECT today_date FROM today_in_tz) - INTERVAL '1 day'
                  THEN s.current_streak + 1
                WHEN s.last_active_date = (SELECT today_date FROM today_in_tz) - INTERVAL '2 days'
                  THEN s.current_streak + 1
                ELSE 1
              END AS streak_val
            FROM user_stats s WHERE s.user_id = ${userId}
          )
          INSERT INTO user_stats (user_id, total_events, last_active_date, current_streak, longest_streak)
          VALUES (${userId}, 1, (SELECT today_date FROM today_in_tz), 1, 1)
          ON CONFLICT (user_id) DO UPDATE SET
            total_events     = user_stats.total_events + 1,
            current_streak   = (SELECT streak_val FROM new_streak_calc),
            longest_streak   = GREATEST(user_stats.longest_streak, (SELECT streak_val FROM new_streak_calc)),
            last_active_date = (SELECT today_date FROM today_in_tz),
            updated_at       = NOW()
          RETURNING current_streak, total_events
        `;
        if (statsRows.length) {
          achievementResult.current_streak = statsRows[0].current_streak;
          achievementResult.total_events   = statsRows[0].total_events;
        }
      } catch (statsErr) {
        console.warn('user_stats upsert failed (non-fatal)', statsErr.message);
      }

      // ── Step 3b: inline achievement evaluation for existing trigger types ────────────────────
      // F17 brief override: harvest_quantity / harvest_quality CASE branches DEFERRED to V4.
      // issue_resolve_count is resolve-path-only by design — intentional no-op on POST.
      // harvest_century works automatically via the existing event_type_count evaluator (count of
      // event_type='harvest' events); no special handling needed for V1.2a-2 ship.
      // F16: no daily cap on achievement XP — encouragement-class grants stay uncapped.
      try {
        if (achievementResult.current_streak != null) {
          const streakVal = achievementResult.current_streak;
          const totalVal  = achievementResult.total_events;
          const earnedRows = await sql`
            WITH today_in_tz AS (
              SELECT (NOW() AT TIME ZONE ${userTz})::date AS today_date,
                     EXTRACT(HOUR FROM (NOW() AT TIME ZONE ${userTz}))::int AS hour_in_tz
            ),
            event_counts AS (
              SELECT
                COUNT(*) FILTER (WHERE event_type = ${eventType})::int AS type_events,
                COUNT(*) FILTER (
                  WHERE (event_date AT TIME ZONE ${userTz})::date = (SELECT today_date FROM today_in_tz)
                )::int AS today_events
              FROM event_log
              WHERE created_by = ${userId} AND deleted_at IS NULL
            ),
            candidates AS (
              SELECT a.id, a.xp_reward
              FROM achievements a, event_counts ec, today_in_tz t
              WHERE a.is_active = true
                AND NOT EXISTS (
                  SELECT 1 FROM user_achievements ua
                  WHERE ua.user_id = ${userId} AND ua.achievement_id = a.id
                )
                AND CASE a.trigger_type
                  WHEN 'streak'           THEN ${streakVal}::int >= (a.trigger_value->>'days')::int
                  WHEN 'event_count'      THEN ${totalVal}::int  >= (a.trigger_value->>'count')::int
                  WHEN 'event_type_count' THEN
                    (a.trigger_value->>'type') = ${eventType}
                    AND ec.type_events >= (a.trigger_value->>'count')::int
                    AND NOT (a.trigger_value ? 'has_private_notes')
                  WHEN 'time_of_day'      THEN
                    (a.trigger_value ? 'hour_gte' AND t.hour_in_tz >= (a.trigger_value->>'hour_gte')::int)
                    OR
                    (a.trigger_value ? 'hour_lt'  AND t.hour_in_tz <  (a.trigger_value->>'hour_lt')::int)
                  WHEN 'multi_per_day'    THEN ec.today_events >= (a.trigger_value->>'count')::int
                  ELSE false
                END
            ),
            inserted AS (
              INSERT INTO user_achievements (user_id, achievement_id, trigger_event_id)
              SELECT ${userId}, c.id, ${eventId}::uuid FROM candidates c
              ON CONFLICT (user_id, achievement_id) DO NOTHING
              RETURNING achievement_id
            ),
            xp_grants AS (
              INSERT INTO xp_events (user_id, amount, reason, source_id)
              SELECT ${userId}, a.xp_reward, 'achievement_earned', i.achievement_id
              FROM inserted i JOIN achievements a ON a.id = i.achievement_id
              RETURNING amount, source_id
            ),
            stats_xp AS (
              UPDATE user_stats
                SET xp = user_stats.xp + COALESCE((SELECT SUM(amount) FROM xp_grants), 0),
                    updated_at = NOW()
              WHERE user_id = ${userId}
                AND EXISTS (SELECT 1 FROM xp_grants)
              RETURNING xp
            )
            SELECT COALESCE(
              (SELECT json_agg(
                 json_build_object('slug', a.slug, 'name', a.name, 'emoji', a.emoji, 'xp_reward', a.xp_reward)
                 ORDER BY a.sort_order
               )
               FROM xp_grants xg JOIN achievements a ON a.id = xg.source_id),
              '[]'::json
            ) AS newly_earned
          `;
          if (earnedRows.length) {
            achievementResult.newly_earned = earnedRows[0].newly_earned ?? [];
          }
        }
      } catch (achErr) {
        console.warn('achievement eval failed (non-fatal)', achErr.message);
      }

      // ── Step 4: flat XP grant with daily cap (timezone-aware) ────────────────────────────────
      let flatXpResult = { granted: 0, today_total: 0, daily_xp_remaining: DAILY_FLAT_XP_CAP };
      try {
        const rows = await sql`
          WITH today_xp AS (
            SELECT COALESCE(SUM(amount), 0)::int AS today_sum
            FROM xp_events
            WHERE user_id = ${userId}
              AND reason = 'event_logged'
              AND (created_at AT TIME ZONE ${userTz})::date = (NOW() AT TIME ZONE ${userTz})::date
          ),
          flat_grant AS (
            INSERT INTO xp_events (user_id, amount, reason, source_id)
            SELECT ${userId}, ${FLAT_XP_PER_EVENT}, 'event_logged', ${eventId}::uuid
            FROM today_xp
            WHERE today_sum < ${DAILY_FLAT_XP_CAP}
            RETURNING amount
          ),
          stats AS (
            UPDATE user_stats
              SET xp = user_stats.xp + COALESCE((SELECT amount FROM flat_grant), 0),
                  updated_at = NOW()
            WHERE user_id = ${userId}
            RETURNING xp
          )
          SELECT
            COALESCE((SELECT amount FROM flat_grant), 0)::int AS granted,
            ((SELECT today_sum FROM today_xp) + COALESCE((SELECT amount FROM flat_grant), 0))::int AS today_total
        `;
        if (rows.length) {
          flatXpResult.granted     = rows[0].granted;
          flatXpResult.today_total = rows[0].today_total;
          flatXpResult.daily_xp_remaining = Math.max(0, DAILY_FLAT_XP_CAP - rows[0].today_total);
        }
      } catch (xpErr) {
        console.warn('flat XP grant failed (non-fatal)', xpErr.message);
      }

      // ── Step 5: app_events telemetry ────────────────────────────────────────────────────────
      try {
        const telemetryEvents = [{
          name: 'log_entry_created',
          metadata: { event_type: eventType, project_id: projectId, event_id: eventId },
        }];
        if (flatXpResult.granted === 0 && flatXpResult.today_total >= DAILY_FLAT_XP_CAP) {
          telemetryEvents.push({
            name: 'daily_xp_capped',
            metadata: { event_id: eventId, today_total: flatXpResult.today_total },
          });
        }
        for (const t of telemetryEvents) {
          await sql`
            INSERT INTO app_events (user_clerk_sub, event_name, event_source, metadata)
            VALUES (${userId}, ${t.name}, 'lambda', ${t.metadata})
          `;
        }
      } catch (telErr) {
        console.warn('app_events telemetry failed (non-fatal)', telErr.message);
      }

      // F16 — achievement XP is uncapped; xp_gained sums flat + all earned-achievement rewards.
      const xpFromAchievements = achievementResult.newly_earned.reduce((s, a) => s + (a.xp_reward ?? 0), 0);
      return resp(201, {
        ...newEvent,
        newly_earned_achievements: achievementResult.newly_earned,
        updated_streak: achievementResult.current_streak,
        xp_gained: flatXpResult.granted + xpFromAchievements,
        daily_xp_remaining: flatXpResult.daily_xp_remaining,
      });
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('events lambda error', err);
    if (err.code === '23514') return resp(400, { error: `Constraint violation: ${err.constraint ?? err.message}` });
    if (err.code === '23502') return resp(400, { error: `Required field missing: ${err.column ?? err.message}` });
    if (err.code === '23503') return resp(400, { error: `Foreign key violation: ${err.constraint ?? err.message}` });
    if (err.code === '23505') return resp(409, { error: `Unique violation: ${err.constraint ?? err.message}` });
    return resp(500, { error: 'Internal server error' });
  }
};
