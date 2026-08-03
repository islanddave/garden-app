import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { householdScope, loadOwnedSpace, warnRejectedFk } from './household.js';
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
// BUG-PHOTOUPLOADRELAY-001 caps. Lambda URLs cap request payloads at 6MB and base64 inflates 4/3:
// these keep base64 + JSON envelope safely under it. A downscaled photo runs ~300-600KB decoded.
const RELAY_MAX_B64_CHARS = 5_200_000;      // ≈3.9MB decoded
const RELAY_THUMB_MAX_B64_CHARS = 700_000;  // ≈525KB decoded; thumbs run 80-260KB
const SAFE_EXT = /^[a-z0-9]{1,8}$/;
const SAFE_CONTENT_TYPE = /^image\/[a-zA-Z0-9.+-]{1,32}$/;
// V4-SPACEPHOTO-001: space/photo ids reach uuid-typed columns. An unparseable value raises 22P02,
// which isUpstream() does not classify — it would surface as an opaque 500 on what is really a bad
// request. Shape-check first so every rejection is a 400 with the same generic body.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
//
// V4-SPACEPHOTO-001 adds a FIFTH arm (spaces), gated on opts.spaceEnabled. The gate is a prod-safety
// control, not a feature toggle: prod has no spaces.featured_photo_id column, so an ungated arm would
// 42703 straight into the swallowed catch below and nothing would ever be visibly wrong — the space
// would just silently never get a hero. `opts` is optional so existing 3-arg call sites are unchanged.
async function autoPromoteFeatured(sql, photo, householdIds, opts) {
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
      // BUG-PHOTOLOCAUTHZ-001: ownership predicate added to match the 3 sibling arms. Was the
      // only arm without it — any authenticated user POSTing a photo with another household's
      // location_id could set that location's featured photo. No backfill gate: locations has
      // 0 NULL created_by across all 29 live rows (W0.2-r1 locations-census).
      await sql`
        UPDATE locations
           SET featured_photo_id = ${photo.id}
         WHERE id = ${photo.location_id}
           AND created_by = ANY(${householdIds})
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
    // V4-SPACEPHOTO-001. Mirrors the inventory_items arm, MINUS the deleted_at predicate: `spaces`
    // has no deleted_at column (verified live). Asserting one would 42703 into the catch below, so
    // a space photo would silently never auto-feature — the exact failure this arm exists to avoid.
    if (opts?.spaceEnabled && photo.space_id) {
      await sql`
        UPDATE spaces
           SET featured_photo_id = ${photo.id}
         WHERE id = ${photo.space_id}
           AND created_by = ANY(${householdIds})
           AND featured_photo_id IS NULL
      `;
    }
  } catch (promoteErr) {
    console.error('auto-promote non-fatal failure', promoteErr?.message ?? promoteErr);
  }
}

// V4-SPACEPHOTO-001 — the photos upsert exists in TWO literal variants and that duplication is a
// deliberate prod-safety control, not an oversight. A neon tagged template's SQL text is STATIC: a
// JS `if` inside one template cannot keep `space_id` out of the emitted statement. When this code
// promoted, prod had no photos.space_id column, so a single widened template would have 42703'd
// EVERY upload the moment it landed — regardless of the flag. The flag-OFF branch below is
// byte-identical to the pre-V4 statement; the widened branch is only ever constructed when
// SPACE_PHOTOS_ENABLED=true.
// STATUS 2026-08-01: the columns ARE now in prod (migrations/v4-spacephoto-001 applied), so this
// split no longer guards against a live 42703. KEEP IT ANYWAY: it is what makes flag-OFF a true
// byte-identical rollback lever, and it is the pattern any FUTURE additive space column must reuse
// (code may promote ahead of its DDL again). Do not collapse the two templates into one.
//
// ADD-PARENT on conflict (widened branch only): the dedupe returns the EXISTING row, which today
// silently drops the parent the caller asked for. A "grand photo" is by definition an image already
// attached to a planting, so a plain INSERT would never attach it to the space. COALESCE keeps an
// existing space_id (re-attaching elsewhere is a re-tag, not an upload) and fills a NULL one.
function buildPhotoInsert(sql, body, userId, spaceEnabled) {
  if (spaceEnabled) {
    return sql`
      INSERT INTO photos
        (project_id, event_id, location_id, plant_id, inventory_item_id, space_id,
         storage_path, caption, is_public, uploaded_by, created_by,
         taken_at, content_hash, file_size_bytes, mime_type, original_filename,
         gps_lat, gps_lon, intake_status)
      VALUES (
        ${body.project_id ?? null},
        ${body.event_id ?? null},
        ${body.location_id ?? null},
        ${body.plant_id ?? null},
        ${body.inventory_item_id ?? null},
        ${body.space_id ?? null},
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
        DO UPDATE SET updated_at = now(),
                      space_id = COALESCE(photos.space_id, EXCLUDED.space_id)
      RETURNING *, (xmax = 0) AS was_inserted
    `;
  }
  return sql`
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
}

// ── V4-SPACEPHOTO-001 space-hero reads ────────────────────────────────────────────────────────────
// Both helpers below take `spaceEnabled` and return EARLY when it is false. That is the same
// prod-safety property buildPhotoInsert's two-template split buys, obtained the cheaper way: a neon
// tagged template's SQL text comes into existence only when the tagged expression is EVALUATED, so a
// function that returns before its template is never a statement at all. At promote time prod had
// neither photos.space_id nor spaces.featured_photo_id, so with the flag off nothing here could
// 42703. (Both columns landed in prod 2026-07-31; the early return is retained as the rollback
// lever and as the pattern for the next code-ahead-of-DDL column.)
// The guard lives INSIDE the helpers (rather than only at the two call sites) so that a future
// caller cannot reintroduce the hazard by forgetting the outer `if`.

// Resolve the caller's OWN household space with no id supplied — the discovery path. Without this
// every space route needs a :spaceId the client has no way to obtain: there is no /api/spaces, and
// no shipped read shape leaks workspace_id.
//
// OWNERSHIP RULE = spaces.created_by, deliberately the SAME predicate loadOwnedSpace() and every
// other space route uses. The tempting alternative — walking the de-facto garden_node.workspace_id
// -> spaces.id link (verified live: every garden_node/container row carries the single space's id,
// but there is NO declared FK either way) — describes ASSOCIATION, not ownership, and would hand the
// client a space that the very next PUT /space-featured then 400s as unowned. One resolution rule,
// one authz predicate, no route can disagree with another.
//
// MULTI-SPACE: deterministic oldest-first, never an error. created_at never changes, so the pick is
// stable across calls; id breaks a same-instant tie. Erroring on >1 would take a household's hero
// down the moment it gained a second space — a regression triggered by unrelated data. COUNT(*)
// OVER () is evaluated before LIMIT, so one round trip yields both the pick and the true total, and
// the total is returned to the caller so the day the one-space assumption breaks is VISIBLE instead
// of silently arbitrary.
async function resolveHouseholdSpace(sql, householdIds, spaceEnabled) {
  if (!spaceEnabled) return [];
  return sql`
    SELECT id, COUNT(*) OVER () AS household_space_count
      FROM spaces
     WHERE created_by = ANY(${householdIds})
     ORDER BY created_at ASC, id ASC
     LIMIT 1
  `;
}

// The space-hero read itself, shared verbatim by the /:spaceId form and the no-id form so the two
// can never drift.
//
// SOFT-DELETE FALLBACK (the reason this is not a one-line lookup): photos are soft-deleted, and
// spaces.featured_photo_id -> photos(id) is ON DELETE SET NULL, which only fires on a HARD delete.
// So a soft-deleted hero leaves the FK intact and pointing at a row whose S3 object the gallery no
// longer shows — presigning it yields a dead URL. The stored hero is therefore joined WITH the
// deleted_at filter, and falls back to the space's newest surviving photo.
//
// featured_photo_id is the EFFECTIVE hero, not the raw column, so the id and the url can never
// disagree — but that alone makes the response AMBIGUOUS, and the ambiguity had a real cost: the
// client's set-featured control has an identity no-op guard, so tapping "set as feature photo" on
// the photo that merely HAPPENS to be the fallback matched the returned id, no-oped, and never
// persisted the designation — the hero silently reverted on the next upload.
// featured_is_explicit closes that: TRUE iff the returned id came from spaces.featured_photo_id
// (alive + household-owned), FALSE whenever it came from the fallback or there is no hero at all.
async function fetchSpaceHero(sql, spaceId, householdIds, spaceEnabled) {
  if (!spaceEnabled) return [];
  return sql`
    SELECT s.id AS space_id,
           s.name,
           COALESCE(fp.id, fb.id) AS featured_photo_id,
           (fp.id IS NOT NULL) AS featured_is_explicit,
           COALESCE(fp.storage_path, fb.storage_path) AS hero_storage_path
      FROM spaces s
      LEFT JOIN photos fp
             ON fp.id = s.featured_photo_id
            AND fp.deleted_at IS NULL
            AND fp.created_by = ANY(${householdIds})
            -- MEMBERSHIP (added 2026-08-02 with PUT /api/photos/:id/space, crucible boss ruling).
            -- The hero must still BE a space photo. space-featured has always required this at
            -- WRITE time, but this read did not re-check it, on the reasonable ground that the
            -- write guaranteed it. The attach route breaks that guarantee: it can now clear
            -- space_id out from under an already-designated hero, leaving featured_photo_id
            -- pointing at a photo the ?space_id gallery will never return — a hero the user can
            -- see but cannot find, re-pick, or clear from the page it appears on.
            -- Re-checking here is self-healing: a de-membered hero drops to the fallback arm
            -- instead of rendering stale, and featured_is_explicit correctly reports FALSE.
            -- This is the READ half of one invariant; do not delete it as redundant with the
            -- write check, and do not add it without the write check.
            AND fp.space_id = s.id
      LEFT JOIN LATERAL (
             SELECT p.id, p.storage_path
               FROM photos p
              WHERE p.space_id = s.id
                AND p.deleted_at IS NULL
                AND p.created_by = ANY(${householdIds})
              ORDER BY p.created_at DESC
              LIMIT 1
           ) fb ON true
     WHERE s.id = ${spaceId}
       AND s.created_by = ANY(${householdIds})
  `;
}

// The shape a hero response takes when there is nothing to show. Used for the no-id form ONLY —
// the /:spaceId form still 404s an unknown/foreign space, because there the caller named an id and
// a 200 would confirm nothing either way. With no id there is nothing to probe FOR, so "your
// household has no space" is an empty state, not an error: a 404 here is indistinguishable from a
// broken scope and would force the client to treat a normal condition as a failure.
const EMPTY_SPACE_HERO = {
  space_id: null,
  name: null,
  featured_photo_id: null,
  featured_is_explicit: false,
  featured_photo_view_url: null,
};

export const handler = async (event) => {
  // A-Pending-4 (T1-6, default-in): single method+path route log — makes CloudWatch invocation
  // evidence per-route (3.9/0A.6 dead-surface sheets) instead of per-function. No payloads logged.
  console.log('route', event.requestContext?.http?.method ?? 'GET', event.rawPath ?? '');
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
  // V4-SPACEPHOTO-001 kill-flag, default OFF (absent env == disabled). Read per-invocation, matching
  // the CARE_RAIN_CREDIT_ENABLED / CARE_RAIN_MAXDAYS_ENABLED house pattern in lambda/daily-plan.
  // PROMOTE SAFETY: photos.space_id and spaces.featured_photo_id now exist in BOTH prod and staging
  // (migrations/v4-spacephoto-001 applied to prod 2026-07-31). They did not when this handler
  // promoted, which is why every surface below is gated by SELECTING A DIFFERENT SQL TEMPLATE, never
  // by a runtime `if` inside one template — a tagged template's text is fixed at construction. That
  // invariant STILL HOLDS and must be preserved: it is what makes flag OFF byte-identical to the
  // pre-V4-SPACEPHOTO handler (including the two new routes, which do not exist at all), i.e. a real
  // rollback lever rather than a code path that merely returns early.
  const spacePhotosEnabled = process.env.SPACE_PHOTOS_ENABLED === 'true';

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

    // POST /api/photos/relay-upload — BUG-PHOTOUPLOADRELAY-001. The photo bytes travel THROUGH
    // the Lambda instead of direct-to-S3. Exists because a client's route to S3 can be dead while
    // its route to Lambda stays healthy (observed live 2026-07-28: TCP to s3.us-east-1 blackholed
    // inside the ISP — device- and app-independent — while lambda-url/CloudFront traffic was
    // fine). The client calls this ONLY after the direct presigned PUT failed its stall watchdog.
    //
    // SECURITY — the same closed grammar as upload-url, not a widening: the caller names the
    // ORIGINAL key only (isAllowedUploadKey; a caller-supplied thumbs/… key 403s), ContentType is
    // allowlisted, and decoded sizes are hard-capped (Lambda URLs cap payloads at 6MB; these caps
    // keep base64+JSON under it). The thumb key is derived SERVER-side, mirroring thumb-upload-url.
    if (rawPath === '/api/photos/relay-upload' && method === 'POST') {
      let relayBody;
      try {
        const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '{}');
        relayBody = JSON.parse(raw);
      } catch {
        return resp(400, { error: 'Invalid JSON body' });
      }
      const { key, content_type: relayType = 'image/jpeg', data_b64: dataB64, thumb_b64: thumbB64 = null } = relayBody ?? {};
      if (!key || !dataB64) return resp(400, { error: 'key and data_b64 are required' });
      if (!isAllowedUploadKey(key) || !SAFE_CONTENT_TYPE.test(relayType)) return resp(403, { error: 'Forbidden' });
      if (typeof dataB64 !== 'string' || dataB64.length > RELAY_MAX_B64_CHARS) return resp(413, { error: 'Photo too large to relay' });
      if (thumbB64 != null && (typeof thumbB64 !== 'string' || thumbB64.length > RELAY_THUMB_MAX_B64_CHARS)) return resp(413, { error: 'Thumb too large to relay' });
      let bytes;
      let thumbBytes = null;
      try {
        bytes = Buffer.from(dataB64, 'base64');
        if (thumbB64) thumbBytes = Buffer.from(thumbB64, 'base64');
      } catch {
        return resp(400, { error: 'Invalid base64' });
      }
      if (!bytes.length) return resp(400, { error: 'Empty photo body' });
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: bytes, ContentType: relayType }));
      // Thumb is best-effort, same contract as step 2b: the read path falls back to view_url
      // when thumbs/<key> is absent, so a thumb failure must never fail the relay.
      let thumbStored = false;
      if (thumbBytes && thumbBytes.length) {
        try {
          await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `thumbs/${key}`, Body: thumbBytes, ContentType: 'image/jpeg' }));
          thumbStored = true;
        } catch (thumbErr) {
          console.error('relay thumb PUT non-fatal failure', thumbErr?.message ?? thumbErr);
        }
      }
      return resp(200, { ok: true, key, thumb: thumbStored });
    }

    // GET /api/photos/view-url/:id — returns pre-signed GET URL for a photo record
    const viewMatch = rawPath.match(/^\/api\/photos\/view-url\/([^/]+)$/);
    if (viewMatch && method === 'GET') {
      const photoId = viewMatch[1];
      const rows = await sql`
        SELECT storage_path FROM photos
        WHERE id = ${photoId}
          AND created_by = ANY(${householdIds})
          AND deleted_at IS NULL
      `;
      if (!rows.length) return resp(404, { error: 'Not found' });
      const viewUrl = await resolvePhotoViewUrl(rows[0].storage_path, { presign: getViewUrl, sm });
      return resp(200, { view_url: viewUrl, expires_in: 900 });
    }

    // ── V4-SPACEPHOTO-001 space routes (all inert unless SPACE_PHOTOS_ENABLED=true) ───────────────
    // There is deliberately NO /api/spaces Lambda. A new function would need a Function URL, CORS,
    // a repo variable, entries in three deploy matrices and an Infrastructure-Sync doc update —
    // disproportionate for a ONE-ROW table. The cost is the smell noted on space-hero below.
    // The id-free space-hero form below is what makes that affordable: it is the DISCOVERY path, so
    // the client never needs a spaces list just to learn its own space id.

    // Turns hero rows into the response body: strips the internal storage path and presigns.
    // A presign failure leaves the url null rather than 500ing the hero read.
    const heroBody = async (rows) => {
      if (!rows.length) return null;
      const { hero_storage_path: heroPath, ...hero } = rows[0];
      let featured_photo_view_url = null;
      try {
        featured_photo_view_url = heroPath
          ? await resolvePhotoViewUrl(heroPath, { presign: getViewUrl, sm })
          : null;
      } catch { /* stays null — a presign failure must not 500 the hero read */ }
      return { ...hero, featured_photo_view_url };
    };

    // GET /api/photos/space-hero — the id-free form. THE DISCOVERY FIX: every other space route
    // needs a :spaceId, and before this there was no shipped surface from which a client could
    // obtain one (no /api/spaces; the plants list SELECT omits workspace_id; the daily-plan read
    // model drops it). The frontend's stopgap was a VITE_SPACE_ID build variable that is unset in
    // every environment, i.e. the feature was unreachable even with the flag on.
    //
    // Resolution rule, zero-space and multi-space behaviour: see resolveHouseholdSpace above.
    // The response carries space_id, which is exactly what the client then feeds to
    // ?space_id / space-featured / space-hero/:spaceId — one round trip bootstraps all of them.
    if (spacePhotosEnabled && rawPath === '/api/photos/space-hero' && method === 'GET') {
      const owned = await resolveHouseholdSpace(sql, householdIds, spacePhotosEnabled);
      const household_space_count = owned.length ? Number(owned[0].household_space_count) : 0;
      if (household_space_count > 1) {
        // Not an error, but the one-space assumption this app was built on has just stopped
        // holding — the pick is deterministic, yet arbitrary from the user's point of view.
        console.warn(JSON.stringify({ msg: 'space-hero-multi-space', userId, household_space_count }));
      }
      if (!owned.length) return resp(200, { ...EMPTY_SPACE_HERO, household_space_count });
      const body = await heroBody(await fetchSpaceHero(sql, owned[0].id, householdIds, spacePhotosEnabled));
      return resp(200, { ...(body ?? EMPTY_SPACE_HERO), household_space_count });
    }

    // GET /api/photos/space-hero/:spaceId — the explicit form. Unchanged contract apart from the
    // additive featured_is_explicit field; still 404s an unknown or out-of-household space.
    // SMELL, acknowledged and priced in: this returns spaces.name, which is not photos-domain data.
    // It is here only because standing up a spaces Lambda costs more than the smell. If `spaces`
    // ever grows real CRUD, this route moves.
    const spaceHeroMatch = rawPath.match(/^\/api\/photos\/space-hero\/([^/]+)$/);
    if (spacePhotosEnabled && spaceHeroMatch && method === 'GET') {
      const spaceId = spaceHeroMatch[1];
      if (!UUID_RE.test(spaceId)) return resp(404, { error: 'Not found' });
      const body = await heroBody(await fetchSpaceHero(sql, spaceId, householdIds, spacePhotosEnabled));
      if (!body) return resp(404, { error: 'Not found' });
      return resp(200, body);
    }

    // PUT /api/photos/space-featured/:spaceId — body { photo_id } designates the Space hero;
    // { photo_id: null } clears it. RE-DESIGNATION is the point: unlike autoPromoteFeatured (which
    // only fills a NULL), this is an explicit choice and overwrites whatever is there, so the
    // first-uploaded photo is never permanently locked in.
    //
    // AUTHZ: two independent gates, both anchored on created_by — the space must be household-owned
    // (loadOwnedSpace) AND the photo must already carry space_id = :spaceId and be household-owned.
    // NOT uploaded_by: that is the stale pattern (V-C1); every other featured-photo validator in the
    // repo uses created_by. Every rejection returns the SAME generic 400 — a distinct "not found"
    // would itself be an existence oracle for another household's ids.
    const spaceFeaturedMatch = rawPath.match(/^\/api\/photos\/space-featured\/([^/]+)$/);
    if (spacePhotosEnabled && spaceFeaturedMatch && method === 'PUT') {
      const spaceId = spaceFeaturedMatch[1];
      const body = JSON.parse(event.body ?? '{}');
      const photoId = body.photo_id ?? null;
      const REJECT = { error: 'photo_id must be a photo attached to a space you can use' };

      if (!UUID_RE.test(spaceId)) return resp(400, REJECT);
      if (!await loadOwnedSpace(sql, spaceId, householdIds)) {
        warnRejectedFk(userId, 'spaces', 'id', spaceId);
        return resp(400, REJECT);
      }
      if (photoId != null) {
        if (!UUID_RE.test(String(photoId))) return resp(400, REJECT);
        const linkRows = await sql`
          SELECT 1 FROM photos
           WHERE id = ${photoId}
             AND space_id = ${spaceId}
             AND created_by = ANY(${householdIds})
             AND deleted_at IS NULL
        `;
        if (!linkRows.length) {
          warnRejectedFk(userId, 'spaces', 'featured_photo_id', photoId);
          return resp(400, REJECT);
        }
      }
      const updated = await sql`
        UPDATE spaces
           SET featured_photo_id = ${photoId}, updated_at = now()
         WHERE id = ${spaceId}
           AND created_by = ANY(${householdIds})
        RETURNING id AS space_id, featured_photo_id
      `;
      if (!updated.length) return resp(400, REJECT);
      return resp(200, updated[0]);
    }

    // PUT /api/photos/:id/space — body { space_id: uuid|null } attaches an existing photo to the
    // Space, or detaches it. This is the ATTACH path; designating a hero is space-featured above.
    //
    // WHY A DEDICATED SUB-RESOURCE rather than adding space_id to the general re-tag PUT (crucible
    // 2026-08-02, boss-technical). Three independent reasons, in order of weight:
    //   1. The general PUT's template EXECUTES WITH THE FLAG OFF. Naming space_id in it would break
    //      the byte-identical-rollback invariant this whole feature is architected around (see
    //      buildPhotoInsert's two-template split) and would 42703 in any environment lacking the
    //      column. A flag-gated route cannot execute flag-off, so the hazard cannot arise here.
    //   2. The general PUT replaces a fixed field set: an omitted key means "cleared". space_id
    //      cannot join that rule without silently detaching on every ordinary re-tag from the
    //      shipped client (which never sends it) — and there would then be no way to express
    //      "clear" distinguishably from "didn't mention it". On a single-field route PUT genuinely
    //      IS replace, so the key is REQUIRED: absent is a 400, explicit null is the clear.
    //   3. The general PUT is the last write path in this handler unswept by V4-AUTHZSWEEP-001 (no
    //      ownership loader; its `prev` CTE lacks deleted_at). Building here inherits none of that.
    //
    // Deliberately does NOT call autoPromoteFeatured. Attaching a batch of photos to the property
    // must not silently make the first one the hero — attach and designate are separate acts, which
    // is the entire reason there are two routes. The upload path still auto-promotes (POST, 4-arg,
    // guarded on featured_photo_id IS NULL); that is unchanged.
    //
    // It DOES drain the quick-tag inbox (V4-SPACECLIENTGAP-001, 2026-08-02 — this clause previously
    // read "does NOT touch intake_status", which was a description of the code as first built and
    // never had a justification behind it). Attaching the Space IS filing the photo, so leaving the
    // row at 'pending_tag' would keep idx_photos_intake_pending matching and the carousel would
    // re-serve a photo the user already filed. Narrowly guarded — see `drainsInbox` below: attach
    // only (never detach), and only out of 'pending_tag' (never 'upload_failed').
    //
    // Every rejection returns the SAME generic 400, matching space-featured: a distinct 404 would
    // be an existence oracle for another household's photo ids.
    const photoSpaceMatch = rawPath.match(/^\/api\/photos\/([^/]+)\/space$/);
    if (spacePhotosEnabled && photoSpaceMatch && method === 'PUT') {
      const photoId = photoSpaceMatch[1];
      const body = JSON.parse(event.body ?? '{}');
      const REJECT = { error: 'space_id must be a space you can use, or null' };

      if (!UUID_RE.test(photoId)) return resp(400, REJECT);
      // Key presence, not truthiness: `{space_id: null}` is a meaningful request (detach) and must
      // be distinguishable from an omitted key, which is a malformed one.
      if (!Object.prototype.hasOwnProperty.call(body, 'space_id')) {
        return resp(400, { error: 'space_id is required (send null to detach)' });
      }
      const nextSpaceId = body.space_id ?? null;
      if (nextSpaceId !== null) {
        if (!UUID_RE.test(String(nextSpaceId)) || !await loadOwnedSpace(sql, nextSpaceId, householdIds)) {
          warnRejectedFk(userId, 'photos', 'space_id', nextSpaceId);
          return resp(400, REJECT);
        }
      }

      // Load first rather than UPDATE-and-catch. photos_must_have_parent is 7-clause and counts
      // space_id, so detaching a SPACE-ONLY photo leaves it parentless — a 23514 that isUpstream()
      // does not classify, i.e. an opaque 500 on a legitimate request. Pre-checking turns that into
      // an honest 400. deleted_at IS NULL here is load-bearing: without it a soft-deleted row could
      // be attached and then designated hero.
      const owned = await sql`
        SELECT id, project_id, event_id, location_id, plant_id, inventory_item_id, intake_status
          FROM photos
         WHERE id = ${photoId}
           AND created_by = ANY(${householdIds})
           AND deleted_at IS NULL
      `;
      if (!owned.length) {
        warnRejectedFk(userId, 'photos', 'id', photoId);
        return resp(400, REJECT);
      }
      const p = owned[0];
      const hasOtherParent = Boolean(p.project_id || p.event_id || p.location_id || p.plant_id || p.inventory_item_id);
      if (nextSpaceId === null && !hasOtherParent) {
        return resp(400, { error: 'cannot detach the only parent — attach it elsewhere first' });
      }

      // V4-SPACECLIENTGAP-001 — DRAIN THE INBOX on attach. Same rule the general PUT applies (see
      // its comment block: clear intake_status only when a parent is actually being SET), extended
      // to the parent this route owns. Without it a bulk-uploaded photo whose only tag is the Space
      // keeps intake_status='pending_tag' forever: idx_photos_intake_pending keeps matching, so the
      // quick-tag carousel re-serves a photo the user already filed and the inbox cannot drain.
      //
      // Guarded three ways, deliberately:
      //   - ONLY on attach (nextSpaceId !== null). Detach is the "un-tag" case, and the general PUT
      //     already establishes that an un-tagged pending row must STAY pending — clearing there
      //     would mark a row filed that nobody has filed.
      //   - ONLY from 'pending_tag'. 'upload_failed' is a different state with its own recovery
      //     path (and its own CHECK clause at the POST validator); attaching a space does not mean
      //     the failed upload succeeded.
      //   - Computed in JS from the row we ALREADY read, so no extra round trip and no widening of
      //     any shared template.
      const drainsInbox = nextSpaceId !== null && p.intake_status === 'pending_tag';

      // No cast on the bound value: in an UPDATE assignment the column supplies the type, so a bare
      // null binds cleanly. (A `::uuid` cast inside a CASE expression does NOT — the neon serverless
      // driver cannot type a null parameter there. Same trap, different context.)
      const attached = await sql`
        UPDATE photos
           SET space_id = ${nextSpaceId},
               intake_status = CASE WHEN ${drainsInbox}::boolean THEN NULL ELSE intake_status END
         WHERE id = ${photoId}
           AND created_by = ANY(${householdIds})
           AND deleted_at IS NULL
        RETURNING id, space_id, intake_status
      `;
      if (!attached.length) return resp(400, REJECT);
      return resp(200, attached[0]);
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
      // V4-PHOTOLOCFIND-001: space gallery. ?location_id=<spaceId> returns photos attached to that
      // space OR any descendant space (same recursive parent_id walk as the events By-Space filter,
      // V4-LOGMANYLOC-001 — a leaf resolves to just itself). This is a CONTAINER-style filter like
      // ?project_id, NOT an attachment source for planting galleries — the Dave 2026-07-09 rule
      // behind ?attachedTo is unchanged.
      const locationId = event.queryStringParameters?.location_id ?? null;
      // V4-SPACEPHOTO-001: the SPACE gallery (photos.space_id), which is NOT ?location_id above.
      // ?location_id walks a WITH RECURSIVE loc_subtree — reusing that walk here is the original
      // bug: a Space gallery would also show every descendant LOCATION's photos. This is an EXACT
      // match on the space, nothing else. Parsed only when the flag is on, so with the flag off
      // spaceId is unconditionally null, its branch is unreachable, and an unknown ?space_id param
      // is ignored exactly as it is today.
      const spaceId = spacePhotosEnabled ? (event.queryStringParameters?.space_id ?? null) : null;
      if (spaceId !== null && !UUID_RE.test(spaceId)) return resp(400, { error: 'space_id must be a uuid' });
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
      } else if (locationId) {
        rows = await sql`
            SELECT
              p.id, p.project_id, p.event_id, p.location_id, p.plant_id,
              p.storage_path, p.caption, p.is_public, p.created_at,
              pp.display_name AS project_name
            FROM photos p
            LEFT JOIN public.container pp ON pp.id = p.project_id
            WHERE p.created_by = ANY(${householdIds})
              AND p.deleted_at IS NULL
              AND p.location_id IN (
                WITH RECURSIVE loc_subtree AS (
                  SELECT id FROM locations WHERE id = ${locationId} AND deleted_at IS NULL
                  UNION ALL
                  SELECT l.id FROM locations l
                    JOIN loc_subtree st ON l.parent_id = st.id
                    WHERE l.deleted_at IS NULL
                )
                SELECT id FROM loc_subtree
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
              AND p.deleted_at IS NULL
            ORDER BY p.created_at DESC
            LIMIT ${limit}
          `;
      } else if (spaceId) {
        // EXACT match. The created_by conjunct is load-bearing and must never be dropped as
        // "redundant with the space check": space_id is attachable, so without it an attach to a
        // space the caller can see would expose every OTHER household's photos on that space.
        rows = await sql`
            SELECT
              p.id, p.project_id, p.event_id, p.location_id, p.plant_id, p.space_id,
              p.storage_path, p.caption, p.is_public, p.created_at,
              pp.display_name AS project_name
            FROM photos p
            LEFT JOIN public.container pp ON pp.id = p.project_id
            WHERE p.created_by = ANY(${householdIds})
              AND p.deleted_at IS NULL
              AND p.space_id = ${spaceId}
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
              AND p.deleted_at IS NULL
            ORDER BY p.created_at DESC
            LIMIT ${limit}
          `;
      }

      // V4-SPACEPHOTO-001: decorate the list with space_id when the gate is open.
      //
      // WHY A SEPARATE QUERY rather than adding `p.space_id` to the four SELECTs above. The client's
      // "untagged" filter treats a photo with no parent as unfinished work, and space_id is one of
      // the seven parents the CHECK recognises — but only the ?space_id branch selected the column,
      // so the field was `undefined` on every row the Photos page ever saw and its space conjunct
      // could never fire. Once photos carry a space_id, every one of them renders as "untagged"
      // (the exact V002-E2 defect the filter's own comment claims to have fixed).
      //
      // The obvious fix — add the column to all four templates — costs the byte-identical-rollback
      // invariant: those templates EXECUTE WITH THE GATE CLOSED, so naming space_id in them makes
      // flag-off no longer byte-identical to the pre-V4 handler, reds the template-count tripwire in
      // space-photos.test.js, and inverts an existing flag-off assertion (int:291 asserts the
      // property is ABSENT). Splitting each into a pair fixes that at the price of eight near-
      // identical SELECTs — the drift cost buildPhotoInsert's own header calls out.
      //
      // This gets all three properties at once: the four templates are untouched (so rollback stays
      // byte-identical and every existing assertion stays valid), the ONE template that names
      // space_id is constructed only when the gate is open, and the field appears exactly when the
      // feature is live. Cost is one indexed PK lookup over at most `limit` ids, against a list call
      // that already awaits N presign round trips — noise.
      if (spacePhotosEnabled && rows.length) {
        // deleted_at IS NULL is redundant here (every id came from a query that already filtered it)
        // and is present anyway: the 0A.6 enumeration guard closes the CLASS, so a serving SELECT on
        // photos carries the filter whether or not this particular caller needs it. That is the point
        // of a class-closing guard — it must not require per-site reasoning to stay true.
        const spaceRows = await sql`
          SELECT id, space_id FROM photos
           WHERE id = ANY(${rows.map((r) => r.id)})
             AND deleted_at IS NULL
        `;
        const spaceById = new Map(spaceRows.map((r) => [r.id, r.space_id]));
        rows = rows.map((r) => ({ ...r, space_id: spaceById.get(r.id) ?? null }));
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
      // V4-SPACEPHOTO-001: the CHECK is 7-clause and counts space_id as a parent in BOTH prod and
      // staging (convalidated 2026-07-31). This guard still counts it only when the flag is on, so
      // that flag-off stays byte-identical to the pre-V4 expression — the client cannot send a
      // space_id the server would honour while the gate is closed.
      const spaceParent = spacePhotosEnabled ? (body.space_id ?? null) : null;
      if (body.intake_status === 'upload_failed'
          && !(body.project_id || body.event_id || body.location_id || body.plant_id || body.inventory_item_id || spaceParent)) {
        return resp(400, { error: "intake_status 'upload_failed' requires a parent" });
      }

      // AUTHZ (V4-AUTHZSWEEP-001 class): space_id is a cross-entity FK set straight from the body.
      // The DB FK proves the space EXISTS, not that the caller owns it — an ungated attach both
      // writes a cross-household FK and, via the ?space_id gallery above, turns into a live
      // cross-household READ. Generic 400, no existence oracle.
      if (spacePhotosEnabled && body.space_id != null) {
        if (!UUID_RE.test(String(body.space_id)) || !await loadOwnedSpace(sql, body.space_id, householdIds)) {
          warnRejectedFk(userId, 'photos', 'space_id', body.space_id);
          return resp(400, { error: 'space_id does not match a space you can use' });
        }
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
      //
      // NOT wrapped in sql.transaction with the auto-promote below, and that is deliberate — see
      // buildPhotoInsert. neon's HTTP transaction is NON-INTERACTIVE: every statement must be built
      // before any of them runs, so the promote arms (which need the RETURNING id) could only join
      // the transaction with a client-generated id — and on the ON CONFLICT dedupe path that id is
      // never inserted, so `SET featured_photo_id = <that id>` FK-violates and rolls back the whole
      // upsert, turning today's 200-duplicate into a 500 on exactly the grand-photo flow add-parent
      // exists to serve. It would also invert the documented NON-FATAL promote contract above.
      const insertQuery = buildPhotoInsert(sql, body, userId, spacePhotosEnabled);

      const insertedRows = await insertQuery;
      const { was_inserted: wasInserted, ...inserted } = insertedRows[0];

      // A duplicate is NOT a new deposit. Return the existing row and stop here — BEFORE
      // auto-promote and BEFORE the evidence-capture block below, or a re-upload appends a second
      // first-party evidence row for the same photo and inflates DrG's confidence off one observation.
      if (wasInserted === false) {
        return resp(200, { ...inserted, duplicate: true });
      }

      await autoPromoteFeatured(sql, inserted, householdIds, { spaceEnabled: spacePhotosEnabled });

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
      //
      // V4-SPACECLIENTGAP-001 adds the space tier — via a SEPARATE gated pre-read, NOT by naming
      // space_id in the UPDATE below. That template is NOT flag-gated: it executes flag-off, so a
      // space_id reference in it would 42703 in any environment lacking the column and would break
      // the byte-identical-rollback invariant this feature is built on (the same reasoning that
      // produced buildPhotoInsert's two-template split and the dedicated attach route). The pre-read
      // costs one indexed PK lookup, flag-ON only, on a route that is already doing a write.
      //
      // Why it belongs in setsParent at all: this route has full-replace semantics, so a save from
      // the tag modal with every field cleared is an "un-tag". For a row whose surviving parent is
      // the SPACE, that un-tag still leaves a properly parented photo — so it must drain the inbox
      // exactly like any other parented row. Without this, a space-attached photo re-tagged through
      // the modal silently falls back into the quick-tag carousel. Note space_id is read from the
      // ROW, not the body: this route neither accepts nor SETs space_id, so the persisted value is
      // what the photos_must_have_parent CHECK will see after the UPDATE.
      let spaceParented = false;
      if (spacePhotosEnabled) {
        const spaceRow = await sql`
          SELECT space_id FROM photos
           WHERE id = ${photoId}
             AND created_by = ANY(${householdIds})
             AND deleted_at IS NULL
        `;
        spaceParented = Boolean(spaceRow[0]?.space_id);
      }
      const setsParent = Boolean(body.project_id || body.location_id || body.plant_id) || spaceParented;
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
      // V4-PHOTOCAPTION-001 — evidence caption sync: the upload-time auto-capture snapshots the
      // caption into an evidence row (note + claim, source='photo_log'). Caption became editable
      // via this PUT, so the snapshot must follow or DrG reads stale evidence forever. Owner-scoped
      // to the household like the photo UPDATE above; best-effort non-fatal like the capture itself;
      // 0-row match (photo never linked to a planting) is a clean no-op.
      try {
        await sql`
          UPDATE public.evidence
             SET note = ${body.caption ?? null},
                 claim = ${body.caption ?? 'Photo observation'}
           WHERE photo_ref = ${photoId}
             AND source = 'photo_log'
             AND created_by = ANY(${householdIds})
             AND deleted_at IS NULL
        `;
      } catch (evErr) {
        console.error('evidence caption sync non-fatal failure', evErr?.message ?? evErr);
      }
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
