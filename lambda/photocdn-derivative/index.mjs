// V4-PHOTOCDN-001 — derivative REPAIR Lambda (origin-group failover target).
// Primary serving is the eager-backfilled derivatives bucket (spec V101 §5 P3d);
// this fires only when a derivative is absent (new upload race, backfill gap).
// Path contract (path-addressed, NOT opaque-hashed — the key must be reversible):
//   GET /d/<variant>/<etag>/<original-key...>.webp
//   variant ∈ {thumb, card}; etag = original's S3 ETag (hex, no quotes) —
//   replacement at the same key yields a new etag => new derivative path (free invalidation).
// Function URL is AuthType NONE + x-origin-verify secret header (CloudFront origin
// custom header, validated below) - IAM+OAC is unusable on origin-group failover
// members (CloudFront doesn't sign retries; verified 2026-07-02).
// ETag-mismatch semantics: serve from CURRENT original but SKIP the S3 write
// (never persist a derivative under a stale-etag key).
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';

const s3 = new S3Client({});
const ORIGINALS_BUCKET = process.env.ORIGINALS_BUCKET ?? 'garden-photos-prod';
const DERIVATIVES_BUCKET = process.env.DERIVATIVES_BUCKET;
const VARIANTS = {
  thumb: (img) => img.resize(96, 96, { fit: 'cover' }).webp({ quality: 70 }),
  card:  (img) => img.resize({ width: 480, withoutEnlargement: true }).webp({ quality: 75 }),
};
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

const resp = (status, body, headers = {}) => ({
  statusCode: status,
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

export const handler = async (event) => {
  // Origin auth: only CloudFront (which injects x-origin-verify) may use this URL.
  // Direct boto3 Invoke (self-test) bypasses the URL layer and carries no headers -
  // permitted only for the self-test route.
  const rawPath = event.rawPath ?? '';
  const verify = event.headers?.['x-origin-verify'];
  const expected = process.env.ORIGIN_VERIFY_SECRET;
  if (rawPath !== '/d/__selftest__' && expected && verify !== expected) {
    return resp(403, { error: 'Forbidden' });
  }
  if (rawPath === '/d/__selftest__') {
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    const webp = await sharp(png).webp().toBuffer();
    const heif = sharp.format.heif;
    return resp(200, { sharp_ok: webp.length > 0, heif_input: !!heif?.input?.buffer, vips: sharp.versions.vips, arch: process.arch });
  }

  const m = rawPath.match(/^\/d\/(thumb|card)\/([0-9a-f]+)\/(.+)\.webp$/);
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

  if (currentEtag === etag && DERIVATIVES_BUCKET) {
    // persist so the next request is served by S3 (primary origin)
    try {
      await s3.send(new PutObjectCommand({
        Bucket: DERIVATIVES_BUCKET, Key: rawPath.slice(1),
        Body: derivative, ContentType: 'image/webp', CacheControl: CACHE_CONTROL,
      }));
    } catch (e) { console.error('derivative persist failed (serving anyway):', e?.message); }
  }

  return {
    statusCode: 200,
    headers: { 'content-type': 'image/webp', 'cache-control': currentEtag === etag ? CACHE_CONTROL : 'no-store' },
    body: derivative.toString('base64'),
    isBase64Encoded: true,
  };
};
