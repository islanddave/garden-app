import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripQuotes, derivativeKey, invokeRawPath, isBackfilled, REQUIRED_COLUMNS } from './photocdn-backfill-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DRIVER = readFileSync(join(here, 'photocdn-backfill.mjs'), 'utf8');
const GEN = readFileSync(join(here, '..', 'lambda', 'photocdn-derivative', 'index.mjs'), 'utf8');
const YML = readFileSync(join(here, '..', '.github', 'workflows', 'deploy-lambda.yml'), 'utf8');

describe('backfill pure helpers', () => {
  it('derivativeKey is path-addressed, etag-scoped, quote-stripped', () => {
    expect(derivativeKey('thumb', '"abc123"', 'plants/p1/a.jpg')).toBe('d/thumb/abc123/plants/p1/a.jpg.webp');
    expect(derivativeKey('card', 'e-2', 'events/e/x.jpg')).toBe('d/card/e-2/events/e/x.jpg.webp'); // multipart -N kept
    expect(() => derivativeKey('full', 'x', 'k')).toThrow();
  });
  it('invokeRawPath is the derivative key with a leading slash (matches generator rawPath)', () => {
    expect(invokeRawPath('thumb', 'abc', 'plants/a.jpg')).toBe('/d/thumb/abc/plants/a.jpg.webp');
  });
  it('isBackfilled requires etag match AND all three derivative fields', () => {
    const full = { original_etag: 'abc', derivative_thumb_key: 't', derivative_card_key: 'c', blurhash: 'L5' };
    expect(isBackfilled(full, 'abc')).toBe(true);
    expect(isBackfilled(full, 'CHANGED')).toBe(false);           // etag drift -> regenerate
    expect(isBackfilled({ ...full, blurhash: null }, 'abc')).toBe(false); // missing field -> not done
    expect(isBackfilled({ original_etag: null }, 'abc')).toBe(false);
  });
  it('stripQuotes + REQUIRED_COLUMNS', () => {
    expect(stripQuotes('"x"')).toBe('x');
    expect(REQUIRED_COLUMNS).toEqual(['original_etag','derivative_thumb_key','derivative_card_key','blurhash']);
  });
});

describe('backfill driver safety (static guards)', () => {
  it('DRY-RUN by default — writes require --execute', () => {
    expect(DRIVER).toMatch(/const execute = has\('--execute'\)/);
    expect(DRIVER).toMatch(/if \(!execute\) \{ planned\+\+/);
  });
  it('PREFLIGHT asserts the additive columns exist before any generation (L-238)', () => {
    expect(DRIVER).toContain('PREFLIGHT FAIL');
    expect(DRIVER).toMatch(/information_schema\.columns/);
  });
  it('AWS/DB clients are lazy-imported inside main() (module loads test-clean)', () => {
    expect(DRIVER).not.toMatch(/^import .*(client-lambda|client-s3|neondatabase)/m);
    expect(DRIVER).toMatch(/await import\('@aws-sdk\/client-lambda'\)/);
  });
  it('per-row UPDATE is immediate (DB is the resumable ledger)', () => {
    expect(DRIVER).toMatch(/UPDATE photos SET original_etag=/);
  });
});

describe('generator (V102 internal-invoke + blurhash) static guards', () => {
  it('stale failover / x-origin-verify framing removed', () => {
    expect(GEN).not.toMatch(/x-origin-verify/);
    expect(GEN).not.toMatch(/origin-group failover/);
  });
  it('blurhash computed once on the thumb variant, RGBA raster, fixed 4x3, returned via x-blurhash header', () => {
    expect(GEN).toContain("import { encode as blurhashEncode } from 'blurhash'");
    expect(GEN).toMatch(/\.ensureAlpha\(\)\s*\.raw\(\)/);
    expect(GEN).toMatch(/if \(variant === 'thumb'\)/);
    expect(GEN).toMatch(/headers\['x-blurhash'\] = blurhash/);
    expect(GEN).toMatch(/data\.length !== info\.width \* info\.height \* 4/); // stride assert
  });
});

describe('deploy-lambda.yml matrix guards for photocdn-derivative', () => {
  it('added to the matrix', () => { expect(YML).toMatch(/tags, photocdn-derivative\]/); });
  it('EXCLUDED from the public Function-URL step (spec-B2)', () => {
    expect(YML).toMatch(/Ensure Function URL exists[\s\S]*?matrix\.function != 'photocdn-derivative'/);
  });
  it('EXCLUDED from the CORS restore step', () => {
    expect(YML).toMatch(/Restore Lambda Function URL CORS[\s\S]*?matrix\.function != 'photocdn-derivative'/);
  });
  it('arm64 sharp build with in-zip assertion', () => {
    expect(YML).toMatch(/npm install --omit=dev --os=linux --cpu=arm64 --include=optional/);
    expect(YML).toMatch(/sharp-linux-arm64.*refusing to deploy an x64 build/s);
  });
  it('post-deploy self-test invoke + no-Function-URL assertion', () => {
    expect(YML).toMatch(/rawPath.*__selftest__/);
    expect(YML).toMatch(/spec-B2 forbids a public surface/);
  });
});
