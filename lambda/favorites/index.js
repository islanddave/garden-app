import { neon } from '@neondatabase/serverless';
import { requestContext } from './request-context.js';

const CORS = {}; // Lambda URL config is sole CORS source — handler must not duplicate

// SEC-13b: what a client may CREATE, exactly the types FavoriteToggle is mounted with in src/ (the DB CHECK also
// admits 'location', which no client sends). GET and DELETE take any type, so a legacy row still lists and
// un-favorites. Guard: lambda/rate-limit.test.js scans src/ for every <FavoriteToggle entityType>.
const FAVORITE_ENTITY_TYPES = new Set(['plant', 'project', 'inventory_item']);

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  // The kit answers OPTIONS and every sign-in refusal (401, the household gate's 403) before any statement.
  const ctx = await requestContext(event, { resp, neon });
  if (ctx.response) return ctx.response;
  const { userId, sql } = ctx;
  const method = event.requestContext?.http?.method ?? 'GET';

  try {
    // GET /api/favorites
    // With entity_type+entity_id: returns {favorited:bool} for single-entity check
    // Without: returns array of all user favorites
    if (method === 'GET') {
      const entityType = event.queryStringParameters?.entity_type ?? null;
      const entityId   = event.queryStringParameters?.entity_id   ?? null;
      if (entityType && entityId) {
        const rows = await sql`
          SELECT id FROM favorites
          WHERE user_id = ${userId}
            AND entity_type = ${entityType}
            AND entity_id = ${entityId}::uuid
        `;
        return resp(200, { favorited: rows.length > 0, id: rows[0]?.id ?? null });
      }
      const rows = await sql`
        SELECT id, entity_type, entity_id, created_at
        FROM favorites
        WHERE user_id = ${userId}
        ORDER BY entity_type, created_at DESC
      `;
      return resp(200, rows);
    }

    // POST /api/favorites — upsert (insert or ignore if already favorited)
    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      if (!body.entity_type) return resp(400, { error: 'entity_type is required' });
      if (!body.entity_id)   return resp(400, { error: 'entity_id is required' });
      if (!FAVORITE_ENTITY_TYPES.has(body.entity_type)) {
        return resp(400, { error: `entity_type must be one of: ${[...FAVORITE_ENTITY_TYPES].join(', ')}` });
      }
      const rows = await sql`
        INSERT INTO favorites (user_id, entity_type, entity_id)
        VALUES (${userId}, ${body.entity_type}, ${body.entity_id}::uuid)
        ON CONFLICT (user_id, entity_type, entity_id) DO NOTHING
        RETURNING id
      `;
      const id = rows[0]?.id ?? null;
      return resp(201, { favorited: true, id, entity_type: body.entity_type, entity_id: body.entity_id });
    }

    // DELETE /api/favorites?entity_type=x&entity_id=y
    if (method === 'DELETE') {
      const entityType = event.queryStringParameters?.entity_type ?? null;
      const entityId   = event.queryStringParameters?.entity_id   ?? null;
      if (!entityType || !entityId) return resp(400, { error: 'entity_type and entity_id are required' });
      await sql`
        DELETE FROM favorites
        WHERE user_id = ${userId}
          AND entity_type = ${entityType}
          AND entity_id = ${entityId}::uuid
      `;
      return resp(200, { favorited: false, entity_type: entityType, entity_id: entityId });
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('favorites lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};
