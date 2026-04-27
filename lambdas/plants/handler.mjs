import { queryAs } from '../shared/db.mjs';
import { requireAuth, AuthError, ok, created, noContent, err, corsPreflight } from '../shared/auth.mjs';

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') return corsPreflight();
  const method = event.requestContext?.http?.method;
  const pathParts = (event.rawPath||'').split('/').filter(Boolean);
  const id = pathParts[2] || null;
  const qs = event.queryStringParameters || {};

  try {
    const userId = await requireAuth(event);

    if (method === 'GET' && !id) {
      const {project_id} = qs;
      let sql = `SELECT p.*, pp.name AS project_name FROM plants p
                 JOIN plant_projects pp ON pp.id=p.project_id
                 WHERE p.deleted_at IS NULL`;
      const params = [];
      if (project_id) { sql += ` AND p.project_id=$${params.length+1}`; params.push(project_id); }
      sql += ` ORDER BY p.created_at DESC`;
      const {rows} = await queryAs(userId, sql, params);
      return ok(rows);
    }

    if (method === 'GET' && id) {
      const {rows} = await queryAs(userId,
        `SELECT p.*, pp.name AS project_name FROM plants p
         JOIN plant_projects pp ON pp.id=p.project_id
         WHERE p.id=$1 AND p.deleted_at IS NULL`, [id]);
      if (!rows.length) return err(404,'Plant not found');
      return ok(rows[0]);
    }

    if (method === 'POST') {
      const {project_id,name,variety,quantity,status,notes,source,germination_rate,days_to_harvest} = JSON.parse(event.body||'{}');
      if (!project_id||!name) return err(400,'project_id and name required');
      const {rows} = await queryAs(userId,
        `INSERT INTO plants (project_id,name,variety,quantity,status,notes,source,germination_rate,days_to_harvest,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [project_id,name,variety||null,quantity||null,status||'active',notes||null,source||null,germination_rate||null,days_to_harvest||null,userId]);
      return created(rows[0]);
    }

    if (method === 'PUT' && id) {
      const {name,variety,quantity,status,notes,source,germination_rate,days_to_harvest} = JSON.parse(event.body||'{}');
      const {rows} = await queryAs(userId,
        `UPDATE plants SET name=$2,variety=$3,quantity=$4,status=$5,notes=$6,source=$7,germination_rate=$8,days_to_harvest=$9
         WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
        [id,name,variety||null,quantity||null,status,notes||null,source||null,germination_rate||null,days_to_harvest||null]);
      if (!rows.length) return err(404,'Plant not found');
      return ok(rows[0]);
    }

    if (method === 'DELETE' && id) {
      const {rows} = await queryAs(userId,
        `UPDATE plants SET deleted_at=NOW() WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [id]);
      if (!rows.length) return err(404,'Plant not found');
      return noContent();
    }

    return err(405,'Method not allowed');
  } catch(e) {
    if (e instanceof AuthError) return err(401,e.message);
    console.error('plants handler error:',e);
    return err(500,'Internal server error');
  }
};
