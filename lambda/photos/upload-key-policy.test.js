// A0.1 — GET /api/photos/upload-url caller-named-key confinement.
// Two layers, per repo convention: the pure policy module is executed for real
// (batch-validators.test.js pattern), and the route wiring is pinned with route-scoped
// source anchors (feed-route.test.js pattern — bounded by the NEXT route marker, never
// global-first-match or fixed char offsets).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAllowedUploadKey, UPLOAD_KEY_PREFIXES } from './uploadKeyPolicy.js';
import { buildPhotoKey, PHOTO_PREFIXES } from '../../src/lib/photoKeys.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, 'index.js'), 'utf8');

const UUID = 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const ID = '11111111-1111-4111-8111-111111111111';

describe('uploadKeyPolicy — accepts exactly the client grammar', () => {
  it('accepts every buildPhotoKey output shape (client-server grammar contract)', () => {
    for (const prefix of PHOTO_PREFIXES) {
      const key = buildPhotoKey({ prefix, id: prefix === 'standalone' ? undefined : ID, uuid: UUID, ext: 'jpg' });
      expect(isAllowedUploadKey(key), key).toBe(true);
    }
  });
  it('policy prefix list matches the client PHOTO_PREFIXES list', () => {
    expect([...UPLOAD_KEY_PREFIXES]).toEqual([...PHOTO_PREFIXES]);
  });
  it('accepts the genUuid fallback shape and common image exts', () => {
    expect(isAllowedUploadKey('standalone/m3kx9q2f-a1b2c3d4.webp')).toBe(true);
    for (const ext of ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif']) {
      expect(isAllowedUploadKey(`plants/${ID}/${UUID}.${ext}`)).toBe(true);
    }
  });
});

describe('uploadKeyPolicy — rejects everything outside the grammar', () => {
  const rejected = [
    // inbox is server-derived ONLY — own or foreign, caller-named inbox keys are spoofs
    `inbox/user_3D2gM0hIl03gjW3JM2DjtPzm0jI/${UUID}.jpg`,
    `inbox/user_someoneelse/${UUID}.jpg`,
    // traversal / absolute / bucket-root
    '../../etc/passwd',
    `standalone/../releases.json`,
    `plants/${ID}/../../sw.js`,
    `/standalone/${UUID}.jpg`,
    'releases.json',
    'sw.js',
    'index.html',
    // foreign prefixes and shape violations
    `uploads/${UUID}.jpg`,
    `knowledge/${UUID}.jpg`,
    `standalone/${ID}/${UUID}.jpg`,
    `plants/${UUID}.jpg`,
    `plants//${UUID}.jpg`,
    `plants/${ID}/sub/${UUID}.jpg`,
    // dotted segments / multi-extension / uppercase ext (client lowercases)
    `standalone/${UUID}.php.jpg`,
    `standalone/.${UUID}.jpg`,
    `standalone/${UUID}.JPG`,
    `standalone/${UUID}.`,
    `standalone/${UUID}`,
    // encoding / whitespace / control garbage
    `standalone/${UUID}%2e%2e.jpg`,
    `standalone/a b.jpg`,
    'standalone/\u0000.jpg',
    'standalone/ .jpg',
    '',
  ];
  for (const key of rejected) {
    it(`403-class reject: ${JSON.stringify(key)}`, () => {
      expect(isAllowedUploadKey(key)).toBe(false);
    });
  }
  it('rejects non-strings and oversized keys', () => {
    expect(isAllowedUploadKey(null)).toBe(false);
    expect(isAllowedUploadKey(undefined)).toBe(false);
    expect(isAllowedUploadKey(42)).toBe(false);
    expect(isAllowedUploadKey(`standalone/${'a'.repeat(300)}.jpg`)).toBe(false);
  });
});

// Route-bounded window: from the upload-url route marker to the NEXT route marker (batch).
function uploadUrlBlock(src) {
  const i = src.indexOf("rawPath === '/api/photos/upload-url'");
  if (i === -1) return '';
  const next = src.indexOf("rawPath === '/api/photos/batch'", i + 1);
  return src.slice(i, next === -1 ? undefined : next);
}

describe('photos Lambda — upload-url route enforces the policy', () => {
  const b = uploadUrlBlock(SRC);
  it('routes GET /api/photos/upload-url', () => {
    expect(SRC).toMatch(/rawPath === '\/api\/photos\/upload-url' && method === 'GET'/);
  });
  it('imports the policy module', () => {
    expect(SRC).toMatch(/import \{ isAllowedUploadKey \} from '\.\/uploadKeyPolicy\.js';/);
  });
  it('gates BOTH key grammar and content type BEFORE presigning, and 403s', () => {
    expect(b).toMatch(/if \(!isAllowedUploadKey\(key\) \|\| !SAFE_CONTENT_TYPE\.test\(contentType\)\) \{\s*return resp\(403/);
    // the reject must precede the presign in the block
    expect(b.indexOf('resp(403')).toBeGreaterThan(-1);
    expect(b.indexOf('resp(403')).toBeLessThan(b.indexOf('getSignedUrl'));
  });
  it('missing key is still a 400 (shape preserved for legitimate callers)', () => {
    expect(b).toMatch(/if \(!key\) return resp\(400, \{ error: 'key is required' \}\);/);
  });
  it('response shape and 5-min expiry unchanged', () => {
    expect(b).toMatch(/upload_url = await getSignedUrl\(s3, cmd, \{ expiresIn: 300 \}\)/);
    expect(b).toMatch(/return resp\(200, \{ upload_url, key \}\);/);
  });
});
