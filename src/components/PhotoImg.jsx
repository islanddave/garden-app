// src/components/PhotoImg.jsx — image-reliability primitive.
//
// Owns the photo SRC LIFECYCLE only, NEVER layout: all sizing / objectFit / borderRadius / aspect
// come from the consumer via ...rest onto the inner <img> (and onto the placeholder box too, so a
// terminal/empty/pending state reserves the SAME box and never shifts layout).
//
// Self-heals an expired S3 presigned URL (900s TTL). On <img> error it re-mints a fresh URL from the
// household-scoped GET /api/photos/view-url/:id (server-side created_by-scoped, not an IDOR). On
// foreground/resume it re-mints an IN-VIEWPORT photo before the stale URL renders; the viewport gate
// keeps a full grid of mounted thumbs from firing N mints on one foreground. A photoId with NO
// initialUrl (an id-only thumb) mints once ON MOUNT. A module-level per-photoId map dedups co-visible
// instances (hero + thumb = one call), tracks lastMintedAt for the proactive elapsed gate, caps
// global concurrency, and survives an off-screen unmount so windowing re-mount doesn't re-mint.
//
// FROZEN CONTRACT — PhotoHero and the img sites compose this; PhotoImg gains NO hero/variant/tier
// prop (composition, not configuration):
// (1) the placeholder inherits the consumer's box styling;
// (2) `fallback` governs the empty, pending, AND error render;
// (3) `hasFallback` says whether the CONSUMER can take over on error — a fact about the caller's own
//     state, not about which derivative this is, so the tier stays entirely on PhotoView's side;
// (4) `mintTier` is an identity, not a mode. The no-tier-prop clause bans a VARIANT MODE (a prop the
//     component branches on to render differently); it must not stop the component telling the mint
//     layer WHICH SOURCE to renew. `mintTier` reaches the mint URL and the cache key and nothing
//     else, and the component body names no tier vocabulary. PhotoImg.tier.test.jsx reds if either
//     stops being true. Render, layout and degrade stay tier-blind;
// (5) `onTerminal(photoId)` is ONE outbound event, fired once at each entry into TERMINAL (heal
//     exhausted, a re-mint 404/403, a mount-mint 404/403) and never for pending, a transient
//     (429/5xx/network) failure or a heal that lands. It exists because with alt="" the TERMINAL box
//     is byte-identical to the PENDING one, so a consumer drawing its own empty state could not tell
//     them apart. It is an event, not a mode: it is called beside each setTerminal(true) and nothing
//     in render, layout or degrade reads it. It is deliberately NOT a flavour of onError: PhotoView
//     steps its degrade chain on every onError, so a terminal onError would walk a thumb tile to the
//     original. PhotoImg.terminal.test.jsx pins each entry, the negatives, and that no
//     setTerminal(true) exists without the event beside it.
import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { TIER } from '../lib/photoModel.js'

export const PRESIGN_TTL_MS = 900 * 1000            // == server view-url expiresIn:900
const MAX_CONCURRENT_MINTS = 6

// Module-level storm control. _key(photoId, tier) -> { url, at, inFlight }, shared across every
// mounted instance. Keyed on the TIER as well as the id because a hero and a tile of the SAME photo
// are two different objects in the bucket: a single-key cache would let a thumb mint answer a full
// one and paint a thumb at full width.
const _cache = new Map()
let _active = 0
const _queue = []

const _TIERS = Object.freeze(Object.values(TIER))
// Unknown/absent tier => the original. The SERVER deliberately 400s an unknown tier (it is the
// authority). The client sits in a render path, where a 400 would be classified as a transient
// failure and retried forever, so a bad tier degrades to the full-tier behaviour instead.
// PhotoImg.tier.test.jsx pins _TIERS against the Lambda's own enum so the two cannot drift apart.
const _tier = (t) => (_TIERS.includes(t) ? t : TIER.FULL)
// The tier is the suffix after the LAST `|`; no member of the closed enum contains one and a photo id
// is a UUID, so no (id, tier) pair can spell another's key. Do not use a NUL separator: it would make
// this file BINARY to git (no diff, no blame).
const _key = (photoId, tier) => `${photoId}|${_tier(tier)}`

