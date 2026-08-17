// src/lib/dataCache.js — V4-IMGCACHE-001 D-1. A subscribable SWR store (module singleton) for
// read-mostly list data. First (and only, in D-1) consumer: the photo-list fetches — the "slow-tab
// win" (revisiting a photo surface paints from cache instead of a refetch-and-re-presign every mount).
// Keyed by identity+path; identity isolation is the CALLER's job (key prefix) + invalidateAll() on an
// identity change — the store itself is identity-agnostic.
//
// Invariants (crucible-hardened — a naive store silently fails these):
// - IMMUTABLE SNAPSHOT (both directions): getSnapshot returns a STABLE ref while the entry is
//   unchanged (useSyncExternalStore infinite-loops / dev-throws otherwise) AND a NEW snapshot ref on
//   any change (else React bails and the update is silently dropped). getSnapshot does ZERO derivation
//   — consumers derive (sort/dedup) via useMemo over `data`.
// - IN-FLIGHT DEDUP: one module-owned promise per key, evicted in finally + IDENTITY-GUARDED (an older
//   settle must not null a newer in-flight) — mirrors PhotoImg.mintUrl. Fetch lifetime is module-owned:
//   a mid-flight unsubscribe does NOT abort (a quick remount stays warm).
// - GENERATION GUARD: monotonic per key; a fetch captures the gen at issue and writes its result only
//   if the gen still matches at SETTLE — discards an older-gen revalidate resolving AFTER an invalidate.
// - MERGE-BY-ID / URL PRESERVATION (boss RES-004): a revalidate that returns the same rows with only
//   fresh presigned URLs keeps the PRIOR `data` ref (URLs are just presigns of the same S3 object;
//   PhotoImg owns URL freshness + heals expiry). So an unchanged list does not re-download the
//   visible screenful. A real membership/field change adopts the fresh list.
//   ⚠ CORRECTION (2026-07-31): this used to claim an unchanged list "yields an Object.is-equal
//   snapshot → no re-render". FALSE. _commit unconditionally nulls e.snap, so getSnapshot builds a
//   NEW object after every settle and useSyncExternalStore re-renders on every revalidate. What is
//   actually stable is the `data` REF — which is what stops the re-download, via consumers' useMemo.
//   The win is real; the stated mechanism was not. (Same class as the false claim corrected in
//   useCacheLifecycle.js — a wrong comment here seeds wrong impact analyses later.)
// - ERROR ONLY WHEN NO DATA: a revalidate failure with a cached value keeps serving the value
//   (error:null); only a COLD failure surfaces `error`.
// - FRESHNESS CLOCK IS NETWORK-ONLY (SW-STALEAPI-001): `at` records the last time the network actually
//   answered. A response the service worker served from its offline cache commits its data but must NOT
//   advance `at` — see _isFromCache below.

const _store = new Map()
const _now = () => Date.now()
const LRU_CAP = 60

// SW-STALEAPI-001. public/sw.js answers an offline /api/* fetch from API_CACHE with a plain 200, and
// src/lib/api.js stamps that parsed value with this symbol. Read via Symbol.for rather than importing
// api.js so this store stays dependency-free — importing api.js would drag Clerk and the routing table
// into every consumer of the cache. The symbol's canonical definition and rationale live in api.js.
//
// Why the store has to care: without this, a cache-served refresh committed `at: _now()`, and
// revalidateLive(RESUME_MIN_AGE_MS) then skipped the next real wake revalidation for 5 minutes —
// the app stopped trying to refetch precisely because it had just failed to fetch.
const FROM_CACHE = Symbol.for('garden-app.fromCache')
function _isFromCache(v) { return !!v && typeof v === 'object' && v[FROM_CACHE] === true }

// Test seam — clear all module state between cases (mirror PhotoImg's __resetPhotoImgCache).
export function __resetDataCache() { _store.clear() }

