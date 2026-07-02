import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { householdScope } from './household.js';
import { resolvePhotoViewUrl } from './photo-access.js';

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

let _secrets = null, _secretsAt = 0;
const SECRETS_TTL_MS = 5 * 60 * 1000; // V3-PHOTODBG-001: refetch after 5min so a rotated secret doesn't strand a warm Lambda
async function getSecrets() {
  if (_secrets && (Date.now() - _secretsAt) < SECRETS_TTL_MS) return _secrets;
  const cmd = new GetSecretValueCommand({ SecretId: process.env.SECRET_NAME ?? 'garden-app/secrets' });
  const res = await sm.send(cmd);
  _secrets = JSON.parse(res.SecretString);
  _secretsAt = Date.now();
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

// V3-PHOTODBG-001: classify transient upstream failures (DB / Secrets Manager / network unreachable) so the
// client receives a retryable 503 with a proper JSON+CORS envelope rather than a generic 500 — or worse, a
// raw CORS-less 502 from an unhandled throw that the frontend can't even read.
function isUpstream(err) {
  const m = `${err?.code ?? ''} ${err?.name ?? ''} ${err?.message ?? ''}`.toLowerCase();
  return /econn|etimedout|enotfound|getaddrinfo|fetch failed|socket hang up|timeout|throttl|serviceunavailable|connection terminated/.test(m);
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

  let secrets;
  try {
    secrets = await getSecrets();
  } catch (err) {
    console.error('getSecrets failed', err?.message ?? err);
    return resp(503, { error: 'Service temporarily unavailable' });
  }

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
  // HOUSEHOLD-MODE: widened at V3-ROLES teardown (photos scope SWITCHED uploaded_by -> created_by)
  const householdIds = householdScope(userId);
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
          AND created_by = ANY(${householdIds})
      `;
      if (!rows.length) return resp(404, { error: 'Not found' });
      const viewUrl = await resolvePhotoViewUrl(rows[0].storage_path, { presign: getViewUrl, sm });
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
              pp.display_name AS project_name
            FROM photos p
            LEFT JOIN public.container pp ON pp.id = p.project_id
            WHERE p.created_by = ANY(${householdIds})
              AND p.project_id = ${projectId}
            ORDER BY p.created_at DESC
            LIMIT ${limit}
          `
        : await sql`
            SELECT
              p.id, p.project_id, p.event_id, p.location_id, p.plant_id,
              p.storage_path, p.caption, p.is_public, p.created_at,
              pp.display_name AS project_name
            FROM photos p
            LEFT JOIN public.container pp ON pp.id = p.project_id
            WHERE p.created_by = ANY(${householdIds})
            ORDER BY p.created_at DESC
            LIMIT ${limit}
          `;

      // Attach pre-signed view URLs to each photo record
      const withUrls = await Promise.all(
        rows.map(async (photo) => {
          try {
            const view_url = await resolvePhotoViewUrl(photo.storage_path, { presign: getViewUrl, sm });
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
            UPDATE public.container
               SET featured_photo_id = ${inserted.id}
             WHERE id = ${inserted.project_id}
               AND created_by = ANY(${householdIds})
               AND featured_photo_id IS NULL
               AND deleted_at IS NULL
          `;
        }
        if (inserted.plant_id) {
          await sql`
            UPDATE public.garden_node p
               SET featured_photo_id = ${inserted.id}
              FROM public.container pp
             WHERE p.id = ${inserted.plant_id}
               AND p.container_id = pp.id
               AND pp.created_by = ANY(${householdIds})
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
               AND created_by = ANY(${householdIds})
               AND featured_photo_id IS NULL
               AND deleted_at IS NULL
          `;
        }
      } catch (promoteErr) {
        console.error('auto-promote non-fatal failure', promoteErr?.message ?? promoteErr);
      }

      // DRG-ENGINE-003 V1.1 — auto-capture on photo log (Dave 2026-06-21): a photo logged against a
      // planting is first-party observational evidence. Resolve the canonical entity_id (entity registry,
      // DRG-ENGINE-002) and append ONE evidence row mirroring the evidence-ingest contract. Canonical
      // source = lambda/evidence-ingest/{index,validate}.js (per-dir Lambda zips cannot import it, so the
      // enum literals are duplicated here — keep in sync). Best-effort + non-fatal (same posture as the
      // auto-promote block above): the photo is already persisted; an evidence-write failure must never
      // 500 the upload. Household-scoped (entity's container.created_by) + append-only (Soft-Delete-Only).
      if (inserted.plant_id) {
        try {
          const entRows = await sql`
            SELECT ent.id AS entity_id
              FROM public.entity ent
              JOIN public.garden_node p ON p.id = ent.planting_ref_id AND p.deleted_at IS NULL
              JOIN public.container pp  ON pp.id = p.container_id AND pp.deleted_at IS NULL
             WHERE ent.entity_type = 'planting'
               AND ent.planting_ref_id = ${inserted.plant_id}
               AND ent.deleted_at IS NULL
               AND pp.created_by = ANY(${householdIds})
             LIMIT 1
          `;
          if (entRows.length > 0) {
            // V2 evidence schema requires the generalized NOT-NULL columns (evidence_class,
            // entity_type, claim_scope, evidence_kind, claim, source_tier, trust_rank,
            // strength_weight, captured_at, provenance). The old V1-shaped INSERT omitted them,
            // so this "non-fatal" capture silently failed on EVERY plant photo (evidence_class
            // NOT NULL) -> DrG got zero photo evidence. Mirror lambda/evidence-ingest/validate.js:
            // first_party_log -> source_tier 'first_party_obs', trust_rank 4, strength_weight 0.700.
            await sql`
              INSERT INTO public.evidence
                (entity_id, schema_version, tier, axis, polarity, finding_type, observed_at, note, photo_ref, source, created_by,
                 evidence_class, entity_type, garden_node_id, claim_scope, evidence_kind, claim,
                 source_tier, trust_rank, strength_weight, captured_at, provenance)
              VALUES
                (${entRows[0].entity_id}::uuid, 2, 'first_party_log', 'local', 'supporting',
                 NULL, NOW(), ${inserted.caption ?? null}, ${inserted.id}, 'photo_log', ${userId},
                 'observation', 'organism', ${inserted.plant_id}::uuid, 'planting', 'photo',
                 ${inserted.caption ?? 'Photo observation'}, 'first_party_obs', 4, 0.700, NOW(), 'user')
            `;
          }
        } catch (evErr) {
          console.error('evidence auto-capture non-fatal failure', evErr?.message ?? evErr);
        }
      }

      return resp(201, inserted);
    }

    // PUT|PATCH /api/photos/:id — re-tag an existing photo: update project / location /
    // plant linkage + caption. Owner-scoped (only the uploader can re-tag). Backs the
    // Photo Library tag modal. The ABSENCE of this route was bug I1 — a re-tag PUT fell
    // through to the 405 below and the raw "Method not allowed" string surfaced in the
    // modal. Full-replace semantics (not partial-merge): the tag modal submits the full
    // {project_id, location_id, plant_id, caption} set every save, so a missing field
    // means "cleared", not "unchanged".
    // Does NOT re-run featured-photo auto-promote: auto-promote is a first-upload
    // behavior (POST); a re-tag is a correction, not a new deposit. (V1.2a-3 Increment A
    // scope decision — revisit if re-tag-to-unfeatured-parent UX is wanted later.)
    const idMatch = rawPath.match(/^\/api\/photos\/([^/]+)$/);
    if (idMatch && (method === 'PUT' || method === 'PATCH')) {
      const photoId = idMatch[1];
      const body = JSON.parse(event.body ?? '{}');
      const updatedRows = await sql`
        UPDATE photos
           SET project_id  = ${body.project_id ?? null},
               location_id = ${body.location_id ?? null},
               plant_id    = ${body.plant_id ?? null},
               caption     = ${body.caption ?? null}
         WHERE id = ${photoId}
           AND created_by = ANY(${householdIds})
        RETURNING *
      `;
      if (!updatedRows.length) return resp(404, { error: 'Photo not found' });
      return resp(200, updatedRows[0]);
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('photos lambda error', err);
    return isUpstream(err)
      ? resp(503, { error: 'Service temporarily unavailable' })
      : resp(500, { error: 'Internal server error' });
  }
};
