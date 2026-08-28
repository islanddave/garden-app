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
//   attached media count. Rows -> posted | failed | orphan_cleaned | orphan_cleanup_failed.
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
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { householdScope } from './household.js';
import { isJpeg, stripJpegExif } from './exif.js';
import {
  GRAPH_VERSION, MAX_PHOTOS, photoUploadUrl, feedUrl, nodeUrl,
  attachedMediaFields, validateShareRequest, classifyGraphError,
} from './graph.js';
import { mapInBatches } from './batch.js';
import { buildPhotoAltText } from './altText.js';
import { cleanupOrphanMedia, strandedError, STATUS_ORPHAN_CLEANED, STATUS_ORPHAN_STRANDED } from './orphans.js';

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

// ── Observability ──────────────────────────────────────────────────────────────────────────────────
// Structured, greppable lines that CloudWatch metric filters key on (provisioned by
// ops/share-observability.sh). This handler had NO instrument that could see a failed publish: the
// Lambda `Errors` metric is structurally blind here because every failure path RETURNS a response
// rather than throwing, so Errors stays flat at zero through a total outage.
//
// The `attempt` counter is not decoration. Without it "zero failures" and "zero attempts" are the
// same picture — and zero attempts is the picture today (share_log holds 0 rows), so a dashboard
// showing no failures would be reporting a feature that has never once run as perfectly healthy.
// Any alarm built on the failure metric alone inherits that ambiguity.
const SHARE_METRIC_PREFIX = 'SHARE_METRIC';
function shareMetric(outcome, fields = {}) {
  try { console.log(`${SHARE_METRIC_PREFIX} ${outcome} ${JSON.stringify(fields)}`); } catch { /* never let telemetry break a post */ }
}
// Map a handler response to an outcome name. 201 = a post was created; 200 = the idempotency replay
// returned a prior post (NOT a new publish, and must not be counted as one); 4xx = the request was
// refused before anything was published; 5xx = we failed while trying.
function outcomeForStatus(statusCode) {
  if (statusCode === 201) return 'posted';
  if (statusCode === 200) return 'replay';
  if (statusCode >= 500) return 'failed';
  return 'rejected';
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
// How many photos are downloaded+stripped at once. See the note at the call site: this is a MEMORY
// bound, not a rate limit. Exported so a test can assert the batching actually happens.
export const PREPARE_CONCURRENCY = 3;

async function preparePhoto(row) {
  const raw = await fetchPhotoBytes(row.storage_path);
  if (!isJpeg(raw)) {
    const err = new Error(`photo ${row.id} is not a JPEG — only JPEG is supported for Facebook sharing`);
    err.userFacing = true;
    throw err;
  }
  const { out, incompleteWalk, reason } = stripJpegExif(raw);
  // FAIL CLOSED. incompleteWalk means the segment walk broke partway and everything past that
  // offset was copied through UNEXAMINED — an APP1/EXIF/GPS block living there is still in `out`.
  // This is the one exit that publishes a photo outside the household, so "we could not prove it
  // is clean" has to stop the publish, not be discarded. Destructuring only `out` (what this line
  // used to do) made a partial strip indistinguishable from a clean one: at a bail offset of 2,
  // `out` IS the untouched original, GPS and all.
  if (incompleteWalk) {
    const err = new Error(`photo ${row.id} is a malformed JPEG (${reason}) — its metadata could not be fully removed, so it was not posted`);
    err.userFacing = true;
    throw err;
  }
  // `alt` rides with the bytes because the Graph call sites see only `prepared[]`. null = no honest
  // description was derivable; the field is then OMITTED, never sent empty (see altField below).
  return { photo_id: row.id, bytes: out, type: 'image/jpeg', name: `${row.id}.jpg`, alt: buildPhotoAltText(row) };
}

// V4-SHAREALTTEXT-001 — spread into the multipart field list. An absent alt must be an ABSENT FIELD,
// not `alt_text_custom=''`: an empty string is a stored, deliberate-looking "this image has no
// description" that suppresses the platform's own fallbacks, whereas omitting leaves the photo in
// the state Facebook already knows how to handle. Filler would be worse than either — a screen
// reader announces it as though it were a description.
function altField(alt) {
  const a = typeof alt === 'string' ? alt.trim() : '';
  return a ? [['alt_text_custom', a]] : [];
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

  // Kill switch: default OFF. Flip via env FB_SHARE_ENABLED=1 once the Page + token are live.
  if (process.env.FB_SHARE_ENABLED !== '1') {
    return resp(503, { error: 'facebook_sharing_disabled', message: 'Facebook sharing is currently turned off.' });
  }

  const rawPath = event.rawPath ?? '/api/share/facebook';

  try {
    if (method === 'GET' && rawPath === '/api/share/facebook/health') return await health();
    if (method === 'POST' && rawPath === '/api/share/facebook') {
      // One seam for every publish outcome. `attempt` is emitted BEFORE the work so a Lambda that
      // dies mid-post (timeout, OOM) still leaves evidence it was tried — the crash itself writes
      // nothing, and an attempt with no matching outcome is the signature of exactly that.
      shareMetric('attempt');
      try {
        const r = await share(event, secrets, userId);
        shareMetric(outcomeForStatus(r.statusCode), { status: r.statusCode });
        return r;
      } catch (err) {
        // Rethrown so the mapping below still produces the response; this only observes.
        shareMetric('failed', { kind: err?.name ?? 'Error', graph: err?.graph?.code ?? null });
        throw err;
      }
    }
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
    const prior = await sql`
      SELECT post_group_id, fb_post_id
      FROM share_log
      WHERE client_request_id = ${clientRequestId} AND status = 'posted'
      ORDER BY created_at DESC LIMIT 1`;
    if (prior.length) return resp(200, { replay: true, post_group_id: prior[0].post_group_id, post_id: prior[0].fb_post_id });
  }

  // Household-scoped existence check. Bytes never leave the household: a photo not owned by a
  // household member is simply "not found" (no existence oracle).
  //
  // V4-SHAREALTTEXT-001 widened this from `SELECT id, storage_path`. The alt text is DERIVED from
  // the record, so the descriptive columns have to be fetched HERE — the Graph call sites below hold
  // only prepared bytes, and there is no second place in this handler that touches the DB per photo.
  // Every added join is LEFT and every ON is on a unique key (event_log/garden_node/cultivar by PK,
  // crop_types by its unique slug), so the row count is unchanged and the `rows.length !==
  // photoIds.length` existence check above still means what it meant.
  //
  // COALESCE(p.plant_id, ev.plant_id): a photo reaches its planting either directly or through the
  // event it was logged against, and lambda/photos/index.js's gallery query already treats those two
  // edges as the same edge. Direct wins — it is the explicit attachment.
  //
  // Soft-delete predicates sit in the ON clauses, not the WHERE, on purpose: a photo whose event or
  // planting was deleted must still POST (it is a live photo in a live library), it just posts with
  // less description. Putting them in the WHERE would turn a deleted planting into "photos_not_found"
  // and block the share outright.
  const rows = await sql`
    SELECT
      p.id, p.storage_path,
      gn.display_name AS planting_name,
      cv.display_name AS variety_name,
      ct.display_name AS crop_name,
      ev.event_type
    FROM photos p
    LEFT JOIN public.event_log ev ON ev.id = p.event_id AND ev.deleted_at IS NULL
    LEFT JOIN public.garden_node gn
           ON gn.id = COALESCE(p.plant_id, ev.plant_id) AND gn.deleted_at IS NULL
    LEFT JOIN public.cultivar cv ON cv.id = gn.cultivar_id AND cv.deleted_at IS NULL
    LEFT JOIN public.crop_types ct ON ct.slug = cv.crop_type_slug AND ct.deleted_at IS NULL
    WHERE p.id = ANY(${photoIds}) AND p.created_by = ANY(${householdIds}) AND p.deleted_at IS NULL`;
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

  // BUG-FBSHAREBYTES-001 — prepare in BOUNDED batches, not all at once.
  //
  // This was Promise.all over every row, which meant up to MAX_PHOTOS originals were downloaded and
  // stripped concurrently. It fetches ORIGINAL bytes (fetchPhotoBytes(row.storage_path) — no
  // derivative, no size check), and prod holds photos up to 10 MB: measured 2026-08-21, 9 of the 33
  // rows carrying file_size_bytes exceed 5 MB, mean 7.8 MB. Ten of those at once is ~78 MB of
  // originals, plus the stripped copies, plus the Blob copy graphMultipart makes for the upload —
  // three live sets of the same bytes on a 1024 MB function whose measured baseline is 106 MB.
  //
  // Bounding the batch fixes it WITHOUT touching image quality, which is why it is the right fix.
  // The obvious alternative — fetch a smaller derivative — is not available and would not be free:
  // the only variants that exist are `thumb` (96x96) and `card` (480px), both WebP. Both are far too
  // small to publish, and Instagram's API does not accept WebP at all. Using a derivative would mean
  // BUILDING a new social-sized JPEG variant and deciding what resolution Dave's public photos get
  // published at — a real decision with a real cost, for a problem concurrency already solves.
  //
  // 3 is chosen against the measured worst case rather than as a round number: 3 x 7.8 MB originals
  // + their stripped copies sits comfortably inside the headroom above the 106 MB baseline, with
  // room for the upload-side Blob. It costs wall-clock on a 10-photo post (4 sequential batches
  // instead of 1) against a 180 s timeout, which is the correct trade — a slower post beats an
  // out-of-memory kill that takes the whole post with it.
  //
  // ORDER IS PRESERVED: batches are awaited in sequence and concatenated, so prepared[] still
  // matches ordered[]. The carousel cover is prepared[0] and must stay the photo Dave picked first.
  let prepared;
  try {
    prepared = await mapInBatches(ordered, PREPARE_CONCURRENCY, (row) => preparePhoto(row));
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
      ...altField(p.alt),
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
      // alt_text_custom rides on the published=false upload because THIS is the call that creates the
      // Photo node; /feed below only attaches it by id and carries the caption, which is post-level
      // text, not per-image text.
      //
      // VERIFIED against live Graph 2026-08-28 (was UNVERIFIED, inferred from Meta's Photo-node docs).
      // Measured without publishing anything: uploaded a synthetic image to the live Page with
      // published=false + alt_text_custom, then GET /{media_id}?fields=alt_text_custom returned the
      // string verbatim, then deleted the media. So the field IS honoured on an unpublished upload —
      // which is the case that matters, because this is the only call in the multi-photo path that
      // can carry per-image alt text. V4-SHAREALTTEXT-001's accessibility promise holds.
      //
      // While measuring: `published` is NOT a readable field on a photo node — GET ?fields=published
      // returns "(#100) Tried accessing nonexisting field". Do not add it to a read-back assertion.
      // Readable on an unpublished node: id, created_time, alt_text_custom, images, link.
      const r = await graphMultipart(photoUploadUrl(pageId), [
        ['access_token', pageToken],
        ...altField(p.alt),
        ['published', 'false'],
      ], p);
      if (!r.ok || r.json?.error) throw new GraphError(r);
      await setStatus(p.photo_id, { status: 'uploading', fb_media_id: r.json.id });
      media.push({ photo_id: p.photo_id, media_fbid: r.json.id });
    }));
  } catch (err) {
    await cleanupOrphans(media, pageToken, groupId, sql);
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
    await cleanupOrphans(media, pageToken, groupId, sql);
    await failAll(classifyGraphError(feed.json, feed.status).message);
    throw new GraphError(feed);
  }

  const postId = feed.json.id;
  for (const m of media) await setStatus(m.photo_id, { status: 'posted', fb_post_id: postId });
  await readBackAssert(postId, pageToken, media.length);
  return resp(201, { post_group_id: groupId, post_id: postId, media: media.map((m) => ({ photo_id: m.photo_id, fb_media_id: m.media_fbid })) });
}

