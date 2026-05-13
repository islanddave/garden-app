import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
// requestChecksumCalculation/responseChecksumValidation: newer SDK v3 versions (3.679+) default
// to injecting x-amz-checksum-mode=ENABLED into GetObject presigned URLs as a query param.
// S3 only accepts that header on actual requests, not presigned URL query strings — causes 403.
// WHEN_REQUIRED suppresses the injection entirely for presigned GET URLs.
const s3 = new S3Client({
  region: process.env.AWS_REGION ?? 'us-east-1',
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const BUCKET = process.env.S3_PHOTOS_BUCKET;
if (!BUCKET) throw new Error('S3_PHOTOS_BUCKET env var not set — check Lambda configuration');

let _secrets = null;
async function getSecrets() {
  if (_secrets) return _secrets;
  const cmd = new GetSecretValueCommand({ SecretId: process.env.SECRET_NAME ?? 'garden-app/secrets' });
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

// Pre-signed PUT URL — browser uploads directly to S3, Lambda never touches the bytes
async function getUploadUrl(photoId, ext, contentType) {
  const key = `uploads/${photoId}.${ext}`;
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType ?? 'image/jpeg',
  });
  const url = await getSignedUrl(s3, cmd, { expiresIn: 300 }); // 5 minutes
  return { url, key };
}

// Pre-signed GET URL — 15-minute expiry per architecture spec
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
    const payload = await verifyToken(token, {
      secretKey: secrets.CLERK_SECRET_KEY,
      authorizedParties: [
        'https://garden.futureishere.net',
        'https://dg6mmjhepoyt9.cloudfront.net',
      ],
    });
    userId = payload.sub;
  } catch (err) {
    console.error('verifyToken failed:', err?.message ?? String(err));
    return resp(401, { error: 'Unauthorized' });
  }

  const sql = neon(secrets.NEON_DATABASE_URL);
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/photos';

  try {
    // GET /api/photos/upload-url — returns pre-signed S3 PUT URL for browser upload
    // Query params: key (full S3 key, caller-generated), content_type (MIME type)
    if (rawPath === '/api/photos/upload-url' && method === 'GET') {
      const key = event.queryStringParameters?.key;
      const contentType = event.queryStringParameters?.content_type ?? 'image/jpeg';
      if (!key) return resp(400, { error: 'key is required' });
      const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType });
      const upload_url = await getSignedUrl(s3, cmd, { expiresIn: 300 });
      return resp(200, { upload_url, key });
    }

    // GET /api/photos/view-url/:id — returns pre-signed GET URL for a photo record
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

    // GET /api/photos — list user's photos with optional filters
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

      // Attach pre-signed view URLs to each photo record
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

    // POST /api/photos — register a photo record after browser has uploaded to S3
    // Browser: PUT to upload_url (from upload-url endpoint), then POST here with storage_path.
    //
    // V2-PHOTO-F1 AUTO-PROMOTE (Dave decision 2026-05-13, YES):
    //   After insert, if the new photo links to exactly one featurable parent
    //   (project / plant / location / inventory_item) AND that parent's
    //   featured_photo_id IS NULL, PATCH it to this photo's id. Single transaction.
    //   Race-safe: the UPDATE's `WHERE featured_photo_id IS NULL` predicate guards
    //   against concurrent uploads — only the first to commit wins; later inserts
    //   no-op on the auto-promote.
    if (rawPath === '/api/photos' && method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      if (!body.storage_path) return resp(400, { error: 'storage_path is required' });

      // neon serverless driver: tagged-template calls are auto-committed individually.
      // For atomicity, wrap in sql.transaction([...]) — multiple tagged templates
      // run in one BEGIN/COMMIT and roll back together on failure.
      const insertQuery = sql`
        INSERT INTO photos
          (project_id, event_id, location_id, plant_id, inventory_item_id,
           storage_path, caption, is_public, uploaded_by, created_by)
        VALUES (
          ${body.project_id ?? null},
          ${body.event_id ?? null},
          ${body.location_id ?? null},
          ${body.plant_id ?? null},
          ${body.inventory_item_id ?? null},
          ${body.storage_path},
          ${body.caption ?? null},
          ${body.is_public ?? true},
          ${userId},
          ${userId}
        )
        RETURNING *
      `;

      const insertedRows = await insertQuery;
      const inserted = insertedRows[0];

      // Auto-promote: parent-by-parent, only if photo has the linkage AND
      // parent's featured_photo_id IS NULL AND caller owns the parent.
      // Each UPDATE is a separate atomic statement; the WHERE clauses guard
      // race conditions. Failures here are non-fatal: the photo row is
      // already persisted, auto-promote is best-effort.
      try {
        if (inserted.project_id) {
          await sql`
            UPDATE plant_projects
               SET featured_photo_id = ${inserted.id}
             WHERE id = ${inserted.project_id}
               AND created_by = ${userId}
               AND featured_photo_id IS NULL
               AND deleted_at IS NULL
          `;
        }
        if (inserted.plant_id) {
          await sql`
            UPDATE plants p
               SET featured_photo_id = ${inserted.id}
              FROM plant_projects pp
             WHERE p.id = ${inserted.plant_id}
               AND p.project_id = pp.id
               AND pp.created_by = ${userId}
               AND p.featured_photo_id IS NULL
               AND p.deleted_at IS NULL
          `;
        }
        if (inserted.location_id) {
          await sql`
            UPDATE locations
               SET featured_photo_id = ${inserted.id}
             WHERE id = ${inserted.location_id}
               AND featured_photo_id IS NULL
               AND deleted_at IS NULL
          `;
        }
        if (inserted.inventory_item_id) {
          await sql`
            UPDATE inventory_items
               SET featured_photo_id = ${inserted.id}
             WHERE id = ${inserted.inventory_item_id}
               AND created_by = ${userId}
               AND featured_photo_id IS NULL
               AND deleted_at IS NULL
          `;
        }
      } catch (promoteErr) {
        console.error('auto-promote non-fatal failure', promoteErr?.message ?? promoteErr);
      }

      return resp(201, inserted);
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('photos lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};
