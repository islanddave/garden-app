// /api/events — Lambda 2.1.x (V1.2a-1 Session 2)
// V002 spec: garden/v1.2a-1-schema-design-V002-20260511.md §C-V1.2a-1-C
//
// POST flow (5 round trips total, P99 ≤ 500ms hard gate):
//   1. Pre-fetch user_timezone (1 query, COALESCE to America/New_York)
//   2. sql.transaction([set_config, INSERT event_log RETURNING, UPSERT entity_memory])
//      - entity_memory next_water_at: location_type-aware interval lookup via SQL CASE
//      - GREATEST() guards backdated event POSTs from regressing next_water_at into the past
//   3. user_stats UPSERT + achievement eval CTE pipeline (best-effort; see ACHIEVEMENT EVAL)
//   4. Flat XP grant with 30/day cap, timezone-aware (best-effort)
//   5. app_events telemetry INSERT (best-effort, fire-and-forget semantics)
//
// ACHIEVEMENT EVAL pipeline (single multi-CTE query):
//   - inline scope per V002 A4: streak / event_count / event_type_count / time_of_day / multi_per_day
//   - deferred (V1.2a-2): location_count, photo_count, level, seasonal, project_event_count, detail_oriented
//   - INSERT user_achievements ON CONFLICT DO NOTHING RETURNING — gates xp_events INSERT
//   - retry-safe: lambda re-execution cannot inflate XP (CTE only inserts xp for newly-created user_achievements rows)
//
// All side-effects (steps 3-5) are wrapped in try/catch. event_log INSERT and entity_memory UPSERT
// are atomic (transaction). On side-effect failure, the response still returns the inserted event row
// — callers see success and the side-effect failure is logged for backfill.

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

const CORS = {}; // Lambda URL config is sole CORS source — handler must not duplicate

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

// Per-location-type watering interval defaults (V002 §A3).
// Lookup precedence: project's watering_interval_days override → location_type default → 4-day fallback.
// Computed inside SQL via inline CASE so a single transactional UPSERT can update next_water_at
// without a pre-fetch round trip. (Inlined directly in the template literal below — neon serverless
// template literals only parameterize values, not SQL fragments. Static text outside ${} is appended.)

