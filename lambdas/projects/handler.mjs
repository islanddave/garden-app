// Lambda: /api/projects
// Routes: GET / | GET /public/:slug | GET /types | POST /types | DELETE /types/:id
//         POST / | GET /:id | PUT /:id | DELETE /:id

import { queryAs, queryPublic } from '../shared/db.mjs';
import { requireAuth, AuthError, ok, created, noContent, err, corsPreflight } from '../shared/auth.mjs';

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') return corsPreflight();

  const method = event.requestContext?.http?.method;
  const pathParts = (event.rawPath || '').split('/').filter(Boolean);
  // ['api','projects'] | ['api','projects','public',slug] | ['api','projects','types'] | ['api','projects','types',id] | ['api','projects',id]
  const seg2 = pathParts[2] || null;
  const seg3 = pathParts[3] || null;

  try {
    // --- Public: GET /api/projects/public/:slug ---
    if (method === 'GET' && seg2 === 'public' && seg3) {
      const {rows} = await queryPublic(
        `SELECT p.*, lwp.full_path AS location_path,
                (SELECT json_agg(e ORDER BY e.event_date DESC)
                 FROM event_log e
                 WHERE e.project_id=p.id AND e.deleted_at IS NULL AND e.is_public=true) AS events
         FROM plant_projects p
         LEFT JOIN locations_with_path lwp ON lwp.id=p.location_id
         WHERE p.slug=$1 AND p.is_public=true AND p.deleted_at IS NULL`,
        [seg3]);
      if (!rows.length) return err(404, 'Project not found');
      return ok(rows[0]);
    }

    // --- Project types ---
    if (seg2 === 'types') {
      const userId = await requireAuth(event);
      if (method === 'GET' && !seg3) {
        const {rows} = await queryAs(userId, `SELECT * FROM project_types ORDER BY category, name`, []);
        return ok(rows);
      }
      if (method === 'POST' && !seg3) {
        const {name,category,description,icon} = JSON.parse(event.body||'{}');
        if (!name) return err(400, 'name required');
        const {rows} = await queryAs(userId,
          `INSERT INTO project_types (name,category,description,icon,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [name,category||'garden',description||null,icon||'📋',userId]);
        return created(rows[0]);
      }
      if (method === 'DELETE' && seg3) {
        await queryAs(userId, `DELETE FROM project_types WHERE id=$1 AND created_by=$2`, [seg3,userId]);
        return noContent();
      }
      return err(405, 'Method not allowed');
    }

    // --- GET /api/projects (list, auth-optional) ---
    if (method === 'GET' && !seg2) {
      let userId = null;
      try { userId = await requireAuth(event); } catch {}
      if (userId) {
        const {rows} = await queryAs(userId,
          `SELECT p.*, lwp.full_path AS location_path
           FROM plant_projects p
           LEFT JOIN locations_with_path lwp ON lwp.id=p.location_id
           WHERE p.deleted_at IS NULL ORDER BY p.created_at DESC`, []);
        return ok(rows);
      } else {
        const {rows} = await queryPublic(
          `SELECT id,slug,name,description,status,species,variety,start_date,end_date,cover_photo_path,created_at
           FROM plant_projects WHERE is_public=true AND deleted_at IS NULL ORDER BY created_at DESC`, []);
        return ok(rows);
      }
    }

    // All remaining routes require auth
    const userId = await requireAuth(event);
    const id = seg2;

    // --- GET /api/projects/:id ---
    if (method === 'GET' && id) {
      const {rows} = await queryAs(userId,
        `SELECT p.*, lwp.full_path AS location_path,
                (SELECT json_agg(e ORDER BY e.event_date DESC)
                 FROM event_log e WHERE e.project_id=p.id AND e.deleted_at IS NULL) AS events
         FROM plant_projects p
         LEFT JOIN locations_with_path lwp ON lwp.id=p.location_id
         WHERE p.id=$1 AND p.deleted_at IS NULL`, [id]);
      if (!rows.length) return err(404, 'Project not found');
      return ok(rows[0]);
    }

    // --- POST /api/projects ---
    if (method === 'POST') {
      const {name,description,status,species,variety,location_id,start_date,end_date,target_quantity,is_public,private_notes,slug:reqSlug,project_type_id} = JSON.parse(event.body||'{}');
      if (!name) return err(400, 'name required');
      const slug = reqSlug || name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') + '-' + Date.now().toString(36);
      const {rows} = await queryAs(userId,
        `INSERT INTO plant_projects (slug,name,description,status,species,variety,location_id,start_date,end_date,target_quantity,is_public,private_notes,created_by,project_type_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [slug,name,description||null,status||'planning',species||null,variety||null,location_id||null,start_date||null,end_date||null,target_quantity||null,is_public!==false,private_notes||null,userId,project_type_id||null]);
      return created(rows[0]);
    }

    // --- PUT /api/projects/:id ---
    if (method === 'PUT' && id) {
      const {name,description,status,species,variety,location_id,start_date,end_date,target_quantity,is_public,private_notes,slug} = JSON.parse(event.body||'{}');
      const {rows} = await queryAs(userId,
        `UPDATE plant_projects
         SET name=$2,description=$3,status=$4,species=$5,variety=$6,location_id=$7,
             start_date=$8,end_date=$9,target_quantity=$10,is_public=$11,private_notes=$12,
             slug=COALESCE($13,slug)
         WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
        [id,name,description||null,status,species||null,variety||null,location_id||null,start_date||null,end_date||null,target_quantity||null,is_public,private_notes||null,slug||null]);
      if (!rows.length) return err(404, 'Project not found');
      return ok(rows[0]);
    }

    // --- DELETE /api/projects/:id ---
    if (method === 'DELETE' && id) {
      const {rows} = await queryAs(userId,
        `UPDATE plant_projects SET deleted_at=NOW() WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL RETURNING id`,
        [id,userId]);
      if (!rows.length) return err(404, 'Project not found');
      return noContent();
    }

    return err(405, 'Method not allowed');
  } catch(e) {
    if (e instanceof AuthError) return err(401, e.message);
    console.error('projects handler error:', e);
    return err(500, 'Internal server error');
  }
};
