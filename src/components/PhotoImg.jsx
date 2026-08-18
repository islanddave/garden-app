// src/components/PhotoImg.jsx — image-reliability primitive (garden-perf-image-plan V102 §A1, +A2b).
//
// Owns the photo SRC LIFECYCLE only, NEVER layout: all sizing / objectFit / borderRadius / aspect
// come from the consumer via ...rest onto the inner <img> (and onto the placeholder box too, so a
// terminal/empty/pending state reserves the SAME box and never shifts layout).
//
// Self-heals an expired S3 presigned URL (900s TTL, rendered by a bare <img> today with no onError →
// permanent blank). On <img> error it re-mints a fresh URL from the household-scoped
// GET /api/photos/view-url/:id (V-B1: server-side created_by-scoped, NOT an IDOR). On foreground/resume
// it proactively re-mints an IN-VIEWPORT photo (esp. a hero) before the stale URL renders — viewport-
// gated (A2b P5) so a full grid of mounted thumbs does not fire N mints on one foreground. Given a
// photoId but NO initialUrl (an id-only thumb, e.g. PutUpPhotoThumb), it mints once ON MOUNT so the
// photo appears without waiting for an interaction (A2b P1). A module-level per-photoId map dedups
// co-visible instances (hero + thumb = one call), tracks lastMintedAt for the proactive elapsed gate,
// caps global concurrency, and survives an off-screen unmount so windowing re-mount doesn't re-mint.
//
// FROZEN CONTRACT — C's tier-agnostic PhotoHero and the A2b img sites compose this; PhotoImg gains
// NO hero/variant/tier prop (composition, not configuration). Freeze deltas folded in: (1) placeholder
// inherits the consumer's box styling; (2) `fallback` governs the empty, pending, AND error render;
// (3) `hasFallback` says whether the CONSUMER can take over on error — a fact about the caller's own
// state, not about which derivative this is, so the tier stays entirely on PhotoView's side.
// (4) V4-TIERBLINDMINT-001 NARROWS the no-tier-prop clause and machine-enforces what it was for.
// The clause bans a VARIANT MODE — a prop the component branches on to render differently. It was
// also, unintentionally, stopping the component from telling the mint layer WHICH SOURCE to renew,
// so every heal re-selected the original: PhotoImg was performing the tier SELECTION this contract
// assigns to PhotoView, silently, because until the Lambda accepted ?tier there was no other answer
// to give. `mintTier` is that missing identity, not a mode — it reaches the mint URL and the cache
// key and nothing else, the component body below names no tier vocabulary at all, and
// PhotoImg.tier.test.jsx reds if either stops being true. Render, layout and degrade stay tier-blind.
import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { TIER } from '../lib/photoModel.js'

export const PRESIGN_TTL_MS = 900 * 1000            // == server view-url expiresIn:900
const MAX_CONCURRENT_MINTS = 6

// Module-level storm control. _key(photoId, tier) -> { url, at, inFlight }. Shared across every
// mounted instance. Keyed on the TIER as well as the id because a hero and a tile of the SAME photo
// are two different objects in the bucket: a single-key cache lets a thumb mint answer a full one
// and paint 163 KB at 94vw (the hazard _seed's publishUrl below was invented to dodge one path of).
const _cache = new Map()
let _active = 0
const _queue = []

const _TIERS = Object.freeze(Object.values(TIER))
// Unknown/absent tier => the original. The SERVER deliberately 400s an unknown tier rather than
// coercing (it is the authority; hiding a caller's typo behind a 200 IS the tier-blindness). The
// client is not the authority and sits in a render path, where a 400 would be classified as a
// transient failure and retried forever — so a bad tier degrades to the pre-existing full-tier
// behaviour instead. PhotoImg.tier.test.jsx pins _TIERS against the Lambda's own enum so the two
// vocabularies cannot drift apart.
const _tier = (t) => (_TIERS.includes(t) ? t : TIER.FULL)
// The tier is always the suffix after the LAST `|`, and no member of the closed enum contains one,
// so the split point is unambiguous and no (id, tier) pair can spell another's key — a photo id is
// a UUID, which cannot contain `|` either. A NUL separator proves the same thing and makes this
// whole file BINARY to git: no diff, no blame, no review on a core component. Any printable byte
// outside the enum buys the identical guarantee for free.
const _key = (photoId, tier) => `${photoId}|${_tier(tier)}`

// The server reads `?tier=`; ABSENT means 'full' (viewTier.js normalizeViewTier), so the default
// tier is sent as no parameter at all. The full-tier request is then byte-identical to the one every
// deployed client already makes — nothing to re-verify on that path — and a full-tier heal cannot
// 400 against a Lambda that predates the enum. Only a non-default tier has to say so.
const _viewUrl = (photoId, tier) => `/api/photos/view-url/${photoId}${tier === TIER.FULL ? '' : `?tier=${tier}`}`

// Test seams — reset / seed module state between cases. `tier` is trailing+defaulted so the
// pre-tier 3-arg call sites keep seeding the full-tier slot they always meant.
export function __resetPhotoImgCache() { _cache.clear(); _active = 0; _queue.length = 0 }
export function __seedPhotoImgUrl(photoId, url, at, tier) { _cache.set(_key(photoId, tier), { url, at: at == null ? Date.now() : at, inFlight: null }) }

