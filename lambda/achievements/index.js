// /api/achievements — V1.2a-1 Session 4
// GET only. Returns user's earned + visible-locked achievements + count of hidden secrets.
//
// Response shape:
//   { earned: AchievementRow[],
//     locked: AchievementRow[],
//     total_earned: int,
//     total_visible: int,
//     secret_locked_count: int }
//
// AchievementRow (earned has earned_at + trigger_event_id; locked omits both):
//   { id, slug, name, description, emoji, xp_reward, trigger_type, trigger_value,
//     sort_order, is_secret (earned only), earned_at? trigger_event_id? }
//
// Sort: earned by earned_at DESC; locked by sort_order ASC.
// Secret achievements: included in `earned` IF earned; otherwise counted in `secret_locked_count`.
// CORS owned by Lambda URL config — handler returns CORS={} per L-052+L-053 + 95bb3c0b CORS race fix.

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

const CORS = {};

function resp(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(body) };
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const secrets = await getSecrets();
  const authHeader = event.headers?.authorization ?? event.headers?.Authorization ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  let userId;
  try {
    const payload = await verifyToken(token, {
      secretKey: secrets.CLERK_SECRET_KEY,
      authorizedParties: ['https://garden.futureishere.net', 'https://dg6mmjhepoyt9.cloudfront.net'],
    });
    userId = payload.sub;
  } catch (err) {
    console.error('verifyToken failed:', err?.message ?? String(err));
    return resp(401, { error: 'Unauthorized' });
  }

  const method = event.requestContext?.http?.method ?? 'GET';
  if (method !== 'GET') return resp(405, { error: 'Method not allowed' });

  const sql = neon(secrets.NEON_DATABASE_URL);

  try {
    const [earned, locked, secretLockedRows] = await Promise.all([
      sql`
        SELECT
          a.id, a.slug, a.name, a.description, a.emoji, a.xp_reward,
          a.trigger_type, a.trigger_value, a.is_secret, a.sort_order,
          ua.earned_at, ua.trigger_event_id
        FROM user_achievements ua
        JOIN achievements a ON a.id = ua.achievement_id
        WHERE ua.user_id = ${userId}
          AND a.is_active = true
        ORDER BY ua.earned_at DESC
      `,
      sql`
        SELECT
          a.id, a.slug, a.name, a.description, a.emoji, a.xp_reward,
          a.trigger_type, a.trigger_value, a.sort_order
        FROM achievements a
        WHERE a.is_active = true
          AND a.is_secret = false
          AND NOT EXISTS (
            SELECT 1 FROM user_achievements ua
            WHERE ua.achievement_id = a.id AND ua.user_id = ${userId}
          )
        ORDER BY a.sort_order ASC, a.name ASC
      `,
      sql`
        SELECT COUNT(*)::int AS n
        FROM achievements a
        WHERE a.is_active = true
          AND a.is_secret = true
          AND NOT EXISTS (
            SELECT 1 FROM user_achievements ua
            WHERE ua.achievement_id = a.id AND ua.user_id = ${userId}
          )
      `,
    ]);

    return resp(200, {
      earned,
      locked,
      total_earned: earned.length,
      total_visible: earned.length + locked.length,
      secret_locked_count: secretLockedRows[0]?.n ?? 0,
    });
  } catch (err) {
    console.error('achievements lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};
