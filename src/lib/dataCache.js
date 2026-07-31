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
//   PhotoImg owns URL freshness + heals expiry). So an unchanged list yields an Object.is-equal
//   snapshot → no re-render, no re-download of the visible screenful. A real membership/field change
//   adopts the fresh list.
// - ERROR ONLY WHEN NO DATA: a revalidate failure with a cached value keeps serving the value
//   (error:null); only a COLD failure surfaces `error`.

const _store = new Map()
const _now = () => Date.now()
const LRU_CAP = 60

// Test seam — clear all module state between cases (mirror PhotoImg's __resetPhotoImgCache).
export function __resetDataCache() { _store.clear() }

function _mk() {
  return { status: 'empty', data: undefined, error: null, gen: 0, at: 0, inFlight: null, fetcher: null, subs: new Set(), snap: null }
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
  if (!e.snap) e.snap = { status: e.status, data: e.data, error: e.error, loading: e.status === 'pending', isValidating: !!e.inFlight }
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

const URL_FIELDS = ['view_url', 'thumb_url', 'featured_photo_view_url']
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
      _commit(cur, { status: 'value', data, error: null, at: _now() })
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

// B4 pull-to-refresh primitive: force every watched key to the network while KEEPING its cached value
// on screen (SWR), and drop unwatched entries so a refresh genuinely clears the app's memory.
//
// NOT invalidateAll(): that clears watched entries too, blanking every mounted list mid-view — the
// opposite of what a refresh gesture should feel like.
//
// V102 §B4 also asks that keys with a pending in-flight MUTATION be exempted so a refresh can't wipe
// an unconfirmed optimistic write. That exemption is vacuous today and deliberately not built: no
// mutation writes through this cache — photo mutations go through useUploadPhoto and then
// invalidatePrefix — so there is no optimistic cache state to protect. Build the exemption together
// with the first optimistic writer (the useInventory adjustQuantity path, per V102 §B2), not before.
export function refreshAll() {
  let n = 0
  for (const [k, e] of [..._store]) {
    if (e.subs.size) { invalidate(k); n++ } else { _store.delete(k) }
  }
  return n
}
