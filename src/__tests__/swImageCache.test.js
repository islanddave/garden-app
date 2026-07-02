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
    // the filter keeps only the three CURRENT versioned names; anything else purges
    const m = SRC.match(/\.filter\(k => k !== STATIC_CACHE && k !== API_CACHE && k !== IMAGE_CACHE\)/)
    expect(m).toBeTruthy()
    expect(SRC).not.toMatch(/'garden-images'/)
  })
  it('image responses are cached only when status 200 AND content-type image/*', () => {
    expect(SRC).toMatch(/response\.status === 200 && type\.startsWith\('image\/'\)/)
  })
  it('CloudFront signing params are stripped from the image cache key (match AND put)', () => {
    expect(SRC).toMatch(/SIGNING_PARAMS = \['Expires', 'Signature', 'Key-Pair-Id', 'Policy'\]/)
    expect(SRC).toMatch(/normalizeImageUrl\(request\.url\)/)
    expect(SRC).toMatch(/cache\.match\(key\)/)
    expect(SRC).toMatch(/cache\.put\(key, response\.clone\(\)\)/)
  })
  it('images route through imageCacheFirst (guarded path), not generic cacheFirst', () => {
    expect(SRC).toMatch(/isImage\(url\)\) \{\s*\n\s*event\.respondWith\(imageCacheFirst\(request\)\)/)
  })
})
