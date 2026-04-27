// Lambda: /api/plants
// Routes: GET / | GET /:id | POST / | PUT /:id | DELETE /:id (soft)
// RLS: authenticated-only for all operations (plants_select_auth policy)
// Table: public.plants
// Ownership: created_by = Clerk user ID (TEXT)

import { queryAs } from '../shared/db.mjs';
import { requireAuth, AuthError, ok, created, noContent, err, corsPreflight } from '../shared/auth.mjs';

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') return corsPreflight();

  const method = event.requestContext?.http?.method;
  const pathParts = (event.rawPath || '').split('/').filter(Boolean);
  const id = pathParts[2] || null;

  try {
    const userId = await requireAuth(event);

    if (method === 'GET' && !id) {
      const qs = event.queryStringParameters || {};
      const projectId = qs.project_id || null;
      let sql = `
        SELECT pl.*, pp.name AS project_name
        FROM plants pl
        LEFT JOIN plant_projects pp ON pp.id = pl.project_id
        WHERE pl.deleted_at IS NULL
      `;
      const params = [];
      if (projectId) {
        params.push(projectId);
        sql += ` AND pl.project_id = $${params.length}`;
      }
      sql += ` ORDER BY pl.created_at DESC`;
      const { rows } = await queryAs(userId, sql, params);
      return ok(rows);
    }

    if (method === 'GET' && id) {
      const { rows } = await queryAs(userId,
        `SELECT pl.*, pp.name AS project_name
         FROM plants pl
         LEFT JOIN plant_projects pp ON pp.id = pl.project_id
         WHERE pl.id = $1 AND pl.deleted_at IS NULL`,
        [id],
      );
      if (!rows.length) return err(404, 'Plant not found');
      return ok(rows[0]);
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { name, genus, species, variety, quantity, status, notes, project_id } = body;
      if (!name)       return err(400, 'name is required');
      if (!project_id) return err(400, 'project_id is required');
      const qty = parseInt(quantity, 10);
      const { rows } = await queryAs(userId,
        `INSERT INTO plants
           (name, genus, species, variety, quantity, status, notes, project_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [name, genus || null, species || null, variety || null,
         isNaN(qty) || qty < 1 ? 1 : qty,
         status || null, notes || null, project_id, userId],
      );
      return created(rows[0]);
    }

    if (method === 'PUT' && id) {
      const body = JSON.parse(event.body || '{}');
      const { name, genus, species, variety, quantity, status, notes, project_id } = body;
      if (!name) return err(400, 'name is required');
      const qty = parseInt(quantity, 10);
      const { rows } = await queryAs(userId,
        `UPDATE plants
         SET name=$2, genus=$3, species=$4, variety=$5, quantity=$6,
             status=$7, notes=$8, project_id=$9
         WHERE id=$1 AND deleted_at IS NULL
         RETURNING *`,
        [id, name, genus || null, species || null, variety || null,
         isNaN(qty) || qty < 1 ? 1 : qty,
         status || null, notes || null, project_id || null],
      );
      if (!rows.length) return err(404, 'Plant not found or not authorized');
      return ok(rows[0]);
    }

    if (method === 'DELETE' && id) {
      const { rows } = await queryAs(userId,
        `UPDATE plants SET deleted_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id`,
        [id],
      );
      if (!rows.length) return err(404, 'Plant not found or not authorized');
      return noContent();
    }

    return err(405, 'Method not allowed');

  } catch (e) {
    if (e instanceof AuthError) return err(401, e.message);
    console.error('plants handler error:', e);
    return err(500, 'Internal server error');
  }
};
