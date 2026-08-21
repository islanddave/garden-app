// /api/share/facebook — V4-FBSHARE-001 (Phase A). Admin-only one-click post of garden photos to the
// "Gardens at Mathews" Facebook Page via the Graph API. WRITE endpoint (posts externally + writes
// share_log). Solo Dev-Mode feasible: Dave is Page admin AND app owner, so NO App Review is needed.
//
// Mirrors lambda/harvests (auth/secrets/Function-URL seam) and lambda/photos (S3 GetObject byte read,
// checksum flags, secrets TTL). Pure logic lives in ./graph.js + ./exif.js (unit-tested without deps).
//
// FLOW (POST):
//   auth (Clerk) -> admin gate (ADMIN_CLERK_SUBS) -> kill switch (FB_SHARE_ENABLED) -> validate ->
//   idempotency replay (client_request_id) -> household-scoped photo fetch (bytes stay private) ->
//   insert pending share_log rows -> per photo: S3 GetObject -> JPEG guard -> EXIF strip ->
//   Graph upload. Single photo: POST /{page}/photos published (caption inline). Multi: POST
//   /{page}/photos published=false (parallel) -> POST /{page}/feed with message + attached_media[].
//   On /feed failure: delete the orphaned published=false media. Best-effort read-back asserts the
//   attached media count. Rows -> posted | failed | orphan_cleaned.
//
// CONSENT/PRIVACY: reads photo BYTES server-side (never url=), so no S3 object is made public and
// photos.is_public is neither read nor written. EXIF stripped before any byte leaves for Facebook.
//
// TOKEN: a non-expiring Page token in Secrets Manager (garden-app/facebook-page-token: { page_id,
// page_token, app_id?, app_secret? }). The exec role's secretsmanager scope is garden-app/* so no IAM
// change is needed. GET .../health runs a debug_token / page probe so a dead token is visible BEFORE
// a post attempt.
import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { householdScope } from './household.js';
import { isJpeg, stripJpegExif } from './exif.js';
import {
  GRAPH_VERSION, MAX_PHOTOS, photoUploadUrl, feedUrl, nodeUrl,
  attachedMediaFields, validateShareRequest, classifyGraphError,
} from './graph.js';
import {
  IG_GRAPH_VERSION, IG_MIN_CAROUSEL, POLL_INTERVAL_MS, POLL_CEILING_MS, STAGING_URL_TTL_SECONDS,
  igMediaUrl, igPublishUrl, igNodeUrl, stagingKey,
  validateInstagramRequest, checkImageBytes, classifyContainerStatus,
  carouselChildFields, carouselParentFields, singleImageFields,
} from './instagram.js';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
// WHEN_REQUIRED: same rationale as lambda/photos — avoid the SDK injecting a checksum header S3
// rejects. We only GetObject here (no presign), but keep the flags identical for consistency.
const s3 = new S3Client({
  region: process.env.AWS_REGION ?? 'us-east-1',
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const BUCKET = process.env.S3_PHOTOS_BUCKET;
if (!BUCKET) throw new Error('S3_PHOTOS_BUCKET env var not set — check Lambda configuration');

const SECRETS_TTL_MS = 5 * 60 * 1000;
let _secrets = null, _secretsAt = 0;
async function getSecrets() {
  if (_secrets && (Date.now() - _secretsAt) < SECRETS_TTL_MS) return _secrets;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: process.env.SECRET_NAME ?? 'garden-app/secrets' }));
  _secrets = JSON.parse(res.SecretString);
  _secretsAt = Date.now();
  return _secrets;
}
let _fb = null, _fbAt = 0;
async function getFbSecret() {
  if (_fb && (Date.now() - _fbAt) < SECRETS_TTL_MS) return _fb;
  const id = process.env.FB_SECRET_NAME ?? 'garden-app/facebook-page-token';
  const res = await sm.send(new GetSecretValueCommand({ SecretId: id }));
  _fb = JSON.parse(res.SecretString);
  _fbAt = Date.now();
  return _fb;
}

