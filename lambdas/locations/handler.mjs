// Lambda: /api/locations
// Routes: GET / | GET /:id | POST / | PUT /:id | DELETE /:id (deactivates — no hard delete)
// RLS: public read (no auth), authenticated write
// Table: public.locations (self-referential hierarchy)
// Soft-delete pattern: is_active = false (locations have no deleted_at)

import { queryAs, queryPublic } from '../shared/db.mjs';
import { requireAuth, AuthError, ok, created, noContent, err, corsPreflight } from '../shared/auth.mjs';

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') return corsPreflight();

  const method = event.requestContext?.http?.method;
  const pathParts = (event.rawPath || '').split('/').filter(Boolean);
  const id = pathParts[2] || null;

  try {
    if (method === 'GET' && !id) {
      const qs = event.queryStringParameters || {};
      const parentId       = qs.parent_id       || null;
      const includeInactive = qs.include_inactive === 'true';

      const params = [];
      let sql = `
        SELECT l.*,
               public.get_location_path(l.id) AS full_path,
               (SELECT json_agg(c ORDER BY c.sort_order, c.name)
                FROM locations c
                WHERE c.parent_id = l.id
                  AND ($1::boolean OR c.is_active = true)
               ) AS children
        FROM locations l
        WHERE 1=1
      `;
      params.push(includeInactive);  // $1

      if (!includeInactive) {
        sql += ` AND l.is_active = true`;
      }
      if (parentId) {
        params.push(parentId);
        sql += ` AND l.parent_id = $${params.length}`;
      } else if (qs.flat !== 'true') {
        sql += ` AND l.parent_id IS NULL`;
      }
      sql += ` ORDER BY l.sort_order, l.name`;

      const { rows } = await queryPublic(sql, params);
      return ok(rows);
    }

    if (method === 'GET' && id) {
      const { rows } = await queryPublic(
        `SELECT l.*,
                public.get_location_path(l.id) AS full_path
         FROM locations l
         WHERE l.id = $1`,
        [id],
      );
      if (!rows.length) return err(404, 'Location not found');
      return ok(rows[0]);
    }

    const userId = await requireAuth(event);

    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { name, slug, parent_id, level, type_label, description, notes,
              is_active, sort_order, icon, color_hex, zone_level } = body;
      if (!name) return err(400, 'name is required');
      if (!slug) return err(400, 'slug is required');

      const { rows } = await queryAs(userId,
        `INSERT INTO locations
           (name, slug, parent_id, level, type_label, description, notes,
            is_active, sort_order, icon, color_hex, zone_level, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [name, slug, parent_id || null, level ?? 0, type_label || null,
         description || null, notes || null, is_active !== false,
         sort_order ?? 0, icon || null, color_hex || null, zone_level || null, userId],
      );
      return created(rows[0]);
    }

    if (method === 'PUT' && id) {
      const body = JSON.parse(event.body || '{}');
      const { name, slug, parent_id, level, type_label, description, notes,
              is_active, sort_order, icon, color_hex, zone_level } = body;
      if (!name) return err(400, 'name is required');

      const { rows } = await queryAs(userId,
        `UPDATE locations
         SET name=$2, slug=$3, parent_id=$4, level=$5, type_label=$6,
             description=$7, notes=$8, is_active=$9, sort_order=$10,
             icon=$11, color_hex=$12, zone_level=$13
         WHERE id=$1
         RETURNING *`,
        [id, name, slug || null, parent_id || null, level ?? 0, type_label || null,
         description || null, notes || null, is_active !== false,
         sort_order ?? 0, icon || null, color_hex || null, zone_level || null],
      );
      if (!rows.length) return err(404, 'Location not found or not authorized');
      return ok(rows[0]);
    }

    if (method === 'DELETE' && id) {
      const { rows } = await queryAs(userId,
        `UPDATE locations SET is_active = false WHERE id = $1 RETURNING id`,
        [id],
      );
      if (!rows.length) return err(404, 'Location not found or not authorized');
      return noContent();
    }

    return err(405, 'Method not allowed');

  } catch (e) {
    if (e instanceof AuthError) return err(401, e.message);
    console.error('locations handler error:', e);
    return err(500, 'Internal server error');
  }
};
