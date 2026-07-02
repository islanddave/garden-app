// V4-PHOTOCDN-001 P1 — static source guards for the issuance seam.
// Repo convention: lambda handler modules import AWS SDK (not resolvable at repo root) and are
// NOT executed in unit tests; behavior is pinned with source-level assertions (see
// household-mode.test.js / evidence-capture.test.js). Runtime cross-dir identity is covered by
// photo-access-copies-sync.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, 'photo-access.js'), 'utf8');

describe('photo-access seam — OFF path is byte-identical presign passthrough', () => {
  it('default/OFF returns the caller presign result with the RAW path (final statement)', () => {
    // the function ends by delegating to the caller-supplied presign — the exact pre-seam path
    expect(SRC).toMatch(/return presign\(storagePath\);\s*\n\}/);
  });
  it('missing path returns null before any work (matches pre-seam null handling)', () => {
    expect(SRC).toMatch(/if \(!storagePath\) return null;/);
  });
  it('CDN work is gated entirely inside PHOTO_CDN_ENABLED === "true" (OFF never signs/reads secret)', () => {
    // the signCdn call sits INSIDE the ON gate's try block — OFF never reaches it
    expect(SRC).toMatch(/PHOTO_CDN_ENABLED === 'true'\)\s*\{\s*try \{\s*return await signCdnOriginalUrl\(storagePath, sm\);/);
  });
  it('AWS modules are lazy-imported INSIDE functions (no top-level import → OFF can never 502)', () => {
    expect(SRC).not.toMatch(/^import .*(cloudfront-signer|client-secrets-manager)/m);
    expect(SRC).toMatch(/await import\('@aws-sdk\/cloudfront-signer'\)/);
    expect(SRC).toMatch(/await import\('@aws-sdk\/client-secrets-manager'\)/);
  });
});

describe('photo-access seam — ON path signing correctness', () => {
  it('signs the /o/* originals-passthrough URL against PHOTO_CDN_DOMAIN with encoded key segments', () => {
    expect(SRC).toMatch(/https:\/\/\$\{process\.env\.PHOTO_CDN_DOMAIN\}\/o\/\$\{encodeKeyPath\(storagePath\)\}/);
    expect(SRC).toMatch(/\.split\('\/'\)\.map\(encodeURIComponent\)\.join\('\/'\)/);
  });
  it('uses the CloudFront public-key id env + the Secrets Manager PEM field private_key_pem_v1', () => {
    expect(SRC).toMatch(/keyPairId: process\.env\.PHOTO_CDN_KEY_PAIR_ID/);
    expect(SRC).toContain('private_key_pem_v1');
    expect(SRC).toMatch(/PHOTO_CDN_SIGNING_SECRET \?\? 'garden-app\/photocdn-signing'/);
  });
  it('15-min TTL shared by both paths', () => {
    expect(SRC).toMatch(/PHOTO_URL_TTL_SECONDS = 900/);
  });
  it('fallback is LOUD (distinct token) then delegates to presign — never silently masks a failed flip', () => {
    expect(SRC).toContain('PHOTO_CDN_SIGN_FALLBACK');
  });
});

describe('photo-access seam — all 6 call sites route through the resolver', () => {
  const DIRS = ['photos', 'plants', 'projects', 'locations', 'inventory-items'];
  for (const d of DIRS) {
    it(`${d}/index.js imports + calls resolvePhotoViewUrl and passes its own presign + sm`, () => {
      const idx = readFileSync(join(here, d, 'index.js'), 'utf8');
      expect(idx).toMatch(/import \{ resolvePhotoViewUrl \} from '\.\/photo-access\.js';/);
      expect(idx).toMatch(/resolvePhotoViewUrl\([^)]*\{ presign: \w+, sm \}\)/);
    });
  }
  it('photos upload PUT presign path is untouched (still mints its own S3 PUT URL)', () => {
    const idx = readFileSync(join(here, 'photos', 'index.js'), 'utf8');
    expect(idx).toMatch(/upload_url = await getSignedUrl\(s3, cmd, \{ expiresIn: 300 \}\)/);
    // upload-url route must NOT route through the read-side resolver
    expect(idx).not.toMatch(/resolvePhotoViewUrl\([^)]*upload/i);
  });
});
