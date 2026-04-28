import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
const BUCKET = process.env.PHOTOS_BUCKET_NAME;

let _secrets = null;
async function getSecrets() {
  if (_secrets) return _secrets;
  const cmd = new GetSecretValueCommand({ SecretId: 'garden-app/secrets' });
  const res = await sm.send(cmd);
  _secrets = JSON.parse(res.SecretString);
  return _secrets;
}

const CORS = {}; // Lambda URL config is sole CORS source — handler must not duplicate

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

async function getUploadUrl(photoId, ext, contentType) {
  const key = `uploads/${photoId}.${ext}`;
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType ?? 'image/jpeg',
  });
  const url = await getSignedUrl(s3, cmd, { expiresIn: 300 });
  return { url, key };
}

async function getViewUrl(storagePath) {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: storagePath });
  return getSignedUrl(s3, cmd, { expiresIn: 900 });
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const secrets = await getSecrets();

  const authHeader = event.headers?.authorization ?? event.headers?.Authorization ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  let userId;
  try {
    const payload = await verifyToken(token, { secretKey: secrets.CLERK_SECRET_KEY });
    userId = payload.sub;
  } catch {
    return resp(401, { error: 'Unauthorized' });
  }

  const sql = neon(secrets.NEON_DATABASE_URL);
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/photos';

  try {
    if (rawPath === '/api/photos/upload-url' && method === 'GET') {
      const ext = event.queryStringParameters?.ext ?? 'jpg';
      const contentType = event.queryStringParameters?.content_type ?? 'image/jpeg';
      const photoId = crypto.randomUUID();
      const { url, key } = await getUploadUrl(photoId, ext, contentType);
      return resp(200, { upload_url: url, storage_path: key, photo_id: photoId });
    }

    const viewMatch = rawPath.match(/^\/api\/photos\/view-url\/([^/]+)$/);
    if (viewMatch && method === 'GET') {
      const photoId = viewMatch[1];
      const rows = await sql`
        SELECT storage_path FROM photos
        WHERE id = ${photoId}
          AND uploaded_by = ${userId}
      `;
      if (!rows.length) return resp(404, { error: 'Not found' });
      const viewUrl = await getViewUrl(rows[0].storage_path);
      return resp(200, { view_url: viewUrl, expires_in: 900 });
    }

    if (rawPath === '/api/photos' && method === 'GET') {
      const projectId = event.queryStringParameters?.project_id ?? null;
      const limit = Math.min(parseInt(event.queryStringParameters?.limit ?? '120', 10), 200);

      const rows = projectId
        ? await sql`
            SELECT
              p.id, p.project_id, p.event_id, p.location_id, p.plant_id,
              p.storage_path, p.caption, p.is_public, p.created_at,
              pp.name AS project_name
            FROM photos p
            LEFT JOIN plant_projects pp ON pp.id = p.project_id
            WHERE p.uploaded_by = ${userId}
              AND p.project_id = ${projectId}
            ORDER BY p.created_at DESC
            LIMIT ${limit}
          `
        : await sql`
            SELECT
              p.id, p.project_id, p.event_id, p.location_id, p.plant_id,
              p.storage_path, p.caption, p.is_public, p.created_at,
              pp.name AS project_name
            FROM photos p
            LEFT JOIN plant_projects pp ON pp.id = p.project_id
            WHERE p.uploaded_by = ${userId}
            ORDER BY p.created_at DESC
            LIMIT ${limit}
          `;

      const withUrls = await Promise.all(
        rows.map(async (photo) => {
          try {
            const view_url = await getViewUrl(photo.storage_path);
            return { ...photo, view_url };
          } catch {
            return { ...photo, view_url: null };
          }
        })
      );

      return resp(200, withUrls);
    }

    if (rawPath === '/api/photos' && method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      if (!body.storage_path) return resp(400, { error: 'storage_path is required' });

      const rows = await sql`
        INSERT INTO photos
          (project_id, event_id, location_id, plant_id,
           storage_path, caption, is_public, uploaded_by)
        VALUES (
          ${body.project_id ?? null},
          ${body.event_id ?? null},
          ${body.location_id ?? null},
          ${body.plant_id ?? null},
          ${body.storage_path},
          ${body.caption ?? null},
          ${body.is_public ?? true},
          ${userId}
        )
        RETURNING *
      `;
      return resp(201, rows[0]);
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('photos lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};
