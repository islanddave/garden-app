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
//   pre-publish content assertion (fail-closed: coordinates + configured terms) -> Graph upload. Single photo: POST /{page}/photos published (caption inline). Multi: POST
//   /{page}/photos published=false (parallel) -> POST /{page}/feed with message + attached_media[].
//   On /feed failure: delete the orphaned published=false media. Best-effort read-back asserts the
//   attached media count. Rows -> posted | failed | orphan_cleaned | orphan_cleanup_failed.
//
// FLOW (POST /api/share/instagram — V4-IGSHARE-001, ships DARK behind IG_SHARE_ENABLED):
//   same auth/admin gates -> validate against INSTAGRAM's limits (2200 caption, 30 tags, 10 carousel,
//   8MB) -> replay guard scoped to target='instagram' -> household-scoped fetch -> bounded prepare ->
//   size check -> content assertion -> stage STRIPPED bytes to S3 -> presign -> container(s) -> poll
//   to FINISHED -> media_publish -> persist permalink -> sweep staging. Rows -> queued | posted |
//   failed. See the Instagram section below for why the shape differs from Facebook's.
//
// CONSENT/PRIVACY: reads photo BYTES server-side (never url=), so no S3 object is made public and
// photos.is_public is neither read nor written. EXIF stripped before any byte leaves for Facebook.
// The Instagram path has no byte-upload available and must hand Meta a URL — it presigns a
// short-lived copy of the ALREADY-STRIPPED bytes, never the original object.
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
import { mapInBatches } from './batch.js';
import { buildPhotoAltText } from './altText.js';
import { cleanupOrphanMedia, strandedError, STATUS_ORPHAN_CLEANED, STATUS_ORPHAN_STRANDED } from './orphans.js';
import { assertPublishSafe, parseForbiddenTerms } from './contentAssertion.js';

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

// Where the Instagram flow parks its EXIF-stripped scratch copy. SEPARATE FROM $BUCKET ON PURPOSE.
//
// garden-photos-prod is versioned AND replicates every object (rule `crr-photos-all`, empty filter)
// to garden-photos-replica-usw2. S3 never replicates version-specific deletes, and that rule has
// DeleteMarkerReplication disabled, so NO deletion of any kind reaches the replica: a sweep that is
// correct on the source bucket still leaves a stripped copy of a private photo in us-west-2 forever.
// A lifecycle rule on both buckets bounds that to ~1 day (applied 2026-08-30) but does not remove
// the mechanism — it is a backstop for a hole that should not exist.
//
// Staging in an UNVERSIONED, UNREPLICATED bucket removes the hole instead of bounding it: a plain
// DeleteObject genuinely deletes, there is no non-current version to strand, and nothing is copied
// to a second region. It also drops the s3:DeleteObjectVersion dependency entirely.
//
// FALLS BACK TO $BUCKET when unset, so an environment that has not been configured yet behaves
// exactly as before rather than failing to publish. The fallback is why this is safe to deploy ahead
// of the env var; the deploy workflow sets the key and scripts/lambda-config-expected.json asserts it.
const IG_STAGING_BUCKET = process.env.IG_STAGING_BUCKET || BUCKET;

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

