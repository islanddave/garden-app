// V4-PHOTOCDN-001 — derivative generator Lambda (INTERNAL-INVOKE ONLY).
// V102 model (fact-settled 2026-07-02): the photos distro is PURE S3+OAC — `/d/*` serves the
// derivatives bucket directly, `/o/*` serves originals via a viewer-request strip-o-prefix fn.
// This Lambda is NOT a CloudFront origin and has NO Function URL. It is invoked INTERNALLY
// (aws lambda invoke, RequestResponse) by the P3 backfill driver / upload path to GENERATE and
// PERSIST WebP derivatives (+ a blurhash) into the derivatives bucket. The invoke boundary is IAM
// (lambda:InvokeFunction on the dedicated role) — the retired origin_verify_secret is gone.
//
// Path contract (path-addressed, NOT opaque-hashed — the key must be reversible so the original is
// recoverable): GET-style event `rawPath = /d/<variant>/<etag>/<original-key...>.webp`
//   variant ∈ {thumb, card}; etag = the original's S3 ETag (hex, no quotes; multipart keeps the -N
//   suffix verbatim) — replacement at the same key yields a new etag => new derivative path (free
//   invalidation). ETag-mismatch: serve from the CURRENT original but SKIP the S3 write (never
//   persist a derivative under a stale-etag key).
// Response: statusCode 200 + `content-type: image/webp` + base64 body (the derivative bytes). On the
//   `thumb` variant ONLY, a compact `x-blurhash` header carries the original's blurhash (a per-ORIGINAL
//   property — computed once, not per-variant); the backfill reads it to persist photos.blurhash.
// Self-test route `/d/__selftest__` decodes an embedded HEIC/raster and returns a JSON health probe
//   (arch/sharp/heif) — used by the deploy verification step to prove the arm64 build actually loads.
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { encode as blurhashEncode } from 'blurhash';

const s3 = new S3Client({});
const ORIGINALS_BUCKET = process.env.ORIGINALS_BUCKET ?? 'garden-photos-prod';
const DERIVATIVES_BUCKET = process.env.DERIVATIVES_BUCKET;
const VARIANTS = {
  thumb: (img) => img.resize(96, 96, { fit: 'cover' }).webp({ quality: 70 }),
  card:  (img) => img.resize({ width: 480, withoutEnlargement: true }).webp({ quality: 75 }),
};
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
// blurhash is a per-ORIGINAL placeholder: encode a tiny RGBA raster (fixed 4x3 components).
const BLURHASH_RASTER = 32, BLURHASH_COMPX = 4, BLURHASH_COMPY = 3;

const resp = (status, body, headers = {}) => ({
  statusCode: status,
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

// Compute a blurhash from the ORIGINAL buffer. ensureAlpha() forces 4-channel RGBA (blurhash.encode
// assumes 4 bytes/pixel — a 3-channel raster mis-strides into garbage), downscaled to a tiny raster
// (encode is O(w*h*comp)). Uses info.width/height (post-resize), never the resize target.
async function computeBlurhash(originalBuf) {
  const { data, info } = await sharp(originalBuf)
    .resize(BLURHASH_RASTER, BLURHASH_RASTER, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (data.length !== info.width * info.height * 4) {
    throw new Error(`blurhash stride mismatch: ${data.length} != ${info.width}*${info.height}*4`);
  }
  return blurhashEncode(new Uint8ClampedArray(data), info.width, info.height, BLURHASH_COMPX, BLURHASH_COMPY);
}

export const handler = async (event) => {
  const rawPath = event.rawPath ?? '';

  if (rawPath === '/d/__selftest__') {
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    const webp = await sharp(png).webp().toBuffer();
    const bh = await computeBlurhash(png);
    const heif = sharp.format.heif;
    return resp(200, { sharp_ok: webp.length > 0, blurhash_ok: typeof bh === 'string' && bh.length > 0, heif_input: !!heif?.input?.buffer, vips: sharp.versions.vips, arch: process.arch });
  }

  const m = rawPath.match(/^\/d\/(thumb|card)\/([0-9a-fA-F-]+)\/(.+)\.webp$/);
  if (!m) return resp(404, { error: 'Not found' });
  const [, variant, etag, keyEncoded] = m;
  const originalKey = decodeURIComponent(keyEncoded);
  if (originalKey.includes('..')) return resp(404, { error: 'Not found' });

  let obj;
  try {
    obj = await s3.send(new GetObjectCommand({ Bucket: ORIGINALS_BUCKET, Key: originalKey }));
  } catch {
    return resp(404, { error: 'Original not found' });
  }
  const currentEtag = (obj.ETag ?? '').replace(/"/g, '');
  const original = Buffer.from(await obj.Body.transformToByteArray());

  let derivative;
  try {
    derivative = await VARIANTS[variant](sharp(original)).toBuffer();
  } catch (e) {
    console.error('derivative generation failed:', originalKey, e?.message);
    return resp(500, { error: 'Generation failed' });
  }

  // blurhash is a per-ORIGINAL property — compute ONCE, on the thumb variant only (avoids double work
  // and two-values-that-should-match). Non-fatal: a blurhash failure must not block the derivative.
  let blurhash = null;
  if (variant === 'thumb') {
    try { blurhash = await computeBlurhash(original); }
    catch (e) { console.error('blurhash failed (non-fatal):', originalKey, e?.message); }
  }

  if (currentEtag === etag && DERIVATIVES_BUCKET) {
    // persist so the next request is served by S3 (the /d/* primary origin)
    try {
      await s3.send(new PutObjectCommand({
        Bucket: DERIVATIVES_BUCKET, Key: rawPath.slice(1),
        Body: derivative, ContentType: 'image/webp', CacheControl: CACHE_CONTROL,
      }));
    } catch (e) { console.error('derivative persist failed (serving anyway):', e?.message); }
  }

  const headers = { 'content-type': 'image/webp', 'cache-control': currentEtag === etag ? CACHE_CONTROL : 'no-store' };
  if (blurhash) headers['x-blurhash'] = blurhash;
  return { statusCode: 200, headers, body: derivative.toString('base64'), isBase64Encoded: true };
};
