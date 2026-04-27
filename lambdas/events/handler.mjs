// Lambda: /api/events
// Table: event_log (NOT "events" — confirmed in neon-post-restore.sql)
// Routes: GET / | GET /:id | POST / | PUT /:id | DELETE /:id (soft)
// Ownership columns: logged_by = Clerk user ID (set on INSERT); created_by = Clerk user ID
// Public read: events where is_public = true AND parent project is_public = true

import { queryAs, queryPublic } from '../shared/db.mjs';
import { requireAuth, AuthError, ok, created, noContent, err, corsPreflight } from '../shared/auth.mjs';

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') return corsPreflight();

  const method = event.requestContext?.http?.method;
  const pathParts = (event.rawPath || '').split('/').filter(Boolean);
  const id = pathParts[2] || null;

  try {
    if (method === 'GET' && !id) {
      let userId = null;
      try { userId = await requireAuth(event); } catch {}

      const qs         = event.queryStringParameters || {};
      const projectId  = qs.project_id  || null;
      const locationId = qs.location_id || null;
      const eventType  = qs.event_type  || null;
      const limit      = Math.min(parseInt(qs.limit, 10) || 200, 500);

      if (userId) {
        const params = [];
        let sql = `
          SELECT e.*,
                 p.name AS project_name, p.slug AS project_slug,
                 l.name AS location_name
          FROM event_log e
          LEFT JOIN plant_projects p ON p.id = e.project_id
          LEFT JOIN locations l ON l.id = e.location_id
          WHERE e.deleted_at IS NULL
        `;
        if (projectId)  { params.push(projectId);  sql += ` AND e.project_id  = $${params.length}`; }
        if (locationId) { params.push(locationId); sql += ` AND e.location_id = $${params.length}`; }
        if (eventType)  { params.push(eventType);  sql += ` AND e.event_type  = $${params.length}`; }
        sql += ` ORDER BY e.event_date DESC LIMIT ${limit}`;
        const { rows } = await queryAs(userId, sql, params);
        return ok(rows);
      } else {
        const params = [];
        let sql = `
          SELECT e.id, e.project_id, e.location_id, e.event_type, e.event_date,
                 e.title, e.notes, e.quantity, e.is_public, e.logged_by,
                 e.created_at, e.updated_at,
                 p.name AS project_name, p.slug AS project_slug
          FROM event_log e
          JOIN plant_projects p ON p.id = e.project_id
          WHERE e.deleted_at IS NULL
            AND e.is_public = true
            AND p.is_public = true
            AND p.deleted_at IS NULL
        `;
        if (projectId) { params.push(projectId); sql += ` AND e.project_id = $${params.length}`; }
        if (eventType) { params.push(eventType); sql += ` AND e.event_type  = $${params.length}`; }
        sql += ` ORDER BY e.event_date DESC LIMIT 100`;
        const { rows } = await queryPublic(sql, params);
        return ok(rows);
      }
    }

    if (method === 'GET' && id) {
      let userId = null;
      try { userId = await requireAuth(event); } catch {}

      if (userId) {
        const { rows } = await queryAs(userId,
          `SELECT e.*,
                  p.name AS project_name, p.slug AS project_slug,
                  l.name AS location_name
           FROM event_log e
           LEFT JOIN plant_projects p ON p.id = e.project_id
           LEFT JOIN locations l ON l.id = e.location_id
           WHERE e.id = $1 AND e.deleted_at IS NULL`,
          [id],
        );
        if (!rows.length) return err(404, 'Event not found');
        return ok(rows[0]);
      } else {
        const { rows } = await queryPublic(
          `SELECT e.id, e.project_id, e.location_id, e.event_type, e.event_date,
                  e.title, e.notes, e.quantity, e.is_public, e.logged_by,
                  e.created_at, e.updated_at,
                  p.name AS project_name, p.slug AS project_slug
           FROM event_log e
           JOIN plant_projects p ON p.id = e.project_id
           WHERE e.id = $1
             AND e.deleted_at IS NULL AND e.is_public = true
             AND p.is_public = true AND p.deleted_at IS NULL`,
          [id],
        );
        if (!rows.length) return err(404, 'Event not found');
        return ok(rows[0]);
      }
    }

    const userId = await requireAuth(event);

    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { project_id, location_id, event_type, event_date,
              title, notes, private_notes, quantity, is_public } = body;
      if (!project_id) return err(400, 'project_id is required');
      if (!event_type) return err(400, 'event_type is required');

      const { rows } = await queryAs(userId,
        `INSERT INTO event_log
           (project_id, location_id, event_type, event_date, title, notes,
            private_notes, quantity, is_public, logged_by, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [project_id, location_id || null, event_type,
         event_date || new Date().toISOString(),
         title || null, notes || null, private_notes || null,
         quantity || null, is_public !== false, userId, userId],
      );
      return created(rows[0]);
    }

    if (method === 'PUT' && id) {
      const body = JSON.parse(event.body || '{}');
      const { event_type, event_date, title, notes, private_notes,
              quantity, is_public, location_id } = body;
      if (!event_type) return err(400, 'event_type is required');

      const { rows } = await queryAs(userId,
        `UPDATE event_log
         SET event_type=$2, event_date=$3, title=$4, notes=$5,
             private_notes=$6, quantity=$7, is_public=$8, location_id=$9
         WHERE id=$1 AND deleted_at IS NULL
         RETURNING *`,
        [id, event_type, event_date, title || null, notes || null,
         private_notes || null, quantity || null,
         is_public !== false, location_id || null],
      );
      if (!rows.length) return err(404, 'Event not found or not authorized');
      return ok(rows[0]);
    }

    if (method === 'DELETE' && id) {
      const { rows } = await queryAs(userId,
        `UPDATE event_log SET deleted_at = NOW()
         WHERE id = $1 AND created_by = $2 AND deleted_at IS NULL
         RETURNING id`,
        [id, userId],
      );
      if (!rows.length) return err(404, 'Event not found or not authorized');
      return noContent();
    }

    return err(405, 'Method not allowed');

  } catch (e) {
    if (e instanceof AuthError) return err(401, e.message);
    console.error('events handler error:', e);
    return err(500, 'Internal server error');
  }
};
