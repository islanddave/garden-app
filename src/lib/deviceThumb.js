// src/lib/deviceThumb.js — BUG-SEEDTHUMBSOFFLINE-001. "Does this phone already hold the thumb?"
//
// The seed list carries each lot's photo ID and its thumb's object KEY (`hero_thumb_key`,
// thumbs/<storage path>), never a signed link (BUG-SEEDLISTSIGNING-001). Minting a link per drawn
// row made My seeds depend on the network for pictures the phone had already downloaded: offline, or
// on a signal too weak to mint, rows it had shown a hundred times drew grey boxes. This asks the
// photo cache first.
//
// HOW THE CACHE IS KEYED, which is the whole trick. sw.js stores a photo thumb in `photos-v1` under
// its presigned URL with every X-Amz-* parameter removed (normalizeImageUrl) — i.e. the object's own
// URL plus whatever non-signing query the signer adds (the SDK's `x-id=GetObject`). That key is the
// same for every mint of one object, so it is also a URL this page can put in an <img>: the service
// worker answers it from the cache with no network at all. The one thing the page does not know is
// the bucket's origin and that trailing query, so it LEARNS both from a key already in the cache
// rather than hard-coding them (they change with the region, a CDN, or the SDK). An empty cache
// teaches nothing, and every lookup then says "not here", which is today's behaviour: mint.
//
// FAILS TOWARD THE NETWORK. No Cache API (jsdom, an insecure origin), no photos-v1, an unreadable
// key, a throw anywhere: the answer is null and the caller mints, exactly as before this existed. A
// hit whose entry is evicted before the <img> asks for it costs one failed request, after which
// PhotoImg's own heal mints by id — the pre-existing path, not a new one.
import { PHOTO_CACHE_NAME } from './swCacheKeys.js'

const THUMB_PREFIX = 'thumbs/'
// A cache that had nothing to teach is asked again after this long rather than on every row: a
// first-ever visit fills photos-v1 as it goes, and the NEXT group opened should benefit.
const RELEARN_EMPTY_MS = 15_000

let learned = null            // Promise<{ origin, search } | null>
let learnedAt = 0

function cacheStorage() {
  try { return typeof caches !== 'undefined' && caches && typeof caches.open === 'function' ? caches : null } catch { return null }
}

/** False where there is no Cache API at all, so a caller can skip the lookup (and its pending frame) outright. */
export function deviceThumbLookupPossible() {
  return cacheStorage() !== null
}

// Test seam. Production code never resets the memo.
export function __resetDeviceThumb() { learned = null; learnedAt = 0 }

async function openPhotoCache(api) {
  // has() first: open() would CREATE an empty photos-v1, and sw.js deliberately never materializes
  // one on a first activate.
  if (typeof api.has === 'function' && !(await api.has(PHOTO_CACHE_NAME))) return null
  return api.open(PHOTO_CACHE_NAME)
}

async function learnTemplate() {
  const api = cacheStorage()
  if (!api) return null
  try {
    const cache = await openPhotoCache(api)
    if (!cache) return null
    for (const req of await cache.keys()) {
      const u = new URL(typeof req === 'string' ? req : req.url)
      if (u.pathname.startsWith(`/${THUMB_PREFIX}`)) return { origin: u.origin, search: u.search }
    }
  } catch { /* unreadable cache: fall through to "nothing learned" */ }
  return null
}

function template() {
  const now = Date.now()
  if (learned && (learnedAt === Infinity || now - learnedAt < RELEARN_EMPTY_MS)) return learned
  learnedAt = now
  learned = learnTemplate().then((t) => { if (t) learnedAt = Infinity; return t })
  return learned
}

/** The cache URL for an object key, given what the cache taught — encoded per path segment, as S3 URLs are. */
export function deviceThumbUrlFor(key, t) {
  return `${t.origin}/${key.split('/').map(encodeURIComponent).join('/')}${t.search}`
}

/**
 * Resolve a thumb key to a URL this phone can draw WITHOUT the network, or null.
 * @param {string|null|undefined} key  the row's hero_thumb_key (thumbs/<storage path>)
 * @returns {Promise<string|null>}
 */
export async function deviceThumbUrl(key) {
  if (typeof key !== 'string' || !key.startsWith(THUMB_PREFIX)) return null
  const api = cacheStorage()
  if (!api) return null
  try {
    const t = await template()
    if (!t) return null
    const url = deviceThumbUrlFor(key, t)
    const cache = await openPhotoCache(api)
    if (!cache) return null
    return (await cache.match(url)) ? url : null
  } catch {
    return null
  }
}
