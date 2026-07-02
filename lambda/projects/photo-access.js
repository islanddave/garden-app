// photo-access.js — V4-PHOTOCDN-001 P1 issuance seam (single access-resolver).
// resolvePhotoViewUrl routes ALL photo GET-URL issuance through one place so the runtime
// kill-flag PHOTO_CDN_ENABLED can switch between the legacy S3 presign path (default/OFF —
// byte-identical to pre-seam behavior) and CloudFront signed URLs against the dedicated photos
// distribution (ON). Sharing (V4-PHOTOSHARE-001) later = a new branch here, zero call-site edits.
//
// DEPLOY NOTE (mirrors household.js): each Lambda is zipped from its OWN dir
// (deploy-lambda.yml: `cd lambda/<fn> && zip -r ../<fn>.zip .`), so a `../photo-access.js` import
// is NOT packaged and 502s at module load. An IDENTICAL copy of this file lives in each signer dir
// (photos, plants, projects, locations, inventory-items), imported as `./photo-access.js`; copies
// are kept byte-identical by lambda/photo-access-copies-sync.test.js.
//
// BYTE-IDENTITY (flag OFF): the caller passes its OWN existing presign helper as `presign`; the OFF
// branch returns presign(storagePath) verbatim — the exact pre-seam code path (same S3 client, same
// expiresIn). No new import executes on the OFF path (cloudfront-signer + secrets-manager are lazily
// imported INSIDE the ON branch), so a packaging miss can NEVER 502 an OFF Lambda.

export const PHOTO_URL_TTL_SECONDS = 900; // 15 min — shared by both paths (keep OFF/ON in lockstep)

// Encode each key segment but preserve '/' separators (S3 keys are UUID/hex today; defensive).
function encodeKeyPath(key) {
  return String(key).split('/').map(encodeURIComponent).join('/');
}

let _cdnKeyPem = null, _cdnKeyAt = 0;
const CDN_KEY_TTL_MS = 5 * 60 * 1000; // refetch a rotated signing key without a cold start
async function cdnPrivateKey(sm) {
  if (_cdnKeyPem && (Date.now() - _cdnKeyAt) < CDN_KEY_TTL_MS) return _cdnKeyPem;
  const { GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const res = await sm.send(new GetSecretValueCommand({
    SecretId: process.env.PHOTO_CDN_SIGNING_SECRET ?? 'garden-app/photocdn-signing',
  }));
  _cdnKeyPem = JSON.parse(res.SecretString).private_key_pem_v1;
  _cdnKeyAt = Date.now();
  return _cdnKeyPem;
}

// Sign an originals-passthrough (/o/*) CloudFront URL for a raw S3 storage key. The distro's
// viewer-request function (photocdn-strip-o-prefix) strips the leading /o before S3, so the signed
// path is /o/<key> and the origin object is <key>. keyPairId = the CloudFront PUBLIC KEY id
// (K1JIPLZ9SVNU1N), a member of the trusted key group attached to /o/*.
async function signCdnOriginalUrl(storagePath, sm) {
  const { getSignedUrl } = await import('@aws-sdk/cloudfront-signer');
  const url = `https://${process.env.PHOTO_CDN_DOMAIN}/o/${encodeKeyPath(storagePath)}`;
  const dateLessThan = new Date(Date.now() + PHOTO_URL_TTL_SECONDS * 1000).toISOString();
  return getSignedUrl({
    url,
    keyPairId: process.env.PHOTO_CDN_KEY_PAIR_ID,
    privateKey: await cdnPrivateKey(sm),
    dateLessThan,
  });
}

// The single access-resolver. `presign` is the caller's OWN existing presign helper (guarantees
// byte-identical OFF behavior). `sm` is the caller's SecretsManagerClient (only used when ON).
// Returns a viewable URL string, or null for a missing path (matches pre-seam null handling).
export async function resolvePhotoViewUrl(storagePath, { presign, sm } = {}) {
  if (!storagePath) return null;
  if (process.env.PHOTO_CDN_ENABLED === 'true') {
    try {
      return await signCdnOriginalUrl(storagePath, sm);
    } catch (err) {
      // Loud fallback: a broken CDN signer silently reverting to presign would MASK a failed flip.
      // Emit a distinct token so a CloudWatch metric-filter alarm catches a fallback storm.
      console.error('PHOTO_CDN_SIGN_FALLBACK cdn sign failed; using presign', err?.message ?? err);
      return presign(storagePath);
    }
  }
  return presign(storagePath);
}