const CORS = {}; // Lambda URL config is sole CORS source — handler must not duplicate.
function resp(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(body) };
}
function isUpstream(err) {
  const m = `${err?.code ?? ''} ${err?.name ?? ''} ${err?.message ?? ''}`.toLowerCase();
  return /econn|etimedout|enotfound|getaddrinfo|fetch failed|socket hang up|timeout|throttl|serviceunavailable|connection terminated/.test(m);
}
function isAdmin(userId) {
  const subs = (process.env.ADMIN_CLERK_SUBS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return subs.length > 0 && subs.includes(userId); // fail-closed: empty allowlist admits no one
}

// ── Graph I/O (the only network surface; pure builders/classifier live in graph.js) ────────────────
async function graphMultipart(url, fields, file) {
  const fd = new FormData();
  for (const [k, v] of fields) fd.append(k, v);
  if (file) fd.append('source', new Blob([file.bytes], { type: file.type || 'image/jpeg' }), file.name || 'photo.jpg');
  const r = await fetch(url, { method: 'POST', body: fd });
  const json = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json };
}
async function graphGet(url) {
  const r = await fetch(url, { method: 'GET' });
  const json = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json };
}
async function graphDelete(url) {
  try {
    const r = await fetch(url, { method: 'DELETE' });
    return r.ok;
  } catch { return false; }
}
// A Graph call that failed with a token/rate/other error -> throw a tagged error the handler maps.
class GraphError extends Error {
  constructor(res) {
    const c = classifyGraphError(res.json, res.status);
    super(c.message);
    this.name = 'GraphError';
    this.graph = c;
    this.httpStatus = res.status;
  }
}

async function fetchPhotoBytes(storagePath) {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: storagePath }));
  const raw = await obj.Body.transformToByteArray();
  return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
}

// Prepare one photo: download -> JPEG magic-byte guard -> lossless EXIF strip. Returns upload part.
async function preparePhoto(row) {
  const raw = await fetchPhotoBytes(row.storage_path);
  if (!isJpeg(raw)) {
    const err = new Error(`photo ${row.id} is not a JPEG — only JPEG is supported for Facebook sharing`);
    err.userFacing = true;
    throw err;
  }
  const { out } = stripJpegExif(raw);
  return { photo_id: row.id, bytes: out, type: 'image/jpeg', name: `${row.id}.jpg` };
}