// The server reads `?tier=`; ABSENT means 'full' (viewTier.js normalizeViewTier), so the default
// tier is sent as no parameter at all. That keeps the full-tier request identical to every deployed
// client's and lets a full-tier heal work against a Lambda that predates the enum.
const _viewUrl = (photoId, tier) => `/api/photos/view-url/${photoId}${tier === TIER.FULL ? '' : `?tier=${tier}`}`

// V4-PHOTOCORS-001 — the CORS-broken latch. A CORS request the origin refuses does NOT fall back to a
// no-cors fetch: the image simply does not load. Each instance retries once plain (below), but a
// whole grid paying an extra failed request per photo would be worse than the caching is a win. So
// the FIRST time a plain retry SUCCEEDS where the CORS attempt FAILED, crossOrigin is latched off
// process-wide. That success-after-failure pair is the precise signal: an expired presign 403s in
// BOTH modes, so latching on "any error" would disable the feature app-wide on the first stale URL.
// One-way and per page load: a latched session never re-probes, and a reload re-probes for free.
let _corsBroken = false
export function __photoCorsBroken() { return _corsBroken }

// crossOrigin is only meaningful for a cross-origin src, and only photos are cross-origin here.
// Total function: a blob:/data: preview or an unparseable src returns false and renders as today.
function _isCrossOrigin(src) {
  if (typeof src !== 'string' || !src) return false
  if (typeof window === 'undefined' || !window.location) return false
  try { return new URL(src, window.location.href).origin !== window.location.origin } catch { return false }
}

// Test seams — reset / seed module state between cases. `tier` is trailing+defaulted so the
// pre-tier 3-arg call sites keep seeding the full-tier slot. The CORS latch is cleared here too, so
// a case that trips it cannot leak into the next.
export function __resetPhotoImgCache() { _cache.clear(); _active = 0; _queue.length = 0; _corsBroken = false }
export function __seedPhotoImgUrl(photoId, url, at, tier) { _cache.set(_key(photoId, tier), { url, at: at == null ? Date.now() : at, inFlight: null }) }

function _drain() { _active--; const next = _queue.shift(); if (next) next() }

// Re-mint a fresh presigned URL for photoId AT `tier`. Dedups in-flight per (photoId, tier), caps
// global concurrency. Two co-visible instances of one photo at DIFFERENT tiers are two objects in
// the bucket, so they correctly cost two requests; same-tier still collapses to one.
// NOTE: `cache:'no-store'` governs the BROWSER HTTP cache only — it does NOT bypass the service worker
// (the SW fetch handler still intercepts /api/photos/view-url via networkFirst). Online this always
// serves a fresh mint; only true-offline can serve a cached, possibly expired, view-url, which then
// self-heals on the next online/foreground. authedFetch = useApiFetch().fetch (returns parsed JSON,
// throws Error{status} on non-2xx). Resolves to a fresh url string; rejects (with .status) on failure.
// 404/absent-url is normalized to status 404. The 200 body also NAMES the tier it minted; that name
// is deliberately not gated on, because an older Lambda omits it.
export function mintUrl(photoId, authedFetch, tier) {
  const t = _tier(tier)
  const k = _key(photoId, t)
  const existing = _cache.get(k)
  if (existing?.inFlight) return existing.inFlight
  const exec = async () => {
    try {
      const d = await authedFetch(_viewUrl(photoId, t), { cache: 'no-store' })
      const url = d && d.view_url
      if (!url) { const e = new Error('view-url returned no url'); e.status = 404; throw e }
      _cache.set(k, { url, at: Date.now(), inFlight: null })
      return url
    } finally { _drain() }
  }
  const start = () => { _active++; return exec() }
  const inFlight = _active < MAX_CONCURRENT_MINTS
    ? start()
    : new Promise((resolve, reject) => _queue.push(() => start().then(resolve, reject)))
  // Clear the in-flight handle on settle (identity-guarded so a newer mint isn't clobbered) so a
  // transient failure can't poison the key with a rejected promise.
  inFlight.catch(() => {}).finally(() => {
    const e = _cache.get(k)
    if (e && e.inFlight === inFlight) _cache.set(k, { ...e, inFlight: null })
  })
  _cache.set(k, { ...(existing || {}), inFlight })
  return inFlight
}

