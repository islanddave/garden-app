// Lambda: /api/projects
// Reference implementation — all other handlers follow this pattern.
// Routes: GET / | POST / | GET /:id | PUT /:id | DELETE /:id

import { queryAs, queryPublic } from '../shared/db.mjs';
import { requireAuth, AuthError, ok, created, noContent, err, corsPreflight } from '../shared/auth.mjs';

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') return corsPreflight();

  const method = event.requestContext?.http?.method;
  const pathParts = (event.rawPath || '').split('/').filter(Boolean);
  // pathParts: ['api', 'projects'] or ['api', 'projects', ':id']
  const id = pathParts[2] || null;

  try {
    // --- Public read: GET /api/projects (no auth required for public projects) ---
    if (method === 'GET' && !id) {
      let userId = null;
      try { userId = await requireAuth(event); } catch {}

      if (userId) {
        // Authenticated: return all non-deleted projects
        const { rows } = await queryAs(userId,
          `SELECT p.*, l.name AS location_name
           FROM plant_projects p
           LEFT JOIN locations l ON l.id = p.location_id
           WHERE p.deleted_at IS NULL
           ORDER BY p.created_at DESC`,
        );
        return ok(rows);
      } else {
        // Unauthenticated: public projects only
        const { rows } = await queryPublic(
          `SELECT id, slug, name, description, status, species, variety,
                  start_date, end_date, cover_photo_path, created_at
           FROM plant_projects
           WHERE is_public = true AND deleted_at IS NULL
           ORDER BY created_at DESC`,
        );
        return ok(rows);
      }
    }

    // All remaining routes require auth
    const userId = await requireAuth(event);

    // --- GET /api/projects/:id ---
    if (method === 'GET' && id) {
      const { rows } = await queryAs(userId,
        `SELECT p.*, l.name AS location_name,
                (SELECT json_agg(e ORDER BY e.event_date DESC) FROM event_log e
                 WHERE e.project_id = p.id AND e.deleted_at IS NULL) AS events
         FROM plant_projects p
         LEFT JOIN locations l ON l.id = p.location_id
         WHERE p.id = $1 AND p.deleted_at IS NULL`,
        [id],
      );
      if (!rows.length) return err(404, 'Project not found');
      return ok(rows[0]);
    }

    // --- POST /api/projects ---
    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { name, description, status, species, variety, location_id,
              start_date, end_date, target_quantity, is_public, private_notes } = body;

      if (!name) return err(400, 'name is required');

      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
                   + '-' + Date.now().toString(36);

      const { rows } = await queryAs(userId,
        `INSERT INTO plant_projects
           (slug, name, description, status, species, variety, location_id,
            start_date, end_date, target_quantity, is_public, private_notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [slug, name, description, status || 'planning', species, variety,
         location_id, start_date, end_date, target_quantity,
         is_public !== false, private_notes, userId],
      );
      return created(rows[0]);
    }

    // --- PUT /api/projects/:id ---
    if (method === 'PUT' && id) {
      const body = JSON.parse(event.body || '{}');
      const { name, description, status, species, variety, location_id,
              start_date, end_date, target_quantity, is_public, private_notes } = body;

      const { rows } = await queryAs(userId,
        `UPDATE plant_projects
         SET name=$2, description=$3, status=$4, species=$5, variety=$6,
             location_id=$7, start_date=$8, end_date=$9, target_quantity=$10,
             is_public=$11, private_notes=$12
         WHERE id=$1 AND deleted_at IS NULL
         RETURNING *`,
        [id, name, description, status, species, variety, location_id,
         start_date, end_date, target_quantity, is_public, private_notes],
      );
      if (!rows.length) return err(404, 'Project not found or not authorized');
      return ok(rows[0]);
    }

    // --- DELETE /api/projects/:id (soft delete) ---
    if (method === 'DELETE' && id) {
      const { rows } = await queryAs(userId,
        `UPDATE plant_projects SET deleted_at = NOW()
         WHERE id = $1 AND created_by = $2 AND deleted_at IS NULL
         RETURNING id`,
        [id, userId],
      );
      if (!rows.length) return err(404, 'Project not found or not authorized');
      return noContent();
    }

    return err(405, 'Method not allowed');

  } catch (e) {
    if (e instanceof AuthError) return err(401, e.message);
    console.error('projects handler error:', e);
    return err(500, 'Internal server error');
  }
};