// ── Handler ────────────────────────────────────────────────────────────────────────────────────────
export const handler = async (event) => {
  const method = event.requestContext?.http?.method ?? 'GET';
  if (method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const secrets = await getSecrets();

  const authHeader = event.headers?.authorization ?? event.headers?.Authorization ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  let userId;
  try {
    const payload = await verifyToken(token, {
      secretKey: secrets.CLERK_SECRET_KEY,
      authorizedParties: ['https://garden.futureishere.net', 'https://dg6mmjhepoyt9.cloudfront.net'],
    });
    userId = payload.sub;
  } catch (err) {
    console.error('verifyToken failed:', err?.message ?? String(err));
    return resp(401, { error: 'Unauthorized' });
  }
  // V4-AUTHZRESIDUE-001 (mirrors lambda/plants + lambda/photos): householdScope('') returns [''] and
  // `'' = ANY(ARRAY[''])` is TRUE in Postgres, so an empty/absent JWT subject would be a live
  // ownership value rather than a no-match. verifyToken rejects such a token first, so this is
  // defence-in-depth; the point is that the invariant is ENFORCED here rather than relied upon.
  if (!userId) return resp(401, { error: 'Unauthorized' });

  if (!isAdmin(userId)) return resp(403, { error: 'Admin only' });

  const rawPath = event.rawPath ?? '/api/share/facebook';

  // Kill switches are PER-TARGET, not global. Instagram (V4-IGSHARE-001) ships dark behind its own
  // IG_SHARE_ENABLED while Facebook is already live, so one flag cannot turn on a surface that has
  // never posted. Health stays reachable whenever either target is on, since diagnosing a dead token
  // is exactly what you need before enabling anything.
  const fbOn = process.env.FB_SHARE_ENABLED === '1';
  const igOn = process.env.IG_SHARE_ENABLED === '1';
  if (rawPath === '/api/share/facebook' && !fbOn) {
    return resp(503, { error: 'facebook_sharing_disabled', message: 'Facebook sharing is currently turned off.' });
  }
  if (rawPath === '/api/share/instagram' && !igOn) {
    return resp(503, { error: 'instagram_sharing_disabled', message: 'Instagram sharing is currently turned off.' });
  }
  if (rawPath === '/api/share/facebook/health' && !fbOn && !igOn) {
    return resp(503, { error: 'sharing_disabled', message: 'Sharing is currently turned off.' });
  }

  try {
    if (method === 'GET' && rawPath === '/api/share/facebook/health') return await health();
    if (method === 'POST' && rawPath === '/api/share/facebook') return await share(event, secrets, userId);
    if (method === 'POST' && rawPath === '/api/share/instagram') return await instagramShare(event, secrets, userId);
    return resp(405, { error: 'Method not allowed' });
  } catch (err) {
    if (err instanceof GraphError) {
      if (err.graph.tokenInvalid) return resp(502, { error: 'facebook_token_invalid', message: 'The Facebook Page token is invalid or expired. Run the health check / re-auth runbook.' });
      if (err.graph.rateLimited) return resp(429, { error: 'facebook_rate_limited', message: 'Facebook is rate-limiting posts right now. Try again shortly.', code: err.graph.code });
      console.error('Graph error:', err.graph);
      return resp(502, { error: 'facebook_error', message: err.graph.message, code: err.graph.code });
    }
    if (err?.userFacing) return resp(422, { error: 'unshareable_photo', message: err.message });
    if (isUpstream(err)) return resp(503, { error: 'upstream_unavailable', message: 'A temporary problem reaching storage or the database. Please retry.' });
    console.error('facebook-share unhandled error:', err?.message ?? String(err));
    return resp(500, { error: 'internal_error' });
  }
};

// GET /api/share/facebook/health — is the Page token alive? Uses debug_token when app creds are
// present (gives expiry), else a lightweight page probe. Read-only; never posts.
async function health() {
  const fb = await getFbSecret();
  if (!fb?.page_id || !fb?.page_token) return resp(500, { error: 'fb_secret_incomplete', message: 'facebook-page-token secret missing page_id/page_token.' });

  if (fb.app_id && fb.app_secret) {
    const appToken = `${fb.app_id}|${fb.app_secret}`;
    const url = `${nodeUrl('debug_token')}?input_token=${encodeURIComponent(fb.page_token)}&access_token=${encodeURIComponent(appToken)}`;
    const r = await graphGet(url);
    if (r.ok && r.json?.data) {
      const d = r.json.data;
      return resp(200, { healthy: !!d.is_valid, page_id: fb.page_id, is_valid: !!d.is_valid, expires_at: d.expires_at ?? 0, scopes: d.scopes ?? [], graph_version: GRAPH_VERSION });
    }
    return resp(200, { healthy: false, page_id: fb.page_id, detail: classifyGraphError(r.json, r.status) });
  }

  // No app creds — probe the page node with the page token itself.
  const r = await graphGet(`${nodeUrl(fb.page_id)}?fields=id,name&access_token=${encodeURIComponent(fb.page_token)}`);
  if (r.ok && r.json?.id) return resp(200, { healthy: true, page_id: r.json.id, page_name: r.json.name ?? null, graph_version: GRAPH_VERSION });
  return resp(200, { healthy: false, page_id: fb.page_id, detail: classifyGraphError(r.json, r.status) });
}

// POST /api/share/facebook — { photo_ids: [...], caption?, client_request_id? }
async function share(event, secrets, userId) {
  let body;
  try { body = JSON.parse(event.body ?? '{}'); } catch { return resp(400, { error: 'invalid_json' }); }

  const v = validateShareRequest(body);
  if (!v.ok) return resp(400, { error: 'validation_failed', details: v.errors });
  const { photoIds, caption, clientRequestId } = v;

  const sql = neon(secrets.NEON_DATABASE_URL);
  const householdIds = householdScope(userId);

  // Idempotency replay: a completed post for this client_request_id returns the prior result rather
  // than re-posting (Graph has no idempotency key; a lost response on retry would double-post).
  if (clientRequestId) {
    // target = 'facebook' is LOAD-BEARING, not symmetry with the Instagram guard below.
    // V4-IGSHARE-001 made the client send ONE client_request_id to BOTH targets, which turned this
    // previously-safe query into a cross-target false positive: Facebook fails, Instagram succeeds
    // and writes a status='posted' row under the shared id, the user taps Retry, and this SELECT
    // matches the INSTAGRAM row. The endpoint then returns replay:true with an Instagram media id
    // as post_id, the sheet reports "Posted to Facebook and Instagram", and Facebook never received
    // the post at all — a silent claim that something is public when it is not.
    const prior = await sql`
      SELECT post_group_id, fb_post_id
      FROM share_log
      WHERE client_request_id = ${clientRequestId} AND target = 'facebook' AND status = 'posted'
      ORDER BY created_at DESC LIMIT 1`;
    if (prior.length) return resp(200, { replay: true, post_group_id: prior[0].post_group_id, post_id: prior[0].fb_post_id });
  }

  // Household-scoped existence check. Bytes never leave the household: a photo not owned by a
  // household member is simply "not found" (no existence oracle).
  const rows = await sql`
    SELECT id, storage_path
    FROM photos
    WHERE id = ANY(${photoIds}) AND created_by = ANY(${householdIds}) AND deleted_at IS NULL`;
  if (rows.length !== photoIds.length) return resp(404, { error: 'photos_not_found', message: 'One or more photos are not in your library.' });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = photoIds.map((id) => byId.get(id)); // preserve requested order for attached_media

  const fb = await getFbSecret();
  if (!fb?.page_id || !fb?.page_token) return resp(500, { error: 'fb_secret_incomplete' });
  const pageId = fb.page_id, pageToken = fb.page_token;

  // Insert pending rows first — the durable record the idempotency + orphan-cleanup logic keys on.
  const groupId = randomUUID();
  for (const id of photoIds) {
    await sql`
      INSERT INTO share_log (post_group_id, photo_id, target, client_request_id, fb_page_id, status, caption, requested_by)
      VALUES (${groupId}, ${id}, 'facebook', ${clientRequestId}, ${pageId}, 'pending', ${caption}, ${userId})`;
  }
  const setStatus = (photoId, patch) => sql`
    UPDATE share_log SET
      status      = COALESCE(${patch.status ?? null}, status),
      fb_media_id = COALESCE(${patch.fb_media_id ?? null}, fb_media_id),
      fb_post_id  = COALESCE(${patch.fb_post_id ?? null}, fb_post_id),
      error       = ${patch.error ?? null},
      updated_at  = now()
    WHERE post_group_id = ${groupId} AND photo_id = ${photoId}`;
  const failAll = (msg) => sql`
    UPDATE share_log SET status = 'failed', error = ${msg}, updated_at = now()
    WHERE post_group_id = ${groupId} AND status IN ('pending', 'uploading')`;

  // Prepare (download + strip) all photos in parallel — independent, cap already <= MAX_PHOTOS.
  let prepared;
  try {
    prepared = await Promise.all(ordered.map((row) => preparePhoto(row)));
  } catch (err) {
    await failAll(err?.message ?? 'photo preparation failed');
    throw err;
  }

  // ── SINGLE photo: one published /photos call, caption inline. ──
  if (prepared.length === 1) {
    const p = prepared[0];
    const r = await graphMultipart(photoUploadUrl(pageId), [
      ['access_token', pageToken],
      ['caption', caption ?? ''],
      ['published', 'true'],
    ], p);
    if (!r.ok || r.json?.error) { await failAll(classifyGraphError(r.json, r.status).message); throw new GraphError(r); }
    const postId = r.json.post_id ?? r.json.id;
    await setStatus(p.photo_id, { status: 'posted', fb_media_id: r.json.id, fb_post_id: postId });
    await readBackAssert(postId, pageToken, 1);
    return resp(201, { post_group_id: groupId, post_id: postId, media: [{ photo_id: p.photo_id, fb_media_id: r.json.id }], permalink: r.json?.permalink_url ?? null });
  }

  // ── MULTI photo: published=false uploads (parallel) -> /feed attached_media (caption on feed). ──
  // media[] accumulates each SUCCESSFUL upload as it resolves (side-effect push, not the Promise.all
  // return), so a mid-batch failure still knows which published=false objects to delete — Promise.all
  // rejects on the first error but earlier uploads already created media on the Page (orphan leak).
  const media = [];
  try {
    await Promise.all(prepared.map(async (p) => {
      const r = await graphMultipart(photoUploadUrl(pageId), [['access_token', pageToken], ['published', 'false']], p);
      if (!r.ok || r.json?.error) throw new GraphError(r);
      await setStatus(p.photo_id, { status: 'uploading', fb_media_id: r.json.id });
      media.push({ photo_id: p.photo_id, media_fbid: r.json.id });
    }));
  } catch (err) {
    await cleanupOrphans(media.map((m) => m.media_fbid), pageToken, groupId, sql);
    await failAll(err instanceof GraphError ? err.graph.message : (err?.message ?? 'media upload failed'));
    throw err;
  }

  // Parallel uploads resolve out of order — restore the caller's requested order for the post layout.
  const orderIdx = new Map(photoIds.map((id, i) => [id, i]));
  media.sort((a, b) => orderIdx.get(a.photo_id) - orderIdx.get(b.photo_id));

  const feed = await graphMultipart(feedUrl(pageId), [
    ['access_token', pageToken],
    ['message', caption ?? ''],
    ...attachedMediaFields(media.map((m) => m.media_fbid)),
  ]);
  if (!feed.ok || feed.json?.error) {
    await cleanupOrphans(media.map((m) => m.media_fbid), pageToken, groupId, sql);
    await failAll(classifyGraphError(feed.json, feed.status).message);
    throw new GraphError(feed);
  }

  const postId = feed.json.id;
  for (const m of media) await setStatus(m.photo_id, { status: 'posted', fb_post_id: postId });
  await readBackAssert(postId, pageToken, media.length);
  return resp(201, { post_group_id: groupId, post_id: postId, media: media.map((m) => ({ photo_id: m.photo_id, fb_media_id: m.media_fbid })) });
}

// Delete orphaned published=false media so a failed /feed doesn't leave invisible objects on the Page.
async function cleanupOrphans(mediaIds, pageToken, groupId, sql) {
  await Promise.all(mediaIds.map((id) => graphDelete(`${nodeUrl(id)}?access_token=${encodeURIComponent(pageToken)}`)));
  // Mark the group's uploaded-but-unposted rows as cleaned (best-effort audit; failAll still sets
  // error on the never-uploaded rows). Runs before failAll, so these leave 'uploading' first.
  try {
    await sql`UPDATE share_log SET status = 'orphan_cleaned', updated_at = now()
              WHERE post_group_id = ${groupId} AND status = 'uploading'`;
  } catch { /* audit-only; never mask the original failure */ }
}

// ── Instagram (V4-IGSHARE-001, Track D) ────────────────────────────────────────────────────────────
//
// SHAPE DIFFERS FROM FACEBOOK ON PURPOSE. Facebook byte-uploads; Instagram has no byte-upload and
// fetches an image_url server-side. So the flow is: strip EXIF -> stage the STRIPPED bytes to S3 ->
// presign that staging key -> container -> poll -> publish -> delete staging.
//
// The staging hop is a PRIVACY REQUIREMENT, not a convenience. Measured 2026-08-21, 4 of 5 sampled
// prod photos carry GPS EXIF. Presigning the original object would hand Meta the untouched file and
// leak home coordinates — silently undoing the guarantee the Facebook path makes in its header
// comment ("EXIF stripped before any byte leaves for Facebook").
//
// COLUMN REUSE: share_log's fb_* columns are target-agnostic by design ("forward-compat: other
// targets later" in the migration). For target='instagram': fb_page_id=ig_user_id,
// fb_media_id=container id, fb_post_id=published IG media id. No migration needed.

async function stageAndSign(prepared, groupId) {
  const key = stagingKey(groupId, prepared.photo_id);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: prepared.bytes, ContentType: 'image/jpeg',
  }));
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn: STAGING_URL_TTL_SECONDS });
  return { key, url };
}