// Seed lastMintedAt from the initialUrl provided at mount (it came from a recent list fetch), so the
// proactive elapsed gate doesn't re-mint a just-mounted fresh hero on the first foreground.
//
// `publishUrl` is false when the consumer holds a fallback BELOW this source (PhotoView mid-degrade).
// The TIMESTAMP is still true of the photo id either way (every URL for that id came down in the same
// list response), but the URL is a derivative that this id's OTHER consumers must not inherit: `.url`
// is read by the mount-fetch below, and its callers include the full-screen Lightbox, which would
// otherwise paint a thumb at 94vw.
function _seed(photoId, initialUrl, publishUrl = true, tier) {
  if (!photoId || !initialUrl) return
  const k = _key(photoId, tier)
  const e = _cache.get(k)
  if (!e || (e.at == null && !e.inFlight)) _cache.set(k, { url: publishUrl ? initialUrl : null, at: Date.now(), inFlight: null })
}

// `hasFallback` — the consumer has a cheaper source in hand for this same photo and will swap it in
// on error (PhotoView's degrade chain). NOT a tier prop. It suppresses the REACTIVE heal and the
// shared-cache URL publish; the PROACTIVE heal is deliberately untouched, because keeping a rendered
// source's presign alive across a resume is as necessary mid-chain as at the end of one.
//
// `mintTier` — WHICH source of this photo the consumer handed down, so a heal renews THAT one instead
// of always re-selecting the original. Destructured (never left in ...rest) so it cannot reach the
// <img> as an unknown DOM attribute. Nothing below branches on it, and it changes in lockstep with
// `initialUrl`, so the initialUrl-change reset already covers a tier switch.
//
// `onTerminal` — freeze delta (5). Called with the photoId beside every setTerminal(true); the
// fallback="none" exhausted heal never enters TERMINAL (it keeps its broken <img>) and never fires.
// Destructured, like mintTier, so it cannot reach the DOM as an unknown handler attribute. On
// PhotoView's id-only arm a mount-mint 404 on the thumb rung fires it too, and that is still true of
// the photo: view-url 404s only a missing, foreign or deleted photo ROW, never a missing derivative.
// The callback MUST NOT THROW: on the two 404 arms it runs before onError({type:'deleted'}), so a
// throw would swallow the signal PhotoView degrades on.
export default function PhotoImg({
  photoId, initialUrl, alt = '', fallback = 'placeholder', loading, hasFallback = false, mintTier,
  onOpen, onRemint, onError, onTerminal, onLoad, style, className, ...rest
}) {
  const { fetch: apiFetch } = useApiFetch()
  const [src, setSrc] = useState(initialUrl ?? null)
  const [terminal, setTerminal] = useState(false)
  const retriedRef = useRef(false)
  const mountedRef = useRef(true)
  const abortRef = useRef(null)
  const imgRef = useRef(null)                       // P5: viewport gate reads the rendered <img> box
  const photoIdRef = useRef(photoId)                // P4/D1: latest identity for the stale-heal guard
  const mountFetchedForRef = useRef(null)           // P1: at most one mount-fetch per photoId
  // V4-PHOTOCORS-001: the ONE src whose CORS attempt already failed here. Holding the URL rather
  // than a boolean makes this self-resetting: a heal or tier step changes `src`, so the new URL gets
  // its own single CORS attempt with no reset branch to keep in sync.
  const [corsFailedSrc, setCorsFailedSrc] = useState(null)

  // Render-time prop-change adoption (NEW-1; no src-watching effect → no render-loop / StrictMode
  // hazard). photoId change → full reset; same photoId but a NEW initialUrl value (Phase-B cache
  // delivering a fresh URL to an already-mounted img) → adopt it and reset the retry budget.
  const [prev, setPrev] = useState({ photoId, initialUrl })
  if (photoId !== prev.photoId || initialUrl !== prev.initialUrl) {
    setPrev({ photoId, initialUrl })
    setSrc(initialUrl ?? null)
    setTerminal(false)
    retriedRef.current = false
    photoIdRef.current = photoId                    // P4: advance identity so a late adopt from the old id no-ops
    abortRef.current?.abort()                        // stop a pending reactive heal bound to the old id
  }

  // V4-PHOTOCORS-001. Ask for the photo in CORS mode so the response is not opaque and sw.js's
  // isImageResponse() can cache it on its real content-type. sw.js's half (presign-param stripping)
  // gates on `request.mode === 'cors'`, which is true exactly when this attribute is set, so the two
  // halves cannot drift apart. Derived, never stored: latch tripped, same-origin src, or a src that
  // already failed CORS here => render with no crossOrigin.
  const useCors = !_corsBroken && corsFailedSrc !== src && _isCrossOrigin(src)

  useEffect(() => { _seed(photoId, initialUrl, !hasFallback, mintTier) }, [photoId, initialUrl, hasFallback, mintTier])
  // Set true on (re)mount — StrictMode runs mount→cleanup→remount, and a cleanup-only ref would leave
  // mountedRef=false after remount, making every async heal bail on the !mountedRef guard.
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; abortRef.current?.abort() } }, [])

  // D1: the single sink for every async URL adoption (mount-fetch / reactive / proactive). The
  // stale-heal guard lives HERE so all three inherit it — a heal that resolves after the consumer
  // paged this instance to a different photoId (Lightbox) never sets the wrong photo's URL.
  const adopt = useCallback((fresh, forPhotoId) => {
    if (!mountedRef.current || !fresh) return
    if (forPhotoId != null && forPhotoId !== photoIdRef.current) return   // P4/D1: stale-heal guard
    // Forced re-decode (NEW-3): if the mint returns the SAME url (evicted-but-valid bitmap), setState
    // is a no-op → toggle src to force a re-fetch/re-decode. A ?t= cache-buster would break the S3
    // presign signature, so we remount the same resource instead.
    setSrc((cur) => {
      if (cur === fresh) {
        queueMicrotask(() => {
          if (mountedRef.current && (forPhotoId == null || forPhotoId === photoIdRef.current)) setSrc(fresh)
        })
        return null
      }
      return fresh
    })
    setTerminal(false)
  }, [])

  // Reactive heal: the <img> errored. Treat as expiry → one re-mint. Classify the MINT failure.
  const handleError = useCallback(async (ev) => {
    // V4-PHOTOCORS-001 — the CORS retry MUST come before everything else in this handler. A refused
    // CORS request is not evidence that the photo is gone: `onError` would advance PhotoView's tier
    // cursor and send a THUMB tile to the original, the hasFallback branch would stand down, and the
    // non-fallback branch would spend the one-shot mint budget on a URL that is fine. Re-render the
    // SAME url without the attribute; if THAT fails too, this runs again with `useCors` false.
    if (useCors) { setCorsFailedSrc(src); return }
    onError?.(ev)
    // The consumer swaps in its own next source on this same event, so minting here would waste a
    // round-trip, and going terminal would blank the box for the frame before the swap lands. Return
    // BEFORE the retry budget is touched: it belongs to the source that actually gets to heal.
    if (hasFallback) return
    if (!photoId || retriedRef.current) { if (fallback !== 'none') { setTerminal(true); onTerminal?.(photoId) } return }
    retriedRef.current = true
    abortRef.current?.abort()
    const ac = new AbortController(); abortRef.current = ac
    try {
      const fresh = await mintUrl(photoId, apiFetch, mintTier)
      if (!mountedRef.current || ac.signal.aborted) return
      onRemint?.(photoId)
      adopt(fresh, photoId)
    } catch (err) {
      // BUG-PHOTOIMGSTALECATCH-001: bail on an aborted heal exactly as the success branch above does.
      // A consumer that pages this instance to another photo (the Lightbox) aborts the heal, and a late
      // 404 for the photo it left says nothing about the one on screen now. Every render-time reset
      // aborts the heal, so the SAME photo getting a new URL mid-heal drops its 404 too: that failure
      // is re-derived if the new URL fails (one more mint, then TERMINAL). PhotoImg.staleCatch.test.jsx
      // pins both shapes.
      if (!mountedRef.current || ac.signal.aborted) return
      const st = err?.status
      if (st === 404) { setTerminal(true); onTerminal?.(photoId); onError?.({ type: 'deleted', photoId }) }   // signal cache invalidate
      else if (st === 403) { setTerminal(true); onTerminal?.(photoId) }                                       // fresh URL still forbidden → terminal
      else { retriedRef.current = false }   // 429/5xx/network/offline → non-terminal, budget NOT spent; proactive/online retries
    }
  }, [photoId, apiFetch, fallback, hasFallback, mintTier, onRemint, onError, onTerminal, adopt, useCors, src])

  // V4-PHOTOCORS-001 — latch detection. This fires only on the plain RETRY of a url whose CORS attempt
  // failed: same url, same network, same presign, only the attribute differs, which isolates the CORS
  // mode as the cause. Wraps onLoad rather than replacing it, so consumers that count loads see every one.
  const handleLoad = useCallback((ev) => {
    if (corsFailedSrc && corsFailedSrc === src) _corsBroken = true
    onLoad?.(ev)
  }, [corsFailedSrc, src, onLoad])

  // Fetch-on-mount: a photoId with NO consumer-provided url (an id-only thumb) resolves once on
  // mount so it renders without an interaction. Guarded so the initialUrl-present path (every shipped
  // consumer, incl. HeroPhoto) is byte-unchanged. Warm cache within TTL → adopt with ZERO network.
  useEffect(() => {
    if (!photoId || initialUrl) return
    if (mountFetchedForRef.current === photoId) return   // once per photoId (parent re-renders must not re-mint/flicker)
    mountFetchedForRef.current = photoId
    const cached = _cache.get(_key(photoId, mintTier))
    if (cached?.url && cached.at != null && Date.now() - cached.at <= PRESIGN_TTL_MS) { adopt(cached.url, photoId); return }
    // No per-effect cancelled flag: adopt()'s mountedRef + photoIdRef guards already drop a resolve
    // after a real unmount, and under StrictMode (mount→cleanup→remount) the mountFetchedForRef guard
    // suppresses the second mint while the first still adopts (mountedRef is true again post-remount).
    mintUrl(photoId, apiFetch, mintTier).then((fresh) => {
      if (!mountedRef.current) return
      onRemint?.(photoId)
      adopt(fresh, photoId)
    }).catch((err) => {
      // BUG-PHOTOIMGSTALECATCH-001: the same identity guard adopt() applies to a resolve. A mount-mint
      // that fails after the consumer re-pointed this instance belongs to the photo it left.
      if (!mountedRef.current || photoIdRef.current !== photoId) return
      const st = err?.status
      if (st === 404) { setTerminal(true); onTerminal?.(photoId); onError?.({ type: 'deleted', photoId }) }
      else if (st === 403) { setTerminal(true); onTerminal?.(photoId) }
      // network/5xx/offline → non-terminal; the proactive/online path recovers it
    })
  }, [photoId, initialUrl, apiFetch, mintTier, adopt, onRemint, onError, onTerminal])

  // Proactive heal: on foreground / resume / bfcache-restore, re-mint an IN-VIEWPORT photo BEFORE the
  // stale URL renders — but only if the last mint is older than the presign TTL (elapsed gate, NEW-4),
  // else a 3s app-switch would needlessly re-fetch and flash the hero. P5 viewport gate: skip any
  // instance whose <img> is off-screen (or not rendered) so a fully-scrolled grid does not storm the
  // mint endpoint on foreground — off-screen thumbs heal reactively on scroll-in instead.
  useEffect(() => {
    if (!photoId) return
    const onWake = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      const el = imgRef.current
      if (!el || typeof el.getBoundingClientRect !== 'function') return   // D2: no rendered img (pending/terminal) → nothing to refresh
      const r = el.getBoundingClientRect()
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 0
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 0
      if (!(r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw)) return   // P5: only refresh the visible screenful
      const e = _cache.get(_key(photoId, mintTier))
      if (e && e.at != null && Date.now() - e.at <= PRESIGN_TTL_MS) return
      retriedRef.current = false
      mintUrl(photoId, apiFetch, mintTier).then((fresh) => { if (mountedRef.current) { onRemint?.(photoId); adopt(fresh, photoId) } }).catch(() => {})
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('pageshow', onWake)
    document.addEventListener('resume', onWake)       // Chromium Page Lifecycle
    window.addEventListener('online', onWake)         // recover a budget-preserved transient failure
    return () => {
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('pageshow', onWake)
      document.removeEventListener('resume', onWake)
      window.removeEventListener('online', onWake)
    }
  }, [photoId, apiFetch, mintTier, onRemint, adopt])

  // ── Render ────────────────────────────────────────────────────────────────────────────────────
  // empty (no photoId AND no url), pending (a photoId whose mount-mint hasn't resolved yet — never
  // emit <img src={null}>), and terminal (heal exhausted) all honor `fallback`:
  //   'placeholder' → a neutral box that INHERITS the consumer's className/style (reserves layout);
  //   'none'        → render nothing (PutUpPhotoThumb's silent-collapse contract).
  // A11y (P3): only a TERMINAL, MEANINGFUL (non-empty alt) image announces (role=img + label); a
  // decorative (alt="") or pending/empty box stays aria-hidden so a failed heal never injects a
  // spurious "Photo unavailable" node. ...rest is spread so a consumer's aria-hidden / data-testid /
  // draggable survive the terminal render too.
  const isEmpty = !photoId && !src
  const pending = !!photoId && !src && !terminal
  const showFallback = isEmpty || pending || terminal
  if (showFallback && fallback === 'none') return null
  if (showFallback) {
    return (
      <div
        {...rest}
        className={className}
        aria-hidden={(!terminal || !alt) ? true : undefined}
        role={terminal && alt ? 'img' : undefined}
        aria-label={terminal && alt ? alt : undefined}
        style={{ backgroundColor: P.greenPale, display: 'block', ...style }}
      />
    )
  }

  // `key` on the element, not just the attribute: dropping crossOrigin in place relies on the browser
  // treating it as a mutation that re-runs "update the image data", and the retry must definitely
  // issue a second request. Remounting guarantees it, with no flash (the CORS attempt painted
  // nothing). Inert for a same-origin src: `useCors` is constant false, so the key never changes.
  const img = (
    <img
      key={useCors ? 'cors' : 'plain'}
      ref={imgRef}
      src={src}
      alt={alt}
      loading={loading}
      className={className}
      style={style}
      crossOrigin={useCors ? 'anonymous' : undefined}
      onError={handleError}
      onLoad={handleLoad}
      {...rest}
    />
  )
  if (!onOpen) return img
  return (
    <button type="button" onClick={onOpen} aria-label={alt ? `${alt} — view larger` : 'View photo'}
      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', lineHeight: 0, display: 'block' }}>
      {img}
    </button>
  )
}
