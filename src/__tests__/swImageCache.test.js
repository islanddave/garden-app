// V4-PHOTOCDN-001 P2 — static-source guard for public/sw.js image-cache correctness
// (household-mode.test.js pattern: DB/DOM-free source asserts; sw.js runs in a worker
// context vitest can't execute directly). Pins: versioned IMAGE_CACHE, no activate-purge
// exclusion of a fixed image cache, content-type guard, signing-param normalization.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8')

describe('sw.js image cache (V4-PHOTOCDN-001 P2)', () => {
  it('IMAGE_CACHE is versioned by CACHE_VERSION (never a fixed name)', () => {
    expect(SRC).toMatch(/const IMAGE_CACHE\s*=\s*`images-\$\{CACHE_VERSION\}`/)
    expect(SRC).not.toMatch(/IMAGE_CACHE\s*=\s*'garden-images'/)
  })
  it('activate purge has no unversioned image-cache survivor', () => {
    // V4-SWCACHEID-001 replaced the exact-equality allowlist with the keepCacheKey predicate (the
    // allowlist could not express a per-sub API name). The invariant this test guards is unchanged:
    // anything not matched by the predicate purges, so no unversioned image cache survives.
    // Behavioural coverage of the same purge lives in swCacheIdentity.test.js.
    expect(SRC).toMatch(/\.filter\(k => !keepCacheKey\(k, CACHE_VERSION\)\)/)
    expect(SRC).toMatch(/if \(key === `images-\$\{version\}`\) return true|key === `images-\$\{version\}`/)
    expect(SRC).not.toMatch(/'garden-images'/)
  })
  it('image responses are cached only when status 200 AND content-type image/*', () => {
    // V4-PHOTOSWHARDEN-001 moved this expression out of imageCacheFirst into isImageResponse so the
    // activate purge can share one predicate. Same invariant, new home — pinned at both ends.
    expect(SRC).toMatch(/function isImageResponse[\s\S]*?startsWith\('image\/'\)/)
    expect(SRC).toMatch(/if \(isImageResponse\(response\)\) \{/)
  })
  it('CloudFront signing params are stripped from the image cache key (match AND put)', () => {
    // WHY THE PINNED LIST CHANGED (V4-PHOTOCORS-001, 2026-08-26). This test pinned the CloudFront
    // params as the WHOLE of the normalization, and that pin was encoding a bug: the CDN path is
    // dormant (the garden-photos Lambda has no PHOTO_CDN_ENABLED, so resolvePhotoViewUrl presigns
    // S3), which means the only signing params any photo URL actually carries are X-Amz-*, and none
    // of them were stripped. Every 900s re-mint was therefore a fresh cache key. The four CloudFront
    // names stay — that path is dormant, not deleted — and the X-Amz family joins them.
    //
    // The call signature moved too, and that is the load-bearing part: normalizeImageUrl now takes a
    // second argument saying whether this request was issued in CORS mode, because the X-Amz strip
    // is only meaningful for a request whose response is NOT opaque. Pinning the old one-argument
    // call would re-pin the half-fix.
    expect(SRC).toMatch(/SIGNING_PARAMS = \['Expires', 'Signature', 'Key-Pair-Id', 'Policy'\]/)
    expect(SRC).toMatch(/PRESIGN_PARAM_PREFIX = 'x-amz-'/)
    expect(SRC).toMatch(/normalizeImageUrl\(request\.url, cors\)/)
    expect(SRC).toMatch(/cache\.match\(key\)/)
    expect(SRC).toMatch(/cache\.put\(key, response\.clone\(\)\)/)
  })

  it('the presign strip is gated on the request mode, never applied unconditionally', () => {
    // The coupling between the two halves of PHOTO_CORS_CACHE_ENABLED is this line and nothing else:
    // sw.js cannot import the flag, so it infers it from the request. Deleting the gate would make
    // the SW half live against a client that never sets crossOrigin — the reachable half-state the
    // flag design exists to prevent.
    expect(SRC).toMatch(/const cors = request\.mode === 'cors'/)
    expect(SRC).toMatch(/if \(corsMode\) \{/)
  })
  it('images route through imageCacheFirst (guarded path), not generic cacheFirst', () => {
    expect(SRC).toMatch(/isImage\(url\)\) \{\s*\n\s*event\.respondWith\(imageCacheFirst\(request\)\)/)
  })
})

// BUG-BOOTSTALL-001 — navigations fail over to the cached shell FAST; APIs keep the long bound.
// Pins the split so a refactor can't silently re-unify them (the 12s nav bound was the frozen
// pre-splash screen on degraded routes).
describe('sw.js navigation vs API timeout split', () => {
  it('defines a short NAV_TIMEOUT_MS and keeps SW_TIMEOUT_MS for APIs', () => {
    const nav = SRC.match(/const NAV_TIMEOUT_MS = (\d+)/);
    const api = SRC.match(/const SW_TIMEOUT_MS = (\d+)/);
    expect(nav).toBeTruthy();
    expect(api).toBeTruthy();
    expect(Number(nav[1])).toBeLessThanOrEqual(5000);
    expect(Number(nav[1])).toBeLessThan(Number(api[1]));
  });
  it('navigationFallback uses the NAV bound; networkFirst keeps the API bound', () => {
    const navFn = SRC.slice(SRC.indexOf('async function navigationFallback'), SRC.indexOf('async function networkFirst'));
    expect(navFn.indexOf('fetchWithTimeout(networkReq, NAV_TIMEOUT_MS)')).toBeGreaterThan(-1);
    expect(navFn.indexOf('fetchWithTimeout(networkReq, SW_TIMEOUT_MS)')).toBe(-1);
    const apiFn = SRC.slice(SRC.indexOf('async function networkFirst'));
    expect(apiFn.indexOf('fetchWithTimeout(networkReq, SW_TIMEOUT_MS)')).toBeGreaterThan(-1);
  });
});
