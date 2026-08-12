// W-RESTORE — ROUTE CONTRACT. The two paths the Recently deleted page calls, proven against the two
// surfaces that actually decide whether a request lands.
//
// WHY THIS FILE EXISTS, precisely. Earlier the same day, a component and its test each declared the
// same private route literal; the UI shipped pointing at an endpoint nobody serves, with 33 green
// tests, because the test asserted the component's own string back at itself. The defence is not
// "assert harder" — it is to assert against artefacts THIS TEST DID NOT WRITE:
//
//   1. src/lib/api.js's real FUNCTION_URLS prefix table, via the real resolveUrl. If /api/photos/*
//      ever stops resolving to a configured Lambda, resolveUrl THROWS and this file goes red — the
//      client-side half of "the request goes somewhere".
//   2. lambda/photos/index.js's real route matchers, read off disk. The server-side half. This is
//      the assertion that a same-day sibling lane did not have.
//
// Neither is authored here, so agreement between them and src/lib/deletedPhotos.js cannot be
// self-fulfilling. Static-source is the correct tier for #2: index.js is not importable from the
// repo root (its @aws-sdk/@clerk/@neondatabase deps are per-Lambda), which is exactly the condition
// that made a literal-vs-literal test look sufficient in the first place.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveUrl } from '../lib/api.js'
import { DELETED_PHOTOS_PATH, restorePhotoPath } from '../lib/deletedPhotos.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HANDLER = readFileSync(resolve(__dirname, '../../lambda/photos/index.js'), 'utf8')
const UUID = '4bf9dcd4-aece-42b5-b926-8f52d36f8c34'

describe('W-RESTORE route contract — client paths vs the real handler', () => {
  it('the list path is matched by a GET arm in lambda/photos/index.js', () => {
    // The handler matches this path by EXACT string comparison, so the exact string is what has to
    // appear — with its method. A path that matches no arm falls through to the 405 at the bottom of
    // the try block, which the page would surface as an unexplained load failure.
    expect(HANDLER).toContain(`rawPath === '${DELETED_PHOTOS_PATH}' && method === 'GET'`)
  })

  it('the restore path is matched by the handler’s OWN regex, extracted from its source', () => {
    // The regex is lifted out of index.js and executed here, rather than re-typed. Re-typing it
    // would reintroduce the two-guesses-that-agree failure at one remove.
    const m = HANDLER.match(/const restoreMatch = rawPath\.match\((\/.+?\/)\);/)
    expect(m, 'restoreMatch regex not found in lambda/photos/index.js').toBeTruthy()
    const re = new RegExp(m[1].slice(1, -1))
    const path = restorePhotoPath(UUID)
    expect(re.test(path)).toBe(true)
    expect(path.match(re)[1]).toBe(UUID)   // the id must land in the capture group the handler reads
    expect(HANDLER).toContain("if (restoreMatch && method === 'POST')")
  })

  it('the list path does NOT collide with the exact-match /api/photos list route', () => {
    // A prefix comparison here would make every deleted-list request return the LIVE library instead
    // — a wrong page with a 200, which no error state can catch.
    expect(HANDLER).toContain("rawPath === '/api/photos' && method === 'GET'")
    expect(DELETED_PHOTOS_PATH).not.toBe('/api/photos')
    expect(HANDLER.indexOf(`rawPath === '${DELETED_PHOTOS_PATH}'`))
      .toBeLessThan(HANDLER.indexOf("rawPath === '/api/photos' && method === 'GET'"))
  })

  it('both paths resolve through the real api.js prefix table', () => {
    // resolveUrl THROWS for an unconfigured prefix. `/api/photos-deleted` (a plausible slip) would
    // throw; `/api/photos/deleted` must not, and must route to the photos Lambda base.
    const base = resolveUrl('/api/photos')
    expect(() => resolveUrl(DELETED_PHOTOS_PATH)).not.toThrow()
    expect(() => resolveUrl(restorePhotoPath(UUID))).not.toThrow()
    expect(resolveUrl(DELETED_PHOTOS_PATH)).toBe(`${base}/deleted`)
    expect(resolveUrl(restorePhotoPath(UUID))).toBe(`${base}/${UUID}/restore`)
  })

  it('the handler serves the deleted list from listDeletedPhotos, not a local SELECT', () => {
    // The 0A.6 enumeration guard (read-paths-deletedat.test.js) asserts every `SELECT ... FROM
    // photos` template in index.js filters `deleted_at IS NULL`. Keeping this query in photoDelete.js
    // is what keeps that guard both TRUE and meaningful; a local SELECT here would either break it or
    // force it to be weakened.
    expect(HANDLER).toContain('listDeletedPhotos')
    expect(HANDLER).not.toMatch(/FROM photos[\s\S]{0,400}deleted_at IS NOT NULL/)
  })
})
