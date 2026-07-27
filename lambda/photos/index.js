import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { householdScope } from './household.js';
import { resolvePhotoViewUrl } from './photo-access.js';
import { isAllowedUploadKey } from './uploadKeyPolicy.js';

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

// V4-PHOTOBULK-001 batch-presign limits/validators. These guard values that become an S3 KEY or a
// signed ContentType, so they are allowlists, not sanitizers — anything not matching is rejected.
const MAX_BATCH = 20;
// Mirrors the photos_intake_status_valid CHECK. Only these two are stored; every other state in
// the design (tagged / skipped) is DERIVED, so a third value here would be a bug, not a feature.
const INTAKE_STATUSES = ['pending_tag', 'upload_failed'];
const SAFE_KEY_SEGMENT = /^[A-Za-z0-9._-]+$/;  // Clerk subs look like user_3D2gM0hIl03gjW3JM2DjtPzm0jI
const SAFE_EXT = /^[a-z0-9]{1,8}$/;
const SAFE_CONTENT_TYPE = /^image\/[a-zA-Z0-9.+-]{1,32}$/;

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

// Featured-photo auto-promote: parent-by-parent, only if the photo has the linkage AND the
// parent's featured_photo_id IS NULL AND the caller owns the parent. Each UPDATE is a separate
// atomic statement; the WHERE clauses guard race conditions (only the first to commit wins).
// Best-effort + NON-FATAL by contract: the photo row is already persisted before this runs, so a
// promote failure must never fail the request.
//
// Called from TWO paths, which are not the same event:
//   POST            — first upload of a photo that already carries its parent.
//   PUT/PATCH       — ONLY when the row was previously intake_status='pending_tag'. A bulk-uploaded
//                     photo's POST had no parent, so the TAG is its first deposit; without this the
//                     plant silently stays photo-less. A re-tag of an already-tagged photo is still
//                     a correction, not a deposit, and still does NOT promote.
async function autoPromoteFeatured(sql, photo, householdIds) {
  try {
    if (photo.project_id) {
      await sql`
        UPDATE public.container
           SET featured_photo_id = ${photo.id}
         WHERE id = ${photo.project_id}
           AND created_by = ANY(${householdIds})
           AND featured_photo_id IS NULL
           AND deleted_at IS NULL
      `;
    }
    if (photo.plant_id) {
      await sql`
        UPDATE public.garden_node p
           SET featured_photo_id = ${photo.id}
          FROM public.container pp
         WHERE p.id = ${photo.plant_id}
           AND p.container_id = pp.id
           AND pp.created_by = ANY(${householdIds})
           AND p.featured_photo_id IS NULL
           AND p.deleted_at IS NULL
      `;
    }
    if (photo.location_id) {
      await sql`
        UPDATE locations
           SET featured_photo_id = ${photo.id}
         WHERE id = ${photo.location_id}
           AND featured_photo_id IS NULL
           AND deleted_at IS NULL
      `;
    }
    if (photo.inventory_item_id) {
      await sql`
        UPDATE inventory_items
           SET featured_photo_id = ${photo.id}
         WHERE id = ${photo.inventory_item_id}
           AND created_by = ANY(${householdIds})
           AND featured_photo_id IS NULL
           AND deleted_at IS NULL
      `;
    }
  } catch (promoteErr) {
    console.error('auto-promote non-fatal failure', promoteErr?.message ?? promoteErr);
  }
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
    // Query params: key (caller-generated via src/lib/photoKeys.js), content_type (MIME type)
    // SECURITY (A0.1) — the caller names the key, so the key is confined to the closed
    // buildPhotoKey grammar (uploadKeyPolicy.js) and the signed ContentType to image/*.
    // Anything else — inbox/* (server-derived only, per the batch route), traversal, absolute
    // keys, foreign prefixes, non-image types — 403s before any presign happens.
    if (rawPath === '/api/photos/upload-url' && method === 'GET') {
      const key = event.queryStringParameters?.key;
      const contentType = event.queryStringParameters?.content_type ?? 'image/jpeg';
      if (!key) return resp(400, { error: 'key is required' });
      if (!isAllowedUploadKey(key) || !SAFE_CONTENT_TYPE.test(contentType)) {
        return resp(403, { error: 'Forbidden' });
      }
      const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType });
      const upload_url = await getSignedUrl(s3, cmd, { expiresIn: 300 });
      return resp(200, { upload_url, key });
    }

    // GET /api/photos/thumb-upload-url — presign the PUT for a new photo's 800px thumbnail.
    //
    // WHY THIS EXISTS: the read path below derives thumb_url by CONVENTION (thumbs/<storage_path>)
    // and 913 existing photos were backfilled with macOS `sips`, but nothing generated a thumb for
    // a NEW upload — so every photo taken after the backfill fell back to its full-size original.
    // The client makes the thumb (it has the decoded bitmap already) and PUTs it here.
    //
    // SECURITY — this does NOT widen the A0.1 closed grammar. The caller names the ORIGINAL key,
    // which is validated by the very same isAllowedUploadKey it must already pass to upload the
    // photo at all; the `thumbs/` prefix is applied SERVER-SIDE and is not caller-nameable. So the
    // only object this can ever sign is the thumb OF a key the caller is already permitted to
    // write. A caller-supplied `thumbs/...` key still 403s on the route above, unchanged.
    // ContentType is pinned to image/jpeg because the thumb is always JPEG (matching the sips
    // backfill) regardless of the original's type.
    if (rawPath === '/api/photos/thumb-upload-url' && method === 'GET') {
      const key = event.queryStringParameters?.key;
      if (!key) return resp(400, { error: 'key is required' });
      if (!isAllowedUploadKey(key)) return resp(403, { error: 'Forbidden' });
      const cmd = new PutObjectCommand({
        Bucket: BUCKET,
        Key: `thumbs/${key}`,
        ContentType: 'image/jpeg',
      });
      const upload_url = await getSignedUrl(s3, cmd, { expiresIn: 300 });
      return resp(200, { upload_url, key: `thumbs/${key}` });
    }

    // POST /api/photos/batch — V4-PHOTOBULK-001. Presign-ONLY, up to MAX_BATCH at a time.
    // There is deliberately no /confirm: POST /api/photos already IS the confirm, and per-photo
    // confirms give the progress granularity the bulk UX wants. getSignedUrl is a local HMAC (no S3
    // round trip), so signing 20 in one call is nearly free.
    //
    // SECURITY — this route accepts NO caller-supplied key. The key is DERIVED from the
    // authenticated Clerk sub: inbox/{userId}/{uuid}.{ext}. The older GET /api/photos/upload-url
    // above still takes a caller-named key but confines it to the closed legacy grammar (A0.1,
    // uploadKeyPolicy.js); inbox/* remains exclusively server-derived — the legacy route 403s any
    // inbox key. A presigned URL always inherits the SIGNER's identity (this Lambda's role), so an
    // IAM policy scoped to inbox/* is not the control here and would break every other prefix this
    // same role signs — server-side derivation is.
    if (rawPath === '/api/photos/batch' && method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      const files = Array.isArray(body.files) ? body.files : null;
      if (!files || files.length === 0) return resp(400, { error: 'files[] is required' });
      if (files.length > MAX_BATCH) {
        return resp(400, { error: `too many files (max ${MAX_BATCH}, got ${files.length})` });
      }
      // The Clerk sub becomes a path segment — validate rather than trust it.
      if (!SAFE_KEY_SEGMENT.test(userId)) return resp(400, { error: 'invalid user identifier' });

      const uploads = [];
      for (const f of files) {
        const ext = String(f?.ext ?? 'jpg').toLowerCase();
        if (!SAFE_EXT.test(ext)) return resp(400, { error: `invalid ext: ${f?.ext}` });
        const contentType = typeof f?.content_type === 'string' && SAFE_CONTENT_TYPE.test(f.content_type)
          ? f.content_type
          : 'image/jpeg';
        const key = `inbox/${userId}/${randomUUID()}.${ext}`;
        const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType });
        uploads.push({
          key,
          upload_url: await getSignedUrl(s3, cmd, { expiresIn: 900 }),
          content_type: contentType,
        });
      }
      return resp(200, { uploads, expires_in: 900 });
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
      // V4-PHOTOGALLERY-001: attachment-scoped gallery. ?attachedTo=<plantingId> returns every photo
      // ATTACHED to that planting by ANY source — directly via photos.plant_id, OR through one of its
      // events (photos.event_id -> event_log.plant_id). This is the canonical gallery membership rule
      // (Dave 2026-07-09): project_id/location_id are NOT attachment sources, so the union is scoped to
      // the PLANTING, not its container — a plant_id-attached photo living in a parent/sibling container
      // still appears (fixes the project-scoped ?project_id fetch that hid such photos). Distinct from
      // ?project_id (container gallery) — this does NOT overload it.
      const attachedTo = event.queryStringParameters?.attachedTo ?? null;
      // Restored to 120 now that the grid takes ~200KB thumbs instead of full originals:
      // 120 thumbs is ~24MB where 120 originals was ~369MB (both measured 2026-07-27). The
      // interim 30 was a stopgap that traded a blank tab for a hard cut with no pagination.
      const limit = Math.min(parseInt(event.queryStringParameters?.limit ?? '120', 10), 200);

      let rows;
      if (attachedTo) {
        rows = await sql`
            SELECT
              p.id, p.project_id, p.event_id, p.location_id, p.plant_id,
              p.storage_path, p.caption, p.is_public, p.created_at,
              pp.display_name AS project_name
            FROM photos p
            LEFT JOIN public.container pp ON pp.id = p.project_id
            WHERE p.created_by = ANY(${householdIds})
              AND p.deleted_at IS NULL
              AND (
                p.plant_id = ${attachedTo}
                OR p.event_id IN (
                  SELECT e.id FROM public.event_log e
                  WHERE e.plant_id = ${attachedTo} AND e.deleted_at IS NULL
                )
              )
            ORDER BY p.created_at DESC
            LIMIT ${limit}
          `;
      } else if (projectId) {
        rows = await sql`
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
          `;
      } else {
        rows = await sql`
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
      }

      // Attach pre-signed view URLs to each photo record.
      //
      // BUG-PHOTOBLANK-001 — thumb_url. The grid was serving 4080x3072 ORIGINALS: 30 of them is
      // ~90MB, and because concurrent downloads progress in lockstep nothing rendered for minutes
      // and then everything appeared at once. Thumbnails are ~200KB (11-23x smaller, measured).
      //
      // The thumb key is SERVER-DERIVED (thumbs/<storage_path>), never caller-supplied — that
      // deliberately avoids widening the A0.1 closed upload-key grammar above. Backfilled for all
      // 913 existing photos; a photo uploaded before its thumb exists simply presigns to a missing
      // object, so the client treats thumb_url as a HINT and falls back to view_url on error.
      const withUrls = await Promise.all(
        rows.map(async (photo) => {
          let view_url = null, thumb_url = null;
          try {
            view_url = await resolvePhotoViewUrl(photo.storage_path, { presign: getViewUrl, sm });
          } catch { /* view_url stays null — same as pre-existing behavior */ }
          try {
            thumb_url = photo.storage_path
              ? await resolvePhotoViewUrl(`thumbs/${photo.storage_path}`, { presign: getViewUrl, sm })
              : null;
          } catch { /* non-fatal: the client falls back to view_url */ }
          return { ...photo, view_url, thumb_url };
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

      // intake_status reaches a CHECK-constrained column, so validate it here rather than letting
      // Postgres reject it — a 23514 falls through isUpstream() to an opaque 500 the client cannot
      // act on. Mirrors photos_intake_status_valid.
      if (body.intake_status != null && !INTAKE_STATUSES.includes(body.intake_status)) {
        return resp(400, { error: `intake_status must be one of: ${INTAKE_STATUSES.join(', ')}` });
      }
      // photos_must_have_parent admits a parentless row ONLY for 'pending_tag'. An 'upload_failed'
      // row with no parent is therefore a guaranteed constraint violation; 400 it explicitly.
      if (body.intake_status === 'upload_failed'
          && !(body.project_id || body.event_id || body.location_id || body.plant_id || body.inventory_item_id)) {
        return resp(400, { error: "intake_status 'upload_failed' requires a parent" });
      }

      // neon serverless driver: tagged-template calls are auto-committed individually.
      // For atomicity, wrap in sql.transaction([...]) — multiple tagged templates
      // run in one BEGIN/COMMIT and roll back together on failure.
      // V4-PHOTOBULK-001 — the capture-metadata columns are additive: every existing caller sends
      // none of them, so they all bind NULL and behavior is byte-identical to before.
      //
      // ON CONFLICT targets idx_photos_content_hash_uniq, the PARTIAL unique index
      // (created_by, content_hash) WHERE content_hash IS NOT NULL AND deleted_at IS NULL — so the
      // predicate must be restated here for Postgres to match that index. Re-uploading the same
      // bytes is expected in bulk intake (re-picking a photo, a retried batch); today that raises a
      // 23505 which falls through isUpstream() to an opaque 500.
      // DO UPDATE, never DO NOTHING: DO NOTHING returns ZERO rows, so insertedRows[0] is undefined
      // and the very next line TypeErrors into the same 500 it was meant to fix.
      // (xmax = 0) distinguishes a real insert from a conflict-update in the same round trip.
      const insertQuery = sql`
        INSERT INTO photos
          (project_id, event_id, location_id, plant_id, inventory_item_id,
           storage_path, caption, is_public, uploaded_by, created_by,
           taken_at, content_hash, file_size_bytes, mime_type, original_filename,
           gps_lat, gps_lon, intake_status)
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
          ${userId},
          ${body.taken_at ?? null},
          ${body.content_hash ?? null},
          ${body.file_size_bytes ?? null},
          ${body.mime_type ?? null},
          ${body.original_filename ?? null},
          ${body.gps_lat ?? null},
          ${body.gps_lon ?? null},
          ${body.intake_status ?? null}
        )
        ON CONFLICT (created_by, content_hash)
          WHERE content_hash IS NOT NULL AND deleted_at IS NULL
          DO UPDATE SET updated_at = now()
        RETURNING *, (xmax = 0) AS was_inserted
      `;

      const insertedRows = await insertQuery;
      const { was_inserted: wasInserted, ...inserted } = insertedRows[0];

      // A duplicate is NOT a new deposit. Return the existing row and stop here — BEFORE
      // auto-promote and BEFORE the evidence-capture block below, or a re-upload appends a second
      // first-party evidence row for the same photo and inflates DrG's confidence off one observation.
      if (wasInserted === false) {
        return resp(200, { ...inserted, duplicate: true });
      }

      await autoPromoteFeatured(sql, inserted, householdIds);

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
    // V4-PHOTOBULK-001 — this route is ALSO the bulk-intake tag path (the quick-tag carousel), not
    // just the Photo Library tag modal. Two behaviors are conditional on the row's PRIOR
    // intake_status, captured via a CTE snapshot (the CTE sees the pre-UPDATE row; RETURNING sees
    // the post-UPDATE row):
    //
    //   1. DRAIN THE INBOX. Tagging clears intake_status, returning the row to the strict
    //      "must have a parent" invariant. Without this, idx_photos_intake_pending keeps matching
    //      and the carousel re-serves photos you already tagged — the inbox can never drain.
    //      CRITICAL: clear it ONLY when a parent is actually being set. This route has full-replace
    //      semantics, so a PUT with all-null parents means "cleared" — and blindly nulling
    //      intake_status on such a row makes it parentless AND non-pending, which the
    //      photos_must_have_parent CHECK rejects (a 500 on a legitimate un-tag). A pending_tag row
    //      that is un-tagged must STAY pending_tag.
    //   2. AUTO-PROMOTE, but only if the row WAS 'pending_tag' — see autoPromoteFeatured. A re-tag
    //      of an already-tagged photo remains a correction and still does not promote, preserving
    //      the original V1.2a-3 Increment A semantics exactly for every legacy row.
    const idMatch = rawPath.match(/^\/api\/photos\/([^/]+)$/);
    if (idMatch && (method === 'PUT' || method === 'PATCH')) {
      const photoId = idMatch[1];
      const body = JSON.parse(event.body ?? '{}');
      // Only the parents this route can actually set. event_id / inventory_item_id are untouched
      // here, so a legacy row parented by one of those keeps satisfying the CHECK on its own.
      // `||` not `??`: an empty-string id must read as "no parent", not as a present value.
      const setsParent = Boolean(body.project_id || body.location_id || body.plant_id);
      const updatedRows = await sql`
        WITH prev AS (
          SELECT id, intake_status
            FROM photos
           WHERE id = ${photoId}
             AND created_by = ANY(${householdIds})
        )
        UPDATE photos p
           SET project_id    = ${body.project_id ?? null},
               location_id   = ${body.location_id ?? null},
               plant_id      = ${body.plant_id ?? null},
               caption       = ${body.caption ?? null},
               intake_status = CASE WHEN ${setsParent}::boolean THEN NULL ELSE p.intake_status END
          FROM prev
         WHERE p.id = prev.id
        RETURNING p.*, prev.intake_status AS prev_intake_status
      `;
      if (!updatedRows.length) return resp(404, { error: 'Photo not found' });
      const { prev_intake_status: prevIntakeStatus, ...updated } = updatedRows[0];
      if (prevIntakeStatus === 'pending_tag') {
        await autoPromoteFeatured(sql, updated, householdIds);
      }
      return resp(200, updated);
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('photos lambda error', err);
    return isUpstream(err)
      ? resp(503, { error: 'Service temporarily unavailable' })
      : resp(500, { error: 'Internal server error' });
  }
};
