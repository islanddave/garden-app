import { queryAs } from '../shared/db.mjs';
import { requireAuth, AuthError, ok, created, noContent, err, corsPreflight } from '../shared/auth.mjs';

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') return corsPreflight();
  const method = event.requestContext?.http?.method;
  const pathParts = (event.rawPath||'').split('/').filter(Boolean);
  const seg2 = pathParts[2] || null;
  const seg3 = pathParts[3] || null;
  const id = (seg2 && seg2 !== 'with-path') ? seg2 : null;
  const qs = event.queryStringParameters || {};

  try {
    const userId = await requireAuth(event);

    // GET /api/locations/with-path
    if (method === 'GET' && seg2 === 'with-path') {
      const {rows} = await queryAs(userId,
        `SELECT * FROM locations_with_path ORDER BY full_path`, []);
      return ok(rows);
    }

    // GET /api/locations[?level=N&active=true]
    if (method === 'GET' && !id) {
      let sql = `SELECT * FROM locations WHERE deleted_at IS NULL`;
      const params = [];
      if (qs.level !== undefined) {
        sql += ` AND level=$${params.length+1}`;
        params.push(parseInt(qs.level));
      }
      if (qs.active !== undefined) {
        sql += ` AND is_active=$${params.length+1}`;
        params.push(qs.active !== 'false');
      }
      sql += ` ORDER BY sort_order NULLS LAST, name`;
      const {rows} = await queryAs(userId, sql, params);
      return ok(rows);
    }

    // PATCH /api/locations/:id/active
    if (method === 'PATCH' && id && seg3 === 'active') {
      const {is_active} = JSON.parse(event.body||'{}');
      const {rows} = await queryAs(userId,
        `UPDATE locations SET is_active=$2 WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
        [id, is_active]);
      if (!rows.length) return err(404,'Location not found');
      return ok(rows[0]);
    }

    // GET /api/locations/:id
    if (method === 'GET' && id) {
      const {rows} = await queryAs(userId,
        `SELECT l.*, lwp.full_path FROM locations l
         LEFT JOIN locations_with_path lwp ON lwp.id=l.id
         WHERE l.id=$1 AND l.deleted_at IS NULL`, [id]);
      if (!rows.length) return err(404,'Location not found');
      return ok(rows[0]);
    }

    // POST /api/locations
    if (method === 'POST') {
      const {name,slug,level,parent_id,type_label,icon,color_hex,is_active,sort_order,notes} = JSON.parse(event.body||'{}');
      if (!name) return err(400,'name required');
      const autoSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
      const {rows} = await queryAs(userId,
        `INSERT INTO locations (name,slug,level,parent_id,type_label,icon,color_hex,is_active,sort_order,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [name,autoSlug,level??0,parent_id||null,type_label||null,icon||null,color_hex||null,is_active!==false,sort_order??null,notes||null]);
      return created(rows[0]);
    }

    // PUT /api/locations/:id
    if (method === 'PUT' && id) {
      const {name,slug,level,parent_id,type_label,icon,color_hex,is_active,sort_order,notes} = JSON.parse(event.body||'{}');
      const {rows} = await queryAs(userId,
        `UPDATE locations SET name=$2,slug=$3,level=$4,parent_id=$5,type_label=$6,icon=$7,color_hex=$8,is_active=$9,sort_order=$10,notes=$11
         WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
        [id,name,slug||null,level,parent_id||null,type_label||null,icon||null,color_hex||null,is_active,sort_order||null,notes||null]);
      if (!rows.length) return err(404,'Location not found');
      return ok(rows[0]);
    }

    // DELETE /api/locations/:id
    if (method === 'DELETE' && id) {
      const {rows} = await queryAs(userId,
        `UPDATE locations SET deleted_at=NOW() WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [id]);
      if (!rows.length) return err(404,'Location not found');
      return noContent();
    }

    return err(405,'Method not allowed');
  } catch(e) {
    if (e instanceof AuthError) return err(401,e.message);
    console.error('locations handler error:',e);
    return err(500,'Internal server error');
  }
};
