// src/components/photo/PhotoView.jsx — V4-PHOTOMODEL-001. THE photo primitive.
//
// One component, one way to render a photo. It COMPOSES <PhotoImg> rather than extending it:
// PhotoImg's contract is frozen at "owns the presigned-URL lifecycle, gains no tier prop", and
// tier/derivative selection is exactly the concern that was missing. PhotoView owns that half —
// which source to render and how to degrade — and delegates expiry self-healing downward.
//
// Split of responsibility:
//   photoModel.js  — WHAT a photo is (parents, sources, expiry)
//   PhotoView      — WHICH source to render, and the degrade chain
//   PhotoImg       — keeping that source's presigned URL alive (900s TTL re-mint)
//
// LAZY LOADING: `loading="lazy"` is BANNED app-wide (noNativeLazyImages.static.test.js, empty
// allow-list) because it was MEASURED not to fire — 120 images with correct srcs, 9 in viewport,
// 0 network requests (2026-07-27, live). Deferral here is done by bounding how many PhotoViews
// exist, via useImageWindow at the consumer. Adding the attribute here would make images silently
// stop loading, which is the failure this component exists to prevent.
//
// ── THE ID-ONLY ARM (`resolveById`) ───────────────────────────────────────────────────────────
// Not every endpoint presigns. GET /api/events/:id returns { id, storage_path, cover_for } and
// preservation_log carries a bare photo_id: presigning lives in the photos Lambda and those
// functions deliberately do not reach for it. Such a row has an EMPTY source chain, so this
// component used to render `null` — i.e. the mandated primitive could not express the one photo
// shape two live surfaces actually have, and both shipped on raw <PhotoImg> through the drift
// guard's allow-list instead. `resolveById` closes that: an empty chain WITH an id hands the id to
// PhotoImg's fetch-on-mount path (A2b P1), which mints against the household-scoped
// GET /api/photos/view-url/:id — the app's ONE signed-URL mechanism, shared cache, storm-dedup,
// concurrency cap and expiry self-heal included. No second URL path, no bypassed presign.
//
//   OPT-IN, NOT AUTOMATIC. A URL-less row without the flag still renders nothing, byte-identically
//     to before. Turning the arm on implicitly would convert every surface that ever receives a
//     URL-less row (a failed presign, a soft-deleted id) from a free silent omission into one
//     network mint per row — a behaviour change no existing caller asked for.
//   FALLBACK, NOT AN OVERRIDE. The flag only matters when the chain is empty; a row that DOES
//     carry a URL renders from it with zero network, so a later server-side widening (events
//     starting to send view_url) upgrades every id-only caller transparently, no client change.
//   TIER-BLIND. /api/photos/view-url/:id mints the ORIGINAL; no thumb derivative is addressable by
//     id. `tier` is therefore ignored on this arm — a tier=THUMB caller gets the full original,
//     which is the same honest degrade sourceChain() already performs for a thumb-less row.
//   STATES (an async resolve has more than two): PENDING and UNRESOLVABLE both render PhotoImg's
//     `fallback` — 'placeholder' (default) reserves the consumer's box, so a grid does not reflow
//     when the mint lands, and a TERMINAL failure with a meaningful alt announces as role=img;
//     'none' collapses silently (PutUpPhotoThumb's contract: the record is the payload, the photo
//     is garnish). A 404 (deleted) or 403 is terminal. A network/5xx failure is NOT terminal and
//     stays pending — note that PhotoImg's proactive re-mint is viewport-gated on a RENDERED <img>,
//     so a pending instance heals on remount rather than on the next foreground. Pre-existing to
//     this arm (it is PhotoImg's mount-fetch path, unchanged); called out because "renders nothing
//     forever" is exactly the failure class this component exists to make impossible to ship blind.
import React, { useState, useCallback } from 'react'
import PhotoImg from '../PhotoImg.jsx'
import { toPhoto, sourceChain, TIER } from '../../lib/photoModel.js'

// photo        — a raw /api/photos row OR an already-canonical photo (toPhoto is idempotent)
// tier         — TIER.THUMB for grids/tiles, TIER.FULL for hero/lightbox/modal
// alt          — overrides the model's derived alt; pass "" for a decorative image
// resolveById  — opt in to the id-only arm above (a row with an id and no URL)
// Every other prop (style, className, decoding, data-testid, aria-*) forwards to PhotoImg, which
// forwards it to the <img> AND to its placeholder box, so layout never shifts between states.
export default function PhotoView({ photo, tier = TIER.FULL, alt, resolveById = false, onOpen, onError, ...rest }) {
  // Index into the source chain. A thumb that fails degrades to the full original that came down in
  // the SAME list response — zero network, because a missing thumb is the expected case
  // (BUG-PHOTONEWTHUMB-001: only the 913 backfilled photos actually have one, yet thumb_url is a
  // non-empty presigned string on all 1094 rows, so its truthiness proves nothing).
  const [step, setStep] = useState(0)

  const p = toPhoto(photo)
  const chain = sourceChain(p, tier)

  // Reset the degrade cursor when the consumer swaps in a different photo (windowed grids and the
  // Lightbox both reuse one instance across ids). Render-time, matching PhotoImg's own adoption
  // idiom — an effect here would paint one frame of the previous photo's degraded source.
  const [prevId, setPrevId] = useState(p?.id ?? null)
  if ((p?.id ?? null) !== prevId) {
    setPrevId(p?.id ?? null)
    setStep(0)
  }

  const atLast = step >= chain.length - 1
  const source = chain[Math.min(step, chain.length - 1)] ?? null

  // Advance the chain on the FIRST failure of a non-final source. PhotoImg only re-mints when it is
  // given a photoId, so while a cheap in-hand degrade is still available we withhold it — that keeps
  // the missing-thumb case free of a network round-trip. On the final source we hand the id over and
  // PhotoImg's expiry self-heal takes charge.
  const handleError = useCallback((ev) => {
    onError?.(ev)
    setStep(s => (s + 1 < chain.length ? s + 1 : s))
  }, [onError, chain.length])

  if (!p) return null

  // The id-only arm. Deliberately placed AFTER the source check so it can never shadow an in-hand
  // URL: it fires only when there is nothing to render and an id to resolve with.
  if (!source) {
    if (!resolveById || !p.id) return null
    return (
      <PhotoImg
        photoId={p.id}
        alt={alt === undefined ? p.alt : alt}
        onOpen={onOpen}
        onError={onError}
        {...rest}
      />
    )
  }

  return (
    <PhotoImg
      photoId={atLast ? p.id : undefined}
      initialUrl={source.url}
      alt={alt === undefined ? p.alt : alt}
      onOpen={onOpen}
      onError={handleError}
      {...rest}
    />
  )
}
