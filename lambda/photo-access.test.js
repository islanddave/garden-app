// V4-PHOTOCDN-001 P1 — static source guards for the issuance seam.
// Repo convention: lambda handler modules import AWS SDK (not resolvable at repo root) and are
// NOT executed in unit tests; behavior is pinned with source-level assertions (see
// household-mode.test.js / evidence-capture.test.js). Runtime cross-dir identity is covered by
// photo-access-copies-sync.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct: deleting live code and leaving
// `// was: <it>` or `TRUE -- dropped: <it>` behind made every raw-source guard below find its
// own epitaph and pass. Assertions run against decommented source. The `//` arm is URL-safe
// (the `[^:]` guard keeps `https://` intact); the `--` arm requires surrounding space so a JS
// decrement is never read as a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(join(here, 'photo-access.js'), 'utf8'));

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

// Per-dir call-site counts, not just "at least one call somewhere in the file".
// The old shape was `for (const d of DIRS) expect(idx).toMatch(/resolvePhotoViewUrl\(.../)` —
// one matching call satisfied the whole file. Proven vacuous by mutation: rewrite
// lambda/plants/index.js:753 from `await resolvePhotoViewUrl(path, { presign: getFeaturedPhotoViewUrl, sm })`
// to `await getFeaturedPhotoViewUrl(path)` and all 14 tests stayed GREEN — that read path
// then served an unsigned S3 presign with no CloudFront signing and no PHOTO_CDN_SIGN_FALLBACK
// telemetry, which is the entire defect this describe block exists to catch. The old title
// also said "all 6 call sites" while checking 5 dirs; there are 9.
const SITES = { photos: 4, plants: 2, projects: 1, locations: 1, 'inventory-items': 1 };
const TOTAL_SITES = Object.values(SITES).reduce((a, b) => a + b, 0); // 9 at d9afab95

describe('photo-access seam — all 9 call sites route through the resolver', () => {
  // Derived from disk, not hand-listed: a dir that starts importing the resolver must be
  // enrolled, and a dir that STOPS importing it (the seam removed wholesale) turns this red
  // instead of quietly shrinking the loop to nothing.
  it('SITES enumerates EVERY dir that imports the resolver', () => {
    const onDisk = readdirSync(here, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((d) => existsSync(join(here, d, 'index.js'))
        && /import \{ resolvePhotoViewUrl \} from '\.\/photo-access\.js';/
          .test(decomment(readFileSync(join(here, d, 'index.js'), 'utf8'))))
      .sort();
    expect(onDisk).toEqual(Object.keys(SITES).sort());
  });

  for (const [d, expected] of Object.entries(SITES)) {
    it(`${d}/index.js routes ALL ${expected} of its photo reads through resolvePhotoViewUrl`, () => {
      const idx = decomment(readFileSync(join(here, d, 'index.js'), 'utf8'));
      expect(idx).toMatch(/import \{ resolvePhotoViewUrl \} from '\.\/photo-access\.js';/);
      const calls = idx.match(/resolvePhotoViewUrl\(/g) ?? [];
      // Exact, not >=: dropping a site is the regression, so a shrink must fail. A NEW site is
      // also a deliberate change — bump the count here so the seam census stays honest.
      expect(calls.length, `${d}: expected ${expected} resolvePhotoViewUrl call site(s); a removed ` +
        'site means that read path bypasses CDN signing entirely').toBe(expected);
      // Every call must carry the caller's own presign + secrets-manager handle. Counting
      // instead of toMatch-ing stops one well-formed call from vouching for a malformed sibling.
      const wellFormed = idx.match(/resolvePhotoViewUrl\([^)]*\{ presign: \w+, sm \}\)/g) ?? [];
      expect(wellFormed.length, `${d}: every resolvePhotoViewUrl call must pass { presign, sm }`)
        .toBe(expected);
    });
  }

  it('the seam census is not vacuous (floor across the whole fleet)', () => {
    const total = Object.keys(SITES).reduce((n, d) =>
      n + (decomment(readFileSync(join(here, d, 'index.js'), 'utf8')).match(/resolvePhotoViewUrl\(/g) ?? []).length, 0);
    expect(total).toBe(TOTAL_SITES);
  });
  it('photos upload PUT presign path is untouched (still mints its own S3 PUT URL)', () => {
    const idx = decomment(readFileSync(join(here, 'photos', 'index.js'), 'utf8'));
    expect(idx).toMatch(/upload_url = await getSignedUrl\(s3, cmd, \{ expiresIn: 300 \}\)/);
    // upload-url route must NOT route through the read-side resolver
    expect(idx).not.toMatch(/resolvePhotoViewUrl\([^)]*upload/i);
  });
});