function _mk() {
  return { status: 'empty', data: undefined, error: null, gen: 0, at: 0, stale: false, inFlight: null, fetcher: null, subs: new Set(), snap: null }
}

function _entry(key) {
  let e = _store.get(key)
  if (e) return e
  e = _mk()
  _store.set(key, e)
  if (_store.size > LRU_CAP) _evict(key)
  return e
}

// Bounded growth: evict oldest-inserted entries that have no live subscribers (never the just-added
// key, never a subscribed key). Map iteration is insertion order → approximate-LRU, O(n) only on growth.
function _evict(keep) {
  for (const [k, v] of _store) {
    if (_store.size <= LRU_CAP) break
    if (k === keep || v.subs.size > 0) continue
    _store.delete(k)
  }
}

function _snap(e) {
  // `stale` = the last commit came from the SW's offline cache, not the network. Exposed so a consumer
  // can say so; the correctness half (never advancing `at`) does not depend on anyone reading it.
  if (!e.snap) e.snap = { status: e.status, data: e.data, error: e.error, loading: e.status === 'pending', isValidating: !!e.inFlight, stale: !!e.stale }
  return e.snap
}

// Apply a state patch, invalidate the cached snapshot, and notify subscribers.
function _commit(e, patch) {
  Object.assign(e, patch)
  e.snap = null
  for (const cb of e.subs) cb()
}

export function subscribe(key, cb) {
  const e = _entry(key)
  e.subs.add(cb)
  return () => { e.subs.delete(cb) }
}

export function getSnapshot(key) { return _snap(_entry(key)) }

// Non-subscribing read of the current snapshot (or null if never touched) — for tests/diagnostics.
export function peek(key) { const e = _store.get(key); return e ? _snap(e) : null }

// The last fetcher registered for a key (updated per mount) — used by revalidate/invalidate.
export function register(key, fetcher) { _entry(key).fetcher = fetcher }

// EVERY presigned-URL field an API row can carry must be listed here. A URL field that is MISSING
// from this list churns on every revalidate (fresh signature, same object), so the row compares
// unequal, the whole list gets a new identity, and the visible screenful re-renders and
// re-downloads — turning a background refresh into the exact cost this guard exists to avoid.
// featured_photo_thumb_url joined at V4-PERFTHEMEA-001, when /api/plants started signing the
// thumbs/ companion alongside featured_photo_view_url.
const URL_FIELDS = ['view_url', 'thumb_url', 'featured_photo_view_url', 'featured_photo_thumb_url']
// True when prev and next are the same list except for presigned-URL churn (same ids, same order,
// same non-URL fields). Lets a plain revalidate keep the prior `data` ref (URL freshness → PhotoImg).
function _sameExceptUrls(prev, next) {
  if (prev === next) return true
  if (!Array.isArray(prev) || !Array.isArray(next) || prev.length !== next.length) return false
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i], b = next[i]
    if (a === b) continue
    if (!a || !b || a.id !== b.id) return false
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys) { if (URL_FIELDS.includes(k)) continue; if (a[k] !== b[k]) return false }
  }
  return true
}