function _drain() { _active--; const next = _queue.shift(); if (next) next() }

// Re-mint a fresh presigned URL for photoId AT `tier`. Dedups in-flight per (photoId, tier), caps
// global concurrency. Two co-visible instances of one photo at DIFFERENT tiers are two objects in
// the bucket, so they correctly cost two requests; same-tier still collapses to one.
// NOTE: `cache:'no-store'` governs the BROWSER HTTP cache only — it does NOT bypass the service worker
// (the SW fetch handler still intercepts /api/photos/view-url via networkFirst). Online this always
// serves a fresh mint; only true-offline can serve a cached — possibly expired — view-url, which then
// self-heals on the next online/foreground. authedFetch = useApiFetch().fetch (returns parsed JSON,
// throws Error{status} on non-2xx). Resolves to a fresh url string; rejects (with .status) on failure.
// 404/absent-url is normalized to status 404. The 200 body also NAMES the tier it minted; that name
// is deliberately not gated on — an older Lambda omits it, and rejecting its response would trade a
// wrong-tier image for no image at all.
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
// proactive elapsed gate doesn't re-mint a just-mounted fresh hero on the first foreground (NEW-4).
//
// `publishUrl` is false when the consumer holds a fallback BELOW this source (PhotoView mid-degrade).
// The TIMESTAMP is still true of the photo id either way — every URL for that id came down in the
// same list response, so they age together — but the URL is a derivative that this id's OTHER
// consumers must not inherit. `.url` is read by exactly one path (the mount-fetch below), and its
// callers include the full-screen Lightbox, which would otherwise paint a 163 KB thumb at 94vw.
// Keeping `publishUrl` now that the slot is tier-keyed is deliberate belt-and-braces: the key stops
// a thumb answering a FULL reader, and this stops a mid-chain source answering at all.
function _seed(photoId, initialUrl, publishUrl = true, tier) {
  if (!photoId || !initialUrl) return
  const k = _key(photoId, tier)
  const e = _cache.get(k)
  if (!e || (e.at == null && !e.inFlight)) _cache.set(k, { url: publishUrl ? initialUrl : null, at: Date.now(), inFlight: null })
}

// `hasFallback` — the consumer has a cheaper source in hand for this same photo and will swap it in
// on error (PhotoView's degrade chain). NOT a tier prop: PhotoImg still knows nothing about thumbs or
// derivatives, only that it is not the last resort. It suppresses the REACTIVE heal and the shared-
// cache URL publish; the PROACTIVE heal is deliberately untouched, because keeping a rendered source's
// presign alive across a resume is exactly as necessary mid-chain as it is at the end of one.
//
// `mintTier` — WHICH source of this photo the consumer handed down, so a heal renews THAT one instead
// of always re-selecting the original. Destructured (never left in ...rest) so it cannot reach the
// <img> as an unknown DOM attribute. It is not a mode: nothing below branches on it, no render,
// layout, degrade or a11y path reads it, and it changes in lockstep with `initialUrl` (each step of
// PhotoView's chain carries its own URL), so the existing initialUrl-change reset already covers a
// tier switch and no separate mintTier-change branch is needed.
export default function PhotoImg({
  photoId, initialUrl, alt = '', fallback = 'placeholder', loading, hasFallback = false, mintTier,
  onOpen, onRemint, onError, onLoad, style, className, ...rest
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
    onError?.(ev)
    // The consumer swaps in its own next source on this same event, so minting here would spend a
    // round-trip on a URL about to be replaced — and going terminal would blank the box for the frame
    // before the swap lands. Return BEFORE the retry budget is touched: the budget belongs to the
    // source that actually gets to heal.
    if (hasFallback) return
    if (!photoId || retriedRef.current) { if (fallback !== 'none') setTerminal(true); return }
    retriedRef.current = true
    abortRef.current?.abort()
    const ac = new AbortController(); abortRef.current = ac
    try {
      const fresh = await mintUrl(photoId, apiFetch, mintTier)
      if (!mountedRef.current || ac.signal.aborted) return
      onRemint?.(photoId)
      adopt(fresh, photoId)
    } catch (err) {
      if (!mountedRef.current) return
      const st = err?.status
      if (st === 404) { setTerminal(true); onError?.({ type: 'deleted', photoId }) }   // signal cache invalidate
      else if (st === 403) { setTerminal(true) }                                       // fresh URL still forbidden → terminal
      else { retriedRef.current = false }   // 429/5xx/network/offline → non-terminal, budget NOT spent; proactive/online retries
    }
  }, [photoId, apiFetch, fallback, hasFallback, mintTier, onRemint, onError, adopt])

  // P1 — Fetch-on-mount: a photoId with NO consumer-provided url (an id-only thumb) resolves once on
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
      if (!mountedRef.current) return
      const st = err?.status
      if (st === 404) { setTerminal(true); onError?.({ type: 'deleted', photoId }) }
      else if (st === 403) { setTerminal(true) }
      // network/5xx/offline → non-terminal; the proactive/online path recovers it
    })
  }, [photoId, initialUrl, apiFetch, mintTier, adopt, onRemint, onError])

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

  const img = (
    <img
      ref={imgRef}
      src={src}
      alt={alt}
      loading={loading}
      className={className}
      style={style}
      onError={handleError}
      onLoad={onLoad}
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