// Daily flat-XP cap (V002 §11): cap event_logged grants at 30 XP/user/day to prevent burst-logging Goodhart.
// Achievement-earned XP is uncapped.
const DAILY_FLAT_XP_CAP = 30;
const FLAT_XP_PER_EVENT = 10;

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

  const idMatch = rawPath.match(/^\/api\/events\/([^/]+)$/);

  try {
    if (idMatch) {
      const eventId = idMatch[1];

      if (method === 'GET') {
        const rows = await sql`
          SELECT
            e.id, e.project_id, e.location_id, e.plant_id,
            e.event_type, e.event_date, e.notes, e.private_notes,
            e.quantity, e.is_public, e.logged_by, e.created_at,
            e.metadata,
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

    // /api/events
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
      if (!body.event_type) return resp(400, { error: 'event_type is required' });
      if (!body.project_id) return resp(400, { error: 'project_id is required' });

      const eventDate = body.event_date
        ? new Date(body.event_date).toISOString()
        : new Date().toISOString();
      const eventType = body.event_type;
      const projectId = body.project_id;
      const metadata = body.metadata ?? null;

      // ── Step 1: pre-fetch user_timezone (COALESCE to America/New_York if profile row absent) ───────
      const tzRows = await sql`
        SELECT COALESCE(
          (SELECT user_timezone FROM profiles WHERE id = ${userId}),
          'America/New_York'
        ) AS tz
      `;
      const userTz = tzRows[0].tz;

      // ── Step 2: atomic transaction — set_config + INSERT event_log + UPSERT entity_memory ─────────
      // set_config sets the audit-trigger actor (no audit trigger on event_log/entity_memory currently;
      // included for symmetry with varieties Lambda + future-proofing per V002 §A8).
      //
      // entity_memory UPSERT semantics:
      //   - last_event_at: always GREATEST() with event_date (out-of-order POSTs don't regress)
      //   - last_<type>_at: only updated when event_type matches (CASE on each column)
      //   - next_water_at: only recomputed when event_type='watering';
      //     uses GREATEST(prior last_watered_at, event_date) + interval (location-type-aware)
      //
      // INSERT path (no existing entity_memory row): location_type/watering_interval_days are NULL,
      // so next_water_at uses the 4-day fallback. UPDATE path applies the full lookup precedence.
      const txResult = await sql.transaction([
        sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
        sql`
          INSERT INTO event_log
            (project_id, location_id, plant_id, event_type, event_date,
             notes, private_notes, quantity, is_public, logged_by, created_by, metadata)
          VALUES (
            ${projectId},
            ${body.location_id ?? null},
            ${body.plant_id ?? null},
            ${eventType},
            ${eventDate},
            ${body.notes ?? null},
            ${body.private_notes ?? null},
            ${body.quantity ?? null},
            ${body.is_public ?? true},
            ${userId},
            ${userId},
            ${metadata}
          )
          RETURNING *
        `,
        sql`
          INSERT INTO entity_memory
            (project_id, last_event_at,
             last_watered_at, last_fertilized_at, last_pruned_at, last_observed_at, last_harvested_at,
             next_water_at)
          VALUES (
            ${projectId},
            ${eventDate}::timestamptz,
            CASE WHEN ${eventType} = 'watering'      THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'fertilization' THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'pruning'       THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'observation'   THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'harvest'       THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'watering'      THEN ${eventDate}::timestamptz + INTERVAL '4 days' ELSE NULL END
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
                         WHEN 'indoor_seedling'  THEN 1
                         WHEN 'outdoor_container' THEN 2
                         WHEN 'outdoor_bed'      THEN 4
                         WHEN 'outdoor_inground' THEN 5
                         WHEN 'indoor_mature'    THEN 5
                         ELSE 4
                       END
                     )::int * INTERVAL '1 day')
              ELSE entity_memory.next_water_at
            END,
            updated_at = NOW()
        `,
      ]);
      const newEvent = txResult[1][0];
      const eventId = newEvent.id;

      // ── Step 3a: user_stats UPSERT with timezone-aware streak math ────────────────────────────────
      // Streak grace (V002 §A7): 1-day passive grace — last_active_date = today-2 still extends the streak.
      // Hard reset only if gap > 2 days in user TZ.
      // Split from achievement eval (Step 3b) because Postgres forbids two CTEs UPDATEing the same
      // row in a single statement ("tuple updated by another command in this transaction"). Two
      // sequential queries cost +1 round-trip but eliminate the double-update class of bug.
      let achievementResult = { newly_earned: [], current_streak: null, total_events: null };
      try {
        const statsRows = await sql`
          WITH today_in_tz AS (
            SELECT (NOW() AT TIME ZONE ${userTz})::date AS today_date
          ),
          new_streak_calc AS (
            -- UPDATE-path streak: derived from existing user_stats row.
            -- INSERT-path defaults to 1 (first event for this user).
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

      // ── Step 3b: inline achievement evaluation + XP grant for newly-earned ────────────────────────
      // Uses post-upsert current_streak + total_events from Step 3a (passed as JS parameters).
      // RETURNING-gate pattern (V002 §A4): xp_events INSERT only fires for user_achievements rows
      // that were actually inserted (not ON CONFLICT skipped) — Lambda retries cannot inflate XP.
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

      // ── Step 4: flat XP grant with daily cap (timezone-aware) ─────────────────────────────────────
      // Single multi-CTE query: read today's flat XP sum → conditionally insert 10 XP if under cap →
      // update user_stats.xp → return granted amount + new today total.
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

      // ── Step 5: app_events telemetry (best-effort, fire-and-forget semantics) ─────────────────────
      // V002 §A5: log_entry_created on every POST; daily_xp_capped if cap was hit.
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

      // ── Response: enriched event + reward state ───────────────────────────────────────────────────
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
