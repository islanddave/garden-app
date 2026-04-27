import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { queryAs } from '../shared/db.mjs';
import { requireAuth, AuthError, ok, created, noContent, err, corsPreflight } from '../shared/auth.mjs';

const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const BUCKET = process.env.S3_PHOTOS_BUCKET;
const VIEW_TTL = 3600;
const UPLOAD_TTL = 300;

async function signedViewUrl(key) {
  return getSignedUrl(s3, new GetObjectCommand({Bucket:BUCKET,Key:key}), {expiresIn:VIEW_TTL});
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') return corsPreflight();
  const method = event.requestContext?.http?.method;
  const pathParts = (event.rawPath||'').split('/').filter(Boolean);
  const seg2 = pathParts[2] || null;
  const qs = event.queryStringParameters || {};

  try {
    const userId = await requireAuth(event);

    if (method === 'GET' && seg2 === 'upload-url') {
      const {key,content_type} = qs;
      if (!key) return err(400,'key required');
      const upload_url = await getSignedUrl(s3,
        new PutObjectCommand({Bucket:BUCKET,Key:key,ContentType:content_type||'image/jpeg'}),
        {expiresIn:UPLOAD_TTL});
      return ok({upload_url, key});
    }

    if (method === 'GET' && seg2 === 'view-url') {
      const {key} = qs;
      if (!key) return err(400,'key required');
      return ok({view_url: await signedViewUrl(key)});
    }

    if (method === 'GET' && !seg2) {
      const {project_id,limit} = qs;
      let sql = `SELECT p.*, pp.name AS project_name FROM photos p
                 LEFT JOIN plant_projects pp ON pp.id=p.project_id
                 WHERE p.deleted_at IS NULL`;
      const params = [];
      if (project_id) { sql += ` AND p.project_id=$${params.length+1}`; params.push(project_id); }
      sql += ` ORDER BY p.taken_at DESC NULLS LAST, p.created_at DESC`;
      if (limit) { sql += ` LIMIT $${params.length+1}`; params.push(parseInt(limit)||20); }
      const {rows} = await queryAs(userId, sql, params);
      const withUrls = await Promise.all(rows.map(async r => ({
        ...r, view_url: r.storage_path ? await signedViewUrl(r.storage_path) : null,
      })));
      return ok(withUrls);
    }

    if (method === 'GET' && seg2) {
      const {rows} = await queryAs(userId,
        `SELECT p.*, pp.name AS project_name FROM photos p
         LEFT JOIN plant_projects pp ON pp.id=p.project_id
         WHERE p.id=$1 AND p.deleted_at IS NULL`, [seg2]);
      if (!rows.length) return err(404,'Photo not found');
      const photo = {...rows[0], view_url: rows[0].storage_path ? await signedViewUrl(rows[0].storage_path) : null};
      return ok(photo);
    }

    if (method === 'POST') {
      const {event_id,project_id,plant_id,location_id,storage_path,taken_at,caption,tags,is_public} = JSON.parse(event.body||'{}');
      if (!storage_path||!project_id) return err(400,'storage_path and project_id required');
      const {rows} = await queryAs(userId,
        `INSERT INTO photos (event_id,project_id,plant_id,location_id,storage_path,taken_at,caption,tags,is_public,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [event_id||null,project_id,plant_id||null,location_id||null,storage_path,taken_at||null,caption||null,tags||null,is_public!==false,userId]);
      const photo = {...rows[0], view_url: await signedViewUrl(rows[0].storage_path)};
      return created(photo);
    }

    if (method === 'PUT' && seg2) {
      const {tags,caption,project_id,location_id,plant_id} = JSON.parse(event.body||'{}');
      const {rows} = await queryAs(userId,
        `UPDATE photos SET tags=$2,caption=$3,project_id=$4,location_id=$5,plant_id=$6
         WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
        [seg2,tags||null,caption||null,project_id||null,location_id||null,plant_id||null]);
      if (!rows.length) return err(404,'Photo not found');
      return ok(rows[0]);
    }

    return err(405,'Method not allowed');
  } catch(e) {
    if (e instanceof AuthError) return err(401,e.message);
    console.error('photos handler error:',e);
    return err(500,'Internal server error');
  }
};