// Best-effort staging sweep. Never throws: a cleanup failure must not mask the real outcome, and the
// ig-staging/ prefix is designed for a lifecycle rule to catch whatever a timeout leaves behind.
async function cleanupStaging(keys) {
  await Promise.all(keys.map(async (Key) => {
    try { await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key })); }
    catch (err) { console.warn('ig staging cleanup failed for', Key, err?.message ?? String(err)); }
  }));
}

async function igPost(url, fields) {
  const fd = new FormData();
  for (const [k, v] of fields) fd.append(k, v);
  const r = await fetch(url, { method: 'POST', body: fd });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json?.error) throw new GraphError({ ok: r.ok, status: r.status, json });
  return json;
}

// D4 polling contract. A container is not publishable the moment it is created — Meta fetches the
// URL asynchronously. Only FINISHED may be published; IN_PROGRESS past the ceiling ABORTS rather
// than looping; ERROR and EXPIRED are terminal and are surfaced distinctly by classifyContainerStatus.
async function pollContainer(containerId, token) {
  const deadline = Date.now() + POLL_CEILING_MS;
  let last = null;
  for (;;) {
    const r = await graphGet(`${igNodeUrl(containerId)}?fields=status_code,status&access_token=${encodeURIComponent(token)}`);
    last = classifyContainerStatus(r.json);
    if (last.finished) return last;
    if (last.terminal) {
      const err = new Error(`Instagram rejected the image: ${last.detail || last.code}`);
      err.userFacing = true;
      err.igStatus = last;
      throw err;
    }
    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      const err = new Error(`Instagram did not finish processing within ${POLL_CEILING_MS / 1000}s (last status ${last.code ?? 'unknown'}).`);
      err.userFacing = true;
      throw err;
    }
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
}