// One seam for every publish outcome, on EVERY target. `attempt` is emitted BEFORE the work so a
// Lambda that dies mid-post (timeout, OOM) still leaves evidence it was tried — the crash itself
// writes nothing, and an attempt with no matching outcome is the signature of exactly that.
//
// THE OUTCOME WORD MUST STAY THE SECOND TOKEN. The provisioned CloudWatch metric filters are literal
// substrings — "SHARE_METRIC attempt", "SHARE_METRIC posted", "SHARE_METRIC failed",
// "SHARE_METRIC rejected" (scripts/share-observability.sh). Adding FIELDS to the trailing JSON is
// safe and is why `target` can be introduced here without reprovisioning; reordering or renaming the
// prefix would silently detach every metric from its filter while the logs still look correct.
//
// `target` is recorded per line rather than split into separate metrics on purpose: the existing
// filters keep counting BOTH surfaces as one publish pipeline, which is the honest aggregate while
// neither has posted, and the field is what lets a per-target filter be added later without a code
// change. A metric that silently changed meaning when Instagram landed would be worse than one that
// counts both and says so.
async function withShareMetrics(target, run) {
  shareMetric('attempt', { target });
  try {
    const r = await run();
    shareMetric(outcomeForStatus(r.statusCode), { target, status: r.statusCode });
    return r;
  } catch (err) {
    // Rethrown so the handler's error mapping below still produces the response; this only observes.
    shareMetric('failed', { target, kind: err?.name ?? 'Error', graph: err?.graph?.code ?? null });
    throw err;
  }
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
// `context` is used only for its remaining-time budget (see pollDeadline). It is optional so the
// handler stays invocable from tests and local scripts without a synthetic Lambda context.
export const handler = async (event, context) => {
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

  // Kill switches are PER-TARGET, not global. Both default OFF and both demand exactly '1'.
  //
  // Facebook has been live since 2026-08-21; Instagram ships DARK behind its own IG_SHARE_ENABLED,
  // which scripts/lambda-config-expected.json pins as MUST-BE-ABSENT. One flag must not be able to
  // turn on a surface that has never posted — and the reverse matters just as much: an operator
  // turning Facebook OFF to stop a problem would, under a single global flag, be unable to leave
  // Instagram running (or worse, would believe they had stopped both when they had stopped neither).
  //
  // Health stays reachable while EITHER target is on. Diagnosing a dead token is exactly what you
  // need to do BEFORE enabling anything, so gating it behind the flag you are trying to decide about
  // is backwards. It is still admin-only and still read-only — it never posts.
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
    if (method === 'POST' && rawPath === '/api/share/facebook') {
      return await withShareMetrics('facebook', () => share(event, secrets, userId));
    }
    if (method === 'POST' && rawPath === '/api/share/instagram') {
      return await withShareMetrics('instagram', () => instagramShare(event, secrets, userId, context));
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
    // `target = 'facebook'` is a SAFETY PROPERTY OF THE QUERY, not symmetry with the Instagram guard.
    //
    // The shipping client gives each target its own id (src/lib/shareIdempotency.js — shareSlotKey
    // includes `target`), so today an Instagram row can never carry a Facebook row's id and this
    // predicate matches nothing extra. It is here for the case where that stops being true: the
    // rescued lane deliberately sent ONE id to BOTH targets, and under that scheme this query
    // returns a cross-target false positive — Facebook fails, Instagram succeeds and writes a
    // status='posted' row under the shared id, the user retries, and this SELECT matches the
    // INSTAGRAM row. The endpoint then answers replay:true with an Instagram media id as post_id
    // and the sheet reports a Facebook post that was never made. Scoping the lookup makes the
    // client's id scheme a choice rather than a load-bearing assumption of the server.
    //
    // `permalink` rides along for a weaker reason than on the Instagram side, where it is the only
    // link the user can get: here linkFor can already synthesise facebook.com/{post_id}. It is worth
    // the column anyway — the canonical URL beats a guess, and it keeps the replay response the same
    // shape as the fresh-post response below, which returns `permalink`. Rows written before
    // BUG-FBPERMALINK-001 carry NULL and simply fall back to the synthesised form.
    const prior = await sql`
      SELECT post_group_id, fb_post_id, permalink
      FROM share_log
      WHERE client_request_id = ${clientRequestId} AND target = 'facebook' AND status = 'posted'
      ORDER BY created_at DESC LIMIT 1`;
    if (prior.length) return resp(200, { replay: true, post_group_id: prior[0].post_group_id, post_id: prior[0].fb_post_id, permalink: prior[0].permalink ?? null });
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
  // BUG-FBPERMALINK-001: `permalink` was missing from this UPDATE entirely, so the column could never
  // be written on the Facebook path no matter what any call site passed — the NULLs in share_log say
  // nothing about what Graph returned. Mirrors the Instagram closure below, which has always had it.
  const setStatus = (photoId, patch) => sql`
    UPDATE share_log SET
      status      = COALESCE(${patch.status ?? null}, status),
      fb_media_id = COALESCE(${patch.fb_media_id ?? null}, fb_media_id),
      fb_post_id  = COALESCE(${patch.fb_post_id ?? null}, fb_post_id),
      permalink   = COALESCE(${patch.permalink ?? null}, permalink),
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

  // PRE-PUBLISH CONTENT ASSERTION, fail-closed. Runs AFTER prepare (so the alt text that will
  // actually be sent is available) and BEFORE the first Graph call, which is the only position where
  // it can stop a disclosure rather than report one. Two prior public-output defects on this project
  // were location disclosures, and the image bytes were the only thing being checked — the text this
  // handler puts on a public Page was inspected by nothing. See ./contentAssertion.js.
  const termsRaw = process.env.SHARE_FORBIDDEN_TERMS;
  const terms = parseForbiddenTerms(termsRaw);
  if (terms === null) {
    // Malformed config must not silently degrade into "no terms to check". That would leave the
    // weaker control running under the name of the stronger one.
    console.error('SHARE_FORBIDDEN_TERMS is set but not a JSON array of strings — refusing to publish');
    shareMetric('blocked', { reason: 'forbidden_terms_malformed' });
    await failAll('publish blocked: content-safety configuration is invalid');
    return resp(500, { error: 'content_check_misconfigured', message: 'The content safety check is misconfigured, so nothing was posted.' });
  }
  const assertion = assertPublishSafe({
    caption,
    altTexts: prepared.map((p) => p.alt).filter(Boolean),
    forbiddenTerms: terms,
  });
  if (!assertion.safe) {
    // `detail` names the term INDEX, never the term, so this log line cannot itself leak.
    console.error('pre-publish content assertion FAILED:', JSON.stringify(assertion.violations));
    shareMetric('blocked', { kinds: [...new Set(assertion.violations.map((v) => v.kind))] });
    await failAll('publish blocked by the pre-publish content check');
    return resp(422, {
      error: 'content_blocked',
      message: contentBlockedMessage(assertion.violations),
      fields: [...new Set(assertion.violations.map((v) => v.field))],
    });
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
    // Deliberately NOT the Instagram shape (fetch the permalink first, persist it in the one UPDATE).
    // status='posted' is the durable record the replay guard keys on, and it is the only thing between
    // a retry and a duplicate post on the Page — putting a Graph GET in front of it would widen the
    // crash window where a live post has no 'posted' row, which is a bad trade for an audit field.
    // So: write posted, then read back, then fill in the permalink. Guarded because a null read must
    // not spend a second UPDATE, and because setStatus assigns `error` outright rather than
    // COALESCEing it — harmless here (it is already NULL on this path) but not worth exercising.
    const permalink = await readBackAssert(postId, pageToken, 1);
    if (permalink) await setStatus(p.photo_id, { permalink });
    return resp(201, { post_group_id: groupId, post_id: postId, media: [{ photo_id: p.photo_id, fb_media_id: r.json.id }], permalink });
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
  // Same ordering rationale as the single-photo path above. The permalink is post-level, so every row
  // in the group gets the same value — share_log is per-photo, and a row that cannot say where its
  // photo went is the gap the column exists to close. This path returned no `permalink` key at all
  // before, so a multi-photo post's response was shaped differently from a single-photo one.
  const permalink = await readBackAssert(postId, pageToken, media.length);
  if (permalink) for (const m of media) await setStatus(m.photo_id, { permalink });
  return resp(201, { post_group_id: groupId, post_id: postId, media: media.map((m) => ({ photo_id: m.photo_id, fb_media_id: m.media_fbid })), permalink });
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

// The human half of a content_blocked response. "Edit the caption and try again" is wrong advice
// whenever the violation is in the ALT TEXT — that text is DERIVED from planting / variety / crop
// display names, so editing the caption changes nothing and the user retries into the same refusal.
// Name the surface that actually tripped. `fields` still carries the precise list; this is the
// sentence a person reads.
function contentBlockedMessage(violations) {
  const inCaption = violations.some((v) => v.field === 'caption');
  const inAlt = violations.some((v) => v.field !== 'caption');
  if (inCaption && inAlt) {
    return 'This post looks like it contains location details — in both the caption and a photo\u2019s description. Neither was sent.';
  }
  if (inAlt) {
    return 'This post was not sent: a photo\u2019s description looks like it contains location details. That text comes from the planting, variety or crop name rather than the caption, so it has to be renamed rather than edited here.';
  }
  return 'This post looks like it contains location details, so it was not sent. Edit the caption and try again.';
}

// ── Instagram (V4-IGSHARE-001, Track D) ────────────────────────────────────────────────────────────
//
// SHAPE DIFFERS FROM FACEBOOK ON PURPOSE. Facebook byte-uploads; Instagram has no byte-upload and
// fetches an image_url server-side. So the flow is: strip EXIF -> stage the STRIPPED bytes to S3 ->
// presign that staging key -> container -> poll -> publish -> delete staging.
//
// THE STAGING HOP IS A PRIVACY REQUIREMENT, NOT A CONVENIENCE. Measured 2026-08-21, 4 of 5 sampled
// prod photos carry GPS EXIF. Presigning the ORIGINAL object would hand Meta the untouched file and
// leak home coordinates — silently undoing the guarantee the Facebook path makes in its header
// ("EXIF stripped before any byte leaves"). The presigned URL must always point at stripped bytes.
//
// VERIFIED 2026-08-21: Meta's fetcher accepts a signed, private, time-limited URL (presigned object
// -> container -> FINISHED on first poll), and the signature is load-bearing (same URL unsigned ->
// HTTP 403). So this needs no world-readable surface.
//
// COLUMN REUSE: share_log's fb_* columns are target-agnostic by design. For target='instagram':
// fb_page_id = ig_user_id, fb_media_id = container id, fb_post_id = published IG media id.
// V4-SHARETARGETS-001 admits target='instagram' and is applied to staging AND prod, which is the
// ordering this handler depends on — the constraint must widen BEFORE a writer emits the new value.

async function stageAndSign(prepared, groupId) {
  const key = stagingKey(groupId, prepared.photo_id);
  // The PutObject RESPONSE carries VersionId on a versioned bucket. Capture it here: it is the only
  // moment we can learn it without a second ListObjectVersions call, and without it the sweep below
  // cannot remove the bytes at all. See cleanupStaging.
  const put = await s3.send(new PutObjectCommand({
    Bucket: IG_STAGING_BUCKET, Key: key, Body: prepared.bytes, ContentType: 'image/jpeg',
  }));
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: IG_STAGING_BUCKET, Key: key }),
    { expiresIn: STAGING_URL_TTL_SECONDS });
  return { key, url, versionId: put?.VersionId ?? null };
}

// Best-effort staging sweep. Never throws: a cleanup failure must not mask the real outcome.
//
// VERSION-AWARE ON PURPOSE — a plain DeleteObject here does NOT delete anything.
// garden-photos-prod has versioning ENABLED (verified 2026-08-28 via get-bucket-versioning). On a
// versioned bucket, DeleteObject without a VersionId writes a DELETE MARKER: the key stops being
// listable and the object still exists as a non-current version, forever. So the obvious sweep — the
// one this function shipped with earlier today — makes an EXIF-stripped copy of a private photo
// invisible rather than gone, which is the failure mode that reads as success. Passing VersionId
// removes that specific version permanently and writes no marker.
//
// RESOLVED 2026-08-30 — READ THIS BEFORE "SIMPLIFYING" THE VERSION HANDLING BELOW.
// Staging now targets $IG_STAGING_BUCKET (see its declaration near the top), which in prod is
// garden-photos-derivatives-769788341849: UNVERSIONED and UNREPLICATED (both verified live). On that
// bucket a plain DeleteObject genuinely removes the bytes, PutObject returns no VersionId, and the
// version-aware branch below is simply never taken.
//
// The version handling is KEPT DELIBERATELY, for two reasons:
//   1. IG_STAGING_BUCKET falls back to $BUCKET when unset, so any environment not yet carrying the
//      env var still stages on the versioned garden-photos-prod and still needs this branch.
//   2. It is keyed on the PutObject response carrying a VersionId, not on a bucket name, so it stays
//      correct if the staging target is ever pointed at a versioned bucket again.
// Deleting it would silently re-open the original defect for exactly those cases.
//
// THE HISTORY, because the mechanism is not obvious and was expensive to find:
// garden-photos-prod is versioned, so a plain DeleteObject writes a DELETE MARKER — the key stops
// listing and the object survives as a non-current version, forever. Worse, it replicates via
// `crr-photos-all` with an EMPTY filter to garden-photos-replica-usw2, with DeleteMarkerReplication
// disabled; and S3 never replicates version-specific deletes under any setting. So NEITHER branch
// below ever reached the replica, and a sweep that looked complete left a stripped copy of a private
// photo in us-west-2 permanently. Lifecycle rules on both buckets (applied 2026-08-30 via
// scripts/ig-staging-retention.sh) bound that to ~1 day, but staging off the replicated bucket is
// what actually removes the mechanism.
async function cleanupStaging(staged) {
  await Promise.all(staged.map(async ({ key: Key, versionId }) => {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: IG_STAGING_BUCKET, Key, ...(versionId ? { VersionId: versionId } : {}) }));
    } catch (err) {
      const denied = /accessdenied|not authorized/i.test(`${err?.name ?? ''} ${err?.message ?? ''}`);
      if (versionId && denied) {
        // The one case worth separating: we KNOW the version and are not allowed to remove it. Fall
        // back so the key at least stops being listable, and say plainly that bytes remain.
        console.error(`ig staging: DeleteObjectVersion DENIED for ${Key} (version ${versionId}) — grant s3:DeleteObjectVersion; STRIPPED BYTES REMAIN as a non-current version`);
        shareMetric('staging_version_retained', { target: 'instagram', reason: 'delete_version_denied' });
        try { await s3.send(new DeleteObjectCommand({ Bucket: IG_STAGING_BUCKET, Key })); }
        catch (e2) { console.error('ig staging: tombstone fallback also failed for', Key, e2?.message ?? String(e2)); }
        return;
      }
      console.error('ig staging cleanup FAILED for', Key, err?.message ?? String(err));
      shareMetric('staging_version_retained', { target: 'instagram', reason: 'delete_failed' });
    }
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

// How much of the invocation is held back for everything AFTER the last poll: media_publish, the
// permalink read, the per-photo status writes, and the staging sweep. Publishing is the step that
// must not be cut off midway — a Lambda killed between media_publish and the status writes leaves a
// LIVE Instagram post with no audit row, on a surface where posts cannot be deleted through the API.
const PUBLISH_TAIL_RESERVE_MS = 25_000;
// Used when the Lambda context is absent (unit tests, local invocation). Prod is 180s; staging is
// 60s, which is why this is derived from the context at runtime rather than hardcoded to prod.
const ASSUMED_BUDGET_MS = 180_000;

// The polling deadline for the WHOLE request, not per container.
//
// THE ARITHMETIC THAT DID NOT WORK. POLL_CEILING_MS is 60s and a carousel polls every child and then
// the parent, so a 10-photo post budgeted up to 11 x 60s = 660s against a 180s function. The failure
// is not a clean error: the Lambda is KILLED, so the `finally` never runs, staging objects are
// stranded, share_log rows stay 'queued' forever, and every container created still counts against
// the 400/24h creation quota. Sharing one deadline across all polls makes the ceiling mean what it
// says — an upper bound on the request, not on each of an unbounded number of steps.
function pollDeadline(context) {
  const remaining = typeof context?.getRemainingTimeInMillis === 'function'
    ? context.getRemainingTimeInMillis()
    : ASSUMED_BUDGET_MS;
  return Date.now() + Math.max(0, remaining - PUBLISH_TAIL_RESERVE_MS);
}

// D4 polling contract. A container is not publishable the moment it is created — Meta fetches the
// URL asynchronously. Only FINISHED may be published; IN_PROGRESS past the ceiling ABORTS rather
// than looping; ERROR and EXPIRED are terminal and are kept distinct by classifyContainerStatus.
//
// `budgetDeadline` is the request-wide bound; POLL_CEILING_MS still caps a SINGLE container so one
// slow item cannot eat the whole budget and starve its siblings. Whichever comes first wins.
async function pollContainer(containerId, token, budgetDeadline = Infinity) {
  const startedAt = Date.now();
  const ownCeiling = startedAt + POLL_CEILING_MS;
  const deadline = Math.min(ownCeiling, budgetDeadline);
  for (;;) {
    const r = await graphGet(`${igNodeUrl(containerId)}?fields=status_code,status&access_token=${encodeURIComponent(token)}`);
    const last = classifyContainerStatus(r.json);
    if (last.finished) return last;
    if (last.terminal) {
      const err = new Error(`Instagram rejected the image: ${last.detail || last.code}`);
      err.userFacing = true;
      err.igStatus = last;
      throw err;
    }
    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      // NAME THE BOUND THAT ACTUALLY RAN OUT. This used to report POLL_CEILING_MS unconditionally —
      // "did not finish processing within 60s" — which is false whenever the request-wide budget is
      // the smaller of the two, and on a carousel the budget is the USUAL one to hit, so the
      // misleading message was the common case rather than the edge. A diagnostic that names the
      // wrong limit sends the reader to tune the wrong number.
      const waited = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      const hitOwnCeiling = deadline === ownCeiling;
      const err = new Error(hitOwnCeiling
        ? `Instagram did not finish processing this image within ${POLL_CEILING_MS / 1000}s (last status ${last.code ?? 'unknown'}).`
        : `Ran out of time waiting for Instagram after ${waited}s — the request's remaining budget, not the per-image limit (last status ${last.code ?? 'unknown'}). Try fewer photos.`);
      err.userFacing = true;
      throw err;
    }
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
}

// POST /api/share/instagram — { photo_ids: [...], caption?, client_request_id? }
async function instagramShare(event, secrets, userId, context) {
  let body;
  try { body = JSON.parse(event.body ?? '{}'); } catch { return resp(400, { error: 'invalid_json' }); }

  const v = validateInstagramRequest(body);
  if (!v.ok) return resp(400, { error: 'validation_failed', details: v.errors });
  const { photoIds, caption, clientRequestId } = v;

  const sql = neon(secrets.NEON_DATABASE_URL);
  const householdIds = householdScope(userId);

  // D5: media_publish is NOT idempotent and accepts no client key, so this replay guard is the only
  // thing between a retried request and a duplicate Instagram post — and unlike Facebook, a mistaken
  // Instagram post CANNOT be deleted through the API (verified 2026-08-21: DELETE -> code 10). It is
  // removable only by hand in the app, which makes the guard matter more here, not less.
  //
  // BUG-IGREPLAYLINK-001: `permalink` is in the SELECT because the replay response is the ONLY place
  // the client can get it. FacebookShareSheet.linkFor refuses to synthesise an Instagram URL (a media
  // id is not addressable as a web URL), so without this column a replayed post renders no "View on
  // Instagram" link at all — the fresh post shows one, the retry of the same post shows none. It is
  // already in share_log; it just was not being read back out.
  if (clientRequestId) {
    const prior = await sql`
      SELECT post_group_id, fb_post_id, permalink
      FROM share_log
      WHERE client_request_id = ${clientRequestId} AND target = 'instagram' AND status = 'posted'
      ORDER BY created_at DESC LIMIT 1`;
    if (prior.length) return resp(200, { replay: true, post_group_id: prior[0].post_group_id, media_id: prior[0].fb_post_id, permalink: prior[0].permalink ?? null });
  }

  // Household-scoped existence check; a photo outside the household is simply "not found".
  //
  // IDENTICAL JOINS TO THE FACEBOOK QUERY, and for the same reason: alt text is DERIVED from the
  // record, so the descriptive columns have to be fetched HERE — the container call sites below hold
  // only prepared bytes. Instagram DOES accept per-image descriptions; Meta's parameter reference
  // for POST /{ig-user-id}/media reads "For image posts only. Alternative text, up to 1000
  // character, for an image. Only supported on a single image or image media in a carousel." So the
  // single container and each carousel CHILD carry it. (An earlier revision of this handler skipped
  // the joins and shipped Instagram without alt text at all, on the belief that support could not be
  // confirmed; the reference settles it.)
  //
  // Every added join is LEFT and every ON is on a unique key, so the row count is unchanged and the
  // `rows.length !== photoIds.length` existence check still means what it meant. Soft-delete
  // predicates sit in the ON clauses, not the WHERE: a photo whose event or planting was deleted
  // must still POST, it just posts with less description.
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
  if (!token) return resp(500, { error: 'fb_secret_incomplete' });

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
      permalink   = COALESCE(${patch.permalink ?? null}, permalink),
      error       = ${patch.error ?? null},
      updated_at  = now()
    WHERE post_group_id = ${groupId} AND photo_id = ${photoId}`;
  // 'queued' — NOT 'uploading'. V4-SHARETARGETS-001 added it for exactly this state: an Instagram
  // container exists and has been accepted, but nothing is published yet. The Facebook path's
  // 'uploading' means a real media object is already sitting on the Page; conflating the two would
  // make the one query that matters ("is anything stranded on a public surface?") unanswerable.
  // failAll below therefore sweeps ('pending','queued') — the IG counterpart of the FB row set.
  const failAll = (msg) => sql`
    UPDATE share_log SET status = 'failed', error = ${msg}, updated_at = now()
    WHERE post_group_id = ${groupId} AND status IN ('pending', 'queued')`;

  const stagedKeys = [];
  try {
    // BOUNDED prepare, exactly as the Facebook path (BUG-FBSHAREBYTES-001). The lane this was
    // rescued from used a bare Promise.all over every row, which predates that fix. The bound
    // matters MORE here than on the Facebook path, not less: this flow holds the original bytes,
    // the stripped copy, AND hands the stripped copy to PutObject — a third live set — on the same
    // 1024 MB function whose measured baseline is 106 MB.
    const prepared = await mapInBatches(ordered, PREPARE_CONCURRENCY, (row) => preparePhoto(row));

    // D6: size is checked AFTER the strip (which only shrinks) and BEFORE any container is created.
    // Instagram rejects above 8MB where Facebook tolerates 10MB, and a REJECTED container still
    // consumes the 400/24h creation quota — so this must not be discovered by spending one.
    for (const p of prepared) {
      const chk = checkImageBytes(p.bytes.byteLength);
      if (!chk.ok) { const e = new Error(chk.error); e.userFacing = true; throw e; }
    }

    // PRE-PUBLISH CONTENT ASSERTION, fail-closed — boss condition 6, mirroring the Facebook path.
    // Runs BEFORE the first container, which is the only position where it can stop a disclosure
    // rather than report one.
    //
    // `altTexts` MUST be fed here now that this flow publishes alt_text. It once passed [] because
    // Instagram sent no per-image text; the moment the field started going out, an empty array would
    // have meant the location-disclosure guard inspected the caption and let user-authored planting,
    // variety and crop names reach a public surface UNCHECKED — the guard reporting on a narrower
    // surface than the one being published to, which is precisely the failure it exists to prevent.
    const terms = parseForbiddenTerms(process.env.SHARE_FORBIDDEN_TERMS);
    if (terms === null) {
      console.error('SHARE_FORBIDDEN_TERMS is set but not a JSON array of strings — refusing to publish');
      shareMetric('blocked', { target: 'instagram', reason: 'forbidden_terms_malformed' });
      await failAll('publish blocked: content-safety configuration is invalid');
      return resp(500, { error: 'content_check_misconfigured', message: 'The content safety check is misconfigured, so nothing was posted.' });
    }
    const assertion = assertPublishSafe({ caption, altTexts: prepared.map((p) => p.alt).filter(Boolean), forbiddenTerms: terms });
    if (!assertion.safe) {
      // `detail` names the term INDEX, never the term, so this log line cannot itself leak.
      console.error('pre-publish content assertion FAILED (instagram):', JSON.stringify(assertion.violations));
      shareMetric('blocked', { target: 'instagram', kinds: [...new Set(assertion.violations.map((x) => x.kind))] });
      await failAll('publish blocked by the pre-publish content check');
      return resp(422, {
        error: 'content_blocked',
        message: contentBlockedMessage(assertion.violations),
        fields: [...new Set(assertion.violations.map((x) => x.field))],
      });
    }

    const staged = [];
    for (const p of prepared) {
      const s = await stageAndSign(p, groupId);
      stagedKeys.push({ key: s.key, versionId: s.versionId });
      staged.push({ photo_id: p.photo_id, url: s.url, alt: p.alt });
    }

    const isCarousel = staged.length >= IG_MIN_CAROUSEL;
    // One deadline for every poll in this request. Computed HERE, after prepare and staging have
    // already spent part of the invocation, so it reflects what is actually left rather than what
    // the function started with.
    const budget = pollDeadline(context);

    // FEASIBILITY PRE-FLIGHT, before the first container exists.
    //
    // A carousel polls each child and then the parent, so it needs at least one poll interval per
    // container to have any chance. If the remaining budget cannot cover that, the request is going
    // to be killed part-way — and the expensive part of being killed is not the failure, it is that
    // every container already created still counts against the 400/24h creation quota and the
    // `finally` never runs to sweep staging. Refusing now costs nothing and spends nothing.
    const pollsNeeded = isCarousel ? staged.length + 1 : 1;
    const minimumNeeded = pollsNeeded * POLL_INTERVAL_MS;
    if (budget - Date.now() < minimumNeeded) {
      const e = new Error(
        `not enough time left to publish ${staged.length} photo${staged.length === 1 ? '' : 's'} to Instagram `
        + `(needs at least ${Math.ceil(minimumNeeded / 1000)}s of polling, `
        + `${Math.max(0, Math.round((budget - Date.now()) / 1000))}s available). Try fewer photos.`);
      e.userFacing = true;
      throw e;
    }

    let creationId;

    if (!isCarousel) {
      const c = await igPost(igMediaUrl(igUserId), singleImageFields(staged[0].url, caption, token, staged[0].alt));
      creationId = c.id;
      await setStatus(staged[0].photo_id, { status: 'queued', fb_media_id: creationId });
      await pollContainer(creationId, token, budget);
    } else {
      // D3: children first (each is_carousel_item, NO caption), then a parent CAROUSEL container
      // referencing them in display order. Publishing the CHILD instead of the parent is the classic
      // mistake — it yields a single-image post and silently drops the rest.
      const childIds = [];
      for (const s of staged) {
        const c = await igPost(igMediaUrl(igUserId), carouselChildFields(s.url, token, s.alt));
        childIds.push(c.id);
        await setStatus(s.photo_id, { status: 'queued', fb_media_id: c.id });
      }
      // All-or-nothing: every child must reach FINISHED before the parent is created, so a partial
      // carousel is never published. All of these share ONE budget — see pollDeadline.
      for (const cid of childIds) await pollContainer(cid, token, budget);

      const parent = await igPost(igMediaUrl(igUserId), carouselParentFields(childIds, caption, token));
      creationId = parent.id;
      await pollContainer(creationId, token, budget);
    }

    // D5: the container id is already persisted (fb_media_id) BEFORE this call, so a lost response on
    // media_publish can be reconciled by reading the container's status_code rather than re-posting.
    const published = await igPost(igPublishUrl(igUserId), [
      ['creation_id', creationId],
      ['access_token', token],
    ]);
    const mediaId = published.id;

    // Fetch the permalink BEFORE writing the posted rows so it can be persisted in the same UPDATE.
    // V4-SHARETARGETS-001 added share_log.permalink for precisely this: without it the audit trail
    // can say a post exists and cannot say WHERE it is — and since an Instagram post cannot be
    // deleted through the API, "where is it" is the only actionable fact a human has.
    let permalink = null;
    try {
      const pr = await graphGet(`${igNodeUrl(mediaId)}?fields=permalink&access_token=${encodeURIComponent(token)}`);
      permalink = pr.json?.permalink ?? null;
    } catch { /* cosmetic only — the post already succeeded */ }

    for (const s of staged) await setStatus(s.photo_id, { status: 'posted', fb_post_id: mediaId, permalink });

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
    // Always sweep staging, on every path. A presigned URL that outlives its object grants nothing,
    // and leaving stripped copies of private photos in the photos bucket is not free.
    await cleanupStaging(stagedKeys);
  }
}

// DoD read-back: confirm the created post carries the expected media count. Non-fatal — logs a
// mismatch (the post already succeeded); the client's success does not hinge on this.
//
// It ALSO harvests the post's permalink and returns it (null if the read failed or Graph omitted it).
// BUG-FBPERMALINK-001 needed a permalink for share_log and this GET was already hitting the post node
// on both publish paths, so `permalink_url` is one more field on a query that was happening anyway —
// no extra Graph call, and therefore no extra queued response in the publish tests. The Instagram
// path spends a dedicated GET on this because it has no equivalent read-back to piggyback on.
//
// VERIFIED against live Graph 2026-08-31: GET /v21.0/{page-post-id}?fields=permalink_url with the
// Page token returns e.g. "https://www.facebook.com/{page}/posts/{post}". The field IS readable on a
// Page post node at v21.0 — it is simply not in the POST /{page-id}/photos response.
async function readBackAssert(postId, pageToken, expected) {
  try {
    const r = await graphGet(`${nodeUrl(postId)}?fields=attachments{subattachments},permalink_url&access_token=${encodeURIComponent(pageToken)}`);
    const subs = r.json?.attachments?.data?.[0]?.subattachments?.data;
    const got = Array.isArray(subs) ? subs.length : (r.json?.attachments?.data?.length ?? null);
    if (got != null && expected > 1 && got !== expected) console.warn(`readBack: post ${postId} media count ${got} != expected ${expected}`);
    return r.json?.permalink_url ?? null;
  } catch (err) { console.warn('readBack skipped:', err?.message ?? String(err)); return null; }
}
