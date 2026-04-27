// Lambda: /api/photos
// Routes: GET / | POST / (pre-signed S3 URL + DB record) | DELETE /:id (soft)
//
// POST flow:
//   1. Client sends metadata (filename, content_type, project_id, etc.)
//   2. Lambda generates S3 key, creates DB record, returns {photo, upload_url}
//   3. Client PUTs the file directly to S3 using upload_url
//   4. Photo is live. No second API call needed.
//
// S3 bucket: process.env.S3_PHOTOS_BUCKET (garden-photos-prod)
// Region: us-east-1. Lambda exec role provides credentials automatically.
// Pre-signed URL expiry: 5 min (sufficient for mobile upload).

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { queryAs, queryPublic } from '../shared/db.mjs';
import { requireAuth, AuthError, ok, created, noContent, err, corsPreflight } from '../shared/auth.mjs';

const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const PHOTOS_BUCKET  = process.env.S3_PHOTOS_BUCKET || 'garden-photos-prod';
const UPLOAD_EXPIRES = 300; // 5 minutes

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
      const eventId    = qs.event_id    || null;
      const locationId = qs.location_id || null;
      const plantId    = qs.plant_id    || null;

      if (userId) {
        const params = [];
        let sql = `
          SELECT ph.*,
                 p.name  AS project_name,
                 e.title AS event_title, e.event_type
          FROM photos ph
          LEFT JOIN plant_projects p ON p.id = ph.project_id
          LEFT JOIN event_log e ON e.id = ph.event_id
          WHERE ph.deleted_at IS NULL
        `;
        if (projectId)  { params.push(projectId);  sql += ` AND ph.project_id  = $${params.length}`; }
        if (eventId)    { params.push(eventId);    sql += ` AND ph.event_id    = $${params.length}`; }
        if (locationId) { params.push(locationId); sql += ` AND ph.location_id = $${params.length}`; }
        if (plantId)    { params.push(plantId);    sql += ` AND ph.plant_id    = $${params.length}`; }
        sql += ` ORDER BY ph.created_at DESC LIMIT 200`;
        const { rows } = await queryAs(userId, sql, params);
        return ok(rows);
      } else {
        const params = [];
        let sql = `
          SELECT ph.id, ph.project_id, ph.event_id, ph.location_id,
                 ph.storage_path, ph.caption, ph.is_public, ph.created_at
          FROM photos ph
          WHERE ph.deleted_at IS NULL AND ph.is_public = true
        `;
        if (projectId) { params.push(projectId); sql += ` AND ph.project_id = $${params.length}`; }
        sql += ` ORDER BY ph.created_at DESC LIMIT 100`;
        const { rows } = await queryPublic(sql, params);
        return ok(rows);
      }
    }

    const userId = await requireAuth(event);

    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { filename, content_type, project_id, event_id, location_id,
              plant_id, caption, is_public } = body;
      if (!filename) return err(400, 'filename is required');

      const ext     = (filename.split('.').pop() || 'jpg').toLowerCase().slice(0, 5);
      const photoId = crypto.randomUUID();
      const prefix  = event_id    ? `events/${event_id}`
                    : project_id  ? `projects/${project_id}`
                    : 'standalone';
      const s3Key   = `${prefix}/${photoId}.${ext}`;
      const mime    = content_type || 'image/jpeg';

      const cmd = new PutObjectCommand({
        Bucket:      PHOTOS_BUCKET,
        Key:         s3Key,
        ContentType: mime,
      });
      const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: UPLOAD_EXPIRES });

      const { rows } = await queryAs(userId,
        `INSERT INTO photos
           (project_id, event_id, location_id, plant_id, storage_path,
            caption, is_public, uploaded_by, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [project_id  || null, event_id    || null,
         location_id || null, plant_id    || null,
         s3Key, caption || null, is_public !== false, userId, userId],
      );

      return created({ ...rows[0], upload_url: uploadUrl });
    }

    if (method === 'DELETE' && id) {
      const { rows } = await queryAs(userId,
        `UPDATE photos SET deleted_at = NOW()
         WHERE id = $1 AND created_by = $2 AND deleted_at IS NULL
         RETURNING id`,
        [id, userId],
      );
      if (!rows.length) return err(404, 'Photo not found or not authorized');
      return noContent();
    }

    return err(405, 'Method not allowed');

  } catch (e) {
    if (e instanceof AuthError) return err(401, e.message);
    console.error('photos handler error:', e);
    return err(500, 'Internal server error');
  }
};