// POST /api/share/instagram — { photo_ids: [...], caption?, client_request_id? }
async function instagramShare(event, secrets, userId) {
  let body;
  try { body = JSON.parse(event.body ?? '{}'); } catch { return resp(400, { error: 'invalid_json' }); }

  const v = validateInstagramRequest(body);
  if (!v.ok) return resp(400, { error: 'validation_failed', details: v.errors });
  const { photoIds, caption, clientRequestId } = v;

  const sql = neon(secrets.NEON_DATABASE_URL);
  const householdIds = householdScope(userId);

  // D5: media_publish is NOT idempotent and accepts no client key, so the replay guard is the only
  // thing standing between a retried request and a duplicate Instagram post. Scoped to
  // target='instagram' so a Facebook post with the same client_request_id never masks an IG post.
  if (clientRequestId) {
    const prior = await sql`
      SELECT post_group_id, fb_post_id
      FROM share_log
      WHERE client_request_id = ${clientRequestId} AND target = 'instagram' AND status = 'posted'
      ORDER BY created_at DESC LIMIT 1`;
    if (prior.length) return resp(200, { replay: true, post_group_id: prior[0].post_group_id, media_id: prior[0].fb_post_id });
  }

  const rows = await sql`
    SELECT id, storage_path
    FROM photos
    WHERE id = ANY(${photoIds}) AND created_by = ANY(${householdIds}) AND deleted_at IS NULL`;
  if (rows.length !== photoIds.length) return resp(404, { error: 'photos_not_found', message: 'One or more photos are not in your library.' });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = photoIds.map((id) => byId.get(id)); // requested order == carousel display order

  const fb = await getFbSecret();
  const igUserId = fb?.ig_user_id;
  if (!igUserId) {
    return resp(500, {
      error: 'ig_not_configured',
      message: 'No Instagram business account is linked. Add ig_user_id to the facebook-page-token secret.',
    });
  }
  const token = fb.page_token;

  const groupId = randomUUID();
  for (const id of photoIds) {
    await sql`
      INSERT INTO share_log (post_group_id, photo_id, target, client_request_id, fb_page_id, status, caption, requested_by)
      VALUES (${groupId}, ${id}, 'instagram', ${clientRequestId}, ${igUserId}, 'pending', ${caption}, ${userId})`;
  }
  const setStatus = (photoId, patch) => sql`
    UPDATE share_log SET
      status      = COALESCE(${patch.status ?? null}, status),
      fb_media_id = COALESCE(${patch.fb_media_id ?? null}, fb_media_id),
      fb_post_id  = COALESCE(${patch.fb_post_id ?? null}, fb_post_id),
      error       = ${patch.error ?? null},
      updated_at  = now()
    WHERE post_group_id = ${groupId} AND photo_id = ${photoId}`;
  const failAll = (msg) => sql`
    UPDATE share_log SET status = 'failed', error = ${msg}, updated_at = now()
    WHERE post_group_id = ${groupId} AND status IN ('pending', 'uploading')`;

  const stagedKeys = [];
  try {
    // Prepare = download + JPEG magic guard + lossless EXIF strip (shared with the Facebook path).
    const prepared = await Promise.all(ordered.map((row) => preparePhoto(row)));

    // D6: size is checked AFTER the strip (which only shrinks) and BEFORE any container is created —
    // a rejected container still consumes the 400/24h creation quota.
    for (const p of prepared) {
      const chk = checkImageBytes(p.bytes.byteLength);
      if (!chk.ok) { const e = new Error(chk.error); e.userFacing = true; throw e; }
    }

    const staged = [];
    for (const p of prepared) {
      const s = await stageAndSign(p, groupId);
      stagedKeys.push(s.key);
      staged.push({ photo_id: p.photo_id, url: s.url });
    }

    const isCarousel = staged.length >= IG_MIN_CAROUSEL;
    let creationId;

    if (!isCarousel) {
      const c = await igPost(igMediaUrl(igUserId), singleImageFields(staged[0].url, caption, token));
      creationId = c.id;
      await setStatus(staged[0].photo_id, { status: 'uploading', fb_media_id: creationId });
      await pollContainer(creationId, token);
    } else {
      // D3: children first (each is_carousel_item, NO caption), then a parent CAROUSEL container
      // referencing them in display order. Publishing the CHILD instead of the parent is the classic
      // mistake — it yields a single-image post and silently drops the rest.
      const childIds = [];
      for (const s of staged) {
        const c = await igPost(igMediaUrl(igUserId), carouselChildFields(s.url, token));
        childIds.push(c.id);
        await setStatus(s.photo_id, { status: 'uploading', fb_media_id: c.id });
      }
      // All-or-nothing: every child must reach FINISHED before the parent is created, so a partial
      // carousel is never published.
      for (const cid of childIds) await pollContainer(cid, token);

      const parent = await igPost(igMediaUrl(igUserId), carouselParentFields(childIds, caption, token));
      creationId = parent.id;
      await pollContainer(creationId, token);
    }

    // D5: the container id is already persisted (fb_media_id) BEFORE this call, so a lost response on
    // media_publish can be reconciled by reading the container's status_code rather than re-posting.
    const published = await igPost(igPublishUrl(igUserId), [
      ['creation_id', creationId],
      ['access_token', token],
    ]);
    const mediaId = published.id;
    for (const s of staged) await setStatus(s.photo_id, { status: 'posted', fb_post_id: mediaId });

    let permalink = null;
    try {
      const pr = await graphGet(`${igNodeUrl(mediaId)}?fields=permalink&access_token=${encodeURIComponent(token)}`);
      permalink = pr.json?.permalink ?? null;
    } catch { /* cosmetic only — the post already succeeded */ }

    return resp(201, {
      post_group_id: groupId,
      media_id: mediaId,
      permalink,
      carousel: isCarousel,
      count: staged.length,
      graph_version: IG_GRAPH_VERSION,
    });
  } catch (err) {
    await failAll(err instanceof GraphError ? err.graph.message : (err?.message ?? 'instagram publish failed'));
    throw err;
  } finally {
    // Always sweep staging, on every path. A presigned URL that outlives its object grants nothing.
    await cleanupStaging(stagedKeys);
  }
}

// DoD read-back: confirm the created post carries the expected media count. Non-fatal — logs a
// mismatch (the post already succeeded); the client's success does not hinge on this.
async function readBackAssert(postId, pageToken, expected) {
  try {
    const r = await graphGet(`${nodeUrl(postId)}?fields=attachments{subattachments}&access_token=${encodeURIComponent(pageToken)}`);
    const subs = r.json?.attachments?.data?.[0]?.subattachments?.data;
    const got = Array.isArray(subs) ? subs.length : (r.json?.attachments?.data?.length ?? null);
    if (got != null && expected > 1 && got !== expected) console.warn(`readBack: post ${postId} media count ${got} != expected ${expected}`);
  } catch (err) { console.warn('readBack skipped:', err?.message ?? String(err)); }
}
