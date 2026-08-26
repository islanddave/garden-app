// Pure cache-key helpers for public/sw.js — Slice 1 of the SW API-cache remediation (design V100).
//
// THE SEAM: public/sw.js is served raw and unbundled, so it cannot import from src/lib/. The block
// between the SW-MIRROR sentinels below is byte-mirrored into public/sw.js, and
// `npm run gate:sw-mirror` fails the build if the two copies drift. This file is the one inside
// coverage.include, so the logic is unit-tested here and merely *executed* there.
//
// Why the sub is a PARTITION KEY and not an authorization decision: the JWT is NOT verified here.
// A forged token yields a wrong partition, which is inert — the network still rejects the request
// and no other user's partition becomes reachable. This defends against the realistic actor
// (someone holding the unlocked phone with only the app UI), not against same-origin script, which
// can read Cache Storage directly regardless.

/* SW-MIRROR-START — byte-identical copy lives in public/sw.js; gate:sw-mirror enforces it */
// Clerk subs are opaque `user_<base58>` strings. VALIDATE rather than sanitize-and-truncate:
// truncation would let two distinct subs share a partition, and a sanitizer that rewrites a bad
// sub into a valid-looking one fails TOWARD a shared partition. An unrecognised shape returns
// null, and null means "no cache at all" (fail closed), never a shared 'anon' bucket.
const SW_SUB_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

// Extract the `sub` claim from an `Authorization: Bearer <jwt>` header. Total function: every
// malformed input returns null rather than throwing, because this runs inside the fetch handler
// and a throw there fails the request rather than falling back to the network.
function subFromAuthHeader(header) {
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(\S+)$/.exec(header)
  if (!match) return null
  const parts = match[1].split('.')
  if (parts.length !== 3) return null
  let claims
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4) b64 += '='
    const bin = atob(b64)
    // Decode as UTF-8 rather than trusting atob's binary string: a non-ASCII claim elsewhere in
    // the payload would otherwise corrupt JSON.parse and lose an otherwise-valid sub.
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    claims = JSON.parse(new TextDecoder().decode(bytes))
  } catch { return null }
  const sub = claims && claims.sub
  if (typeof sub !== 'string' || !SW_SUB_PATTERN.test(sub)) return null
  return sub
}

// null sub => null name => caller performs NO cache read and NO cache write.
function apiCacheNameFor(version, sub) {
  if (typeof version !== 'string' || !version) return null
  if (typeof sub !== 'string' || !SW_SUB_PATTERN.test(sub)) return null
  return `api-${version}-u-${sub}`
}

// V4-PHOTOCORS-001 — the ONE cache deliberately not keyed on CACHE_VERSION, hence a literal here
// rather than something derived from `version`. A photo is immutable content at a stable key (an S3
// object never changes under its path, and normalizeImageUrl strips the rotating presign params), so
// a CODE deploy is not a reason to throw its bytes away — and deploys run several times a day, often
// enough that a version-keyed photo cache is deleted before it can repay the requests that filled it.
// The API and STATIC caches stay version-keyed on purpose: their contents genuinely do go stale on
// deploy and update detection depends on that. Do not generalize this to them.
// The `-v1` is a MANUAL epoch, not the build version: bump it only to deliberately abandon every
// stored photo (a change to the key normalization would be such a reason).
const PHOTO_CACHE_NAME = 'photos-v1'

// Predicate replacing the old equality allowlist. The allowlist deleted every key not exactly
// equal to the three constants, so any per-sub name self-destructed on every activation. Note the
// BARE `api-${version}` is deliberately NOT kept: unsegmented entries must not survive the upgrade
// that exists to remove them.
function keepCacheKey(key, version) {
  if (typeof key !== 'string' || typeof version !== 'string' || !version) return false
  if (key === PHOTO_CACHE_NAME) return true
  if (key === `static-${version}` || key === `images-${version}`) return true
  const prefix = `api-${version}-u-`
  if (key.startsWith(prefix)) return SW_SUB_PATTERN.test(key.slice(prefix.length))
  return false
}
/* SW-MIRROR-END */

export { SW_SUB_PATTERN, subFromAuthHeader, apiCacheNameFor, keepCacheKey, PHOTO_CACHE_NAME }
