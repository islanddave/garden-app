// /api/plants — VARIETY-REF Session 2 dual-read update
// Adds variety_id + source_inventory_item_id + metadata write paths.
// Adds nested variety_ref object via LEFT JOIN to plant_varieties (deleted_at-aware).
// Legacy flat fields (genus, species, variety as text) RETAINED for backward compat
// during Session 2/3 cutover window. Lambda 2.0.5 (Session 3 cleanup) will remove them.

import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
const s3 = new S3Client({
  region: process.env.AWS_REGION ?? 'us-east-1',
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const BUCKET = process.env.S3_PHOTOS_BUCKET;

async function getFeaturedPhotoViewUrl(storagePath) {
  if (!storagePath || !BUCKET) return null;
  try {
    const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: storagePath });
    return await getSignedUrl(s3, cmd, { expiresIn: 900 });
  } catch (err) {
    console.error('getFeaturedPhotoViewUrl failed', err?.message ?? err);
    return null;
  }
}

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

// Shared SELECT clause — list + by-id share columns and JOIN shape.
// Build variety_ref as JSONB object on the SQL side; LEFT JOIN preserves rows
// where variety_id is NULL or the linked variety is soft-deleted.
const SELECT_COLS = `
  p.id, p.name, p.genus, p.species, p.variety, p.quantity,
  p.status, p.notes, p.project_id,
  p.variety_id, p.source_inventory_item_id, p.metadata,
  p.created_at, p.updated_at,
  pp.name AS project_name,
  CASE WHEN pv.id IS NOT NULL THEN
    jsonb_build_object(
      'id', pv.id, 'name', pv.name, 'species', pv.species, 'genus', pv.genus,
      'days_to_maturity_min', pv.days_to_maturity_min,
      'days_to_maturity_max', pv.days_to_maturity_max,
      'care_notes', pv.care_notes, 'soil_notes', pv.soil_notes,
      'sun_requirements', pv.sun_requirements,
      'common_diseases', pv.common_diseases,
      'expected_yield_notes', pv.expected_yield_notes,
      'photo_id', pv.photo_id, 'source_url', pv.source_url
    )
  ELSE NULL END AS variety_ref
`;

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
  const rawPath = event.rawPath ?? '/api/plants';

  const idMatch = rawPath.match(/^\/api\/plants\/([^/]+)$/);

  try {
    if (idMatch) {
      const plantId = idMatch[1];

      if (method === 'GET') {
        const rows = await sql`
          SELECT p.id, p.name, p.genus, p.species, p.variety, p.quantity,
                 p.status, p.notes, p.project_id,
                 p.variety_id, p.source_inventory_item_id, p.metadata,
                 p.featured_photo_id, fp.storage_path AS featured_photo_storage_path,
                 p.created_at, p.updated_at,
                 pp.name AS project_name,
                 CASE WHEN pv.id IS NOT NULL THEN
                   jsonb_build_object(
                     'id', pv.id, 'name', pv.name, 'species', pv.species, 'genus', pv.genus,
                     'days_to_maturity_min', pv.days_to_maturity_min,
                     'days_to_maturity_max', pv.days_to_maturity_max,
                     'care_notes', pv.care_notes, 'soil_notes', pv.soil_notes,
                     'sun_requirements', pv.sun_requirements,
                     'common_diseases', pv.common_diseases,
                     'expected_yield_notes', pv.expected_yield_notes,
                     'photo_id', pv.photo_id, 'source_url', pv.source_url
                   )
                 ELSE NULL END AS variety_ref
          FROM plants p
          JOIN plant_projects pp ON pp.id = p.project_id
          LEFT JOIN plant_varieties pv ON pv.id = p.variety_id AND pv.deleted_at IS NULL
          LEFT JOIN photos fp ON fp.id = p.featured_photo_id
          WHERE p.id = ${plantId}
            AND p.deleted_at IS NULL
            AND pp.created_by = ${userId}
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        const row = rows[0];
        const featured_photo_view_url = await getFeaturedPhotoViewUrl(row.featured_photo_storage_path);
        const { featured_photo_storage_path: _ignore, ...rest } = row;
        return resp(200, { ...rest, featured_photo_view_url });
      }

      if (method === 'PUT') {
        const body = JSON.parse(event.body ?? '{}');

        // V2-PHOTO-F1: strict validation for featured_photo_id (linkage = photos.plant_id).
        const hasFeatured = Object.prototype.hasOwnProperty.call(body, 'featured_photo_id');
        if (hasFeatured && body.featured_photo_id != null) {
          const linkRows = await sql`
            SELECT 1 FROM photos
             WHERE id = ${body.featured_photo_id}
               AND plant_id = ${plantId}
               AND uploaded_by = ${userId}
          `;
          if (!linkRows.length) {
            return resp(400, { error: 'featured_photo_id must be a photo linked to this plant' });
          }
        }

        const rows = await sql`
          UPDATE plants p
          SET
            name                     = COALESCE(${body.name ?? null}, p.name),
            genus                    = COALESCE(${body.genus ?? null}, p.genus),
            species                  = COALESCE(${body.species ?? null}, p.species),
            variety                  = COALESCE(${body.variety ?? null}, p.variety),
            quantity                 = COALESCE(${body.quantity ?? null}, p.quantity),
            status                   = COALESCE(${body.status ?? null}, p.status),
            notes                    = COALESCE(${body.notes ?? null}, p.notes),
            variety_id               = COALESCE(${body.variety_id ?? null}, p.variety_id),
            source_inventory_item_id = COALESCE(${body.source_inventory_item_id ?? null}, p.source_inventory_item_id),
            metadata                 = COALESCE(${body.metadata ?? null}, p.metadata),
            featured_photo_id        = CASE
              WHEN ${hasFeatured} THEN ${body.featured_photo_id ?? null}
              ELSE p.featured_photo_id
            END
          FROM plant_projects pp
          WHERE p.id = ${plantId}
            AND p.project_id = pp.id
            AND pp.created_by = ${userId}
            AND p.deleted_at IS NULL
          RETURNING p.*
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, rows[0]);
      }

      if (method === 'DELETE') {
        await sql`
          UPDATE plants p
          SET deleted_at = NOW()
          FROM plant_projects pp
          WHERE p.id = ${plantId}
            AND p.project_id = pp.id
            AND pp.created_by = ${userId}
            AND p.deleted_at IS NULL
        `;
        return resp(200, { ok: true });
      }

      return resp(405, { error: 'Method not allowed' });
    }

    if (method === 'GET') {
      const projectId = event.queryStringParameters?.project_id ?? null;
      const rows = projectId
        ? await sql`
            SELECT p.id, p.name, p.genus, p.species, p.variety, p.quantity,
                   p.status, p.notes, p.project_id,
                   p.variety_id, p.source_inventory_item_id, p.metadata,
                   p.created_at,
                   pp.name AS project_name,
                   CASE WHEN pv.id IS NOT NULL THEN
                     jsonb_build_object(
                       'id', pv.id, 'name', pv.name, 'species', pv.species, 'genus', pv.genus,
                       'days_to_maturity_min', pv.days_to_maturity_min,
                       'days_to_maturity_max', pv.days_to_maturity_max,
                       'care_notes', pv.care_notes, 'soil_notes', pv.soil_notes,
                       'sun_requirements', pv.sun_requirements,
                       'common_diseases', pv.common_diseases,
                       'expected_yield_notes', pv.expected_yield_notes,
                       'photo_id', pv.photo_id, 'source_url', pv.source_url
                     )
                   ELSE NULL END AS variety_ref
            FROM plants p
            JOIN plant_projects pp ON pp.id = p.project_id
            LEFT JOIN plant_varieties pv ON pv.id = p.variety_id AND pv.deleted_at IS NULL
            WHERE pp.created_by = ${userId}
              AND p.project_id = ${projectId}
              AND p.deleted_at IS NULL
            ORDER BY p.created_at DESC
          `
        : await sql`
            SELECT p.id, p.name, p.genus, p.species, p.variety, p.quantity,
                   p.status, p.notes, p.project_id,
                   p.variety_id, p.source_inventory_item_id, p.metadata,
                   p.created_at,
                   pp.name AS project_name,
                   CASE WHEN pv.id IS NOT NULL THEN
                     jsonb_build_object(
                       'id', pv.id, 'name', pv.name, 'species', pv.species, 'genus', pv.genus,
                       'days_to_maturity_min', pv.days_to_maturity_min,
                       'days_to_maturity_max', pv.days_to_maturity_max,
                       'care_notes', pv.care_notes, 'soil_notes', pv.soil_notes,
                       'sun_requirements', pv.sun_requirements,
                       'common_diseases', pv.common_diseases,
                       'expected_yield_notes', pv.expected_yield_notes,
                       'photo_id', pv.photo_id, 'source_url', pv.source_url
                     )
                   ELSE NULL END AS variety_ref
            FROM plants p
            JOIN plant_projects pp ON pp.id = p.project_id
            LEFT JOIN plant_varieties pv ON pv.id = p.variety_id AND pv.deleted_at IS NULL
            WHERE pp.created_by = ${userId}
              AND p.deleted_at IS NULL
            ORDER BY p.created_at DESC
          `;
      return resp(200, rows);
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      if (!body.name) return resp(400, { error: 'name is required' });
      if (!body.project_id) return resp(400, { error: 'project_id is required' });
      const qty = parseInt(body.quantity, 10);
      const rows = await sql`
        INSERT INTO plants
          (project_id, name, genus, species, variety, quantity, status, notes, created_by,
           variety_id, source_inventory_item_id, metadata)
        VALUES (
          ${body.project_id},
          ${body.name},
          ${body.genus ?? null},
          ${body.species ?? null},
          ${body.variety ?? null},
          ${isNaN(qty) || qty < 1 ? 1 : qty},
          ${body.status ?? null},
          ${body.notes ?? null},
          ${userId},
          ${body.variety_id ?? null},
          ${body.source_inventory_item_id ?? null},
          ${body.metadata ?? null}
        )
        RETURNING *
      `;
      return resp(201, rows[0]);
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('plants lambda error', err);
    if (err.code === '23503') return resp(400, { error: `Foreign key violation: ${err.constraint ?? err.message}` });
    if (err.code === '23514') return resp(400, { error: `Constraint violation: ${err.constraint ?? err.message}` });
    return resp(500, { error: 'Internal server error' });
  }
};