// Delete orphaned published=false media so a failed /feed doesn't leave invisible objects on the Page.
//
// Control flow + the cleaned/stranded split live in ./orphans.js so they are unit-testable without
// this file's AWS/Clerk/Neon deps (see that module's header). This function is now only the I/O
// seam: it binds the Graph delete and the two status writes.
//
// A FAILED delete is written as 'failed' with its own error rather than being left for failAll:
// failAll only touches rows still in ('pending','uploading') and would overwrite `error` with the
// generic Graph message, losing the one fact that has to survive — that a real object is stranded
// on the Page and needs removing by hand.
//
// A stranded object now gets its OWN status rather than being overloaded onto 'failed'.
// V4-SHARETARGETS-001 widened share_log_status_valid to admit 'orphan_cleanup_failed', and that DDL
// is applied to staging and prod as of 2026-08-28 — which is the ordering this change depends on.
// The constraint must always widen BEFORE a handler emits the new value: the reverse order raises
// 23514 AFTER the post has reached a public Page, leaving a live post with no audit row.
// 'failed' could not distinguish "the post did not go out" from "the post did not go out AND a real
// unpublished object is stranded on a public Page and needs removing by hand" — the second is the
// only one that requires a human, and it was unqueryable.
async function cleanupOrphans(media, pageToken, groupId, sql) {
  return cleanupOrphanMedia({
    media,
    deleteMedia: (mediaFbid) => graphDelete(`${nodeUrl(mediaFbid)}?access_token=${encodeURIComponent(pageToken)}`),
    markCleaned: (photoId) => sql`
      UPDATE share_log SET status = ${STATUS_ORPHAN_CLEANED}, updated_at = now()
      WHERE post_group_id = ${groupId} AND photo_id = ${photoId} AND status = 'uploading'`,
    markStranded: (photoId, mediaFbid) => sql`
      UPDATE share_log SET status = ${STATUS_ORPHAN_STRANDED}, updated_at = now(), error = ${strandedError(mediaFbid)}
      WHERE post_group_id = ${groupId} AND photo_id = ${photoId} AND status = 'uploading'`,
    // Loud: the only signal that a real object was left on a public Page.
    log: (msg, detail) => console.error(`${msg} on group ${groupId}:`, detail),
  });
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