// Kick a network revalidate for `key` using its registered fetcher. Dedups an in-flight call, guards
// the write by generation, and merges by id. Returns the in-flight promise (or null when no fetcher).
export function revalidate(key) {
  const e = _entry(key)
  if (e.inFlight) return e.inFlight
  const fetcher = e.fetcher
  if (typeof fetcher !== 'function') return null
  const gen = e.gen
  const exec = Promise.resolve().then(fetcher).then(
    (fresh) => {
      const cur = _store.get(key)
      if (!cur || cur.gen !== gen) return                 // gen-guard: invalidated mid-flight → discard
      const list = Array.isArray(fresh) ? fresh : (fresh ?? [])
      const data = _sameExceptUrls(cur.data, list) ? cur.data : list   // preserve unchanged rows' URLs
      // SW-STALEAPI-001. A cache-served response still yields usable data (status stays 'value' — an
      // offline user keeps their list), but it is NOT evidence of freshness, so `at` is left untouched:
      // it keeps pointing at the last time the NETWORK answered. That is what lets revalidateLive's age
      // gate still fire on the next wake instead of being suppressed by the failure itself.
      // Checked on `fresh` AND `list` because the marker rides on the object identity api.js returned;
      // a fetcher that substitutes a fallback (`d ?? []` on a null body) legitimately loses it, which
      // degrades to today's behaviour rather than to a wrong answer.
      const fromCache = _isFromCache(fresh) || _isFromCache(list)
      _commit(cur, fromCache
        ? { status: 'value', data, error: null, stale: true }
        : { status: 'value', data, error: null, stale: false, at: _now() })
    },
    (err) => {
      const cur = _store.get(key)
      if (!cur || cur.gen !== gen) return
      if (cur.status !== 'value') _commit(cur, { status: 'error', error: err })   // error only when no usable data
    },
  )
  exec.catch(() => {}).finally(() => {
    const cur = _store.get(key)
    if (cur && cur.inFlight === exec) _commit(cur, { inFlight: null })   // identity-guarded evict
  })
  _commit(e, { inFlight: exec, status: e.status === 'empty' ? 'pending' : e.status })
  return exec
}

// Mark a key stale (bump gen → drop any older-gen in-flight result) and, if it has live subscribers,
// immediately re-revalidate — so a mounted consumer (LocationDetail upload, PlantingDetail events)
// refreshes without a remount. Keeps the cached value while the new fetch runs (SWR).
export function invalidate(key) {
  const e = _store.get(key)
  if (!e) return
  _commit(e, { gen: e.gen + 1, inFlight: null })
  if (e.subs.size && typeof e.fetcher === 'function') revalidate(key)
}

// Invalidate every key whose PATH part starts with `pathPrefix` (keys are `${identity}|${path}`).
export function invalidatePrefix(pathPrefix) {
  for (const key of [..._store.keys()]) {
    const bar = key.indexOf('|')
    const path = bar === -1 ? key : key.slice(bar + 1)
    if (path.startsWith(pathPrefix)) invalidate(key)
  }
}

// Identity change: discard every entry (bump gens first so any in-flight result for an old key is
// dropped when it settles against the cleared map, then clear). Mounted hooks are already keyed on the
// NEW identity and re-subscribe to fresh (empty) entries.
export function invalidateAll() {
  for (const e of _store.values()) { e.gen += 1; e.inFlight = null }
  _store.clear()
}

// ── V4-IMGCACHE-002 D-2 — boot-warm / resume-revalidate / refresh ────────────────────────────────

// THE canonical key builder. Both useCachedFetch and boot-warm MUST go through this: a warm that
// builds its key even slightly differently writes an entry no hook will ever read (V102 §B1), which
// looks like a working warm and costs a wasted request on every boot.
export function keyFor(sub, path) { return `${sub}|${path}` }

// B3 boot-warm. Seeds a key BEFORE any component mounts, so the first visit to a photo surface paints
// from cache instead of a cold fetch. No-ops when the key already holds data or has a fetch in flight
// (never duplicates a real mount's work).
//
// A FAILED warm must leave NO trace (V102 §B3: "failed warms write nothing"). revalidate() commits
// status:'error' on a cold failure, which would make the first real mount render an error state
// instead of a clean loading→fetch. So on a data-less error we reset the entry to 'empty' — the
// entry OBJECT is kept (not deleted) because any subscriber that arrived mid-warm holds a reference
// to it, and replacing it would orphan their callback.
//
// SW-STALEAPI-001: an OFFLINE warm is not a failed warm — the SW hands back real cached rows, so the
// entry legitimately reaches status 'value' (stale:true) and survives this cleanup. It carries at:0,
// so the first mount and the first wake both revalidate it rather than treating it as fresh.
export function warm(key, fetcher) {
  const e = _entry(key)
  if (e.data !== undefined || e.inFlight) return null
  e.fetcher = fetcher
  const p = revalidate(key)
  if (!p) return null
  p.catch(() => {}).finally(() => {
    const cur = _store.get(key)
    if (cur && cur.status === 'error' && cur.data === undefined) _commit(cur, { status: 'empty', error: null })
  })
  return p
}

