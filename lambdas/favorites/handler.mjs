// Lambda: /api/favorites
// Polymorphic favorites: entity_type ('project' | 'plant' | 'location' | 'inventory_item') + entity_id
// Routes: GET / | POST / | DELETE /:entity_type/:entity_id
//
// IMPORTANT: user_id is the ownership column — NOT created_by.
// (See landmine in bold-tender-galileo handoff.)
// Assumed schema: (user_id TEXT, entity_type TEXT, entity_id UUID)
// with a composite unique constraint on (user_id, entity_type, entity_id).

import { queryAs } from '../shared/db.mjs';
import { requireAuth, AuthError, ok, created, noContent, err, corsPreflight } from '../shared/auth.mjs';

const VALID_ENTITY_TYPES = new Set(['project', 'plant', 'location', 'inventory_item']);

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') return corsPreflight();

  const method = event.requestContext?.http?.method;
  const pathParts = (event.rawPath || '').split('/').filter(Boolean);
  // pathParts: ['api','favorites'] | ['api','favorites',entity_type,entity_id]
  const entityType = pathParts[2] || null;
  const entityId   = pathParts[3] || null;

  try {
    const userId = await requireAuth(event);

    if (method === 'GET') {
      const qs = event.queryStringParameters || {};
      const filterType = qs.entity_type || null;

      const params = [userId];
      let sql = `
        SELECT entity_type, entity_id, created_at
        FROM favorites
        WHERE user_id = $1
      `;
      if (filterType) {
        params.push(filterType);
        sql += ` AND entity_type = $${params.length}`;
      }
      sql += ` ORDER BY created_at DESC`;
      const { rows } = await queryAs(userId, sql, params);
      return ok(rows);
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { entity_type, entity_id } = body;
      if (!entity_type) return err(400, 'entity_type is required');
      if (!entity_id)   return err(400, 'entity_id is required');
      if (!VALID_ENTITY_TYPES.has(entity_type)) {
        return err(400, `entity_type must be one of: ${[...VALID_ENTITY_TYPES].join(', ')}`);
      }

      const { rows } = await queryAs(userId,
        `INSERT INTO favorites (user_id, entity_type, entity_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, entity_type, entity_id) DO NOTHING
         RETURNING *`,
        [userId, entity_type, entity_id],
      );
      return created(rows[0] || { user_id: userId, entity_type, entity_id });
    }

    if (method === 'DELETE' && entityType && entityId) {
      const { rows } = await queryAs(userId,
        `DELETE FROM favorites
         WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3
         RETURNING entity_id`,
        [userId, entityType, entityId],
      );
      if (!rows.length) return err(404, 'Favorite not found');
      return noContent();
    }

    return err(405, 'Method not allowed');

  } catch (e) {
    if (e instanceof AuthError) return err(401, e.message);
    console.error('favorites handler error:', e);
    return err(500, 'Internal server error');
  }
};
