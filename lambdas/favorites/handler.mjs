import { queryAs } from '../shared/db.mjs';
import { requireAuth, AuthError, ok, created, noContent, err, corsPreflight } from '../shared/auth.mjs';

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') return corsPreflight();
  const method = event.requestContext?.http?.method;
  const qs = event.queryStringParameters || {};

  try {
    const userId = await requireAuth(event);

    // GET /api/favorites — list all OR check single
    if (method === 'GET') {
      if (qs.entity_type && qs.entity_id) {
        const {rows} = await queryAs(userId,
          `SELECT id FROM favorites WHERE user_id=$1 AND entity_type=$2 AND entity_id=$3`,
          [userId,qs.entity_type,qs.entity_id]);
        return ok({favorited: rows.length > 0, id: rows[0]?.id || null});
      }
      const {rows} = await queryAs(userId,
        `SELECT id,entity_type,entity_id,created_at FROM favorites WHERE user_id=$1 ORDER BY created_at DESC`,
        [userId]);
      return ok(rows);
    }

    // POST /api/favorites
    if (method === 'POST') {
      const {entity_type,entity_id} = JSON.parse(event.body||'{}');
      if (!entity_type||!entity_id) return err(400,'entity_type and entity_id required');
      const {rows} = await queryAs(userId,
        `INSERT INTO favorites (user_id,entity_type,entity_id) VALUES ($1,$2,$3)
         ON CONFLICT (user_id,entity_type,entity_id) DO UPDATE SET entity_id=EXCLUDED.entity_id
         RETURNING id`,
        [userId,entity_type,entity_id]);
      return created({id: rows[0].id});
    }

    // DELETE /api/favorites?entity_type=x&entity_id=y
    if (method === 'DELETE') {
      if (!qs.entity_type||!qs.entity_id) return err(400,'entity_type and entity_id required');
      await queryAs(userId,
        `DELETE FROM favorites WHERE user_id=$1 AND entity_type=$2 AND entity_id=$3`,
        [userId,qs.entity_type,qs.entity_id]);
      return noContent();
    }

    return err(405,'Method not allowed');
  } catch(e) {
    if (e instanceof AuthError) return err(401,e.message);
    console.error('favorites handler error:',e);
    return err(500,'Internal server error');
  }
};