// B5 resume revalidation. Revalidates keys that something is actually WATCHING — an unsubscribed
// entry has no viewer, so refetching it on every foreground would burn bandwidth for nobody.
//
// `minAgeMs` is measured against `at`, which SW-STALEAPI-001 keeps NETWORK-ONLY. An offline
// cache-served commit leaves `at` alone, so the gate below measures "how long since real data" rather
// than "how long since the last attempt" — the distinction the SW's silent 200 used to erase.
//
// `minAgeMs` is the elapsed gate, and it is the whole reason this isn't chatty: a 3-second
// app-switch fires visibilitychange too, and refetching every photo list on every glance would be
// strictly worse than the problem being solved. Mirrors PhotoImg's proactive elapsed gate (NEW-4).
// Returns the number of keys kicked (test seam + a caller-visible signal that the gate held).
export function revalidateLive(minAgeMs = 0) {
  const now = _now()
  let n = 0
  for (const [k, e] of _store) {
    if (!e.subs.size || e.inFlight || typeof e.fetcher !== 'function') continue
    if (minAgeMs > 0 && e.at && now - e.at < minAgeMs) continue
    if (revalidate(k)) n++
  }
  return n
}

// B4 refresh primitive: force every watched key to the network while KEEPING its cached value on
// screen (SWR). Unwatched entries are LEFT ALONE.
//
// NOT invalidateAll(): that clears watched entries too, blanking every mounted list mid-view — the
// opposite of what a refresh gesture should feel like.
//
// ⚠ 2026-07-31 (crucible, 6 panels + boss): this used to `_store.delete(k)` every unwatched entry,
// on the stated intent that "a refresh genuinely clears the app's memory". That was a latent
// regression of the B3 boot-warm win. warm() registers NO subscriber, and the boot-warm effect is
// deps-`[sub]` so it never re-seeds within a session — so calling refreshAll() from any surface
// that isn't PhotosWall DELETED the boot-warmed /api/photos entry, making the next Photos visit a
// cold fetch-and-re-presign. A control reached for to make things fresher made the app slower.
// The delete was also redundant with _evict()'s LRU cap (which already skips subscribed keys), and
// didn't even reliably shrink the store — getSnapshot() calls _entry(), which recreates entries on
// read. Latent, not live: refreshAll has no non-test callers. Fixed now so the next session wiring
// this documented "B4 hook-point" doesn't step on it. See the PTR re-open gate in
// useCacheLifecycle.js before building any affordance on top of this.
//
// V102 §B4 also asks that keys with a pending in-flight MUTATION be exempted so a refresh can't wipe
// an unconfirmed optimistic write. That exemption is vacuous today and deliberately not built: no
// mutation writes through this cache — photo mutations go through useUploadPhoto and then
// invalidatePrefix — so there is no optimistic cache state to protect. Build the exemption together
// with the first optimistic writer (the useInventory adjustQuantity path, per V102 §B2), not before.
// The count gates on the SAME condition invalidate() re-kicks on (subs + a registered fetcher).
// It previously counted on subs.size alone, so a subscribed-but-fetcher-less key incremented n
// while issuing zero requests — an over-report that made the return value unsafe as UI copy.
export function refreshAll() {
  let n = 0
  for (const k of [..._store.keys()]) {
    const e = _store.get(k)
    if (!e || !e.subs.size || typeof e.fetcher !== 'function') continue
    invalidate(k)
    n++
  }
  return n
}
